import { asCalendarDate, displayDate, localDate, toLocalDate } from './dates';
import { deriveTags, deriveTitle, todoLines } from './notes';
import { parseQuery } from './query';
import { buildIndex, search, upsertInIndex } from './search';
import type { Note } from './types';

const note = (o: Partial<Note>): Note => ({
  id: crypto.randomUUID(), kind: 'typed', title: null, body: '', written_on: null,
  written_on_precision: null, tags: [], ocr_status: null, confidence: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null, seq: '0', ...o,
});

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

console.log('\nquery grammar');
check('bare words', parseQuery('kubernetes retro').text, 'kubernetes retro');
check('tag filter', parseQuery('tag:meeting budget').tags, ['meeting']);
check('tag strips from text', parseQuery('tag:meeting budget').text, 'budget');
check('is:scan', parseQuery('is:scan notes').kind, 'scan');
check('after: pads month', parseQuery('after:2026-01').after, '2026-01-01');
check('before: pads month to end', parseQuery('before:2026-02').before, '2026-02-31');
check('after: full date', parseQuery('after:2026-03-14').after, '2026-03-14');
check('bare year', parseQuery('after:2026').after, '2026-01-01');
check('phrase extracted', parseQuery('"exact phrase" tag:x').phrases, ['exact phrase']);
check('phrase removed from text', parseQuery('"exact phrase" hello').text, 'hello');
check('colon inside phrase not a filter', parseQuery('"tag:notreal"').tags, []);
check('bad date ignored', parseQuery('after:notadate').after, null);
check('is:todo sets the flag', parseQuery('is:todo').todo, true);
check('is:todo strips from text', parseQuery('is:todo budget').text, 'budget');
check('is:scan still works alongside', parseQuery('is:scan').todo, false);
check('an unknown is: value stays as text', parseQuery('is:banana').text, 'is:banana');

console.log('\nsearch');
const notes = [
  note({ id: 'n1', title: 'Q3 planning', body: 'who owns the migration? ask about the gyre', tags: ['planning'], written_on: '2026-03-14' }),
  note({ id: 'n2', title: 'Migration notes', body: 'the migration path from the old system', tags: ['eng'], written_on: '2026-02-02' }),
  note({ id: 'n3', title: 'Architecture scratch', body: 'local-first search sketch', tags: ['ideas'], written_on: '2025-11-08', kind: 'scan' }),
];
buildIndex(notes);

check('finds both migration notes', search('migration').hits.length, 2);
check('title boost ranks n2 first', search('migration').hits[0]!.note.id, 'n2');
check('fuzzy tolerates OCR-style typo', search('migraton').hits.length > 0, true);
check('prefix match', search('migrat').hits.length, 2);
check('tag filter narrows', search('tag:ideas').hits.length, 1);
check('is:scan filters', search('is:scan').hits.length, 1);
check('after: filters on written_on', search('after:2026-03').hits.length, 1);
check('before: filters', search('before:2025-12').hits.length, 1);
check('combined text+tag', search('migration tag:eng').hits.length, 1);
check('phrase must match literally', search('"migration path"').hits.length, 1);
check('phrase that does not exist', search('"migration pathway"').hits.length, 0);
check('empty query browses all, newest first', search('').hits[0]!.note.id, 'n1');
check('snippet is populated', search('migration').hits[0]!.snippet.length > 0, true);

console.log('\nlocal dates (regression: written_on must not use UTC)');
// 2026-08-20 20:54 EDT is 2026-08-21 00:54 UTC. The calendar date is the 20th.
const evening = new Date('2026-08-21T00:54:00Z');
check('toISOString would have said the 21st', evening.toISOString().slice(0, 10), '2026-08-21');
if (Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('America/')) {
  check('local date is the 20th in US timezones', toLocalDate('2026-08-21T00:54:00Z'), '2026-08-20');
}
check('localDate matches the machine calendar day', localDate(), new Date().toLocaleDateString('en-CA'));
check('localDate format is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDate()), true);

// Regression: postgres `date` arriving as a UTC-midnight timestamp.
check('timestamp coerced to calendar date', asCalendarDate('2026-08-20T00:00:00.000Z'), '2026-08-20');
check('plain date passes through', asCalendarDate('2026-08-20'), '2026-08-20');
check('displayDate survives a timestamp written_on',
  displayDate({ written_on: '2026-08-20T00:00:00.000Z', created_at: '2026-01-01T00:00:00Z' }), '2026-08-20');
check('before: matches a note dated that same day',
  (() => { buildIndex([note({ id: 'd1', title: 'x', body: 'y', written_on: '2026-08-20' })]);
           return search('before:2026-08-20').hits.length; })(), 1);

console.log('\nderivation');
check('title is the first non-empty line', deriveTitle('Timezone check, written this evening.\nmore'), 'Timezone check, written this evening.');
check('leading markdown heading stripped', deriveTitle('# Q3 planning\nbody'), 'Q3 planning');
check('blank body has no title', deriveTitle('   \n  '), null);
check('hashtags become tags', deriveTags('a #test and #q3-plan here'), ['test', 'q3-plan']);
check('duplicate tags collapse', deriveTags('#a #a #b'), ['a', 'b']);
check('mid-word hash is not a tag', deriveTags('issue#5 and #real'), ['real']);

// These cases are MIRRORED in server/src/lib/todo.test.ts. The client derives
// tags on save and the server derives them at import; if they drift, a scan's
// indicator flips the first time the note is edited. Change one, fix both.
check('bare TODO becomes the todo tag', deriveTags('call Priya TODO'), ['todo']);
check('#todo tag form agrees', deriveTags('#todo'), ['todo']);
check('both forms collapse to one tag', deriveTags('TODO and #todo'), ['todo']);
check('lowercase todo in prose is not a task', deriveTags('nothing todo with it'), []);
check('TODO inside a word does not count', deriveTags('TODOS and MASTODON'), []);
check('a struck TODO is a task abandoned', deriveTags('~~TODO~~ handled'), []);
check('a struck tag is taken back', deriveTags('~~#old~~ #new'), ['new']);
check('a struck TODO does not suppress a live one', deriveTags('~~TODO~~ then TODO'), ['todo']);
check('todo joins other tags', deriveTags('#meeting TODO'), ['meeting', 'todo']);

console.log('\nis:todo filter');
buildIndex([
  note({ id: 't1', title: 'open one', body: 'TODO chase the invoice', tags: ['todo'] }),
  note({ id: 't2', title: 'closed one', body: 'chased the invoice', tags: [] }),
  note({ id: 't3', title: 'tagged too', body: 'TODO', tags: ['todo', 'meeting'] }),
]);
check('is:todo selects only marked notes', search('is:todo').hits.length, 2);
check('is:todo composes with a tag', search('is:todo tag:meeting').hits.map((h) => h.note.id), ['t3']);
check('is:todo composes with text', search('is:todo invoice').hits.map((h) => h.note.id), ['t1']);
check('tag:todo reaches the same notes', search('tag:todo').hits.length, 2);

console.log('\nTODO lines');
const texts = (b: string) => todoLines(b).map((t) => t.text);
check('finds the marked line', texts('Meeting\nchase the invoice TODO\nother'), ['chase the invoice TODO']);
check('#todo form too', texts('a\nbook room #todo'), ['book room #todo']);
check('every marked line', texts('TODO one\nnot this\n#todo two'), ['TODO one', '#todo two']);
check('a marker alone takes the next line', texts('TODO:\n\n  call Priya\nlater'), ['call Priya']);
check("a scan's appended marker has no text", texts('notes here\n\n#todo\n'), ['']);
check('a struck TODO is not a line', texts('~~TODO~~ done\nTODO live'), ['TODO live']);
check('struck text is left out of the shown line', texts('TODO ~~old~~ new'), ['TODO new']);
check('prose todo is not a line', texts('nothing todo with it'), []);
const offs = todoLines('first\n~~x~~ TODO here');
check('offsets index the real body', 'first\n~~x~~ TODO here'.slice(offs[0]!.start, offs[0]!.end), '~~x~~ TODO here');
// The [ ] beside a title and the strip in the editor must never disagree.
for (const b of ['TODO', '~~a\nTODO~~ b', 'x #todo-list', '#TODO', 'a\n#todo', 'TODOS', '~~TODO~~ then TODO', 'MASTODON #todo']) {
  check(`lines agree with the tag: ${JSON.stringify(b)}`, todoLines(b).length > 0, deriveTags(b).includes('todo'));
}

console.log('\nTODO snippets');
buildIndex([
  note({ id: 's1', title: 'standup', body: 'standup\nlots of talk\nTODO send the deck\nmore talk about budget', tags: ['todo'] }),
  note({ id: 's2', title: 'scan', kind: 'scan', body: 'page text about budget\n\n#todo\n', tags: ['todo'] }),
  note({ id: 's3', title: 'plain', body: 'plain\nbudget talk', tags: [] }),
]);
const hit = (q: string, id: string) => search(q).hits.find((h) => h.note.id === id)!;
check('a browse shows the task', [hit('', 's1').snippet, hit('', 's1').todo], ['TODO send the deck', true]);
check('is:todo shows the task', hit('is:todo', 's1').snippet, 'TODO send the deck');
check('is:todo with words still shows the task', hit('is:todo budget', 's1').todo, true);
check('a word search keeps the excerpt', hit('budget', 's1').todo, false);
check('a margin-only scan falls back to the excerpt', [hit('is:todo', 's2').todo, hit('is:todo', 's2').snippet.startsWith('page text')], [false, true]);
check('a note with no TODO is unchanged', hit('', 's3').todo, false);

console.log('\nincremental index upkeep');
buildIndex(notes);
const edited = { ...notes[0]!, body: 'kubernetes rollout plan', title: 'Q3 planning' };
upsertInIndex(edited);
check('edit is searchable', search('kubernetes').hits.length, 1);
check('old body no longer matches', search('gyre').hits.length, 0);
upsertInIndex({ ...notes[1]!, deleted_at: '2026-08-20T00:00:00Z' });
check('tombstone drops from index', search('migration').hits.length, 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
