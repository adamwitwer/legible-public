import MiniSearch from 'minisearch';
import { displayDate } from './dates';
import type { Note } from './types';
import { isEmptyQuery, parseQuery, type ParsedQuery } from './query';

export type Hit = {
  note: Note;
  score: number;
  /** Body excerpt around the first match, for the result line. */
  snippet: string;
  terms: string[];
};

let index: MiniSearch<Note> | null = null;
let corpus = new Map<string, Note>();

const options = {
  fields: ['title', 'body', 'tagText'],
  storeFields: ['id'],
  idField: 'id',
} as const;

/** MiniSearch wants tags as text, not an array. */
const forIndex = (n: Note) => ({ ...n, title: n.title ?? '', tagText: n.tags.join(' ') });

export function buildIndex(notes: Note[]) {
  corpus = new Map(notes.map((n) => [n.id, n]));
  index = new MiniSearch<Note>(options as any);
  index.addAll(notes.map(forIndex) as any);
}

/** Incremental upkeep so an edit doesn't cost a full rebuild. */
export function upsertInIndex(note: Note) {
  if (!index) return;
  if (corpus.has(note.id)) index.discard(note.id);
  if (note.deleted_at) {
    corpus.delete(note.id);
    return;
  }
  corpus.set(note.id, note);
  index.add(forIndex(note) as any);
}

function matchesFilters(n: Note, q: ParsedQuery): boolean {
  if (q.kind && n.kind !== q.kind) return false;
  if (q.tags.length) {
    const tags = n.tags.map((t) => t.toLowerCase());
    if (!q.tags.every((t) => tags.includes(t))) return false;
  }
  // Date filters run against the date on the page, falling back to creation.
  const on = displayDate(n);
  if (q.after && on < q.after) return false;
  if (q.before && on > q.before) return false;
  if (q.phrases.length) {
    const hay = `${n.title ?? ''}\n${n.body}`.toLowerCase();
    if (!q.phrases.every((p) => hay.includes(p))) return false;
  }
  return true;
}

function makeSnippet(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!terms.length) return flat.slice(0, 140);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, 140);
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 140);
}

const byRecency = (a: Note, b: Note) => {
  const ad = displayDate(a);
  const bd = displayDate(b);
  return bd.localeCompare(ad) || b.updated_at.localeCompare(a.updated_at);
};

export function search(raw: string, limit = 60): { hits: Hit[]; parsed: ParsedQuery } {
  const parsed = parseQuery(raw);
  const all = [...corpus.values()];

  // No text to rank on: this is a browse, so show newest first.
  if (!parsed.text) {
    const hits = all
      .filter((n) => matchesFilters(n, parsed))
      .sort(byRecency)
      .slice(0, limit)
      .map((note) => ({ note, score: 0, snippet: makeSnippet(note.body, parsed.phrases), terms: parsed.phrases }));
    return { hits, parsed };
  }

  if (!index) return { hits: [], parsed };

  // Fuzzy matters more than usual here: OCR of handwriting produces near-misses,
  // and exact-token search would silently lose those notes.
  const results = index.search(parsed.text, {
    prefix: true,
    fuzzy: 0.2,
    boost: { title: 3, tagText: 2 },
    combineWith: 'AND',
  });

  const hits: Hit[] = [];
  for (const r of results) {
    const note = corpus.get(r.id as string);
    if (!note || !matchesFilters(note, parsed)) continue;
    hits.push({
      note,
      score: r.score,
      snippet: makeSnippet(note.body, [...r.terms, ...parsed.phrases]),
      terms: [...r.terms, ...parsed.phrases],
    });
    if (hits.length >= limit) break;
  }
  return { hits, parsed };
}

export const indexSize = () => corpus.size;
export { isEmptyQuery };
