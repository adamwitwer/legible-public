import { stripStruck } from './struck.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log('\ndropping crossed-out text');
check('nothing struck is returned untouched', stripStruck('Aug 1  Meeting Title\n- a'), 'Aug 1  Meeting Title\n- a');
check('a struck figure leaves the correction', stripStruck('- venue deposit ~~$4,200~~ $3,800'), '- venue deposit $3,800');
check('a wholly struck line goes', stripStruck('that is just how some\n~~Aug 2~~\nGive me'), 'that is just how some\nGive me');
check('a struck list item goes, marker and all', stripStruck('- keep\n- ~~call Bob~~\n- also'), '- keep\n- also');
check('a numbered item too', stripStruck('1. ~~gone~~\n2. stays'), '2. stays');
check('indentation of a nested item is kept', stripStruck('  - old ~~x~~ new'), '  - old new');
check('a strike at the start of a line', stripStruck('~~goog~~ good'), 'good');
check('a strike spanning lines', stripStruck('a ~~b\nc~~ d'), 'a d');
check('blank lines around a dropped line collapse', stripStruck('x\n\n~~Aug 2~~\n\ny'), 'x\n\ny');
check('only touched lines are tidied', stripStruck('Aug 1  Title\n- a ~~b~~  c'), 'Aug 1  Title\n- a c');
check('an unmatched ~~ is left alone', stripStruck('a ~~ b'), 'a ~~ b');
const messy = 'Aug 1  T\n\n- ~~x~~\n- y ~~z~~ w\n~~q~~';
check('idempotent', stripStruck(stripStruck(messy)), stripStruck(messy));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
