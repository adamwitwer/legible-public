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
import { decideEnroll, overBudget } from '../lib/enroll.js';
import { challengeFromResponse } from '../lib/webauthn.js';

/**
 * Ceremony endpoints are cheap to call and expensive to have brute-forced, so
 * they carry their own per-IP limit rather than the looser global floor.
 *
 * Per-IP is best-effort and nothing security-critical rests on it: under
 * `trustProxy` the key comes from X-Forwarded-For, which the caller controls
 * (see the note in index.ts). It blunts runaway clients and casual floods. The
 * enroll code — the one thing here worth brute-forcing — is guarded by
 * `enrollFailures` below instead, which does not depend on the caller's IP.
 */
const ceremonyLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

const COOKIE = 'legible_session';
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** Thrown inside a transaction to roll it back when :forget matches nothing. */
class UnknownCredential extends Error {}

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
  // Abandoned ceremonies are the normal case, not an anomaly, so they are swept
  // here rather than by a scheduled job for one table. Sampled rather than run
  // every time: /login/start needs no credential, and a table-wide DELETE on
  // every unauthenticated call turns one cheap request into lock contention and
  // WAL churn on a 256MB instance. Stale rows are inert either way — every
  // lookup already filters on expires_at.
  if (Math.random() < 0.02) await sql`delete from challenges where expires_at <= now()`;
}

/**
 * Redeem a challenge, once.
 *
 * Load-bearing beyond what it looks like: `expectedChallenge` is now derived
 * from the client's own clientDataJSON, so simplewebauthn's own
 * challenge-equality check compares a value against itself and can no longer
 * catch anything. ALL challenge binding rests on this lookup being an exact,
 * single-use, kind-scoped match. Keep it that way — a LIKE, a fallback that
 * returns the challenge anyway, or dropping the `kind` predicate would silently
 * remove the binding entirely, and no test would fail.
 */
async function takeChallenge(challenge: string | null, kind: 'register' | 'authenticate') {
  if (!challenge) return null;
  const [row] = await sql<{ challenge: string }[]>`
    delete from challenges
    where id = ${challenge} and kind = ${kind} and expires_at > now()
    returning challenge
  `;
  return row?.challenge ?? null;
}

/**
 * Every session records the passkey that opened it, so forgetting that passkey
 * can end the sessions it opened — see migrations/009_session_credential.sql.
 */
async function issueSession(reply: FastifyReply, credentialId: string) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = env.sessionDays * 24 * 60 * 60;
  await sql`
    insert into sessions (token, expires_at, credential_id)
    values (${hash(token)}, now() + ${`${env.sessionDays} days`}::interval, ${credentialId})
  `;
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge,
  });
}

/** The stored form of the caller's session token, or '' when there is none. */
const callerSession = (req: FastifyRequest) => {
  const token = req.cookies[COOKIE];
  return token ? hash(token) : '';
};

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
      {
        id: string;
        label: string | null;
        rp_id: string;
        created_at: Date;
        last_used_at: Date | null;
        sessions: number;
      }[]
    >`
      select c.id, c.label, c.rp_id, c.created_at, c.last_used_at,
             count(s.token)::int as sessions
      from credentials c
      left join sessions s on s.credential_id = c.id and s.expires_at > now()
      group by c.id
      order by c.created_at
    `;
    // The id is truncated: it identifies a device well enough to tell them
    // apart without handing the whole credential ID to anything that asks.
    return rows.map((r) => ({
      id: r.id.slice(0, 12),
      label: r.label,
      rp_id: r.rp_id,
      usable: r.rp_id === env.rpId,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      sessions: r.sessions,
    }));
  });

  // Removing the last credential is deliberately allowed: it re-arms the enroll
  // code, which applies while no credential exists FOR THIS RP ID. That is the
  // escape hatch when every passkey has become unusable — and since a domain move
  // now leaves zero usable credentials on its own, the hatch opens there without
  // anyone having to delete anything first.
  //
  // Forgetting a passkey also signs out everything it opened. That is the point
  // of forgetting a lost phone's passkey, and until migration 009 it did not
  // happen: the phone's cookie outlived its credential by up to SESSION_DAYS.
  // A synced passkey (iCloud Keychain, Google Password Manager) is ONE credential
  // across several devices, so forgetting it signs all of them out — including,
  // possibly, the caller. `signedOut` tells the client which.
  app.delete<{ Params: { id: string } }>(
    '/api/auth/credentials/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const mine = callerSession(req);
      const result = await sql.begin(async (tx) => {
        const doomed = tx`select id from credentials where left(id, 12) = ${req.params.id}`;
        // Sessions go first and explicitly, so the count is real; the foreign
        // key's ON DELETE CASCADE is the backstop, not the mechanism.
        //
        // NULL credential_id means the session predates 009 and nobody knows
        // which passkey opened it — it may well be the lost phone's. Those end
        // too, except the caller's own: whoever is holding it is not the device
        // being forgotten.
        // Expired rows go too, but only live ones count as "signed out".
        const ended = await tx<{ token: string; live: boolean }[]>`
          delete from sessions
          where credential_id in (${doomed})
             or (credential_id is null and token <> ${mine})
          returning token, expires_at > now() as live
        `;
        const gone = await tx<{ id: string }[]>`
          delete from credentials where id in (${doomed}) returning id
        `;
        if (!gone.length) {
          // Nothing matched, so nothing should have been signed out either —
          // not even the legacy sessions. Roll the whole thing back.
          throw new UnknownCredential();
        }
        return { ended };
      }).catch((err) => {
        if (err instanceof UnknownCredential) return null;
        throw err;
      });
      if (!result) return reply.code(404).send({ error: 'unknown_credential' });

      const signedOut = result.ended.some((s) => s.token === mine);
      if (signedOut) reply.clearCookie(COOKIE, { path: '/' });
      return {
        ok: true,
        remaining: await credentialCount(),
        sessionsEnded: result.ended.filter((s) => s.live).length,
        signedOut,
      };
    },
  );

  /**
   * Sign out every device but this one, keeping every passkey.
   *
   * :forget is the wrong tool when the passkey is synced: the same credential
   * lives on the phone that went missing and on the laptop you are typing on,
   * and removing it would mean re-enrolling everything you still have.
   */
  app.post('/api/auth/sessions/end-others', { preHandler: requireAuth }, async (req) => {
    const ended = await sql<{ live: boolean }[]>`
      delete from sessions where token <> ${callerSession(req)}
      returning expires_at > now() as live
    `;
    return { ok: true, sessionsEnded: ended.filter((s) => s.live).length };
  });

  // --- registration -------------------------------------------------------

  /**
   * A budget for WRONG enroll codes, shared by everyone and keyed to a constant.
   *
   * Keying this to the caller's IP would be useless — X-Forwarded-For is
   * attacker-supplied, so the cap could be rotated past. But a shared bucket
   * consumed on every ATTEMPT would be worse than useless: a stranger could
   * spend it in ten requests an hour and the owner, arriving with the correct
   * code, would be turned away by a limiter that runs before the code is even
   * checked. That is the same shared-mutable-state lockout this file exists to
   * remove, rebuilt one layer up.
   *
   * So the budget is spent only on FAILURE, and only inside the handler. A
   * correct code never touches it. An authenticated second-device enrolment
   * never touches it. Someone guessing gets ten tries an hour, globally, and
   * cannot lock the owner out by exhausting a bucket the owner does not draw on.
   */
  const enrollFailures = app.createRateLimit({
    max: 10,
    timeWindow: '1 hour',
    keyGenerator: () => 'enroll-failures',
  });

  app.post<{ Body: { enrollCode?: string } }>(
    '/api/auth/register/start',
    { config: ceremonyLimit },
    async (req, reply) => {
    const bootstrapped = (await credentialCount()) > 0;
    const decision = await decideEnroll({
      bootstrapped,
      authenticated: bootstrapped ? await currentSession(req) : false,
      supplied: req.body?.enrollCode,
      expected: env.enrollCode,
      spendFailure: async () => {
        // req.ips is the whole X-Forwarded-For chain; req.ip alone is the
        // attacker-chosen head of it, so the one security log in this system
        // would otherwise record whatever they cared to put there.
        req.log.warn({ chain: req.ips, socket: req.socket.remoteAddress }, 'bad enroll code');
        // overBudget, not `!isAllowed` — see the note on BudgetResult.
        return overBudget(await enrollFailures(req));
      },
    });
    if (!decision.ok) {
      if (decision.retryAfter) reply.header('retry-after', String(decision.retryAfter));
      return reply.code(decision.code).send({ error: decision.error });
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

      await issueSession(reply, credential.id);
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

    const credentialId = req.body?.response?.id;
    if (typeof credentialId !== 'string' || !credentialId) {
      return reply.code(400).send({ error: 'unknown_credential' });
    }
    const [cred] = await sql<{ id: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      select id, public_key, counter, transports from credentials
      where id = ${credentialId} and rp_id = ${env.rpId}
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
    await issueSession(reply, cred.id);
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
