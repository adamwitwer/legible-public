import { bodyHash } from './summary';
import { buildIndex, search } from './search';
import type { Note } from './types';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// MIRRORED in server/src/lib/summarize.test.ts — same inputs, same digests. If
// these drift, every summary in the app reads as stale forever.
console.log('\nbody hash (mirrored on the server)');
check('known vector', await bodyHash('Aug 8  Meeting Title\n- lorem ipsum'),
  '35fcdaf70a11993acb09281cf6e281a028ee3251141780034cee0a35499676da');
check('empty body', await bodyHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('one character changes it', (await bodyHash('a')) === (await bodyHash('a ')), false);

console.log('\nsummaries stay out of search');
const n: Note = {
  id: 's1', kind: 'typed', title: 'Invoice chase', body: 'ring the supplier', written_on: null,
  written_on_precision: null, tags: [], ocr_status: null, confidence: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, seq: '1',
  summary: 'A reminder concerning the zeppelin procurement.', summary_body_hash: 'x', summarized_at: null,
};
buildIndex([n]);
check('a word only in the summary finds nothing', search('zeppelin').hits.length, 0);
check('the body is still found', search('supplier').hits.length, 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
