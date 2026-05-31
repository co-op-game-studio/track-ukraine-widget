/**
 * HTML surfaces the Worker emits for browser navigation.
 *
 *   - /embed  — always served, designed for iframe embedding on 3rd-party
 *               sites. Posts resize events to its parent.
 *   - /       — when PREVIEW_MODE='true' (dev/uat/stg), renders the widget
 *               for direct browser preview. Prod 301s to trackukraine.com.
 *
 * Owns its implementation as of Phase 12 T-075 (2026-04-19).
 *
 * Traces: FR-26 AC-26.1..AC-26.12. FR-42.
 */

/** Canonical bioguide shape: one uppercase letter + six digits. */
const BIOGUIDE_RE = /^[A-Z][0-9]{6}$/;

/**
 * Embed-friendly HTML served at /embed on any env. Designed for iframe
 * embedding on third-party sites (e.g. trackukraine.com, Discord link
 * previews, WordPress). Notifies the parent frame of its content height
 * via postMessage so the host can auto-size the iframe.
 *
 * FR-60 AC-60.1: an optional `bioguide` deep-links the embed straight onto
 * one member's RepDetail (used by the admin profile preview). The value is
 * validated against BIOGUIDE_RE before it is written into the markup; an
 * absent/invalid value mounts the bare widget unchanged (AC-60.7). Because
 * a valid bioguide can only ever be `[A-Z][0-9]{6}`, it is injection-safe by
 * construction — no untrusted text reaches the HTML.
 *
 * FR-60 AC-60.9: the inline mount/resize script carries a per-response CSP
 * nonce so it survives the route's strict `script-src` (no `'unsafe-inline'`).
 * The router passes the same nonce into the `script-src` directive. The nonce
 * is rendered into a `nonce="…"` attribute; the value is provided by the
 * Worker (`crypto.randomUUID()`) and is therefore trusted.
 */
export function buildEmbedHtml(envName: string, bioguide?: string, nonce?: string): string {
  const validBioguide = bioguide && BIOGUIDE_RE.test(bioguide) ? bioguide : null;
  // Only emitted when the id passed the shape check above.
  const bioguideLine = validBioguide
    ? `\n        el.setAttribute('bioguide', ${JSON.stringify(validBioguide)});`
    : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Voter Info Widget</title>
    <meta property="og:title" content="Voter Info Widget — Ukraine Focus" />
    <meta property="og:description" content="See how your U.S. Senators and Representative voted on major Ukraine aid, sanctions, and oversight legislation." />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      body { font-family: "Hanken Grotesk", system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="viw-mount"></div>
    <script src="/voter-info-widget.iife.js" defer></script>
    <script${nonceAttr}>
      // Mount the widget with api-base = this page's origin. This forces
      // fetch() calls to be cross-origin (vs. same-origin with no Origin
      // header) so the Worker's ALLOWED_ORIGINS check sees a real Origin.
      window.addEventListener('load', function () {
        var el = document.createElement('voter-info-widget');
        el.setAttribute('api-base', window.location.origin);${bioguideLine}
        document.getElementById('viw-mount').appendChild(el);
      });
      // Auto-size iframe: on content-height changes, postMessage to parent.
      (function () {
        var lastHeight = 0;
        function notify() {
          var h = document.documentElement.scrollHeight;
          if (h !== lastHeight) {
            lastHeight = h;
            window.parent.postMessage(
              { type: 'viw:resize', height: h, env: ${JSON.stringify(envName)} },
              '*'
            );
          }
        }
        var ro = new ResizeObserver(notify);
        ro.observe(document.body);
        window.addEventListener('load', notify);
        setInterval(notify, 500);
      })();
    </script>
  </body>
</html>`;
}

export function buildPreviewHtml(envName: string): string {
  // Non-prod preview served behind CF Access. The Worker skips the Origin
  // allowlist check on PREVIEW_MODE envs because Access is the gate. Only
  // prod enforces the cross-site embed allowlist.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Voter Info Widget — ${envName}</title>
    <style>
      html, body { margin: 0; padding: 0; min-height: 100vh; }
      body { background: #ffffff; font-family: "Hanken Grotesk", system-ui, sans-serif; }
      .viw-env-label {
        position: fixed; top: 8px; right: 8px;
        background: #000; color: #ffd400; padding: 6px 10px; border-radius: 4px;
        font-family: monospace; font-size: 12px; border: 2px solid #ffd400; z-index: 9999;
      }
    </style>
  </head>
  <body>
    <div class="viw-env-label">ENV: ${envName}</div>
    <voter-info-widget api-base=""></voter-info-widget>
    <script src="/voter-info-widget.iife.js" defer></script>
  </body>
</html>`;
}
