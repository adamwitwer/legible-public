import { appendTodoMarker, hasTodoMarker, TODO_MARKER } from './todo.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// MIRRORED in web/src/lib/search.test.ts, against deriveTags. The client derives
// tags on every save and the server derives them once at import; if the two
// disagree, a scan's indicator flips the first time the note is edited.
console.log('\nwhat counts as a TODO marker');
check('bare TODO', hasTodoMarker('call Priya TODO'), true);
check('#todo tag form', hasTodoMarker('#todo'), true);
check('both at once', hasTodoMarker('TODO and #todo'), true);
check('lowercase todo in prose is not a task', hasTodoMarker('nothing todo with it'), false);
check('TODO inside a word does not count', hasTodoMarker('TODOS and MASTODON'), false);
check('a struck TODO is a task abandoned', hasTodoMarker('~~TODO~~ handled'), false);
check('a struck one does not suppress a live one', hasTodoMarker('~~TODO~~ then TODO'), true);
check('empty body', hasTodoMarker(''), false);
check('multiline body', hasTodoMarker('a line\nTODO ring back\nanother'), true);

console.log('\nwriting the marker into a body');
check('appended as its own trailing line', appendTodoMarker('the transcript'), `the transcript\n\n${TODO_MARKER}\n`);
check('trailing whitespace collapses first', appendTodoMarker('body\n\n\n'), `body\n\n${TODO_MARKER}\n`);
check('an empty body gets just the marker', appendTodoMarker(''), `${TODO_MARKER}\n`);
check('the result is itself detectable', hasTodoMarker(appendTodoMarker('x')), true);
check('appending is idempotent under detection', hasTodoMarker(appendTodoMarker('TODO already')), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
