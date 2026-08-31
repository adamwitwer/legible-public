import { resolveDate, segment, type PageOcr } from './segment.js';

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const block = (o: Partial<PageOcr['ocr']['blocks'][number]> = {}) => ({
  starts_note: false, title: null, date_text: null, date_precision: null, transcript: 'body', ...o,
});
const page = (idx: number, blocks: any[], annotations: any[] = [], shotAt = '2026-08-20T14:00:00Z'): PageOcr => ({
  pageId: `p${idx}`, idx, shotAt, ocr: { blocks, annotations, confidence: 0.9, illegible: [] },
});

console.log('\ndate resolution (pages carry "Aug 1" with no year)');
const shot = new Date('2026-08-20T14:00:00Z');
check('bare month-day infers the year from the shot date',
  resolveDate('Aug 1', 'day', shot), { date: '2026-08-01', precision: 'inferred' });
check('explicit year is trusted and marked day-precise',
  resolveDate('Aug 1, 2024', 'day', shot), { date: '2024-08-01', precision: 'day' });
check('numeric date', resolveDate('3/14', 'day', shot), { date: '2026-03-14', precision: 'inferred' });
check('two-digit year expands to 20xx and wins over the shot year',
  resolveDate('3/14/24', 'day', shot), { date: '2024-03-14', precision: 'day' });
check('bare month', resolveDate('September', 'month', shot), { date: '2026-09-01', precision: 'inferred' });
check('year alone', resolveDate('2023', 'year', shot), { date: '2023-01-01', precision: 'year' });
check('no date text', resolveDate(null, null, shot), { date: null, precision: null });
check('no fallback and no year yields nothing rather than a guess',
  resolveDate('Aug 1', 'day', null), { date: null, precision: null });
check('nonsense is not forced into a date', resolveDate('meeting', null, shot), { date: null, precision: null });

console.log('\nsegmentation');
// The real shape of images/: p1 starts a note, p2 continues it under a struck
// date and a bare "Tell me" heading, p3 finishes that note in its upper block and
// opens a dated one halfway down, and p4 opens a third at the page top.
// "Tell me" carries no date, so under the date-required rule it is a subject
// inside the note above rather than a note of its own.
const pages = [
  page(0, [block({ starts_note: true, title: 'Meeting Title', date_text: 'Aug 1', date_precision: 'day', transcript: 'Lorem ipsum\ndolor sit amet\ndolore provident' })], [
    { side: 'right', rotation: 0, kind: 'note', anchor: 'dolor sit amet', text: 'right-margin note here' },
  ]),
  page(1, [
    block({ transcript: 'that is just how some\n~~Aug 2~~\nGive me one little blip' }),
    block({ starts_note: true, title: 'Tell me', transcript: 'flip Yeahhhh' }),
  ], [
    { side: 'right', rotation: 90, kind: 'note', anchor: 'that is just how some', text: 'FB Insights!' },
  ]),
  page(2, [
    block({ transcript: 'I will be one lonely guy' }),
    block({ starts_note: true, title: 'The Second Coming', date_text: 'Aug 2', date_precision: 'day', transcript: 'Turning and turning\nin the widening gyre' }),
  ]),
  page(3, [block({ starts_note: true, title: 'Love makes your soul crawl out', date_text: 'Aug 3', date_precision: 'day', transcript: 'from its hiding place' })]),
];
const notes = segment(pages);

check('four pages become three notes — Tell me has no date', notes.length, 3);
check('first note titled', notes[0]!.title, 'Meeting Title');
check('first note spans three pages', notes[0]!.pages.length, 3);
check('second note titled', notes[1]!.title, 'The Second Coming');
check('the mid-page note occupies only the page it starts on', notes[1]!.pages.length, 1);
check('third note opens at the top of its own page', notes[2]!.title, 'Love makes your soul crawl out');
check('an undated header is folded into the note above it',
  notes[0]!.body.includes('flip Yeahhhh'), true);
check('a struck date in the body does not become a note date',
  [notes[0]!.body.includes('~~Aug 2~~'), notes[0]!.writtenOn], [true, '2026-08-01']);
check('a page-top start records no anchor', notes[0]!.pages[0]!.startsAt, null);
check('continuation pages are joined into the body',
  notes[0]!.body.includes('Lorem ipsum') && notes[0]!.body.includes('lonely guy'), true);
check('dates resolve using the shot year', notes[0]!.writtenOn, '2026-08-01');
check('inferred year is flagged as such', notes[0]!.writtenOnPrecision, 'inferred');
check('original date text is preserved verbatim', notes[0]!.dateText, 'Aug 1');

console.log('\na dated header still starts a note mid-page');
{
  const mid = segment([
    page(0, [block({ starts_note: true, title: 'Meeting Title', date_text: 'Aug 1', date_precision: 'day', transcript: 'Lorem ipsum' })]),
    page(1, [
      block({ transcript: 'I will be one lonely guy' }),
      block({ starts_note: true, title: 'The Second Coming', date_text: 'Aug 2', date_precision: 'day', transcript: 'widening gyre' }),
    ]),
  ]);
  check('a dated mid-page header opens a second note', mid.length, 2);
  check('it occupies only the page it starts on', mid[1]!.pages.map((p) => p.pageId), ['p1']);
  check('the mid-page start records an anchor', Boolean(mid[1]!.pages[0]!.startsAt), true);
  check('the page belongs to both notes',
    [mid[0]!.pages.some(p => p.pageId === 'p1'), mid[1]!.pages.some(p => p.pageId === 'p1')], [true, true]);
  check('and it keeps its own date', mid[1]!.writtenOn, '2026-08-02');
}

console.log('\na name alone never starts a note');
{
  const named = segment([
    page(0, [
      block({ starts_note: true, title: 'Meeting Title', date_text: 'Aug 1', date_precision: 'day', transcript: 'Lorem ipsum' }),
      block({ starts_note: true, title: 'Tell me', transcript: 'optional password' }),
      block({ starts_note: true, title: 'The vanishing spies', transcript: 'october - critical mass' }),
    ]),
  ]);
  check('three headers, one dated, yield one note', named.length, 1);
  check('the dated one is the note', named[0]!.title, 'Meeting Title');
  check('the undated headers survive as body text',
    named[0]!.body.includes('optional password') && named[0]!.body.includes('critical mass'), true);
}

console.log('\nannotations stay attached to the right note');
check('the margin note lands on note 1', notes[0]!.annotations.some(a => a.text === 'right-margin note here'), true);
check('horizontal marginalia keeps rotation 0',
  notes[0]!.annotations.find(a => a.text === 'right-margin note here')?.rotation, 0);
check('rotated marginalia is kept with its rotation',
  notes[0]!.annotations.find(a => a.text === 'FB Insights!')?.rotation, 90);
check('annotation keeps its anchor',
  notes[0]!.annotations.find(a => a.text === 'right-margin note here')?.anchor, 'dolor sit amet');

// A boundary page: marginalia above the split belongs to the note above it.
const boundaryPages = [
  page(0, [block({ starts_note: true, title: 'Meeting Title', date_text: 'Aug 1', date_precision: 'day', transcript: 'I will be one lonely guy' }),
           block({ starts_note: true, title: 'The Second Coming', date_text: 'Aug 2', date_precision: 'day', transcript: 'Turning and turning' })],
        [{ side: 'right', rotation: 0, kind: 'note', anchor: 'one lonely guy', text: 'right-margin note here' }]),
];
const bn = segment(boundaryPages);
check('marginalia follows its anchor, not the page owner',
  [bn[0]!.annotations.some(a => a.text === 'right-margin note here'),
   bn[1]!.annotations.some(a => a.text === 'right-margin note here')], [true, false]);
check('anchorless marginalia falls back to the last note on the page',
  segment([page(0, [block({ starts_note: true, transcript: 'a' })], [{ side: 'left', rotation: 0, kind: 'note', anchor: null, text: 'x' }])])[0]!.annotations.length, 1);

check('trailing em dash is trimmed from a title',
  segment([page(0, [block({ starts_note: true, title: 'Tell me \u2014\u2014' })])])[0]!.title, 'Tell me');
check('a title that is only a dash becomes null',
  segment([page(0, [block({ starts_note: true, title: ' \u2014 ' })])])[0]!.title, null);
check('internal dashes survive',
  segment([page(0, [block({ starts_note: true, title: 'FB Insights \u2014 the rest' })])])[0]!.title, 'FB Insights \u2014 the rest');

console.log('\nedge cases');
check('a page with no header at all still yields one note', segment([page(0, [block()])]).length, 1);
check('empty batch yields nothing', segment([]).length, 0);
check('pages are ordered by idx regardless of input order',
  segment([page(1, [block({ transcript: 'second' })]), page(0, [block({ starts_note: true, transcript: 'first' })])])[0]!.body,
  'first\n\nsecond');

console.log('\ndates carried forward through a notebook');
// Since a new note must carry a date, the only way a note ends up dateless is a
// date_text the parser cannot read — a garbled or unconventional header. Carry
// forward is the safety net for that, not the main path it was before.
{
  const notes = segment([
    page(0, [block({ starts_note: true, title: 'Lorem ipsum', date_text: 'July 17', date_precision: 'day', transcript: 'dolor sit amet' })]),
    page(1, [block({ starts_note: true, title: 'Tell me', date_text: 'thursday', transcript: 'optional password' })]),
    page(2, [block({ starts_note: true, title: 'Tell me', date_text: 'later that week', transcript: 'the quick brown fox' })]),
    page(3, [block({ starts_note: true, title: 'The vanishing spies', date_text: 'July 23', date_precision: 'day', transcript: 'blockers' })]),
  ]);
  check('the dated note keeps its own date', notes[0]!.writtenOn, '2026-07-17');
  check('its precision stays inferred, not sequence', notes[0]!.writtenOnPrecision, 'inferred');
  check('a note whose date text will not parse inherits', notes[1]!.writtenOn, '2026-07-17');
  check('and is marked as coming from order', notes[1]!.writtenOnPrecision, 'sequence');
  check('inheritance continues past one note', notes[2]!.writtenOn, '2026-07-17');
  check('a later dated note overrides the carry', notes[3]!.writtenOn, '2026-07-23');
  check('and keeps its own precision', notes[3]!.writtenOnPrecision, 'inferred');
}

{
  const notes = segment([
    page(0, [block({ starts_note: true, title: null, transcript: 'continues from an earlier notebook page' })]),
    page(1, [block({ starts_note: true, title: 'Dated', date_text: 'Aug 1', date_precision: 'day', transcript: 'lorem ipsum' })]),
  ]);
  check('a note before the first date stays null rather than inheriting backwards', notes[0]!.writtenOn, null);
  check('and carries no precision', notes[0]!.writtenOnPrecision, null);
  check('the later dated note is unaffected', notes[1]!.writtenOn, '2026-08-01');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
