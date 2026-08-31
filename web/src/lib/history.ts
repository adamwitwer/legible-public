/**
 * Shell-style prompt history.
 *
 * `index` is null when the prompt is not browsing history. Stepping back from
 * null starts at the newest entry; stepping forward past the newest leaves
 * history and restores an empty prompt, the way a shell does.
 */
export type HistoryStep = { index: number | null; query: string };

export function stepHistory(
  history: readonly string[],
  index: number | null,
  direction: 'back' | 'forward',
): HistoryStep | null {
  if (direction === 'back') {
    if (!history.length) return null;
    const next = index === null ? history.length - 1 : Math.max(0, index - 1);
    const entry = history[next];
    return entry === undefined ? null : { index: next, query: entry };
  }
  if (index === null) return null; // forward only means something while browsing
  const next = index + 1;
  const entry = history[next];
  if (next >= history.length || entry === undefined) return { index: null, query: '' };
  return { index: next, query: entry };
}

/** Newest last, no consecutive repeats, capped. */
export function pushHistory(history: readonly string[], raw: string, max: number): string[] {
  const entry = raw.trim();
  if (!entry) return history as string[];
  if (history[history.length - 1] === entry) return history as string[];
  return [...history, entry].slice(-max);
}
