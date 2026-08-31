#!/usr/bin/env node
/**
 * Copy the whole archive somewhere Adam controls.
 *
 * Render keeps managed Postgres backups and R2 keeps the page images, but
 * both live inside accounts that could lapse, and neither produces anything
 * readable without this app. So this writes three things:
 *
 *   notes/   one markdown file per note — the only artifact that outlives
 *            Legible itself. Readable in any editor, greppable, restorable
 *            by hand.
 *   data/    a gzipped JSON dump of every table worth keeping. The exact
 *            restore path, including the revision history markdown flattens.
 *   pages/   the R2 page images, synced by storage key.
 *
 * A backup that fails quietly is worse than none, because you will believe
 * you have one. Any error here writes LAST_RUN_FAILED into the backup folder
 * — visible in Finder, next to the data — and exits non-zero.
 *
 * Usage:
 *   node --env-file=.env scripts/backup.mjs [--out DIR] [--keep 14] [--no-images]
 *
 * Needs RENDER_DATABASE_URL (Render dashboard, external URL) and the four
 * R2_* values. Session cookies are deliberately not used: they expire after
 * 90 days, and this has to keep working unattended.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import postgres from 'postgres';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const OUT = resolve(flag('--out', process.env.BACKUP_DIR ?? join(homedir(), 'Dropbox', 'Documents', 'Legible')));
const KEEP = Number(flag('--keep', 14));
const IMAGES = !argv.includes('--no-images');
const FAILED = join(OUT, 'LAST_RUN_FAILED');

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (pass --env-file=.env, or export it)`);
  return v;
};

const stamp = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

/** Filesystem-safe, human-recognisable, and stable across runs. */
function slug(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function frontmatter(note, pages) {
  const lines = [
    '---',
    `id: ${note.id}`,
    `title: ${JSON.stringify(note.title ?? '')}`,
    `date: ${note.written_on ?? ''}`,
  ];
  // Precision is what tells you a date was guessed rather than read off the
  // page, so it has to survive the export.
  if (note.written_on_precision) lines.push(`date_precision: ${note.written_on_precision}`);
  lines.push(`kind: ${note.kind}`);
  if (note.tags?.length) lines.push(`tags: [${note.tags.join(', ')}]`);
  // relative to notes/, so the reference resolves on disk from the file itself
  if (pages.length) lines.push(`pages:\n${pages.map((p) => `  - ../${p}`).join('\n')}`);
  lines.push(`created: ${note.created_at.toISOString()}`, `updated: ${note.updated_at.toISOString()}`, '---', '');
  return lines.join('\n');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const sql = postgres(need('RENDER_DATABASE_URL'), { ssl: 'require' });

  // ---------------------------------------------------------------- read
  // written_on is cast to text: as a Date it would be shifted by whatever
  // timezone the machine running the backup happens to be in.
  const notes = await sql`
    select id, kind, title, body, body_ocr_raw, written_on::text as written_on,
           written_on_precision, tags, ocr_status, ocr_model, ocr_run_at, confidence,
           created_at, updated_at, deleted_at, seq
    from notes order by seq`;
  const revisions = await sql`select * from note_revisions order by saved_at`;
  const pages = await sql`select * from pages order by batch_id, idx`;
  const notePages = await sql`select * from note_pages order by note_id, idx`;
  const annotations = await sql`select * from annotations order by note_id`;
  const batches = await sql`select * from batches order by created_at`;
  await sql.end();
  log(`read  ${notes.length} notes · ${revisions.length} revisions · ${pages.length} pages`);

  // ------------------------------------------------------------ json dump
  const dataDir = join(OUT, 'data');
  await mkdir(dataDir, { recursive: true });
  const dumpPath = join(dataDir, `legible-${stamp}.json.gz`);
  const payload = JSON.stringify(
    { exported_at: new Date().toISOString(), notes, note_revisions: revisions, pages, note_pages: notePages, annotations, batches },
    null,
    2,
  );
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(dumpPath));
  gzip.end(payload);
  await written;
  log(`wrote ${dumpPath.replace(OUT, '.')} (${((await stat(dumpPath)).size / 1024).toFixed(0)} KB)`);

  // Keep a window of dumps rather than one: Dropbox versioning is a
  // convenience, not a guarantee, and a bad export could otherwise be the
  // only copy by the time anyone notices.
  const dumps = (await readdir(dataDir)).filter((f) => /^legible-\d{4}-\d\d-\d\d\.json\.gz$/.test(f)).sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - KEEP))) {
    await unlink(join(dataDir, old));
    log(`pruned ${old}`);
  }

  // ------------------------------------------------------------- markdown
  const notesDir = join(OUT, 'notes');
  await mkdir(notesDir, { recursive: true });
  const pageKey = new Map(pages.map((p) => [p.id, p.storage_key]));
  const byNote = new Map();
  for (const np of notePages) {
    if (!byNote.has(np.note_id)) byNote.set(np.note_id, []);
    byNote.get(np.note_id).push(pageKey.get(np.page_id));
  }

  const used = new Set();
  let count = 0;
  for (const note of notes) {
    if (note.deleted_at) continue; // still in the JSON dump, just not as a file
    const base = [note.written_on ?? 'undated', slug(note.title) || slug(note.body) || 'untitled'].join('-');
    let name = `${base}.md`;
    if (used.has(name)) name = `${base}-${note.id.slice(0, 6)}.md`;
    used.add(name);
    const refs = (byNote.get(note.id) ?? []).filter(Boolean);
    await writeFile(join(notesDir, name), frontmatter(note, refs) + (note.body ?? '') + '\n');
    count++;
  }
  // Drop files for notes that were deleted or renamed, so the folder is a
  // mirror of the archive rather than an accumulation of every title ever.
  for (const f of await readdir(notesDir)) {
    if (f.endsWith('.md') && !used.has(f)) { await unlink(join(notesDir, f)); log(`removed stale ${f}`); }
  }
  log(`wrote ${count} markdown notes`);

  // --------------------------------------------------------------- images
  if (!IMAGES) { log('skipped images (--no-images)'); return; }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${need('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY') },
  });
  const bucket = need('R2_BUCKET');
  // storage keys already start with `pages/`, so they anchor at OUT itself
  const blobRoot = OUT;

  let token, fetched = 0, skipped = 0, seen = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      seen++;
      const dest = join(blobRoot, obj.Key);
      // Size is enough: these blobs are written once and never edited.
      const local = await stat(dest).catch(() => null);
      if (local && local.size === obj.Size) { skipped++; continue; }
      await mkdir(dirname(dest), { recursive: true });
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
      await pipeline(got.Body, createWriteStream(dest));
      fetched++;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  log(`images: ${seen} in bucket · ${fetched} downloaded · ${skipped} already present`);
}

try {
  await main();
  await rm(FAILED, { force: true });
  log(`\nbackup complete → ${OUT}`);
} catch (err) {
  await mkdir(OUT, { recursive: true }).catch(() => {});
  await writeFile(FAILED, `${new Date().toISOString()}\n\n${err?.stack ?? err}\n`).catch(() => {});
  console.error(`\nBACKUP FAILED: ${err?.message ?? err}`);
  console.error(`wrote ${FAILED}`);
  process.exit(1);
}
