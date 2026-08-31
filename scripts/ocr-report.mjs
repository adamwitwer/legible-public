import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL);

const [batch] = await sql`select id, status from batches order by created_at desc limit 1`;
const pages = await sql`
  select idx, ocr_status, confidence, ocr_json, error from pages
  where batch_id = ${batch.id} order by idx`;

console.log(`batch ${batch.id}  status=${batch.status}\n${'='.repeat(78)}`);

for (const p of pages) {
  const j = p.ocr_json ?? {};
  console.log(`\n── PAGE ${p.idx + 1} ── ${p.ocr_status}  confidence ${p.confidence ?? '-'}`);
  if (p.error) { console.log(`   ERROR: ${p.error}`); continue; }
  for (const b of j.blocks ?? []) {
    const head = b.starts_note
      ? `┌ NEW NOTE: "${b.title ?? '(untitled)'}"${b.date_text ? `  date_text="${b.date_text}" (${b.date_precision})` : ''}`
      : '┌ (continues previous note)';
    console.log(`   ${head}`);
    console.log(b.transcript.split('\n').map((l) => `   │ ${l}`).join('\n'));
  }
  for (const a of j.annotations ?? []) {
    console.log(`   ✎ MARGIN ${a.side}${a.rotation ? ` @${a.rotation}°` : ''} [${a.kind}] "${a.text}"`);
    if (a.anchor) console.log(`     ↳ beside: "${a.anchor}"`);
  }
  if (j.illegible?.length) console.log(`   ? illegible: ${j.illegible.join('; ')}`);
}
await sql.end();
