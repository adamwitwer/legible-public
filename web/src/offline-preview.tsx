// Boots the real App against seeded local data with no server, exercising the
// offline path. Only for driving the UI in a browser without Postgres.
import { createRoot } from 'react-dom/client';
import App from './App';
import { db } from './lib/db';
import type { Note } from './lib/types';
import './styles.css';

const mk = (id: string, title: string, day: string, body: string): Note => ({
  id, kind: 'scan', title, body, written_on: `2026-08-${day}`, written_on_precision: 'day',
  tags: [], ocr_status: null, confidence: null,
  created_at: `2026-08-${day}T10:00:00Z`, updated_at: `2026-08-${day}T10:00:00Z`,
  deleted_at: null, seq: day, dirty: 0,
});

await db.notes.clear();
await db.notes.bulkPut([
  mk('n1', 'Meeting Title', '01', 'lorem ipsum dolor sit amet, dolore provident'),
  mk('n2', 'The Second Coming', '02', 'turning and turning in the widening gyre'),
  mk('n3', 'Love makes your soul crawl out', '03', 'from its hiding place'),
  mk('n4', 'The vanishing spies', '04', 'just something I read'),
  mk('n5', 'Pangram', '05', 'the quick brown fox jumps over the lazy dog'),
  // a merged note: the second entry lost its date and was absorbed
  mk('n6', 'Meeting Title', '08',
     'Aug 8  Meeting Title\n\n- lorem ipsum\n- dolor sit amet\n\n' +
     'FB Insights!\n\n- that is just how some things do not materialize'),
]);

createRoot(document.getElementById('root')!).render(<App />);
