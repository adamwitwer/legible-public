import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/legible'),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  /**
   * WebAuthn relying-party ID: the registrable domain, no scheme or port.
   * Passkeys are scoped to this — changing it invalidates every enrolled device.
   *
   * Render injects the service's own public hostname, so on Render this cannot
   * drift from the URL the browser actually used. That matters because the
   * browser reports an RP ID mismatch only as a generic "could not create
   * credential" — there is no error that names the cause. An explicit RP_ID
   * still wins, which is what a custom domain needs.
   */
  rpId: process.env.RP_ID ?? process.env.RENDER_EXTERNAL_HOSTNAME ?? 'localhost',
  rpName: process.env.RP_NAME ?? 'Legible',
  /** Full origin(s) the browser will send. Must include scheme and port. */
  origin: (process.env.ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim()),

  /**
   * One-time code that authorises enrolling the FIRST passkey.
   *
   * The dev fallback must never reach production. The hatch is normally shut —
   * it only opens when no credential exists for the current RP ID — but a
   * custom-domain move produces exactly that state on its own, and at that
   * moment this code is the only thing between a stranger and the archive.
   * Render sets it via `generateValue: true`; if that is ever cleared, fail to
   * start rather than fall back to a value published in this repo.
   */
  enrollCode: (() => {
    const v = process.env.ENROLL_CODE;
    if (v) return v;
    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      throw new Error(
        'refusing to start in production without ENROLL_CODE: the development ' +
          'fallback is public, and it authorises enrolling a passkey whenever no ' +
          'credential exists for this RP ID',
      );
    }
    return 'dev-enroll';
  })(),

  sessionDays: Number(process.env.SESSION_DAYS ?? 90),
  /** Serve the built PWA from this server (production single-origin deploy). */
  serveStatic: process.env.SERVE_STATIC === 'true',

  /**
   * Where page images live in development when R2 is not configured. Anchored to
   * the repo rather than cwd, so `npm run dev` (cwd=server/) and `npm start`
   * (cwd=repo root) put blobs in the same place.
   */
  blobRoot:
    process.env.BLOB_ROOT ??
    resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.data', 'blobs')),

  r2: {
    bucket: process.env.R2_BUCKET ?? '',
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    keyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secret: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Handwriting is the hard case; accuracy compounds over a decades-long archive. */
  ocrModel: process.env.OCR_MODEL ?? 'claude-opus-5',
  /** 0 disables the in-process worker (useful in tests). */
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
};

export const isProd = env.nodeEnv === 'production';
