import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which build you are looking at, shown in the header.
 *
 * MMDD.hhmm in UTC, because the only question it has to answer on a phone is
 * "is this newer than the deploy I just pushed?" — and there, a cache-busting
 * query string proves a fresh fetch but says nothing about whether the deploy
 * has finished, so a change that has not landed and one that did not work look
 * identical. A timestamp separates them at a glance; a commit SHA would need a
 * lookup, and is seven characters of nothing on a 320px screen. The commit
 * rides along in the title attribute: Render exposes it as RENDER_GIT_COMMIT
 * during the build, and it reads "local" otherwise.
 */
function buildId() {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}.${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  const sha = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local';
  return `${stamp}·${sha}`;
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
