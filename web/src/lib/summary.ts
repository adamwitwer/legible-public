/**
 * SHA-256 of a note body, hex — MIRRORED from server/src/lib/summarize.ts.
 *
 * The server stamps the hash of the body it summarized; this hashes the body on
 * screen, and a mismatch is what "stale" means. Both sides hash the exact string
 * as UTF-8. The shared test vector in summary.test.ts holds the two together.
 *
 * Resolves null where SubtleCrypto does not exist, which is any page served over
 * plain http from something other than localhost. Unknown then reads as "not
 * stale" rather than flagging every summary.
 */
export async function bodyHash(body: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
