/**
 * Query grammar. Bare words match text; prefixed tokens filter; they compose.
 *
 *   kubernetes retro
 *   tag:meeting after:2026-01 budget
 *   before:2025-06-15 is:scan
 *   "exact phrase" tag:ideas
 */
export type ParsedQuery = {
  text: string;
  phrases: string[];
  tags: string[];
  kind: 'typed' | 'scan' | null;
  after: string | null;
  before: string | null;
};

/** Pads a partial date so `after:2026-01` means "from the start of January". */
function normalizeDate(raw: string, edge: 'start' | 'end'): string | null {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (d) return `${y}-${mo}-${d}`;
  if (mo) return edge === 'start' ? `${y}-${mo}-01` : `${y}-${mo}-31`;
  return edge === 'start' ? `${y}-01-01` : `${y}-12-31`;
}

export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    phrases: [],
    tags: [],
    kind: null,
    after: null,
    before: null,
  };

  let rest = input;

  // Quoted phrases first, so their contents aren't parsed as filters.
  rest = rest.replace(/"([^"]+)"/g, (_, phrase: string) => {
    out.phrases.push(phrase.trim().toLowerCase());
    return ' ';
  });

  const words: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const colon = token.indexOf(':');
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1);
      if (!value) continue;
      if (key === 'tag') { out.tags.push(value.toLowerCase()); continue; }
      if (key === 'is' && (value === 'scan' || value === 'typed')) { out.kind = value; continue; }
      if (key === 'after')  { out.after  = normalizeDate(value, 'start'); continue; }
      if (key === 'before') { out.before = normalizeDate(value, 'end');   continue; }
    }
    words.push(token);
  }

  out.text = words.join(' ');
  return out;
}

export function isEmptyQuery(q: ParsedQuery) {
  return !q.text && !q.phrases.length && !q.tags.length && !q.kind && !q.after && !q.before;
}
