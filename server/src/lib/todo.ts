/**
 * What counts as a TODO marker, and how one is written into a note body.
 *
 * MIRRORED in web/src/lib/notes.ts (`deriveTags`). The client re-derives tags on
 * every save; the server derives them once at import. If the two disagree, a
 * scan's indicator would flip the first time the note was edited — which looks
 * like the feature randomly forgetting. There is no module shared across the two
 * workspaces, so the mirror is held by matching cases in todo.test.ts and
 * web/src/lib/search.test.ts: change one regex and the other suite fails.
 */

/** The single tag everything reads from: the row indicator, `tag:todo`, `is:todo`. */
export const TODO_TAG = 'todo';

/** What gets written into a scan's body when the TODO was in the margin. */
export const TODO_MARKER = '#todo';

/**
 * Struck text is retracted, not absent — it stays in the body so the change of
 * mind survives, but it must not drive tags. A crossed-out TODO is a task
 * abandoned, which is the opposite of an open one.
 */
const STRUCK = /~~[\s\S]*?~~/g;

/**
 * Uppercase, and a whole word. This is deliberate: "TODO" is a mark someone
 * made on purpose, whereas a case-insensitive match would turn every sentence
 * containing "todo" into a task. `#todo` is the same claim in tag form.
 */
const BARE = /\bTODO\b/;
const TAGGED = /(?:^|\s)#todo\b/i;

export function hasTodoMarker(text: string): boolean {
  const live = text.replace(STRUCK, ' ');
  return BARE.test(live) || TAGGED.test(live);
}

/**
 * Append the marker as its own trailing line.
 *
 * Deliberately NOT inline at the annotation's anchor: marginalia flattened into
 * the body reading order corrupts meaning (Phase 0 finding 3 — a qualifier lands
 * on the wrong claim). A discrete line at the end is an app-level marker that
 * reads as one, and the untouched transcript is kept alongside it in
 * notes.body_ocr_raw, which nothing ever overwrites.
 */
export function appendTodoMarker(body: string): string {
  const trimmed = body.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${TODO_MARKER}\n` : `${TODO_MARKER}\n`;
}
