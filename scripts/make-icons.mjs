#!/usr/bin/env node
/**
 * Rasterise the app icons from web/public/favicon.svg.
 *
 * Run: node scripts/make-icons.mjs
 *
 * The SVG is the only source of truth; every PNG here is derived. That matters
 * in a public repo — a committed binary nobody can regenerate is a binary
 * nobody can safely change. Re-run this after editing favicon.svg.
 *
 * Rendering goes through headless Chrome rather than ImageMagick: IM without an
 * librsvg delegate falls back to its own SVG parser, which quietly mangles
 * arcs and rounded rects — you get a PNG, just not the one you drew.
 *
 * Three shapes, because three consumers want different things:
 *
 *   favicon.svg          rx=7. A browser tab draws the icon as-is, so the
 *                        rounding has to be in the artwork.
 *   apple-touch-icon     rx=0, full bleed. iOS applies its own squircle mask.
 *                        Ship pre-rounded corners and you get rounding inside
 *                        rounding, with the home screen showing through the gap.
 *   maskable             rx=0 and the nib scaled to 80% about the centre.
 *                        Android may crop a maskable icon to any shape it likes;
 *                        only the centre 80% circle is guaranteed to survive.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'web', 'public');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try {
      await run(c, ['--version']);
      return c;
    } catch {}
  }
  throw new Error(
    `No Chrome found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME=/path/to/chrome and re-run.`,
  );
}

/** Square off the corners, and optionally shrink the nib into the maskable safe zone. */
function variant(svg, { square, safeZone }) {
  let out = svg;
  if (square) out = out.replace('<rect width="32" height="32" rx="7"', '<rect width="32" height="32"');
  if (safeZone) {
    out = out.replace(
      '<path fill="#14100b"',
      '<path transform="translate(16,16) scale(0.8) translate(-16,-16)" fill="#14100b"',
    );
  }
  return out;
}

async function render(chrome, svg, size, outPath) {
  const page = join(tmpdir(), `legible-icon-${size}-${Date.now()}.html`);
  // No margin, no scrollbars: the window IS the icon, so every pixel Chrome
  // paints is a pixel in the PNG.
  await writeFile(
    page,
    `<meta charset=utf-8><style>html,body{margin:0;padding:0;overflow:hidden}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await run(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${size},${size}`,
    `--screenshot=${outPath}`,
    `file://${page}`,
  ]).catch((e) => {
    // Chrome logs display-link noise to stderr on macOS and still exits 0-ish;
    // only a missing output file is a real failure.
    if (!e.stdout && !e.stderr) throw e;
  });
  await unlink(page).catch(() => {});
}

const chrome = await findChrome();
const svg = await readFile(join(pub, 'favicon.svg'), 'utf8');

const targets = [
  { file: 'apple-touch-icon.png', size: 180, opts: { square: true } },
  { file: 'icon-192.png', size: 192, opts: { square: true } },
  { file: 'icon-512.png', size: 512, opts: { square: true } },
  { file: 'icon-maskable-512.png', size: 512, opts: { square: true, safeZone: true } },
];

for (const { file, size, opts } of targets) {
  const out = join(pub, file);
  await render(chrome, variant(svg, opts), size, out);
  const { size: bytes } = await (await import('node:fs/promises')).stat(out);
  console.log(`${file}  ${size}x${size}  ${bytes} bytes`);
}
