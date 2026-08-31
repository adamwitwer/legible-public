import { safeEqual } from './webauthn.js';

/**
 * What @fastify/rate-limit's `createRateLimit()` hands back, reduced to the one
 * bit that matters — and it is NOT the field it looks like.
 *
 * `isAllowed: true` is returned ONLY when the request matched the allowList
 * (index.js:262-273). Every other call — comfortably under the limit or far
 * over it — falls through to a single `isAllowed: false` return
 * (index.js:306-316) where `isExceeded: current > max` is the real signal.
 * Reading `!isAllowed` therefore treats every request as over the limit, and
 * the type union declares both branches so the compiler is content.
 *
 * This is translated here, against literal fixtures of the library's two real
 * shapes, because the last version of this file mocked the library with
 * semantics the library does not have and the tests agreed with the bug.
 */
export type BudgetResult =
  | { isAllowed: true }
  | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number };

export function overBudget(r: BudgetResult): { overLimit: boolean; retryAfter: number } {
  if (r.isAllowed) return { overLimit: false, retryAfter: 0 };
  return { overLimit: r.isExceeded, retryAfter: r.ttlInSeconds };
}

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
  /**
   * Charges one failure against the shared budget and reports whether that
   * budget is now spent. Called only on a wrong code — see the note below on
   * why this is back-pressure rather than a cap.
   */
  spendFailure: () => Promise<{ overLimit: boolean; retryAfter: number }>;
}): Promise<EnrollDecision> {
  // Adding a device to an archive that already has one needs a session, not the
  // code. The code is only ever the bootstrap path.
  if (opts.bootstrapped) {
    return opts.authenticated ? { ok: true } : { ok: false, code: 401, error: 'not_authenticated' };
  }

  if (safeEqual(opts.supplied, opts.expected)) return { ok: true };

  // NOTE ON ORDERING, because it is not what it first appears to be.
  //
  // The guess is evaluated ABOVE this line, so the budget does not cap guessing
  // — it reports on it. That is deliberate, and it is the resolution of a real
  // tension: a budget consulted BEFORE the comparison would cap brute force,
  // but any bucket a stranger can drain is a bucket the owner can be locked out
  // of, and this endpoint is the documented way back into the archive after a
  // domain move. A per-IP key does not escape that either — under trustProxy
  // the key is caller-written, and a key derived from the proxy chain can
  // collapse to a shared upstream address that the owner sits behind too.
  //
  // So brute force is not held off by this budget. It is held off by the code
  // itself: env.ts refuses to start in production unless ENROLL_CODE carries
  // enough entropy that guessing it is infeasible at any request rate. This
  // budget exists to make a burst of wrong codes visible in the log and to
  // apply back-pressure, and it can be emptied by a stranger without costing
  // the owner anything, because the owner's correct code never consults it.
  const budget = await opts.spendFailure();
  if (budget.overLimit) {
    return { ok: false, code: 429, error: 'too_many_enroll_attempts', retryAfter: budget.retryAfter };
  }
  return { ok: false, code: 403, error: 'bad_enroll_code' };
}
