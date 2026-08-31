#!/usr/bin/env node
/**
 * Phase 3 backfill: push a directory of notebook photos through the capture
 * pipeline, then print the proposed note boundaries for review.
 *
 * Usage:
 *   node scripts/backfill.mjs <dir> [--dated YYYY[-MM]] [--api URL] [--dry]
 *
 * --dated matters. These pages carry "Aug 11" with no year, so the year is
 * inferred from when the photo was taken. Photographing a 2023 notebook today
 * would date every note in it to this year. Pass the period the notebook is
 * actually from and that becomes the fallback instead.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`
backfill — import a notebook into Legible

  node scripts/backfill.mjs <dir> [options]

  --dated YYYY[-MM]   The period this notebook is from. Used to resolve years for
                      pages that write "Aug 11" with no year. Without this, the
                      year defaults to when you took the photo.
  --api URL           API base (default http://localhost:3001)
  --cookie NAME=VAL   Session cookie, if not using --api against a signed-in host
  --dry               List what would be uploaded and stop.

Pages are uploaded in filename order — name them so they sort correctly
(001.jpeg, 002.jpeg …, not 1.jpeg, 2.jpeg … which sorts 1, 10, 11, 2).
`);
  process.exit(0);
}

const dir = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const api = flag('--api', process.env.LEGIBLE_API ?? 'http://localhost:3001');
const cookie = flag('--cookie', process.env.LEGIBLE_COOKIE ?? '');
const dated = flag('--dated');
const dry = args.includes('--dry');

if (dated && !/^\d{4}(-\d{2})?$/.test(dated)) {
  console.error(`--dated must be YYYY or YYYY-MM, got "${dated}"`);
  process.exit(1);
}

const IMAGE = /\.(jpe?g|png|webp)$/i;
const files = (await readdir(dir)).filter((f) => IMAGE.test(f)).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
);
if (!files.length) { console.error(`no images in ${dir}`); process.exit(1); }

// The date the pipeline should fall back to for pages with no year on them.
const fallbackDate = dated
  ? new Date(`${dated.length === 4 ? `${dated}-06` : dated}-15T12:00:00Z`)
  : null;

console.log(`${files.length} pages from ${dir}`);
console.log(`year fallback: ${fallbackDate ? fallbackDate.toISOString().slice(0, 10) + ' (from --dated)' : 'the photo\'s own timestamp — pass --dated if this notebook is not from this year'}`);
console.log(`first: ${files[0]}   last: ${files[files.length - 1]}`);
if (dry) { files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(3)}  ${f}`)); process.exit(0); }

const headers = cookie ? { cookie } : {};
const call = async (path, init = {}) => {
  const res = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const batch = await call('/api/capture/batches', { method: 'POST' });
console.log(`\nbatch ${batch.id}`);

for (const [i, name] of files.entries()) {
  const path = join(dir, name);
  const buf = await readFile(path);
  const shotAt = fallbackDate ?? (await stat(path)).mtime;
  const form = new FormData();
  form.append('shot_at', shotAt.toISOString());
  form.append('file', new Blob([buf], { type: extname(name).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg' }), basename(name));
  await call(`/api/capture/batches/${batch.id}/pages`, { method: 'POST', body: form });
  process.stdout.write(`\r  uploaded ${i + 1}/${files.length}`);
}
console.log('\n\nreading pages…');

let done = 0;
for (;;) {
  const state = await call(`/api/capture/batches/${batch.id}`);
  const d = state.pages.filter((p) => p.ocr_status === 'done').length;
  const failed = state.pages.filter((p) => p.ocr_status === 'failed');
  if (d !== done) { done = d; process.stdout.write(`\r  ${done}/${files.length} read`); }
  if (state.batch.status === 'review' && state.proposed?.length) {
    console.log(`\n\n${state.proposed.length} notes proposed:\n`);
    for (const [i, n] of state.proposed.entries()) {
      console.log(`  ${String(i + 1).padStart(3)}. ${(n.title ?? '(untitled)').padEnd(28)} ${(n.writtenOn ?? 'no date').padEnd(11)} ${(n.writtenOnPrecision ?? '-').padEnd(9)} pages ${n.pages.map((p) => p.idx + 1).join(',')}`);
    }
    console.log(`\nreview and commit at: ${api.replace(':3001', ':5173')}  (batch ${batch.id})`);
    if (failed.length) console.log(`\n${failed.length} page(s) failed: ${failed.map((f) => f.idx + 1).join(', ')}`);
    break;
  }
  if (failed.length === state.pages.length) { console.error('\nall pages failed'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 3000));
}
