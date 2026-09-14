import { bodyHash, buildSummaryPrompt } from './summarize.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// MIRRORED in web/src/lib/summary.test.ts. The server stamps this hash on a
// summary and the client recomputes it to decide "stale"; if the two drift on
// the same text, every summary reads as stale forever.
console.log('\nbody hash (mirrored on the client)');
check('known vector', bodyHash('Aug 8  Meeting Title\n- lorem ipsum'),
  '35fcdaf70a11993acb09281cf6e281a028ee3251141780034cee0a35499676da');
check('empty body', bodyHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('non-ASCII hashes as UTF-8', bodyHash('café — ~~Aug 2~~'),
  bodyHash(Buffer.from('café — ~~Aug 2~~', 'utf8').toString('utf8')));
check('one character changes it', bodyHash('a') === bodyHash('a '), false);

console.log('\nprompt');
const typed = buildSummaryPrompt({ kind: 'typed', title: 'Invoice chase', writtenOn: '2026-08-06', body: 'TODO ring the supplier', annotations: [] });
check('carries the body', typed.includes('<body>\nTODO ring the supplier\n</body>'), true);
check('typed note has no margin section', typed.includes('<margin_annotations>'), false);
check('untitled is said, not blank', buildSummaryPrompt({ kind: 'typed', title: null, writtenOn: null, body: 'x', annotations: [] }).includes('<title>(untitled)</title>'), true);

const scan = buildSummaryPrompt({
  kind: 'scan', title: 'Meeting Title', writtenOn: '2026-08-08', body: '- lorem ipsum\n- dolor sit amet',
  annotations: [
    { side: 'left', kind: 'speaker', anchor: 'lorem ipsum', text: 'Priya' },
    { side: 'right', kind: 'todo', anchor: null, text: 'TODO' },
  ],
});
check('scan says it was transcribed', scan.includes('transcribed'), true);
check('speaker keeps its anchor', scan.includes('- [speaker, left margin, beside "lorem ipsum"] Priya'), true);
check('an anchorless annotation still reads', scan.includes('- [todo, right margin] TODO'), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
