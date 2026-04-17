import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load .env files (.env, .env.local, .env.[mode]) — including non-VITE_ prefixed vars
  const env = loadEnv(mode, process.cwd(), '');
  const congressKey = env.VITE_CONGRESS_API_KEY ?? env.CONGRESS_API_KEY ?? '';

  return {
    plugins: [react()],
    server: {
      proxy: {
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
    // Library-mode builds don't substitute `process.env.NODE_ENV` by default
    // (Vite leaves the library environment-neutral). React reads that at
    // module-load time, so without substitution the browser crashes with
    // `process is not defined` before the widget ever mounts. Replace it
    // explicitly to `"production"` for the IIFE build.
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
