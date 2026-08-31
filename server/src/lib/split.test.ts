import { findBoundaryPage, splitBody, titleOf } from './split.js';

let passed = 0;
let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const body = 'Aug 1  Meeting Title\n\n- lorem ipsum\n\nAug 2  The Second Coming\n\n- widening gyre\n';
const at = body.indexOf('Aug 2');

console.log('\nwhere the text divides');
check('head stops before the second header', splitBody(body, at)?.head,
  'Aug 1  Meeting Title\n\n- lorem ipsum');
check('tail starts at it', splitBody(body, at)?.tail,
  'Aug 2  The Second Coming\n\n- widening gyre');
check('trailing blank lines are trimmed off the head', splitBody('a\n\n\nb', 1)?.head, 'a');
check('leading blank lines are trimmed off the tail', splitBody('a\n\n\nb', 1)?.tail, 'b');
check('splitting at the very start is refused', splitBody(body, 0), null);
check('splitting at the very end is refused', splitBody(body, body.length), null);
check('whitespace-only tail is refused', splitBody('a\n\n   \n', 1), null);
check('an offset past the end is refused', splitBody('abc', 99), null);
check('a fractional offset is refused', splitBody('abc', 1.5), null);

console.log('\nthe title of the new note');
check('first non-empty line', titleOf('\n\nAug 2  The Second Coming\n- x'), 'Aug 2  The Second Coming');
check('markdown heading marker is dropped', titleOf('# July 17 — Meeting Title\n- x'), 'July 17 — Meeting Title');
check('nothing but whitespace has no title', titleOf('   \n  \n'), null);

console.log('\nwhich page the second note opens on');
// Shortened from real pages: the body joins block transcripts, so the same
// words reach the body with different whitespace than the transcript has.
const pages = [
  { ocr_json: { blocks: [{ transcript: 'lorem ipsum continued\n\n- dolor\n  - sit amet' }] } },
  { ocr_json: { blocks: [{ transcript: 'Turning — and turning\n\n- widening gyre' }] } },
  { ocr_json: { blocks: [{ transcript: '- open questions\n  - timing' }] } },
];
check('finds the page the tail starts on', findBoundaryPage(pages, 'Turning — and turning\n\n- widening gyre'), 1);
check('tolerates whitespace differing from the transcript',
  findBoundaryPage(pages, 'Turning —   and\n\nturning'), 1);
check('page 0 when the tail is the whole note', findBoundaryPage(pages, 'lorem ipsum continued\n\n- dolor'), 0);
check('-1 when the text is on no page', findBoundaryPage(pages, 'something never written down'), -1);
check('-1 for an empty tail', findBoundaryPage(pages, '   '), -1);
check('-1 when there are no pages at all', findBoundaryPage([], 'anything'), -1);
check('a page with no ocr is skipped, not fatal',
  findBoundaryPage([{ ocr_json: null }, pages[1]!], 'Turning — and'), 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
