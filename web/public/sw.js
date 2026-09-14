/**
 * Legible's service worker: the app opens with no signal.
 *
 * What it serves, and the one thing it must never touch:
 *
 *   navigations  NETWORK FIRST. A deploy lands the next time the app opens online;
 *                the cached shell is only the fallback. Cache-first here is how a
 *                phone ends up running last week's bundle with nothing to say so —
 *                the exact failure the build stamp in the header exists to catch.
 *   /assets/*    cache first. Vite content-hashes these names, so a URL never
 *                changes meaning; a new deploy is new URLs.
 *   icons, the manifest
 *                served from cache, refreshed in the background.
 *   /api/*       NEVER. Notes already live in the local replica (IndexedDB). A
 *                cached API response would be private data in a second store,
 *                outliving logout and answering for a session that has ended.
 *
 * The shell is refreshed on every online navigation: the HTML is re-cached and the
 * script and stylesheet it names are fetched in too, so the first offline open
 * after a deploy gets the new bundle whole, never a mix. Scripts and stylesheets it
 * no longer names are pruned then. Fonts are cached on first use and not pruned —
 * their names change only when the font package does.
 */
const CACHE = 'legible-shell-v1';
const SHELL = '/';
const REFRESHED = /^\/(favicon\.svg|manifest\.webmanifest|apple-touch-icon\.png|icon-[\w-]+\.png)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch(SHELL, { cache: 'no-store' });
      if (res.ok) await cacheShell(res);
    } catch {
      // Installing offline: the next online navigation fills the cache instead.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(event, req));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event, req));
  } else if (REFRESHED.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
  // Anything else goes to the network untouched.
});

async function networkFirstShell(event, req) {
  try {
    const res = await fetch(req);
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
      event.waitUntil(cacheShell(res.clone()));
    }
    return res;
  } catch {
    const cached = await (await caches.open(CACHE)).match(SHELL);
    if (cached) return cached;
    throw new Error('offline, and no shell cached yet');
  }
}

async function cacheFirst(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) event.waitUntil(cache.put(req, res.clone()));
  return res;
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => { if (res.ok) return cache.put(req, res.clone()).then(() => res); return res; })
    .catch(() => undefined);
  if (hit) { event.waitUntil(refresh); return hit; }
  const res = await refresh;
  if (res) return res;
  throw new Error('offline, and not cached');
}

/** Cache the HTML, fetch in what it names, and drop scripts/styles it no longer does. */
async function cacheShell(res) {
  const html = await res.clone().text();
  const cache = await caches.open(CACHE);
  await cache.put(SHELL, res);
  const wanted = new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
  );
  await Promise.all([...wanted].map(async (path) => {
    if (await cache.match(path)) return;
    const r = await fetch(path);
    if (r.ok) await cache.put(path, r);
  }));
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (/^\/assets\/.+\.(?:js|css)$/.test(path) && !wanted.has(path)) await cache.delete(key);
  }
}
