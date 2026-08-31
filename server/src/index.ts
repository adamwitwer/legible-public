import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
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
  /**
   * Render terminates TLS ahead of us and puts the caller in X-Forwarded-For,
   * so without this every request looks like it came from the proxy — and a
   * per-IP rate limit keyed to one shared address locks the real user out the
   * moment anyone else is noisy. Trusting the header is the lesser evil, but it
   * IS attacker-controlled, so a per-IP cap can be sidestepped by rotating it.
   * That is why the enroll-code limit in routes/auth.ts is keyed globally
   * instead: it is the one cap that has to hold, and it cannot be rotated past.
   */
  trustProxy: true,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * Security headers. The archive is private, the app is same-origin, and it
 * loads nothing from anywhere else — so the policy can be strict.
 *
 * `style-src` keeps 'unsafe-inline' because React sets element styles directly;
 * everything else is 'self' or 'none'. frame-ancestors 'none' is the one that
 * matters most here: it stops the app being framed for clickjacking, and unlike
 * X-Frame-Options it is honoured by every current browser.
 */
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  // One year, and only where TLS actually terminates in front of us.
  strictTransportSecurity: isProd
    ? { maxAge: 31536000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false, // would block the page images we serve ourselves
});

/**
 * Rate limiting. There was none, and the enroll code is guessable in unlimited
 * attempts without it — see the ceremony limits in routes/auth.ts, which are
 * tighter than this global floor.
 *
 * The health check is exempt: Render polls it, and a throttled health check
 * reads as an unhealthy service and gets the instance recycled.
 */
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/api/health',
});

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
