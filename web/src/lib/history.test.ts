import { pushHistory, stepHistory } from './history.js';

let passed = 0;
let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const h = ['tag:1on1', 'gyre', 'before:2026-08-01'];

console.log('\nstepping back');
check('from a fresh prompt lands on the newest', stepHistory(h, null, 'back'), { index: 2, query: 'before:2026-08-01' });
check('again walks older', stepHistory(h, 2, 'back'), { index: 1, query: 'gyre' });
check('stops at the oldest rather than wrapping', stepHistory(h, 0, 'back'), { index: 0, query: 'tag:1on1' });
check('empty history does nothing', stepHistory([], null, 'back'), null);

console.log('\nstepping forward');
check('walks newer', stepHistory(h, 0, 'forward'), { index: 1, query: 'gyre' });
check('past the newest leaves history and clears', stepHistory(h, 2, 'forward'), { index: null, query: '' });
check('forward while not browsing does nothing', stepHistory(h, null, 'forward'), null);

console.log('\nrecording');
check('appends newest last', pushHistory(h, 'ipsum', 10), [...h, 'ipsum']);
check('blank is not recorded', pushHistory(h, '   ', 10), h);
check('trims before recording', pushHistory([], '  gyre  ', 10), ['gyre']);
check('no consecutive repeat', pushHistory(h, 'before:2026-08-01', 10), h);
check('a repeat that is not consecutive is kept', pushHistory(h, 'gyre', 10), [...h, 'gyre']);
check('caps at max, dropping oldest', pushHistory(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
