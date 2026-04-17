# Deployment — Voter Info Widget on Cloudflare

**Status**: v2.4.0 architecture. Single-domain, Cloudflare-native.

## Architecture

The widget is a **third-party embed** — someone drops a `<script>` tag into a
host page on a domain they control (e.g. trackukraine.com on Fourthwall).
We have no access to the host's domain or infrastructure. All of our services
run from a domain **we** control on **our** Cloudflare account.

```
┌──────────────────────────────┐
│  Embedder (e.g. trackukraine │   Hosts a page with:
│  .com on Fourthwall)         │     <script src="https://vote.cogs.it.com/
└──────────────┬───────────────┘                    voter-info-widget.iife.js">
               │                                 <voter-info-widget
               │                                    api-base="https://vote.cogs.it.com">
               ▼
  ┌───────────────────────────────────────────────────┐
  │  Cloudflare Worker @ vote.cogs.it.com             │
  │  (single origin for everything)                   │
  │                                                   │
  │  /voter-info-widget.iife.js   ┐                   │
  │  /ukraineBills.json           ├─► R2 bucket (private, bound to Worker)
  │  /ukraineVotes.json           ┘                   │
  │                                                   │
  │  /api/census/*     ─► Census Bureau geocoder      │
  │  /api/congress/*   ─► api.congress.gov (key injected)
  │  /api/senate/*     ─► www.senate.gov              │
  │                                                   │
  │  Edge cache on all API responses (FR-25)          │
  │  Origin whitelist for /api/* (AC-25.5)            │
  └───────────────────────────────────────────────────┘
```

One hostname. One Worker. One R2 bucket reached through the Worker's binding
(bucket stays private). Three secrets in a Cloudflare account you own.

## One-time setup

### 1. Cloudflare account + API token

1. Log in at https://dash.cloudflare.com. Note the **Account ID** (right sidebar).
2. Create an API token at https://dash.cloudflare.com/profile/api-tokens:
   - Template: **Edit Cloudflare Workers**
   - Additional permissions to add beyond the template:
     - **Account** → **Workers R2 Storage** → Edit
     - **Account** → **Workers Scripts** → Edit
   - Save the token — Cloudflare only shows it once. This is `CLOUDFLARE_API_TOKEN`.

### 2. R2 bucket

```bash
npx wrangler r2 bucket create voter-info-widget-assets
```

The bucket stays private — no public domain bound to it. The Worker reaches it
via the `ASSETS` binding defined in `wrangler.toml`.

### 3. Domain

Pick a domain **you** own. Example used in config: `vote.cogs.it.com`.

The domain needs its DNS on Cloudflare. If the apex (`cogs.it.com`) is already
on Cloudflare, the subdomain `vote` can be added as a Worker custom domain
with one click in the dashboard. If the apex is elsewhere, CNAME
`vote.cogs.it.com` to the Worker's `*.workers.dev` hostname and bind the
custom domain in the Worker settings.

### 4. Deploy the Worker

```bash
# Set the API key as a Worker secret (encrypted at rest, never in code)
echo "YOUR_CONGRESS_KEY" | npx wrangler secret put CONGRESS_API_KEY

# Optionally widen or restrict allowed origins
# (default: trackukraine.com + www.trackukraine.com + localhost)
npx wrangler secret put ALLOWED_ORIGINS

# Deploy
npx wrangler deploy
```

Then bind the custom domain in the CF dashboard:
**Workers & Pages → voter-info-widget-proxy → Settings → Triggers →
Add Custom Domain → `vote.cogs.it.com`**.

Cloudflare handles the TLS cert automatically.

### 5. Upload the static assets to R2

These are built artifacts; CI normally does it, but the first deploy may be
manual:

```bash
npm ci
npm run build:lib
npm run curate    # refreshes ukraineBills.json + ukraineVotes.json

npx wrangler r2 object put voter-info-widget-assets/voter-info-widget.iife.js \
  --file dist/voter-info-widget.iife.js \
  --content-type "application/javascript; charset=utf-8"

npx wrangler r2 object put voter-info-widget-assets/ukraineBills.json \
  --file src/data/ukraineBills.json \
  --content-type "application/json; charset=utf-8"

npx wrangler r2 object put voter-info-widget-assets/ukraineVotes.json \
  --file src/data/ukraineVotes.json \
  --content-type "application/json; charset=utf-8"
```

Smoke test:
```bash
curl -I https://vote.cogs.it.com/voter-info-widget.iife.js
# → 200, application/javascript

curl "https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=1600+Pennsylvania+Ave+NW+Washington+DC+20500&benchmark=Public_AR_Current&vintage=Current_Current&format=json" \
  -H "Origin: https://trackukraine.com"
# → 200 JSON with CORS headers set to trackukraine.com
```

### 6. GitHub Actions secrets

Set these so CI can deploy:

| Secret | Source |
|---|---|
| `CLOUDFLARE_API_TOKEN` | created in step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | right sidebar of CF dashboard |
| `CONGRESS_API_KEY` | https://api.congress.gov/sign-up (for the weekly data refresh job) |

Quick CLI:
```bash
gh secret set CLOUDFLARE_API_TOKEN --body "$(< ~/.cf-token)"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "your-32-char-account-id"
gh secret set CONGRESS_API_KEY --body "your-congress-key"
```

## Routine operations

### Deploy

`git push origin main` → `.github/workflows/deploy.yml` runs:
  1. Typecheck + test
  2. `npm run build:lib` + `npm run curate`
  3. Upload three files to R2 via wrangler
  4. `wrangler deploy` to push the Worker

To deploy manually (e.g. rolling back):
```bash
git checkout <good-commit>
npm run build:lib
npm run curate
# three `wrangler r2 object put` commands (see step 5)
npx wrangler deploy
```

### Refresh curated data

`.github/workflows/refresh-data.yml` runs weekly on Sunday. Opens a PR with
diffs against `src/data/` when new votes are added or classifications change.

Manual:
```bash
npm run curate
git diff src/data/           # review
git add src/data/ && git commit -m "chore: refresh curated data"
git push
```

### Rotate the Congress.gov API key

```bash
echo "NEW_KEY" | npx wrangler secret put CONGRESS_API_KEY
gh secret set CONGRESS_API_KEY --body "NEW_KEY"
```

Widget doesn't need redeployment — the key only lives server-side in the Worker.

### Invalidate the edge cache

Usually unnecessary — our roll-call data is immutable. But if you shipped a
bad build:

```bash
# Purge one URL
curl -X POST "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":["https://vote.cogs.it.com/voter-info-widget.iife.js"]}'

# Or purge everything
curl -X POST "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"purge_everything":true}'
```

## Security model

- **API keys** only exist as Worker secrets and GitHub Action secrets. Never
  in code, never in the widget bundle, never sent to the browser.
- **CORS** restricts `/api/*` access to whitelisted origins (default:
  `trackukraine.com`, `www.trackukraine.com`, `localhost`). Arbitrary
  third-party sites cannot use our proxy as a free Congress.gov proxy.
  Static-asset routes (JS, JSON) permit any origin so the bundle can be
  embedded wherever needed.
- **R2 stays private.** The bucket has no public domain; only the Worker
  (with the `ASSETS` binding) can read from it. Lost secrets don't leak the
  bucket contents; a compromised Worker is the only failure mode.
- **Supply chain.** Our widget JS is served from our R2, not a third-party
  CDN. Fourthwall operators can pin it with SRI if they want:
  ```html
  <script src="https://vote.cogs.it.com/voter-info-widget.iife.js"
          integrity="sha384-..." crossorigin="anonymous"></script>
  ```
  (SRI breaks on deploy if you change the bundle; hash updates must be
  communicated to the embedder.)
- **DDoS / rate-limiting**: Cloudflare's defaults. Worker auto-scales.
  Edge cache absorbs >99% of post-warmup traffic.

## Embedding

Paste into Fourthwall's custom-HTML theme section (or any HTML page):

```html
<script src="https://vote.cogs.it.com/voter-info-widget.iife.js"></script>
<voter-info-widget api-base="https://vote.cogs.it.com"></voter-info-widget>
```

That's the whole embed. Because static assets and the API live at the same
origin, we don't need a separate `assets-base` attribute — the widget derives
the JSON file location from its own `<script>` tag's origin.

## Widening the embed whitelist

If you want other allies to embed the widget too, update the Worker env var:

```bash
# Add another origin
echo "https://trackukraine.com,https://www.trackukraine.com,https://ally.example.com" \
  | npx wrangler secret put ALLOWED_ORIGINS
```

Or change the default list in `wrangler.toml`'s `[vars]` section and redeploy.

## Troubleshooting

**CORS error in browser console** on `/api/*` fetch:
- Check `Origin` header being sent matches your whitelist
- Check the Worker's `ALLOWED_ORIGINS` value matches exactly (scheme + host, no path)

**`403 Origin not allowed`**:
- Same as above — it's the Worker actively refusing the origin

**`500 Server misconfigured: CONGRESS_API_KEY not set`**:
- Run `wrangler secret put CONGRESS_API_KEY` and redeploy

**Static file returns 404**:
- Verify the R2 object exists: `wrangler r2 object get voter-info-widget-assets/voter-info-widget.iife.js --file /tmp/check.js && head -c 200 /tmp/check.js`
- Re-upload if missing

**`X-Proxy-Cache: MISS` on every request**:
- Cache API writes happen in the background; first few requests per URL are
  expected misses. If misses persist, check the cache key — we strip
  `api_key` from the key so different users share cache entries.
