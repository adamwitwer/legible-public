#!/usr/bin/env node
/**
 * Drop crossed-out text from scanned notes imported before the rule existed.
 *
 *   npm run strip-struck              dry run: counts only, writes nothing
 *   npm run strip-struck -- --apply   writes
 *
 * New imports drop ~~struck~~ spans at segmentation. This brings the earlier scans
 * in line using the very same function (server/src/lib/struck.ts), so the cleanup
 * and the import rule cannot disagree about what "crossed out" means.
 *
 * Prints note ids and character counts, never titles or text: it runs against the
 * real archive, and its output lands in terminals and transcripts.
 *
 * Each changed note gets a note_revisions row holding the body as it was, so the
 * original comes back from history in the editor. updated_at is NOT touched: sync
 * is last-write-wins on it, and bumping it would make an edit still queued on a
 * phone lose to this script and land in history instead of the note. The seq
 * trigger still carries the new body to every device.
 *
 * Only scans. Typed notes are what was typed, strikes and all.
 */
import postgres from 'postgres';
import { stripStruck } from '../server/src/lib/struck.ts';

const apply = process.argv.includes('--apply');
const url = process.env.RENDER_DATABASE_URL;
if (!url) {
  console.error('RENDER_DATABASE_URL is not set: run via `npm run strip-struck`, which loads .env');
  process.exit(1);
}

const sql = postgres(url, { ssl: 'require' });
try {
  const rows = await sql`
    select id, title, body from notes
    where kind = 'scan' and deleted_at is null and position('~~' in body) > 0
  `;
  const changes = rows
    .map((r) => ({ id: r.id, title: r.title, body: r.body, next: stripStruck(r.body) }))
    .filter((c) => c.next !== c.body);

  console.log(`${rows.length} scanned note(s) contain "~~"; ${changes.length} would change.`);
  for (const c of changes) console.log(`  ${c.id}  -${c.body.length - c.next.length} chars`);

  if (!apply) {
    console.log('\nDry run: nothing written. Re-run with --apply.');
  } else if (changes.length) {
    const updated = await sql.begin(async (tx) => {
      let n = 0;
      for (const c of changes) {
        await tx`insert into note_revisions (note_id, title, body) values (${c.id}, ${c.title}, ${c.body})`;
        // Guarded on the body read above: if a sync changed the note meanwhile,
        // the count comes up short and the whole transaction rolls back.
        const res = await tx`update notes set body = ${c.next} where id = ${c.id} and body = ${c.body}`;
        n += res.count;
      }
      if (n !== changes.length) {
        throw new Error(`expected ${changes.length} updates, got ${n}: a note changed underneath, nothing written`);
      }
      return n;
    });
    console.log(`\nApplied to ${updated} note(s). Originals are in each note's history.`);
  }
} finally {
  await sql.end();
}
