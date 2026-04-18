import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev server routes `/env-<name>/*` to the corresponding env's Worker,
 * attaching CF Access service-token headers for dev/uat/stg so the browser
 * never sees the Access challenge. Prod is straight pass-through.
 *
 * The env picker in main.tsx sets apiBase = "/env-<name>" so every widget
 * fetch ends up on the right worker with the right auth.
 *
 * /api/census, /api/congress, /api/senate are retained for same-origin legacy
 * fetch paths that haven't been cutover yet.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const congressKey = env.VITE_CONGRESS_API_KEY ?? env.CONGRESS_API_KEY ?? '';
  const accessClientId = env.CF_ACCESS_CLIENT_ID ?? '';
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET ?? '';

  const envTargets: Record<'dev' | 'uat' | 'stg' | 'prod', { target: string; gated: boolean }> = {
    dev: { target: 'https://dev.vote.cogs.it.com', gated: true },
    uat: { target: 'https://uat.vote.cogs.it.com', gated: true },
    stg: { target: 'https://stg.vote.cogs.it.com', gated: true },
    prod: { target: 'https://vote.cogs.it.com', gated: false },
  };

  const envProxies: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(envTargets)) {
    envProxies[`/env-${name}`] = {
      target: cfg.target,
      changeOrigin: true,
      secure: true,
      rewrite: (path: string) => path.replace(new RegExp(`^/env-${name}`), ''),
      configure: (proxy: { on: (ev: string, cb: (...args: unknown[]) => void) => void }) => {
        proxy.on('proxyReq', (proxyReq: { setHeader: (k: string, v: string) => void }) => {
          if (cfg.gated && accessClientId && accessClientSecret) {
            proxyReq.setHeader('CF-Access-Client-Id', accessClientId);
            proxyReq.setHeader('CF-Access-Client-Secret', accessClientSecret);
          }
          // Emulate a browser from an allowed origin so the Worker's CORS check passes.
          proxyReq.setHeader('Origin', 'https://trackukraine.com');
        });
      },
    };
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        ...envProxies,
        '/api/census': {
          target: 'https://geocoding.geo.census.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/census/, ''),
        },
        '/api/congress': {
          target: 'https://api.congress.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => {
            const rewritten = path.replace(/^\/api\/congress/, '');
            if (!congressKey) return rewritten;
            const sep = rewritten.includes('?') ? '&' : '?';
            return `${rewritten}${sep}api_key=${congressKey}`;
          },
        },
        '/api/senate': {
          target: 'https://www.senate.gov',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/senate/, ''),
        },
      },
    },
    ...(mode === 'lib'
      ? {
          define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
          },
        }
      : {}),

    build:
      mode === 'lib'
        ? {
            lib: {
              entry: 'src/embed.tsx',
              name: 'VoterInfoWidget',
              fileName: 'voter-info-widget',
              formats: ['iife'],
            },
            cssCodeSplit: false,
            emptyOutDir: false,
          }
        : {
            outDir: 'dist',
          },
  };
});
