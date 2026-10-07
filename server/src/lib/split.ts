/**
 * The parts of splitting a note that can be wrong on their own: where the text
 * divides, and which page the second half opens on.
 */

import { stripStruck } from './struck.js';
import { hasTodoMarker, TODO_TAG } from './todo.js';

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

/**
 * Which of the original note's tags one half keeps.
 *
 * Tags are a pure function of the body, so a half keeps a tag only if its own
 * text still carries it. Copying them whole put a TODO from one half on both,
 * and the half without the word had no text to delete to clear it.
 *
 * Filters the original's tags rather than deriving afresh: a half is a piece of
 * the whole, so it can lose a tag but never gain one. The #tag pattern MIRRORS
 * TAG_RE in web/src/lib/notes.ts, struck text included; split.test.ts repeats
 * deriveTags' cases from search.test.ts to hold them together.
 */
export function keptTags(tags: readonly string[], text: string): string[] {
  const live = stripStruck(text);
  const hashtags = new Set(
    [...live.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1]!.toLowerCase()),
  );
  return tags.filter((t) => (t === TODO_TAG ? hasTodoMarker(text) : hashtags.has(t)));
}

type PageLike = { ocr_json?: { blocks?: { transcript?: string }[] } | null };

/**
 * Index of the page the tail begins on, or -1 when it cannot be located.
 *
 * The stored body and the per-block transcripts are the same words with
 * different whitespace — the body is blocks joined together — so both sides are
 * flattened before comparing. The raw transcripts still carry ~~struck~~ text
 * that bodies no longer do, so that is stripped too, or no tail would match.
 */
export function findBoundaryPage(pages: readonly PageLike[], tail: string): number {
  const flatten = (t: string) => stripStruck(t).replace(/\s+/g, ' ').trim().toLowerCase();
  const probe = flatten(tail.slice(0, 60));
  if (!probe) return -1;
  return pages.findIndex((p) =>
    (p.ocr_json?.blocks ?? []).some((b) => flatten(b?.transcript ?? '').includes(probe)),
  );
}
