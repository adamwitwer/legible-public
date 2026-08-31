import { localDate } from './dates';
import { db } from './db';
import { upsertInIndex } from './search';
import type { Note } from './types';

const uuid = () =>
  (crypto.randomUUID?.() ??
    ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (c / 4)))).toString(16),
    )) as string;

/** Notes are created locally with a client UUID, so this works offline. */
export async function createNote(partial: Partial<Note> = {}): Promise<Note> {
  const now = new Date().toISOString();
  const body = partial.body ?? '';
  const note: Note = {
    id: uuid(),
    kind: 'typed',
    // Derive the same way an edit does, so `:new some text` isn't born untitled
    // and untagged. An explicit title/tags in `partial` still wins below.
    title: deriveTitle(body),
    body: '',
    written_on: localDate(),
    written_on_precision: 'day',
    tags: deriveTags(body),
    ocr_status: null,
    confidence: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    seq: '0',
    dirty: 1,
    ...partial,
  };
  await db.notes.put(note);
  upsertInIndex(note);
  return note;
}

/** First non-empty line becomes the title; the rest is the body. */
export function deriveTitle(body: string): string | null {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  if (!line) return null;
  return line.replace(/^#+\s*/, '').trim().slice(0, 120) || null;
}

const TAG_RE = /(?:^|\s)#([a-z0-9][a-z0-9_-]*)/gi;
export function deriveTags(body: string): string[] {
  return [...new Set([...body.matchAll(TAG_RE)].map((m) => m[1]!.toLowerCase()))];
}

/** What an edit may change. Anything omitted is left alone. */
export type NotePatch = {
  body?: string;
  title?: string | null;
  written_on?: string | null;
  written_on_precision?: string | null;
};

export async function saveNote(id: string, patch: NotePatch): Promise<Note | undefined> {
  const existing = await db.notes.get(id);
  if (!existing) return;

  const next: Note = { ...existing };
  let changed = false;

  if (patch.body !== undefined && patch.body !== existing.body) {
    next.body = patch.body;
    next.tags = deriveTags(patch.body);
    // A typed note's title IS its first line — that is the whole editing model,
    // and re-deriving keeps them in step. A scan's title came from the header on
    // the page and is independent of the transcript, so deriving it here would
    // silently replace "Meeting Title" with the first line of the OCR the moment the
    // body was touched.
    // A typed note's title tracks its first line only while it still *is* that
    // line: once you set one by hand, editing the body leaves it alone. Scans
    // never track — 17 of the imported ones happen to have a title identical to
    // their first body line, and those came off the page header, not the text.
    if (existing.kind === 'typed' && existing.title === deriveTitle(existing.body)) {
      next.title = deriveTitle(patch.body);
    }
    changed = true;
  }

  if (patch.title !== undefined && patch.title !== existing.title) {
    next.title = patch.title?.trim() ? patch.title.trim() : null;
    changed = true;
  }

  if (patch.written_on !== undefined && patch.written_on !== existing.written_on) {
    next.written_on = patch.written_on || null;
    // Setting a date by hand asserts it. Clearing one asserts nothing.
    next.written_on_precision = next.written_on
      ? (patch.written_on_precision ?? 'day')
      : null;
    changed = true;
  }

  if (!changed) return existing;

  next.updated_at = new Date().toISOString();
  next.dirty = 1;
  await db.notes.put(next);
  upsertInIndex(next);
  return next;
}

/** Tombstone, not a delete — sync has to be able to see it. */
export async function deleteNote(id: string) {
  const existing = await db.notes.get(id);
  if (!existing) return;
  const now = new Date().toISOString();
  const updated: Note = { ...existing, deleted_at: now, updated_at: now, dirty: 1 };
  await db.notes.put(updated);
  upsertInIndex(updated);
}
