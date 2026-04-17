/**
 * Web Component wrapper — defines <voter-info-widget> as a custom element.
 * Traces to: US-6, US-9, FR-24, FR-26, ADR-004, ADR-005.
 *
 * Mounts React into a Shadow DOM so host-site styles can't leak in.
 * CSS is inlined via Vite's `?inline` suffix.
 *
 * Attributes:
 *   api-base       URL of the CORS proxy Worker (e.g. https://api.trackukraine.com)
 *   assets-base    URL where static assets (rosters JSON) are hosted (e.g. https://cdn.trackukraine.com)
 */
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { VoterInfoWidget } from './VoterInfoWidget';
import { initRosters } from './services/bundledRosters';
// @ts-expect-error Vite handles the ?inline CSS import
import widgetCss from './styles/widget.css?inline';

/**
 * Compute where to fetch the roster JSON file from. Precedence:
 *   1. `assets-base` attribute (if the embedder set it explicitly)
 *   2. `api-base` attribute (single-domain setup — rosters and API share origin)
 *   3. Same origin as the <script> tag that loaded the widget
 *   4. Current page origin (dev fallback)
 *
 * In the single-domain deployment (vote.cogs.it.com), steps 2 and 3 both
 * yield the same URL — callers only need to set `api-base`.
 */
function rosterUrl(element: HTMLElement): string {
  const assetsBase = element.getAttribute('assets-base');
  if (assetsBase) {
    return `${assetsBase.replace(/\/$/, '')}/ukraineVotes.json`;
  }

  const apiBase = element.getAttribute('api-base');
  if (apiBase) {
    return `${apiBase.replace(/\/$/, '')}/ukraineVotes.json`;
  }

  // Derive from the <script> tag that loaded this widget
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="voter-info-widget"]');
  for (const s of Array.from(scripts)) {
    try {
      const u = new URL(s.src);
      return `${u.origin}${u.pathname.replace(/[^/]+$/, '')}ukraineVotes.json`;
    } catch {
      // continue
    }
  }

  return '/ukraineVotes.json';
}

class VoterInfoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['api-base', 'assets-base'];
  }

  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' });

    // Inject scoped CSS
    const style = document.createElement('style');
    style.textContent = widgetCss as string;
    shadow.appendChild(style);

    // FR-24: kick off the rosters fetch before React mounts. The hook checks
    // `hasBundledRoster()` on each open; if rosters arrive late it falls back
    // to the network path transparently.
    initRosters(rosterUrl(this));

    // Mount React
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    this.root = createRoot(mount);
    this.render();
  }

  attributeChangedCallback() {
    if (this.root) this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private render() {
    const apiBase = this.getAttribute('api-base') ?? '';
    this.root?.render(
      <StrictMode>
        <VoterInfoWidget apiBase={apiBase} />
      </StrictMode>,
    );
  }
}

if (!customElements.get('voter-info-widget')) {
  customElements.define('voter-info-widget', VoterInfoElement);
}
