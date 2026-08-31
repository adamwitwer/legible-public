import { safeEqual } from './webauthn.js';

/** What the caller is allowed to do next, and what to answer if not. */
export type EnrollDecision =
  | { ok: true }
  | { ok: false; code: 401 | 403 | 429; error: string; retryAfter?: number };

/**
 * Who may start a passkey registration.
 *
 * Extracted from the route because the ordering here is the security property,
 * and inside the route it is untestable without a database — which is how the
 * first version of this shipped with the budget charged in the wrong place.
 *
 * The rule: the failure budget is spent ONLY on a wrong code. A correct code
 * does not touch it, and neither does an already-authenticated device adding a
 * second passkey. That is what stops the budget becoming a lockout — a limiter
 * that ran before the code was checked would let a stranger spend it and turn
 * the owner away at the door, which is the same shared-state failure the
 * per-ceremony challenge work exists to remove.
 */
export async function decideEnroll(opts: {
  /** Does a usable credential already exist for this RP ID? */
  bootstrapped: boolean;
  /** Is this request carrying a live session? */
  authenticated: boolean;
  /** Straight off the JSON body, so: anything at all. */
  supplied: unknown;
  expected: string;
  /** Charges one failure against the shared budget. Called only on a wrong code. */
  spendFailure: () => Promise<{ isAllowed: boolean; ttlInSeconds: number }>;
}): Promise<EnrollDecision> {
  // Adding a device to an archive that already has one needs a session, not the
  // code. The code is only ever the bootstrap path.
  if (opts.bootstrapped) {
    return opts.authenticated ? { ok: true } : { ok: false, code: 401, error: 'not_authenticated' };
  }

  if (safeEqual(opts.supplied, opts.expected)) return { ok: true };

  const budget = await opts.spendFailure();
  if (!budget.isAllowed) {
    return {
      ok: false,
      code: 429,
      error: 'too_many_enroll_attempts',
      retryAfter: budget.ttlInSeconds,
    };
  }
  return { ok: false, code: 403, error: 'bad_enroll_code' };
}
