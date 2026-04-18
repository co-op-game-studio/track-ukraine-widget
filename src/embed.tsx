/**
 * Web Component wrapper — defines <voter-info-widget> as a custom element.
 * Traces to: US-6, US-9, FR-24 (revised), FR-26, ADR-004, ADR-011.
 *
 * Mounts React into a Shadow DOM so host-site styles can't leak in.
 * CSS is inlined via Vite's `?inline` suffix.
 *
 * Attributes:
 *   api-base       URL of the proxy Worker (e.g. https://vote.cogs.it.com).
 *                  Member profiles are fetched from `${apiBase}/api/members/{bioguideId}`
 *                  per ADR-011 (KV-sole-datastore).
 */
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { VoterInfoWidget } from './VoterInfoWidget';
import { initRosters } from './services/bundledRosters';
// @ts-expect-error Vite handles the ?inline CSS import
import widgetCss from './styles/widget.css?inline';

/**
 * Compute the API base for member-profile fetches. Precedence:
 *   1. `api-base` attribute (single-domain setup)
 *   2. Same origin as the <script> tag that loaded the widget
 *   3. Current page origin (dev fallback)
 */
function apiBaseFor(element: HTMLElement): string {
  const attr = element.getAttribute('api-base');
  if (attr) return attr.replace(/\/$/, '');
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[src*="voter-info-widget"]');
  for (const s of Array.from(scripts)) {
    try {
      const u = new URL(s.src);
      return u.origin;
    } catch {
      /* continue */
    }
  }
  return '';
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

    // FR-24 revised (ADR-011): initialize the member-profile service with
    // the apiBase. Profiles are fetched lazily per-member on demand.
    initRosters(apiBaseFor(this));

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
