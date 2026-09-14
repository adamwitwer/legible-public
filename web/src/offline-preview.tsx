// Boots the real App against seeded local data with no server, exercising the
// offline path. Only for driving the UI in a browser without Postgres.
import { createRoot } from 'react-dom/client';
import App from './App';
import { db } from './lib/db';
import { deriveTags } from './lib/notes';
import { bodyHash } from './lib/summary';
import type { Note } from './lib/types';
import './styles.css';

const mk = (id: string, title: string, day: string, body: string): Note => ({
  id, kind: 'scan', title, body, written_on: `2026-08-${day}`, written_on_precision: 'day',
  // Derived rather than hardcoded, so the harness exercises the real rule —
  // including which TODOs count and which are struck out.
  tags: deriveTags(body), ocr_status: null, confidence: null,
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
  mk('n7', 'Invoice chase', '06', 'TODO ring the supplier back about the March invoice'),
  mk('n8', 'Already handled', '07', '~~TODO~~ chased it, they are sending a credit note'),
  // a merged note: the second entry lost its date and was absorbed
  mk('n6', 'Meeting Title', '08',
     'Aug 8  Meeting Title\n\n- lorem ipsum\n- dolor sit amet\n\n' +
     'FB Insights!\n\n- that is just how some things do not materialize'),
]);

// One summary that matches its note and one written for an earlier body, so
// both states of the panel can be looked at without a server.
const fresh = await db.notes.get('n1');
if (fresh) {
  await db.notes.put({
    ...fresh,
    summary: 'A short entry under a meeting heading, holding two placeholder lines of lorem ipsum and nothing else.\n\nNo decisions, names or follow-ups are recorded.',
    summary_body_hash: await bodyHash(fresh.body),
    summary_model: 'claude-opus-5',
    summarized_at: '2026-09-14T10:00:00Z',
  });
}
const old = await db.notes.get('n7');
if (old) {
  await db.notes.put({
    ...old,
    summary: 'A reminder to call the supplier about an invoice from February.',
    summary_body_hash: await bodyHash('TODO ring the supplier back about the February invoice'),
    summary_model: 'claude-opus-5',
    summarized_at: '2026-09-01T10:00:00Z',
  });
}

createRoot(document.getElementById('root')!).render(<App />);
