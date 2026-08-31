/**
 * The parts of splitting a note that can be wrong on their own: where the text
 * divides, and which page the second half opens on.
 */

export type SplitText = { head: string; tail: string };

/** Returns null when the point leaves one side empty — nothing to split. */
export function splitBody(body: string, at: number): SplitText | null {
  if (!Number.isInteger(at) || at < 0 || at > body.length) return null;
  // Both sides are trimmed at both ends: each becomes a note body, and neither
  // should inherit the blank lines that happened to sit around the cut.
  const head = body.slice(0, at).trim();
  const tail = body.slice(at).trim();
  if (!head || !tail) return null;
  return { head, tail };
}

/** First non-empty line, minus any markdown heading marker. */
export function titleOf(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 120) || null;
}

type PageLike = { ocr_json?: { blocks?: { transcript?: string }[] } | null };

/**
 * Index of the page the tail begins on, or -1 when it cannot be located.
 *
 * The stored body and the per-block transcripts are the same words with
 * different whitespace — the body is blocks joined together — so both sides are
 * flattened before comparing.
 */
export function findBoundaryPage(pages: readonly PageLike[], tail: string): number {
  const flatten = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const probe = flatten(tail.slice(0, 60));
  if (!probe) return -1;
  return pages.findIndex((p) =>
    (p.ocr_json?.blocks ?? []).some((b) => flatten(b?.transcript ?? '').includes(probe)),
  );
}
