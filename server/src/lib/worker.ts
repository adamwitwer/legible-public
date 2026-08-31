import { sql } from '../db/index.js';
import { env } from './env.js';
import { readPage } from './ocr.js';
import { claim, enqueue, fail, succeed } from './queue.js';
import { segment, type PageOcr } from './segment.js';
import { storage } from './storage.js';

const KINDS = ['ocr_page', 'segment_batch'];

async function runOcrPage(payload: { pageId: string }) {
  const [page] = await sql<
    { id: string; batch_id: string; idx: number; storage_key: string; content_type: string }[]
  >`select id, batch_id, idx, storage_key, content_type from pages where id = ${payload.pageId}`;
  if (!page) return;

  await sql`update pages set ocr_status = 'running' where id = ${page.id}`;

  const totalRows = await sql<{ total: string }[]>`
    select count(*)::text as total from pages where batch_id = ${page.batch_id}
  `;
  const total = totalRows[0]?.total ?? '1';
  // Give the model the preceding note's title so a headerless page is understood
  // as a continuation rather than an orphan.
  const [prev] = await sql<{ title: string | null }[]>`
    select ocr_json->'blocks'->-1->>'title' as title
    from pages
    where batch_id = ${page.batch_id} and idx < ${page.idx} and ocr_json is not null
    order by idx desc limit 1
  `;

  const image = await storage.get(page.storage_key);
  const { result, model } = await readPage(image, page.content_type as any, {
    pageNumber: page.idx + 1,
    totalPages: Number(total),
    previousTitle: prev?.title ?? null,
  });

  await sql`
    update pages set
      ocr_status = 'done', ocr_json = ${sql.json(result as any)},
      ocr_model = ${model}, ocr_run_at = now(),
      confidence = ${result.confidence ?? null}, error = null
    where id = ${page.id}
  `;

  // Last page in the batch to finish schedules segmentation.
  const remainingRows = await sql<{ remaining: string }[]>`
    select count(*)::text as remaining from pages
    where batch_id = ${page.batch_id} and ocr_status in ('pending','running')
  `;
  if (Number(remainingRows[0]?.remaining ?? 0) === 0) {
    await sql`update batches set status = 'review' where id = ${page.batch_id}`;
    await enqueue('segment_batch', { batchId: page.batch_id });
  }
}

async function runSegmentBatch(payload: { batchId: string }) {
  const pages = await sql<{ id: string; idx: number; shot_at: string | null; ocr_json: any }[]>`
    select id, idx, shot_at, ocr_json from pages
    where batch_id = ${payload.batchId} and ocr_json is not null
    order by idx
  `;
  const proposed = segment(
    pages.map((p): PageOcr => ({ pageId: p.id, idx: p.idx, shotAt: p.shot_at, ocr: p.ocr_json })),
  );
  // Segmentation is derived and cheap — cached on the batch so review is instant,
  // and re-derivable without ever re-calling the OCR API.
  await sql`
    update batches set status = 'review', proposed = ${sql.json(proposed as any)}
    where id = ${payload.batchId}
  `;
}

async function tick(): Promise<boolean> {
  const job = await claim(KINDS);
  if (!job) return false;
  try {
    if (job.kind === 'ocr_page') await runOcrPage(job.payload);
    else if (job.kind === 'segment_batch') await runSegmentBatch(job.payload);
    await succeed(job.id);
  } catch (err) {
    const exhausted = await fail(job.id, err, job.attempts, job.max_attempts);
    if (exhausted && job.kind === 'ocr_page') {
      await sql`
        update pages set ocr_status = 'failed', error = ${String((err as Error)?.message ?? err)}
        where id = ${job.payload.pageId}
      `;
    }
    console.error(`job ${job.id} (${job.kind}) failed:`, err);
  }
  return true;
}

/** In-process loop. Promote to a Render Background Worker if volume ever needs it. */
export function startWorker() {
  if (env.workerConcurrency <= 0) return () => {};
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const did = await tick();
        if (!did) await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        console.error('worker loop error:', err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  for (let i = 0; i < env.workerConcurrency; i++) void loop();
  return () => { stopped = true; };
}

export { tick as runOneJob };
