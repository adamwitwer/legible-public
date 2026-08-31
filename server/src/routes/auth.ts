import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { sql } from '../db/index.js';
import { env, isProd } from '../lib/env.js';
import { challengeFromResponse, safeEqual } from '../lib/webauthn.js';

/**
 * Ceremony endpoints are cheap to call and expensive to have brute-forced, so
 * they carry their own limits on top of the global one.
 *
 * `enrollLimit` is keyed to a CONSTANT rather than to the caller's IP, and
 * that is the point: X-Forwarded-For is attacker-controlled, so a per-IP cap on
 * the enroll code can be sidestepped by rotating the header. A global cap
 * cannot. Legitimate enrolment happens perhaps twice a year, so a ceiling this
 * low costs nothing and is the one limit that actually has to hold.
 */
const ceremonyLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };
const enrollLimit = {
  rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: () => 'enroll-global' },
};

const COOKIE = 'legible_session';
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Single fixed user — there is exactly one of them. */
const USER_ID = new TextEncoder().encode('adam');
const USER_NAME = 'adam';

/**
  * One row per ceremony, keyed by the challenge itself.
  *
  * These used to be keyed by kind — a single "authenticate" row shared by
  * everyone — so any unauthenticated caller could POST /login/start and
  * overwrite the challenge of whoever was mid-login. Their authenticator would
  * sign a challenge the server had already replaced, `takeChallenge` would
  * return the stranger's, and verification failed. Repeated in a loop that
  * locked the real user out of their own archive with no credential at all.
  */
async function putChallenge(challenge: string, kind: 'register' | 'authenticate') {
  await sql`
    insert into challenges (id, challenge, kind, expires_at)
    values (${challenge}, ${challenge}, ${kind}, now() + interval '5 minutes')
    on conflict (id) do nothing
  `;
  // Abandoned ceremonies are the normal case, not an anomaly: sweep them here
  // rather than carrying a scheduled job for one table.
  await sql`delete from challenges where expires_at <= now()`;
}

async function takeChallenge(challenge: string | null, kind: 'register' | 'authenticate') {
  if (!challenge) return null;
  const [row] = await sql<{ challenge: string }[]>`
    delete from challenges
    where id = ${challenge} and kind = ${kind} and expires_at > now()
    returning challenge
  `;
  return row?.challenge ?? null;
}

async function issueSession(reply: FastifyReply) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = env.sessionDays * 24 * 60 * 60;
  await sql`
    insert into sessions (token, expires_at)
    values (${hash(token)}, now() + ${`${env.sessionDays} days`}::interval)
  `;
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge,
  });
}

export async function currentSession(req: FastifyRequest): Promise<boolean> {
  const token = req.cookies[COOKIE];
  if (!token) return false;
  const [row] = await sql<{ token: string }[]>`
    update sessions set last_seen_at = now()
    where token = ${hash(token)} and expires_at > now()
    returning token
  `;
  return Boolean(row);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!(await currentSession(req))) {
    return reply.code(401).send({ error: 'not_authenticated' });
  }
}

export default async function authRoutes(app: FastifyInstance) {
  /**
   * Credentials that still work HERE. A passkey is scoped to the RP ID it was
   * created under, so one registered against another domain is not merely stale —
   * the authenticator will never offer it. Counting those as "enrolled" is what
   * used to wedge the enroll code shut after a domain move.
   */
  const credentialCount = async () => {
    const rows = await sql<{ count: string }[]>`
      select count(*)::text as count from credentials where rp_id = ${env.rpId}
    `;
    return Number(rows[0]?.count ?? 0);
  };

  app.get('/api/auth/state', async (req) => ({
    enrolled: (await credentialCount()) > 0,
    authenticated: await currentSession(req),
  }));

  app.get('/api/auth/credentials', { preHandler: requireAuth }, async () => {
    // Deliberately NOT scoped to the current RP ID. A credential registered under
    // another domain cannot sign in, but it is still a row someone has to clean up,
    // and a pane that hides it makes it impossible to :forget.
    const rows = await sql<
      { id: string; label: string | null; rp_id: string; created_at: Date; last_used_at: Date | null }[]
    >`select id, label, rp_id, created_at, last_used_at from credentials order by created_at`;
    // The id is truncated: it identifies a device well enough to tell them
    // apart without handing the whole credential ID to anything that asks.
    return rows.map((r) => ({
      id: r.id.slice(0, 12),
      label: r.label,
      rp_id: r.rp_id,
      usable: r.rp_id === env.rpId,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    }));
  });

  // Removing the last credential is deliberately allowed: it re-arms the enroll
  // code, which applies while no credential exists FOR THIS RP ID. That is the
  // escape hatch when every passkey has become unusable — and since a domain move
  // now leaves zero usable credentials on its own, the hatch opens there without
  // anyone having to delete anything first.
  app.delete<{ Params: { id: string } }>(
    '/api/auth/credentials/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const [gone] = await sql<{ id: string }[]>`
        delete from credentials where left(id, 12) = ${req.params.id} returning id
      `;
      if (!gone) return reply.code(404).send({ error: 'unknown_credential' });
      return { ok: true, remaining: await credentialCount() };
    },
  );

  // --- registration -------------------------------------------------------

  app.post<{ Body: { enrollCode?: string } }>(
    '/api/auth/register/start',
    { config: enrollLimit },
    async (req, reply) => {
    const bootstrapped = (await credentialCount()) > 0;

    // The first passkey needs the one-time code. Adding a second device only
    // requires already being signed in on the first.
    if (bootstrapped) {
      if (!(await currentSession(req))) return reply.code(401).send({ error: 'not_authenticated' });
    } else if (!safeEqual(req.body?.enrollCode ?? '', env.enrollCode)) {
      req.log.warn({ ip: req.ip }, 'bad enroll code');
      return reply.code(403).send({ error: 'bad_enroll_code' });
    }

    // Scoped to this RP ID for the same reason: excluding a credential from another
    // domain would stop the authenticator re-registering here, which is exactly the
    // thing a domain move needs it to do.
    const existing = await sql<{ id: string; transports: string[] }[]>`
      select id, transports from credentials where rp_id = ${env.rpId}
    `;

    const options = await generateRegistrationOptions({
      rpName: env.rpName,
      rpID: env.rpId,
      userID: USER_ID,
      userName: USER_NAME,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    await putChallenge(options.challenge, 'register');
    return options;
  },
  );

  app.post<{ Body: { response: any; label?: string } }>(
    '/api/auth/register/finish',
    { config: ceremonyLimit },
    async (req, reply) => {
      const expectedChallenge = await takeChallenge(
        challengeFromResponse(req.body?.response),
        'register',
      );
      if (!expectedChallenge) return reply.code(400).send({ error: 'challenge_expired' });

      // Every failure mode in here throws rather than returning verified:false,
      // so without the catch a bad ceremony surfaces as an opaque 500.
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: req.body.response,
          expectedChallenge,
          expectedOrigin: env.origin,
          expectedRPID: env.rpId,
        });
      } catch (err) {
        // The reason stays in the log. Handing an unauthenticated caller the
        // raw exception text describes our verification internals to them.
        req.log.warn({ err }, 'registration verification threw');
        return reply.code(400).send({ error: 'verification_failed' });
      }

      if (!verification.verified || !verification.registrationInfo) {
        return reply.code(400).send({ error: 'verification_failed' });
      }

      const { credential } = verification.registrationInfo;
      await sql`
        insert into credentials (id, public_key, counter, transports, label, rp_id)
        values (
          ${credential.id},
          ${Buffer.from(credential.publicKey)},
          ${credential.counter},
          ${credential.transports ?? []},
          ${req.body.label ?? null},
          ${env.rpId}
        )
        on conflict (id) do update set
          public_key = excluded.public_key,
          counter    = excluded.counter,
          transports = excluded.transports,
          label      = coalesce(excluded.label, credentials.label),
          rp_id      = excluded.rp_id
      `;

      await issueSession(reply);
      return { ok: true };
    },
  );

  // --- authentication -----------------------------------------------------

  app.post('/api/auth/login/start', { config: ceremonyLimit }, async () => {
    const options = await generateAuthenticationOptions({
      rpID: env.rpId,
      userVerification: 'preferred',
    });
    await putChallenge(options.challenge, 'authenticate');
    return options;
  });

  app.post<{ Body: { response: any } }>(
    '/api/auth/login/finish',
    { config: ceremonyLimit },
    async (req, reply) => {
    const expectedChallenge = await takeChallenge(
      challengeFromResponse(req.body?.response),
      'authenticate',
    );
    if (!expectedChallenge) return reply.code(400).send({ error: 'challenge_expired' });

    const [cred] = await sql<{ id: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      select id, public_key, counter, transports from credentials
      where id = ${req.body.response.id} and rp_id = ${env.rpId}
    `;
    if (!cred) return reply.code(400).send({ error: 'unknown_credential' });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge,
        expectedOrigin: env.origin,
        expectedRPID: env.rpId,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: Number(cred.counter),
          transports: cred.transports as any,
        },
      });
    } catch (err) {
      req.log.warn({ err, credentialId: cred.id }, 'authentication verification threw');
      return reply.code(401).send({ error: 'verification_failed' });
    }

    if (!verification.verified) return reply.code(401).send({ error: 'verification_failed' });

    await sql`
      update credentials
      set counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
      where id = ${cred.id}
    `;
    await issueSession(reply);
    return { ok: true };
  },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await sql`delete from sessions where token = ${hash(token)}`;
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}
