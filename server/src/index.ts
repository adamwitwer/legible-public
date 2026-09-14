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
 * Security headers.
 *
 * `style-src` keeps 'unsafe-inline' because React sets element styles directly.
 * Fonts are self-hosted (@fontsource, imported by web/src/styles.css), so style
 * and font sources are this origin only. They used to name fonts.googleapis.com
 * and fonts.gstatic.com; those went because the service worker cannot cache a
 * cross-origin font under connect-src 'self' — the app opened offline in system
 * fonts — and because a private archive should not announce page views to a
 * third party. If a stylesheet ever comes from another host again: 'unsafe-inline'
 * does NOT cover an external URL, and omitting the host degrades the app to
 * fallback fonts silently rather than with an error.
 *
 * frame-ancestors 'none' is the one that matters most here: it stops the app
 * being framed for clickjacking, and unlike X-Frame-Options every current
 * browser honours it.
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
 * Rate limiting, and an honest account of what it buys.
 *
 * This floor is keyed per IP, and under trustProxy that key comes from a header
 * the caller writes. Anyone willing to rotate X-Forwarded-For walks past it. So
 * treat it as protection against runaway clients and accidents, NOT against a
 * deliberate attacker — measured: 305 requests from one spoofed IP get 429,
 * the same 305 spread over rotated IPs do not.
 *
 * Nothing security-critical is allowed to depend on it. The one limit that has
 * to hold — wrong enroll codes — is keyed to a constant and charged only on
 * failure, in routes/auth.ts.
 *
 * The health check is exempt, query string included: Render polls
 * `healthCheckPath` and a throttled health check reads as an unhealthy service
 * and gets the instance recycled.
 */
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  allowList: (req) => req.url.split('?')[0] === '/api/health',
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
    // The icon is favicon.svg, and index.html points at it. A browser old
    // enough to ignore that link still asks for /favicon.ico unprompted, and
    // the SPA fallback below would hand it a 200 with an HTML body — an icon
    // that fails as a decode error rather than as a missing file. 404 is the
    // honest answer, and it is what makes the browser fall back cleanly.
    if (req.url === '/favicon.ico') return reply.code(404).send();
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
