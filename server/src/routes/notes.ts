import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { requireAuth } from './auth.js';
import { findBoundaryPage, splitBody, titleOf } from '../lib/split.js';
import { bodyHash, summarizeNote, SummaryRefused } from '../lib/summarize.js';
import { env } from '../lib/env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IncomingNote = {
  id: string;
  kind?: 'typed' | 'scan';
  title?: string | null;
  body?: string;
  written_on?: string | null;
  written_on_precision?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at: string;
  deleted_at?: string | null;
};

export default async function noteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * Batch upsert. Keyed by client-generated UUID so a queued offline write can
   * be replayed safely. Last-write-wins on updated_at; the losing body is kept
   * as a revision rather than discarded.
   */
  app.post<{ Body: { notes: IncomingNote[] } }>('/api/notes', async (req, reply) => {
    const incoming = req.body?.notes ?? [];
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return reply.code(400).send({ error: 'no_notes' });
    }
    if (incoming.length > 500) return reply.code(413).send({ error: 'batch_too_large' });
    for (const n of incoming) {
      if (!UUID.test(n.id ?? '')) return reply.code(400).send({ error: 'bad_id', id: n.id });
      if (!n.updated_at) return reply.code(400).send({ error: 'missing_updated_at', id: n.id });
    }

    const saved = await sql.begin(async (tx) => {
      const out: any[] = [];

      for (const n of incoming) {
        const [existing] = await tx<{ title: string | null; body: string; updated_at: string }[]>`
          select title, body, updated_at from notes where id = ${n.id} for update
        `;

        // Stale write: keep it as a revision so nothing is lost, but don't apply it.
        if (existing && new Date(n.updated_at) <= new Date(existing.updated_at)) {
          if ((n.body ?? '') !== existing.body) {
            await tx`
              insert into note_revisions (note_id, title, body)
              values (${n.id}, ${n.title ?? null}, ${n.body ?? ''})
            `;
          }
          continue;
        }

        // Snapshot the version we're about to overwrite.
        if (existing) {
          await tx`
            insert into note_revisions (note_id, title, body)
            values (${n.id}, ${existing.title}, ${existing.body})
          `;
        }

        const [row] = await tx`
          insert into notes (
            id, kind, title, body, written_on, written_on_precision,
            tags, created_at, updated_at, deleted_at
          ) values (
            ${n.id},
            ${n.kind ?? 'typed'},
            ${n.title ?? null},
            ${n.body ?? ''},
            ${n.written_on ?? null},
            ${n.written_on_precision ?? null},
            ${n.tags ?? []},
            ${n.created_at ?? new Date().toISOString()},
            ${n.updated_at},
            ${n.deleted_at ?? null}
          )
          on conflict (id) do update set
            kind = excluded.kind,
            title = excluded.title,
            body = excluded.body,
            written_on = excluded.written_on,
            written_on_precision = excluded.written_on_precision,
            tags = excluded.tags,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at
          returning id, seq::text as seq, updated_at
        `;
        out.push(row);
      }
      return out;
    });

    return { saved };
  });

  /**
   * Break one note in two at a character offset in its body.
   *
   * The repair for a note that swallowed the one after it — which is now the
   * failure mode of the "a new note carries a date" rule: forget the date and
   * the next meeting is absorbed silently rather than split wrongly.
   *
   * Pages are never taken away from the original. A page can belong to two
   * notes (that is what starts_at is for), and attaching one to both is
   * harmless where losing the image behind a note is not.
   */
  app.post<{ Params: { id: string }; Body: { at?: number } }>(
    '/api/notes/:id/split',
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
      const at = Number(req.body?.at);
      if (!Number.isInteger(at) || at < 0) return reply.code(400).send({ error: 'bad_offset' });

      const [note] = await sql<
        { id: string; kind: string; body: string; title: string | null;
          written_on: string | null; tags: string[] }[]
      >`
        select id, kind, body, title, written_on::text as written_on, tags
        from notes where id = ${req.params.id} and deleted_at is null
      `;
      if (!note) return reply.code(404).send({ error: 'not_found' });

      const parts = splitBody(note.body, at);
      if (!parts) {
        return reply.code(400).send({
          error: 'nothing_to_split',
          message: 'that point leaves one side empty',
        });
      }
      const { head, tail } = parts;

      const pages = await sql<{ page_id: string; idx: number; ocr_json: any }[]>`
        select np.page_id, np.idx, p.ocr_json
        from note_pages np join pages p on p.id = np.page_id
        where np.note_id = ${note.id} order by np.idx
      `;

      const boundary = findBoundaryPage(pages, tail);
      const carried = boundary >= 0 ? pages.slice(boundary) : pages;

      const newId = randomUUID();
      const title = titleOf(tail);

      await sql.begin(async (tx) => {
        await tx`
          insert into note_revisions (note_id, title, body)
          values (${note.id}, ${note.title}, ${note.body})
        `;
        await tx`update notes set body = ${head}, updated_at = now() where id = ${note.id}`;
        await tx`
          insert into notes (
            id, kind, title, body, body_ocr_raw, written_on, written_on_precision,
            tags, ocr_status, created_at, updated_at
          ) values (
            ${newId}, ${note.kind}, ${title}, ${tail}, ${tail},
            ${note.written_on},
            -- the date is the one it was absorbed under, not one it earned
            ${note.written_on ? 'sequence' : null},
            ${note.tags}, ${note.kind === 'scan' ? 'done' : null}, now(), now()
          )
        `;
        for (const [i, p] of carried.entries()) {
          await tx`
            insert into note_pages (note_id, page_id, idx, starts_at)
            values (${newId}, ${p.page_id}, ${i}, ${i === 0 ? tail.slice(0, 80) : null})
            on conflict do nothing
          `;
        }
      });

      return {
        id: newId,
        title,
        pages: carried.length,
        // false means the boundary could not be located and both notes now
        // reference every page, rather than the images being divided.
        pages_divided: boundary >= 0,
      };
    },
  );

  /**
   * Summarize a note, on request only.
   *
   * Summarizes the server's copy of the body, so the client pushes first — the
   * same contract as split. The hash stamped is of the body actually sent to the
   * model, so an edit that lands mid-request still reads as stale afterwards.
   *
   * NEVER set updated_at here. Sync is last-write-wins on updated_at: a push
   * whose updated_at is not newer than the stored one is kept as a revision and
   * NOT applied. If this bumped updated_at, anything typed while the model was
   * working would be pushed, lose that comparison, and land silently in history
   * instead of the note. The seq trigger still fires on this UPDATE, which is
   * all sync needs to carry the summary down.
   *
   * Its own tight limit: each call spends money, and a stuck client retrying in
   * a loop under the global 300/min floor would spend a lot of it.
   */
  app.post<{ Params: { id: string } }>(
    '/api/notes/:id/summary',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
      if (!env.anthropicApiKey) return reply.code(503).send({ error: 'no_model_key' });

      const [note] = await sql<
        { id: string; kind: 'typed' | 'scan'; title: string | null; body: string; written_on: string | null }[]
      >`
        select id, kind, title, body, written_on::text as written_on
        from notes where id = ${req.params.id} and deleted_at is null
      `;
      if (!note) return reply.code(404).send({ error: 'not_found' });
      if (!note.body.trim()) {
        return reply.code(400).send({ error: 'nothing_to_summarize', message: 'the note is empty' });
      }

      const annotations = await sql<
        { side: string | null; kind: string | null; anchor: string | null; text: string }[]
      >`
        select a.side, a.kind, a.anchor, a.text
        from annotations a
        left join note_pages np on np.note_id = a.note_id and np.page_id = a.page_id
        where a.note_id = ${note.id}
        order by np.idx nulls last, a.anchor nulls last
      `;

      let result: { summary: string; model: string };
      try {
        result = await summarizeNote({
          kind: note.kind, title: note.title, writtenOn: note.written_on, body: note.body, annotations,
        });
      } catch (e) {
        if (e instanceof SummaryRefused) return reply.code(422).send({ error: 'refused', message: e.message });
        req.log.error(e, 'summary failed');
        return reply.code(502).send({ error: 'model_failed', message: (e as Error).message });
      }

      const [row] = await sql`
        update notes
        set summary = ${result.summary},
            summary_body_hash = ${bodyHash(note.body)},
            summary_model = ${result.model},
            summarized_at = now()
        where id = ${note.id} and deleted_at is null
        returning summary, summary_body_hash, summary_model, summarized_at, seq::text as seq
      `;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return row;
    },
  );

  /** Drop a note's summary. Same rule as above: no updated_at. */
  app.delete<{ Params: { id: string } }>('/api/notes/:id/summary', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    const [row] = await sql`
      update notes
      set summary = null, summary_body_hash = null, summary_model = null, summarized_at = null
      where id = ${req.params.id} and deleted_at is null
      returning seq::text as seq
    `;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/notes/:id/revisions', async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: 'bad_id' });
    const rows = await sql`
      select id::text as id, title, body, saved_at
      from note_revisions where note_id = ${req.params.id}
      order by saved_at desc limit 50
    `;
    return { revisions: rows };
  });

  /**
   * Server-side full-text search. The client searches its local index instead —
   * this exists for the >25k-note fallback and as a correctness check on it.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { hits: [] };
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const hits = await sql`
      select id, title, written_on, updated_at,
             ts_rank(search, websearch_to_tsquery('english', ${q})) as rank
      from notes
      where deleted_at is null and search @@ websearch_to_tsquery('english', ${q})
      order by rank desc, updated_at desc
      limit ${limit}
    `;
    return { hits };
  });
}
