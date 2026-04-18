# Voter Info Widget — Ukraine edition

A front-end-only, stateless web component that lets U.S. voters see how their
federal representatives voted on Ukraine-related legislation. Built for
embedding on sites like [trackukraine.com](https://trackukraine.com).

- 🇺🇦 **Curated Ukraine bills** — a hand-picked set of ~27 bills (5 featured majors) from the 117th–119th Congresses, refreshed from Congress.gov on each build
- 📊 **Single Ukraine Support Score** — weighted vote + sponsorship signal, rendered as a red→yellow→green gradient
- 🚫 **Obstruction detection** — procedural anti-Ukraine votes are flagged and counted separately
- 🧭 **Clustered votes** — each bill shows a single "primary" passage vote; procedural maneuvers (cloture, motion-to-proceed, motion-to-recommit) nest under it
- 🎨 **Track Ukraine visual identity** — Hanken Grotesk, flat boxy, italic uppercase headings, yellow/black/white palette, cyan-transparent root
- 🔌 **Embed anywhere** — single `<script>` + `<voter-info-widget>` custom element with Shadow DOM isolation

Full product spec in [`docs/spec.md`](docs/spec.md) (v2.2.0). Design in
[`docs/design.md`](docs/design.md). External API contracts in
[`docs/api-contracts.md`](docs/api-contracts.md).

## Embedding on trackukraine.com (Fourthwall)

trackukraine.com runs on the Fourthwall platform. Fourthwall themes support
custom HTML sections — paste the widget in there.

Because the widget is a **third-party embed**, all of its infrastructure
(JS bundle, JSON datasets, and CORS-proxy API) runs on a separate domain
that the widget operator controls. The host site (trackukraine.com) only
references our embed snippet; nothing on their infrastructure changes.

### The embed snippet

Pinned with Subresource Integrity — the recommended form (FR-26 AC-26.10):

```html
<script
  src="https://vote.cogs.it.com/voter-info-widget.iife.js"
  integrity="sha384-REPLACE_WITH_CURRENT_HASH"
  crossorigin="anonymous"
  async
></script>
<voter-info-widget api-base="https://vote.cogs.it.com"></voter-info-widget>
```

Replace `sha384-REPLACE_WITH_CURRENT_HASH` with the current release's hash.
Fetch the current hash from `https://vote.cogs.it.com/voter-info-widget.iife.js.sri`
(published alongside the bundle by the deploy workflow — FR-26 AC-26.9).

The SRI hash changes on every widget release. An integrator who automates the
fetch (e.g., a build step that pulls the hash at deploy time) stays pinned
across releases. An integrator who hardcodes the hash will see the widget fail
to load (browser blocks the script on hash mismatch) after the next deploy
until they update the hash — this is the **correct** behavior: a silent
auto-update would defeat the point of SRI.

The bundle response carries `Access-Control-Allow-Origin: *` so
`crossorigin="anonymous"` works (FR-27 AC-27.1b).

**Unpinned (not recommended):**

```html
<script src="https://vote.cogs.it.com/voter-info-widget.iife.js" async></script>
<voter-info-widget api-base="https://vote.cogs.it.com"></voter-info-widget>
```

Without `integrity=`, an integrator inherits the full trust chain of the
widget's deploy pipeline — a Cloudflare account compromise or a deploy mistake
means arbitrary JS executes in the `trackukraine.com` origin. SRI is the only
mitigation a third-party embedder can apply.

Either way: both lines go into a Fourthwall custom-HTML section. The widget
self-mounts when the browser reaches it.

`vote.cogs.it.com` is a single Cloudflare Worker domain serving:

- `/voter-info-widget.iife.js` — the widget bundle (~310 KB gzipped)
- `/ukraineBills.json` — curated bill metadata (auto-fetched by the bundle at boot)
- `/ukraineVotes.json` — baked vote rosters (auto-fetched, served cached from R2)
- `/api/*` — CORS proxy to Census Bureau, Congress.gov, Senate.gov

Everything serves from one origin; CORS is restricted to the embed host
(`trackukraine.com`) for `/api/*` and wide-open for the static files.

### Setting up the infrastructure

See [`docs/deployment.md`](docs/deployment.md) for the full playbook:
Cloudflare R2 bucket creation, Worker deployment, custom domain binding,
GitHub Actions secrets.

### Host-page styling

The widget root has `background: transparent` and `font-family: "Hanken Grotesk"`,
so it inherits the host's cyan background and the host's font naturally. Hero
headings render **white, italic, uppercase, weight 900, with a 1px black drop
shadow** to mimic the "COMING SOON" treatment.

If the widget is embedded on a light/white background instead of the cyan
Fourthwall page, override in the host page:

```css
voter-info-widget {
  --viw-hero-text-color: #000;
}
```

## Development

```bash
npm install
echo "VITE_CONGRESS_API_KEY=your_key_here" > .env
npm run dev       # http://127.0.0.1:5173
npm test          # full test suite
npm run typecheck # strict TS check
```

Dev server's `index.html` sets `background: #00b4e6` so you can see how the
widget looks on the real Track Ukraine cyan.

## Refreshing the curated bills

```bash
npm run curate   # pulls from Congress.gov /bill + /actions + /summaries
```

The curator writes `src/data/ukraineBills.json`. To add or remove a bill, edit
the `CURATED` array in `scripts/build-curated-bills.mjs` and re-run.

## Project structure

```
src/
  components/       React components (flat, boxy, italic-uppercase)
  hooks/            Composed stateful hooks
  services/         Pure async fns: API callers + scoring
  styles/widget.css Stylesheet — v2.2 Track Ukraine identity
  data/             Curated bill dataset (generated)
  types/            TS types — domain + API response shapes
scripts/            Curator, spec refresh, debug scripts
docs/               Spec, design, API contracts, ADRs, CI/CD spec
tests/              Vitest unit + integration + e2e
proxy/              Cloudflare Worker reference CORS proxy
```

## License & attribution

Not affiliated with any government agency or with trackukraine.com.
Data from U.S. Census Bureau, Congress.gov, and Senate.gov (all public).
