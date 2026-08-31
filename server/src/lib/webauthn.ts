import { timingSafeEqual } from 'node:crypto';

/**
 * The challenge the authenticator actually signed, read back out of the
 * ceremony response.
 *
 * WebAuthn challenges used to be stored under a fixed key — one row for
 * "register", one for "authenticate" — which meant any unauthenticated caller
 * could start a ceremony and overwrite the pending challenge of whoever was
 * mid-login. Their authenticator would sign a challenge the server had already
 * replaced, and the ceremony failed. Keying each challenge by its own value
 * removes the shared slot: concurrent ceremonies no longer collide, and a
 * stranger's abandoned challenge is just a row that expires.
 *
 * clientDataJSON is base64url of a JSON object whose `challenge` is the
 * base64url challenge the server issued.
 */
export function challengeFromClientData(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string' || !clientDataJSON) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const challenge = (parsed as { challenge?: unknown }).challenge;
  return typeof challenge === 'string' && challenge.length > 0 ? challenge : null;
}

/** Pull it straight off a ceremony response body, whatever shape survived JSON. */
export function challengeFromResponse(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const inner = (response as { response?: unknown }).response;
  if (typeof inner !== 'object' || inner === null) return null;
  return challengeFromClientData((inner as { clientDataJSON?: unknown }).clientDataJSON);
}

/**
 * Constant-time string compare. `!==` on the enroll code leaks its length and,
 * in principle, its prefix through response timing; the code is the one secret
 * that stands between a stranger and the whole archive, so it does not get
 * compared with an operator that returns early.
 */
export function safeEqual(a: unknown, b: string): boolean {
  // `a` arrives straight off a JSON body, so it is whatever the caller sent.
  // Buffer.from throws on a number or an object, and an unhandled throw here is
  // an unauthenticated 500 on the enrol path.
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a signal.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
