import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL);

// Mirrors the four sample pages in images/: p1 opens a note, p2 continues it
// under a bare subject header, p3 finishes it in its upper block and opens a
// dated note halfway down, and p4 opens a third at the top of the page.
// See the appendix in ARCHITECTURE.md.
const pages = [
  { blocks: [{ starts_note: true, title: 'Meeting Title', date_text: 'Aug 1', date_precision: 'day',
      transcript: 'Lorem ipsum\ndolor sit amet\ndolore provident\n\nThe quick brown\nfox jumps over the\nlazy dog\n\nThe vanishing spies\njust something I read' }],
    annotations: [{ side: 'right', rotation: 0, kind: 'note', anchor: 'dolor sit amet', text: 'right-margin note here' }] },
  // "Tell me" is heading-shaped but carries no date, so it stays a subject inside
  // the note above. The struck "Aug 2" is body text, not this note's header date.
  { blocks: [{ starts_note: false, title: null, date_text: null, date_precision: null,
      transcript: 'that is just how some\nthings do not\nmaterialize\n\n~~Aug 2~~\nGive me one little\nblip and I’ll totally\nflip Yeahhhh…\n\nTell me' }],
    annotations: [{ side: 'right', rotation: 90, kind: 'note', anchor: 'that is just how some', text: 'FB Insights!' }] },
  // Page 3: finishes note 1, then starts note 2 halfway down.
  { blocks: [
      { starts_note: false, title: null, date_text: null, date_precision: null,
        transcript: 'it’s nothing but\nskies and\nI will be one lonely\nguy' },
      { starts_note: true, title: 'The Second Coming', date_text: 'Aug 2', date_precision: 'day',
        transcript: 'Turning and turning\nin the widening gyre' },
    ],
    annotations: [] },
  { blocks: [{ starts_note: true, title: 'Love makes your soul crawl out from its hiding place',
      date_text: 'Aug 3', date_precision: 'day',
      transcript: 'Love makes your soul crawl out from its hiding place' }], annotations: [] },
];

const [batch] = await sql`select id from batches order by created_at desc limit 1`;
for (const [idx, p] of pages.entries()) {
  await sql`update pages set ocr_status='done', ocr_json=${sql.json({ ...p, confidence: 0.94, illegible: [] })},
            ocr_model='stub', ocr_run_at=now(), confidence=0.94
            where batch_id=${batch.id} and idx=${idx}`;
}
console.log(`stubbed OCR for ${pages.length} pages in batch ${batch.id}`);
await sql.end();
