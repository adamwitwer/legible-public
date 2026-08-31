import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { enqueue } from '../lib/queue.js';
import { segment, type PageOcr } from '../lib/segment.js';
import { pageKey, storage } from '../lib/storage.js';
import { requireAuth } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function captureRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/capture/batches', async () => {
    const id = randomUUID();
    await sql`insert into batches (id) values (${id})`;
    return { id, status: 'uploading' };
  });

  /**
   * One page image. The note appears immediately as pending and fills in when the
   * worker finishes — you are never blocked watching a spinner.
   */
  app.post<{ Params: { id: string } }>('/api/capture/batches/:id/pages', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_batch_id' });

    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'no_file' });
    const buffer: Buffer = await file.toBuffer();
    if (!buffer.length) return reply.code(400).send({ error: 'empty_file' });

    const contentType: string = file.mimetype ?? 'image/jpeg';
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) {
      return reply.code(415).send({ error: 'unsupported_type', contentType });
    }

    const shotAtRaw = (file.fields?.shot_at as any)?.value;
    const shotAt = shotAtRaw && !Number.isNaN(Date.parse(shotAtRaw)) ? new Date(shotAtRaw) : null;

    const nextRows = await sql<{ next: string }[]>`
      select coalesce(max(idx) + 1, 0)::text as next from pages where batch_id = ${req.params.id}
    `;
    const idx = Number(nextRows[0]?.next ?? 0);
    const id = randomUUID();
    const key = pageKey(id);

    await storage.put(key, buffer, contentType);
    await sql`
      insert into pages (id, batch_id, idx, storage_key, content_type, bytes, shot_at)
      values (${id}, ${req.params.id}, ${idx}, ${key}, ${contentType}, ${buffer.length}, ${shotAt})
    `;
    // A batch reaches 'review' as soon as the OCR queue drains, which on a phone
    // happens while you are still in the camera taking the next page. Adding a page
    // reopens the batch rather than being ignored: status goes back to 'ocr' and the
    // cached boundaries are dropped, because they no longer describe every page.
    await sql`
      update batches set status = 'ocr', proposed = null
      where id = ${req.params.id} and status in ('uploading', 'ocr', 'review')
    `;
    await enqueue('ocr_page', { pageId: id });

    return { id, idx, bytes: buffer.length, ocr_status: 'pending' };
  });

  app.get<{ Params: { id: string } }>('/api/capture/batches/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_batch_id' });
    const [batch] = await sql<{ id: string; status: string; proposed: any }[]>`
      select id, status, proposed from batches where id = ${req.params.id}
    `;
    if (!batch) return reply.code(404).send({ error: 'not_found' });

    const pages = await sql`
      select id, idx, ocr_status, confidence, error,
             jsonb_array_length(coalesce(ocr_json->'blocks','[]'::jsonb)) as blocks
      from pages where batch_id = ${req.params.id} order by idx
    `;
    return { batch: { id: batch.id, status: batch.status }, pages, proposed: batch.proposed ?? [] };
  });

  /** Re-derive boundaries from stored OCR. Costs nothing — no API call. */
  app.post<{ Params: { id: string } }>('/api/capture/batches/:id/resegment', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_batch_id' });
    const pages = await sql<{ id: string; idx: number; shot_at: string | null; ocr_json: any }[]>`
      select id, idx, shot_at, ocr_json from pages
      where batch_id = ${req.params.id} and ocr_json is not null order by idx
    `;
    const proposed = segment(
      pages.map((p): PageOcr => ({ pageId: p.id, idx: p.idx, shotAt: p.shot_at, ocr: p.ocr_json })),
    );
    await sql`update batches set proposed = ${sql.json(proposed as any)} where id = ${req.params.id}`;
    return { proposed };
  });

  /**
   * Turn reviewed boundaries into real notes. The client sends back the proposed
   * set, possibly edited — merged, split, retitled, redated.
   */
  app.post<{ Params: { id: string }; Body: { notes: any[] } }>(
    '/api/capture/batches/:id/commit',
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_batch_id' });
      const incoming = req.body?.notes;
      if (!Array.isArray(incoming) || !incoming.length) return reply.code(400).send({ error: 'no_notes' });

      const created = await sql.begin(async (tx) => {
        const ids: string[] = [];
        for (const n of incoming) {
          const noteId = randomUUID();
          const now = new Date().toISOString();
          await tx`
            insert into notes (
              id, kind, title, body, body_ocr_raw, written_on, written_on_precision,
              tags, ocr_status, confidence, created_at, updated_at
            ) values (
              ${noteId}, 'scan', ${n.title ?? null}, ${n.body ?? ''}, ${n.body ?? ''},
              ${n.writtenOn ?? null}, ${n.writtenOnPrecision ?? null},
              ${n.tags ?? []}, 'done', ${n.confidence ?? null}, ${now}, ${now}
            )
          `;
          for (const [i, p] of (n.pages ?? []).entries()) {
            await tx`
              insert into note_pages (note_id, page_id, idx, starts_at)
              values (${noteId}, ${p.pageId}, ${i}, ${p.startsAt ?? null})
              on conflict do nothing
            `;
          }
          for (const a of n.annotations ?? []) {
            await tx`
              insert into annotations (id, note_id, page_id, side, rotation, anchor, kind, text)
              values (${randomUUID()}, ${noteId}, ${a.pageId ?? null}, ${a.side ?? null},
                      ${a.rotation ?? 0}, ${a.anchor ?? null}, ${a.kind ?? 'note'}, ${a.text})
            `;
          }
          ids.push(noteId);
        }
        await tx`update batches set status = 'committed', committed_at = now() where id = ${req.params.id}`;
        return ids;
      });

      return { created };
    },
  );

  /**
   * Discard a batch and everything it holds: rows, queued jobs, and the page
   * images in storage. This is the "that capture went wrong, throw it away"
   * path, and the only way page images ever leave storage.
   *
   * It refuses once any page is referenced by a note. note_pages cascades on
   * page delete, so removing a committed batch's pages would strip the page
   * linkage off real notes — the note text would survive, its scans would
   * silently become unviewable, and nothing would raise. Checking the
   * references rather than batch.status catches that however it arose.
   */
  app.delete<{ Params: { id: string } }>('/api/capture/batches/:id', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_batch_id' });

    const [batch] = await sql<{ id: string; status: string }[]>`
      select id, status from batches where id = ${req.params.id}
    `;
    if (!batch) return reply.code(404).send({ error: 'not_found' });

    const pages = await sql<{ id: string; storage_key: string }[]>`
      select id, storage_key from pages where batch_id = ${req.params.id}
    `;

    const [used] = await sql<{ notes: number }[]>`
      select count(distinct note_id)::int as notes from note_pages
      where page_id in (select id from pages where batch_id = ${req.params.id})
    `;
    const notes = used?.notes ?? 0;
    if (notes > 0) {
      return reply.code(409).send({
        error: 'batch_in_use',
        notes,
        message: `${notes} note(s) still reference these pages; delete those notes first`,
      });
    }

    // Blobs first. Deleting the rows first would lose the storage keys, leaving
    // objects that nothing can ever name again; an object store delete is
    // idempotent, so failing here is safe to retry.
    const results = await Promise.allSettled(pages.map((p) => storage.delete(p.storage_key)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) {
      return reply.code(502).send({
        error: 'storage_delete_failed',
        failed,
        message: `${failed} of ${pages.length} image(s) could not be removed; nothing was deleted, retry`,
      });
    }

    const ids = pages.map((p) => p.id);
    await sql.begin(async (tx) => {
      // Jobs reference pages through their payload, with no foreign key.
      if (ids.length) await tx`delete from jobs where payload->>'pageId' = any(${ids})`;
      await tx`delete from batches where id = ${req.params.id}`; // pages cascade
    });

    return { deleted: { batch: req.params.id, pages: pages.length, status: batch.status } };
  });

  /** Images stream through the authenticated API — no URL works outside a session. */
  app.get<{ Params: { id: string } }>('/api/pages/:id/image', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_page_id' });
    const [page] = await sql<{ storage_key: string; content_type: string }[]>`
      select storage_key, content_type from pages where id = ${req.params.id}
    `;
    if (!page) return reply.code(404).send({ error: 'not_found' });
    const body = await storage.get(page.storage_key);
    return reply.header('content-type', page.content_type).header('cache-control', 'private, max-age=86400').send(body);
  });

  /** Page images for a note, so a search hit can show the original. */
  app.get<{ Params: { id: string } }>('/api/notes/:id/pages', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    const pages = await sql`
      select p.id, np.idx, np.starts_at, p.confidence
      from note_pages np join pages p on p.id = np.page_id
      where np.note_id = ${req.params.id} order by np.idx
    `;
    const annotations = await sql`
      select id, page_id, side, rotation, anchor, kind, text
      from annotations where note_id = ${req.params.id}
    `;
    return { pages, annotations };
  });
}
