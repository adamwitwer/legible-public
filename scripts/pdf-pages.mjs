#!/usr/bin/env node
/**
 * Turn scanned-notebook PDFs into page images the capture pipeline can read.
 *
 * The Notes.app export is ~5MB per page — far past anything the OCR call can
 * use. Claude Opus 5 is on the high-resolution vision tier: it downscales
 * anything over 2576px on the long edge OR over 4784 visual tokens, where a
 * visual token is a 28x28 patch. Rendering past whichever of those binds first
 * just spends upload bandwidth on pixels the model never sees, so we compute
 * the largest render that clears both and stop there.
 *
 * Requires poppler (`brew install poppler`) for pdftoppm.
 *
 * Usage:
 *   node scripts/pdf-pages.mjs inbox/<notebook> [--out <dir>] [--quality 88]
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MAX_LONG_EDGE = 2576;   // high-resolution tier long-edge cap
const MAX_VISUAL_TOKENS = 4784;
const PATCH = 28;

/**
 * Notes.app occasionally captures the open notebook rather than one page, so a
 * near-square frame turns up among the portrait ones. Its right half is always
 * the NEXT scan, caught early and cut off at the frame edge — so keeping it
 * would import the same writing twice, once truncated. Crop to the left page
 * and let the following image supply the right one.
 */
const SPREAD_ASPECT = 0.85;   // width/height above this is an open-notebook shot
const SPREAD_KEEP = 0.65;     // fraction of width that is the left page + gutter

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`
pdf-pages — render notebook PDFs to page images

  node scripts/pdf-pages.mjs <dir> [--out <dir>] [--quality N]

Pages are numbered continuously across the PDFs in filename order, so a
notebook split into 01.pdf..04.pdf becomes 001.jpg..096.jpg in one sequence.
`);
  process.exit(0);
}

const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const dir = resolve(args[0]);
const out = resolve(flag('--out', join(dir, 'pages')));
const quality = Number(flag('--quality', '88'));

const pdfs = (await readdir(dir))
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
if (!pdfs.length) { console.error(`no PDFs in ${dir}`); process.exit(1); }

/**
 * Largest render of a page that the model will accept without downscaling.
 * Long edge is one bound; the patch-count budget is the other, and for a
 * portrait notebook page the patch budget is what actually binds.
 */
function targetLongEdge(widthPt, heightPt) {
  const aspect = Math.min(widthPt, heightPt) / Math.max(widthPt, heightPt);
  // tokens = (short/28) * (long/28) = aspect * long^2 / 784
  const byTokens = Math.sqrt((MAX_VISUAL_TOKENS * PATCH * PATCH) / aspect);
  return Math.floor(Math.min(MAX_LONG_EDGE, byTokens));
}

async function pageSize(pdf) {
  const { stdout } = await run('pdfinfo', ['-f', '1', '-l', '1', pdf]);
  const m = stdout.match(/Page\s+1\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/);
  if (!m) throw new Error(`could not read page size from ${pdf}`);
  return [Number(m[1]), Number(m[2])];
}

await mkdir(out, { recursive: true });
const staging = join(out, '.staging');

let page = 0;
const spreads = [];
for (const pdf of pdfs) {
  const path = join(dir, pdf);
  const [w, h] = await pageSize(path);
  const longEdge = targetLongEdge(w, h);

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await run('pdftoppm', [
    '-jpeg', '-jpegopt', `quality=${quality}`,
    '-scale-to', String(longEdge),
    path, join(staging, 'p'),
  ]);

  const rendered = (await readdir(staging)).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
  for (const f of rendered) {
    page += 1;
    const src = join(staging, f);
    const dest = join(out, `${String(page).padStart(3, '0')}.jpg`);
    const { stdout } = await run('magick', ['identify', '-format', '%w %h', src]);
    const [pw, ph] = stdout.trim().split(' ').map(Number);
    if (pw / ph > SPREAD_ASPECT) {
      const keep = Math.round(pw * SPREAD_KEEP);
      await run('magick', [src, '-crop', `${keep}x${ph}+0+0`, '+repage', dest]);
      spreads.push(page);
    } else {
      await rename(src, dest);
    }
  }
  console.log(`${basename(pdf)}  ${rendered.length} pages  @ ${longEdge}px long edge`);
}
await rm(staging, { recursive: true, force: true });

let bytes = 0;
for (const f of await readdir(out)) bytes += (await readFile(join(out, f))).byteLength;
console.log(`\n${page} pages → ${out}`);
if (spreads.length) {
  console.log(`cropped ${spreads.length} open-notebook shot(s) to the left page: ${spreads.map((n) => String(n).padStart(3, '0')).join(', ')}`);
  console.log(`  → check each against the page after it, which should hold the right half in full`);
}
console.log(`${(bytes / 1024 / 1024).toFixed(1)} MB total, ${Math.round(bytes / page / 1024)} KB/page average`);
