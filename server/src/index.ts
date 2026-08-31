import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { env, isProd } from './lib/env.js';
import authRoutes from './routes/auth.js';
import captureRoutes from './routes/capture.js';
import noteRoutes from './routes/notes.js';
import syncRoutes from './routes/sync.js';
import { sql } from './db/index.js';
import { startWorker } from './lib/worker.js';

const app = Fastify({
  logger: isProd ? true : { transport: { target: 'pino-pretty' } },
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

app.get('/api/health', async () => {
  await sql`select 1`;
  return { ok: true, env: env.nodeEnv };
});

await app.register(authRoutes);
await app.register(noteRoutes);
await app.register(syncRoutes);
await app.register(captureRoutes);

// OCR runs in-process: one user does not need a separate worker service.
const stopWorker = startWorker();

// In production one service serves both the API and the PWA. Same origin keeps
// WebAuthn and the session cookie simple — a split origin would force the RP ID
// up to onrender.com, which is a public suffix and therefore not usable.
if (env.serveStatic) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  const { default: fastifyStatic } = await import('@fastify/static');
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.sendFile('index.html');
  });
}

const shutdown = async () => {
  stopWorker();
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: env.port, host: '0.0.0.0' });
