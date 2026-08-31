import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../lib/env.js';
import { sql } from './index.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

async function main() {
  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(migrationsDir, file), 'utf8');
    process.stdout.write(`  applying ${file} ... `);
    await sql.begin(async (tx) => {
      // Bound as a transaction-local setting so a migration can read the RP ID the
      // app is actually running under — reachable from plain SQL as
      // current_setting('legible.rp_id'), without interpolating it into the text.
      await tx`select set_config('legible.rp_id', ${env.rpId}, true)`;
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file})`;
    });
    process.stdout.write('ok\n');
    ran++;
  }

  console.log(ran === 0 ? 'Migrations: already up to date.' : `Migrations: applied ${ran}.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await sql.end();
  process.exit(1);
});
