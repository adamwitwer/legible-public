import { readFile } from 'node:fs/promises';
import { readPage } from '../server/dist/lib/ocr.js';

const [file, prevTitle, pageNo, total] = process.argv.slice(2);
const { result, usage } = await readPage(await readFile(file), 'image/jpeg', {
  pageNumber: Number(pageNo ?? 1),
  totalPages: Number(total ?? 1),
  previousTitle: prevTitle || null,
});
const cost = (usage.input_tokens * 5 + usage.output_tokens * 25) / 1e6;
console.log(`${file}  in=${usage.input_tokens} out=${usage.output_tokens}  ~$${cost.toFixed(4)}`);
for (const b of result.blocks) {
  console.log(`  ${b.starts_note ? `NEW NOTE: "${b.title}"` : '(continues)'}  ${b.transcript.split('\n')[0].slice(0, 50)}…`);
}
for (const a of result.annotations) console.log(`  margin ${a.side}${a.rotation ? `@${a.rotation}°` : ''} [${a.kind}] "${a.text}"`);
