/**
 * Dev entry point — renders the widget directly (no Shadow DOM) for dev mode.
 * Production uses embed.tsx via the library build.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VoterInfoWidget } from './VoterInfoWidget';
import { initRosters } from './services/bundledRosters';
import './styles/widget.css';

// FR-24: in dev, Vite serves the JSON file from src/data/. In production the
// sibling-file fetch comes from R2 via embed.tsx's rosterUrl() helper.
initRosters('/src/data/ukraineVotes.json');

const root = document.getElementById('root')!;
createRoot(root).render(
  <StrictMode>
    <VoterInfoWidget apiBase="" />
  </StrictMode>,
);
