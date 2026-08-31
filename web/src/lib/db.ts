import Dexie, { type Table } from 'dexie';
import type { Note } from './types';

class LegibleDB extends Dexie {
  notes!: Table<Note, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super('legible');
    this.version(1).stores({
      notes: 'id, updated_at, written_on, seq, dirty, deleted_at',
      meta: 'key',
    });
  }
}

export const db = new LegibleDB();

export async function getMeta(key: string, fallback = '') {
  return (await db.meta.get(key))?.value ?? fallback;
}
export async function setMeta(key: string, value: string) {
  await db.meta.put({ key, value });
}

/** Everything the index and the list care about — tombstones excluded. */
export async function allLiveNotes(): Promise<Note[]> {
  const rows = await db.notes.toArray();
  return rows.filter((n) => !n.deleted_at);
}
