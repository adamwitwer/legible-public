import { sql } from '../db/index.js';

export type Job = { id: string; kind: string; payload: any; attempts: number; max_attempts: number };

/**
 * Note `sql.json(...)` rather than `JSON.stringify(...)::jsonb`. postgres.js
 * JSON-encodes a string parameter bound to jsonb, so stringifying first stores a
 * JSON *string* containing JSON. Reading it back yields a string, `payload.pageId`
 * is undefined, and the job silently no-ops and marks itself done.
 */
export async function enqueue(kind: string, payload: unknown, runAfter?: Date) {
  const [row] = await sql<{ id: string }[]>`
    insert into jobs (kind, payload, run_after)
    values (${kind}, ${sql.json(payload as any)}, ${runAfter ?? new Date()})
    returning id::text as id
  `;
  return row!.id;
}

/**
 * Claim one job. SKIP LOCKED means two workers never take the same row, which
 * costs nothing when there is only one and is correct if we ever scale out.
 */
export async function claim(kinds: string[]): Promise<Job | null> {
  const [row] = await sql<Job[]>`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'pending' and run_after <= now() and kind = any(${kinds})
      order by id
      for update skip locked
      limit 1
    )
    returning id::text as id, kind, payload, attempts, max_attempts
  `;
  return row ?? null;
}

export async function succeed(id: string) {
  await sql`update jobs set status = 'done', last_error = null where id = ${id}::bigint`;
}

export async function fail(id: string, err: unknown, attempts: number, maxAttempts: number) {
  const message = err instanceof Error ? err.message : String(err);
  const exhausted = attempts >= maxAttempts;
  await sql`
    update jobs set
      status = ${exhausted ? 'failed' : 'pending'},
      last_error = ${message},
      run_after = now() + (${Math.min(2 ** attempts, 60)} || ' seconds')::interval
    where id = ${id}::bigint
  `;
  return exhausted;
}
