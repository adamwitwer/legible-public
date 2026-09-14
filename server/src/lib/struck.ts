/**
 * Crossed-out text, and dropping it.
 *
 * The OCR prompt still transcribes a retraction as ~~text~~, and that stays true
 * of pages.ocr_json: it is what lets a struck date never be read as a note's
 * header date, and the photograph and raw OCR remain a record of the change of
 * mind. But a note's body is the digital note, and Adam wants crossed-out words
 * gone from it (2026-09-14). So segmentation strips them, and so does commit, and
 * scripts/strip-struck.mjs applies the same function to notes imported before.
 * Typed notes are never stripped: they are exactly what was typed.
 */
export const STRUCK = /~~[\s\S]*?~~/g;

/** Marks where a span was, so only the lines it touched get tidied. */
const HOLE = String.fromCharCode(0);
const LIST_MARKER_ONLY = /^([-*+]|\d+[.)])$/;

/**
 * Remove every ~~span~~ and tidy only the lines a span touched: the gap it leaves
 * collapses to one space, and a line left with nothing — or only a list marker —
 * goes. Lines without a strike are untouched, so a header's deliberate double
 * space ("Aug 1  Meeting Title") survives. An unmatched ~~ is left alone.
 */
export function stripStruck(text: string): string {
  if (!text.includes('~~')) return text;
  const marked = text.replace(STRUCK, HOLE);
  if (!marked.includes(HOLE)) return text;

  const lines: string[] = [];
  for (const line of marked.split('\n')) {
    if (!line.includes(HOLE)) { lines.push(line); continue; }
    // Indentation is measured on the line as written, before the span comes out:
    // a line that opened with a strike ("~~goog~~ good") has no indent, only the
    // gap the strike left. \s does not match HOLE, so it stops at the first span.
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    const content = line.slice(indent.length).split(HOLE).join('').replace(/[ \t]{2,}/g, ' ').trim();
    if (!content || LIST_MARKER_ONLY.test(content)) continue;
    lines.push(indent + content);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
