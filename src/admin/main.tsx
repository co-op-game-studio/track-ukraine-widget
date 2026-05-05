/**
 * Admin SPA entry (FR-52).
 *
 * Mounted at /admin behind Cloudflare Access. The Worker JWT-verifies on
 * every /api/admin/* request; this SPA does no client-side auth — it just
 * reads /api/admin/whoami to confirm identity and lets every action go
 * through the gated API.
 *
 * Six tabs (FR-52 AC-52.3): Bills, Votes, Comments, Statements, Quotes,
 * Recent Activity. List-detail layout per design.md §4.20.
 *
 * Traces to FR-52, FR-58.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import '../styles/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('admin SPA: #root not found');
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
