import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Admin SPA Vite config (FR-52 AC-52.1).
 *
 * Builds `src/admin/main.tsx` into `dist/admin/` with its own HTML shell.
 * The main embed bundle is unchanged; admin code is fully isolated.
 *
 * Run:
 *   npm run dev:admin    # vite dev server on port 5174 with /env-* proxies
 *   npm run build:admin  # static bundle into dist/admin
 */
export default defineConfig({
  plugins: [react()],
  root: 'src/admin',
  // FR-52 AC-52.2 — admin SPA is served under `/admin/`, so its built
  // asset URLs must be prefixed accordingly. Without this, Vite emits
  // root-relative `/assets/...` paths that 404 in production because
  // the assets land at `/admin/assets/...` per the dist layout.
  base: '/admin/',
  build: {
    outDir: resolve(__dirname, 'dist/admin'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/admin/index.html'),
    },
  },
  server: {
    port: 5174,
    // Reuse the same /env-<name>/* proxy pattern as the embed dev server
    // so the admin SPA can talk to dev/uat/stg/prod admin APIs locally.
    proxy: {
      '/env-dev': {
        target: 'https://dev.vote.cogs.it.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/env-dev/, ''),
      },
      '/env-uat': {
        target: 'https://uat.vote.cogs.it.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/env-uat/, ''),
      },
      '/env-stg': {
        target: 'https://stg.vote.cogs.it.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/env-stg/, ''),
      },
      '/env-prod': {
        target: 'https://vote.cogs.it.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/env-prod/, ''),
      },
    },
  },
});
