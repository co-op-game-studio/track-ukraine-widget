/**
 * Dev entry point — renders the widget directly (no Shadow DOM) for dev mode.
 * Production uses embed.tsx via the library build.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VoterInfoWidget } from './VoterInfoWidget';
import { initRosters } from './services/bundledRosters';
import './styles/widget.css';

// Dev mode: point at the local dev server, which proxies /api/* to the
// dev Worker (see vite.config.ts). Member profiles come from KV via
// /api/members/{bioguideId} per ADR-011.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEV_API_BASE: string = ((import.meta as any).env?.VITE_API_BASE as string | undefined) ?? 'https://dev.vote.cogs.it.com';
initRosters(DEV_API_BASE);

const root = document.getElementById('root')!;
createRoot(root).render(
  <StrictMode>
    <VoterInfoWidget apiBase={DEV_API_BASE} />
  </StrictMode>,
);
