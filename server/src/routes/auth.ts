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

const COOKIE = 'legible_session';
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Single fixed user — there is exactly one of them. */
const USER_ID = new TextEncoder().encode('adam');
const USER_NAME = 'adam';

async function putChallenge(id: string, challenge: string, kind: 'register' | 'authenticate') {
  await sql`
    insert into challenges (id, challenge, kind, expires_at)
    values (${id}, ${challenge}, ${kind}, now() + interval '5 minutes')
    on conflict (id) do update set challenge = excluded.challenge, expires_at = excluded.expires_at
  `;
}

async function takeChallenge(id: string, kind: 'register' | 'authenticate') {
  const [row] = await sql<{ challenge: string }[]>`
    delete from challenges
    where id = ${id} and kind = ${kind} and expires_at > now()
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

  app.post<{ Body: { enrollCode?: string } }>('/api/auth/register/start', async (req, reply) => {
    const bootstrapped = (await credentialCount()) > 0;

    // The first passkey needs the one-time code. Adding a second device only
    // requires already being signed in on the first.
    if (bootstrapped) {
      if (!(await currentSession(req))) return reply.code(401).send({ error: 'not_authenticated' });
    } else if (req.body?.enrollCode !== env.enrollCode) {
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

    await putChallenge('register', options.challenge, 'register');
    return options;
  });

  app.post<{ Body: { response: any; label?: string } }>(
    '/api/auth/register/finish',
    async (req, reply) => {
      const expectedChallenge = await takeChallenge('register', 'register');
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
        req.log.warn({ err }, 'registration verification threw');
        return reply
          .code(400)
          .send({ error: 'verification_failed', message: (err as Error).message });
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

  app.post('/api/auth/login/start', async () => {
    const options = await generateAuthenticationOptions({
      rpID: env.rpId,
      userVerification: 'preferred',
    });
    await putChallenge('authenticate', options.challenge, 'authenticate');
    return options;
  });

  app.post<{ Body: { response: any } }>('/api/auth/login/finish', async (req, reply) => {
    const expectedChallenge = await takeChallenge('authenticate', 'authenticate');
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
      return reply
        .code(401)
        .send({ error: 'verification_failed', message: (err as Error).message });
    }

    if (!verification.verified) return reply.code(401).send({ error: 'verification_failed' });

    await sql`
      update credentials
      set counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
      where id = ${cred.id}
    `;
    await issueSession(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await sql`delete from sessions where token = ${hash(token)}`;
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}
