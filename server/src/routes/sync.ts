import type { FastifyInstance } from 'fastify';
import { sql } from '../db/index.js';
import { requireAuth } from './auth.js';

const PAGE = 500;

export default async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * Everything that changed after `since`, in seq order, tombstones included.
   * The client stores the returned cursor and passes it back next time.
   */
  app.get<{ Querystring: { since?: string } }>('/api/sync', async (req, reply) => {
    const since = req.query.since ?? '0';
    if (!/^\d+$/.test(since)) return reply.code(400).send({ error: 'bad_cursor' });

    const rows = await sql`
      select id, kind, title, body, written_on, written_on_precision, tags,
             ocr_status, confidence,
             created_at, updated_at, deleted_at, seq::text as seq
      from notes
      where seq > ${since}::bigint
      order by seq asc
      limit ${PAGE}
    `;

    const cursor = rows.length ? rows[rows.length - 1]!.seq : since;
    return { notes: rows, cursor, more: rows.length === PAGE };
  });
}
