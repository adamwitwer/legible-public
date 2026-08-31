import { api } from './api';
import { db, getMeta, setMeta } from './db';
import type { Note } from './types';

const CURSOR = 'sync_cursor';

/** Push local edits, then pull everything newer than our cursor. */
export async function sync(): Promise<{ pushed: number; pulled: number }> {
  let pushed = 0;
  let pulled = 0;

  const dirty = await db.notes.where('dirty').equals(1).toArray();
  if (dirty.length) {
    for (let i = 0; i < dirty.length; i += 200) {
      const batch = dirty.slice(i, i + 200);
      const { saved } = await api.push(batch.map(({ dirty: _d, seq: _s, ...n }) => n));
      await db.transaction('rw', db.notes, async () => {
        for (const row of saved as { id: string; seq: string }[]) {
          const local = await db.notes.get(row.id);
          // Leave it dirty if it changed again while the request was in flight.
          if (local && local.updated_at <= (batch.find((b) => b.id === row.id)?.updated_at ?? '')) {
            await db.notes.update(row.id, { dirty: 0, seq: row.seq });
          }
        }
      });
      pushed += batch.length;
    }
  }

  for (;;) {
    const since = await getMeta(CURSOR, '0');
    const { notes, cursor, more } = (await api.pull(since)) as {
      notes: Note[];
      cursor: string;
      more: boolean;
    };
    if (notes.length) {
      await db.transaction('rw', db.notes, async () => {
        for (const incoming of notes) {
          const local = await db.notes.get(incoming.id);
          // Don't let a pull clobber an edit we haven't pushed yet.
          if (local?.dirty === 1 && local.updated_at > incoming.updated_at) continue;
          await db.notes.put({ ...incoming, dirty: 0 });
        }
      });
      pulled += notes.length;
    }
    await setMeta(CURSOR, cursor);
    if (!more) break;
  }

  await setMeta('last_sync', new Date().toISOString());
  return { pushed, pulled };
}

export async function lastSync(): Promise<Date | null> {
  const v = await getMeta('last_sync');
  return v ? new Date(v) : null;
}

/** Wipes the local replica so the next sync refetches from scratch. */
export async function resetLocal() {
  await db.notes.clear();
  await setMeta(CURSOR, '0');
}
