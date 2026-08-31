import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env, isProd } from './env.js';

/**
 * Page images are served through the authenticated API rather than signed URLs.
 * For one user that is simpler and strictly more private: no URL exists that
 * works outside a live session, so nothing can leak by being forwarded.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Dev default: no Cloudflare account needed to work on the pipeline. */
class LocalStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(join(this.root, key));
    // Never let a crafted key escape the blob root.
    if (!p.startsWith(resolve(this.root))) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch(() => {});
  }
}

/**
 * Production: Cloudflare R2 over the S3 API.
 *
 * The SDK is imported dynamically so local dev never installs or loads it.
 * That has to be `await import`, not `require` — this package is ESM
 * ("type": "module"), where `require` is not defined at all, so a `require`
 * here would not fail at build time or at startup: it would throw
 * ReferenceError on the first page upload, in production, only.
 */
class R2Storage implements Storage {
  private client: Promise<any> | null = null;

  constructor(
    private bucket: string,
    private cfg: { accountId: string; keyId: string; secret: string },
  ) {}

  /** One client, created on first use and reused after. */
  private connect() {
    this.client ??= import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: 'auto',
          endpoint: `https://${this.cfg.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: this.cfg.keyId, secretAccessKey: this.cfg.secret },
        }),
    );
    return this.client;
  }

  async put(key: string, body: Buffer, contentType: string) {
    const [client, { PutObjectCommand }] = await Promise.all([
      this.connect(),
      import('@aws-sdk/client-s3'),
    ]);
    await client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string) {
    const [client, { GetObjectCommand }] = await Promise.all([
      this.connect(),
      import('@aws-sdk/client-s3'),
    ]);
    const res = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of res.Body as AsyncIterable<Buffer>) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async delete(key: string) {
    const [client, { DeleteObjectCommand }] = await Promise.all([
      this.connect(),
      import('@aws-sdk/client-s3'),
    ]);
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function build(): Storage {
  if (env.r2.bucket && env.r2.accountId && env.r2.keyId && env.r2.secret) {
    return new R2Storage(env.r2.bucket, {
      accountId: env.r2.accountId,
      keyId: env.r2.keyId,
      secret: env.r2.secret,
    });
  }
  // Render's filesystem is ephemeral: every deploy would silently drop the page
  // images while their rows stayed in Postgres, leaving notes whose scans 404.
  // Refuse to start rather than lose the archive one deploy at a time.
  if (isProd) {
    throw new Error(
      'refusing to start in production without R2: set R2_BUCKET, R2_ACCOUNT_ID, ' +
        'R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (blob storage on the local ' +
        'filesystem does not survive a deploy)',
    );
  }
  return new LocalStorage(env.blobRoot);
}

export const storage = build();
export const usingR2 = Boolean(env.r2.bucket);

/** Stable, unguessable key. Sharded so a directory listing stays sane. */
export const pageKey = (pageId: string) => `pages/${pageId.slice(0, 2)}/${pageId}.jpg`;
