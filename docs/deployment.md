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
  │  /voter-info-widget.iife.js       ┐               │
  │  /voter-info-widget.iife.js.sri   ├─► Worker Sites
  │  /ukraineBills.json               │  ASSETS binding
  │  /ukraineVotes.json               ┘  (./dist in repo)
  │                                                   │
  │  /api/members/{id}       ─►┐                      │
  │  /api/bills/{id}           │  KV_VOTER_INFO      │
  │  /api/roll-calls/{key}     │  (read-through to   │
  │  /api/name-search?q=...    ┘   Congress.gov)     │
  │                                                   │
  │  /api/census/*     ─► Census Bureau geocoder      │
  │  /api/congress/*   ─► api.congress.gov (key injected)
  │  /api/senate/*     ─► www.senate.gov              │
  │                                                   │
  │  Edge cache on all API responses (FR-25)          │
  │  Origin whitelist for /api/* (AC-25.5)            │
  │  In-Worker rate limit per IP (AC-27.21)           │
  └───────────────────────────────────────────────────┘
```

One hostname. One Worker deploy bundles static assets (Worker Sites) +
a KV namespace for curator data. Three Cloudflare secrets plus the
Worker's per-env `CONGRESS_API_KEY` secret. No R2 — the migration to
Worker Sites + KV happened in v2.5.0 per ADR-011.

## One-time setup

### 1. Cloudflare account + API token

1. Log in at https://dash.cloudflare.com. Note the **Account ID** (right sidebar).
2. Create an API token at https://dash.cloudflare.com/profile/api-tokens:
   - Template: **Edit Cloudflare Workers**
   - Additional permissions to add beyond the template:
     - **Account** → **Workers KV Storage** → Edit
     - **Account** → **Workers Scripts** → Edit
   - Save the token — Cloudflare only shows it once. This is `CLOUDFLARE_API_TOKEN`.

### 2. KV namespace

```bash
npx wrangler kv namespace create KV_VOTER_INFO
# Copy the `id` from the output into wrangler.toml's `[[kv_namespaces]]`
# block (one per env: prod, dev, uat, stg).
```

Static assets (the bundle, SRI sidecar, curated JSON) are NOT stored in
KV — they ship as Worker Sites static assets from `./dist`, handled
automatically by `wrangler deploy`.

### 2b. R2 static archive bucket (v2.6.0 — FR-41)

Create **one R2 bucket per env** to serve as the durable tier-2 archive
for byte-level-static upstream responses (closed-session Senate XML,
House rosters, aged bill-actions/summaries). Scope is narrow; see FR-41
in `docs/spec.md` for the full data-type eligibility matrix.

```bash
# Per env — name pattern: voter-info-widget-archive-${env}
npx wrangler r2 bucket create voter-info-widget-archive-prod
npx wrangler r2 bucket create voter-info-widget-archive-dev
npx wrangler r2 bucket create voter-info-widget-archive-uat
npx wrangler r2 bucket create voter-info-widget-archive-stg
```

Bindings are already declared in `wrangler.toml` as `R2_STATIC` per env;
**if the bucket does not exist at deploy time, `wrangler deploy` fails
fast** — AC-41.11 intentional. No auto-creation.

**Steady-state footprint: ~13 MB per env** (~200 Senate XML + ~200 House
rosters + ~200 House vote-detail + ~27 bill-actions + ~27 bill-summaries).
At R2 storage pricing $0.015/GB/month, cost is <$0.001/month per env.
Egress within Cloudflare (Worker → R2) is free.

**Do NOT reuse the retired `R2_ASSETS` binding from the ADR-011-era
static-asset serving path.** That binding was removed when static assets
moved to Worker Sites. `R2_STATIC` is a distinct binding with a distinct
purpose (upstream-bytes archive, not widget bundle serving).

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

### 5. Ship the static assets with the Worker (Worker Sites)

As of ADR-011, static assets are served via **Worker Sites** — the
`[assets]` binding in `wrangler.toml` points at `./dist`, and
`wrangler deploy` ships every file under that directory with the Worker
itself. There is no separate R2 upload step for static content. Member /
bill / roll-call data lives in KV; see `scripts/publish-to-kv.ts`.

All four assets must be present in `./dist` before `wrangler deploy`:
the bundle, its SRI sidecar, and the two Ukraine datasets
(FR-26 AC-26.9, AC-26.11).

```bash
npm ci
npm run build:lib             # writes dist/voter-info-widget.iife.js
npm run build:sri             # writes dist/voter-info-widget.iife.js.sri (AC-26.9)
npm run curate                # writes src/data/ukraineBills.json + ukraineVotes.json

# The curated JSON lives under src/data/ so Vite can bundle it; Worker
# Sites needs the copies under ./dist. The deploy workflow copies them
# automatically (`.github/workflows/deploy.yml`); for manual deploys,
# copy them yourself:
cp src/data/ukraineBills.json dist/
cp src/data/ukraineVotes.json dist/

npx wrangler deploy           # ships ./dist + the Worker together
```

Smoke test (AC-26.11 — every asset SHALL return 200):
```bash
for key in voter-info-widget.iife.js voter-info-widget.iife.js.sri ukraineBills.json ukraineVotes.json; do
  code=$(curl -o /dev/null -s -w "%{http_code}" "https://vote.cogs.it.com/$key")
  echo "$code  /$key"
done
# → 200  /voter-info-widget.iife.js
#   200  /voter-info-widget.iife.js.sri
#   200  /ukraineBills.json
#   200  /ukraineVotes.json

# AC-26.12: confirm the Worker deploy is the authority for the bundle
# response (not a Pages binding or a direct R2 public URL).
curl -I https://vote.cogs.it.com/voter-info-widget.iife.js | grep -iE "content-type|strict-transport-security|cross-origin-resource-policy"
# Expect:
#   Content-Type: application/javascript; charset=utf-8   (or text/javascript from CF)
#   Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
#   Cross-Origin-Resource-Policy: cross-origin

curl "https://vote.cogs.it.com/api/census/geocoder/geographies/onelineaddress?address=1600+Pennsylvania+Ave+NW+Washington+DC+20500&benchmark=Public_AR_Current&vintage=Current_Current&format=json" \
  -H "Origin: https://trackukraine.com"
# → 200 JSON with CORS headers set to trackukraine.com
```

**If the static-asset smoke test does not return the Worker's security
header baseline**, something else in the Cloudflare account is serving
`/voter-info-widget.iife.js` instead of the Worker. Common culprits: a
leftover Pages project bound to the same hostname, a Transform Rule
overriding the response, or a stale R2 public-bucket custom domain.
Resolve by removing the conflicting binding — the Worker deploy is the
single authority per AC-26.12.

### 6. GitHub Actions secrets

Set these so CI can deploy and run the non-prod post-deploy smoke:

| Secret | Source | Required for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | created in step 1 | all envs (deploy) |
| `CLOUDFLARE_ACCOUNT_ID` | right sidebar of CF dashboard | all envs (deploy) |
| `CONGRESS_API_KEY` | https://api.congress.gov/sign-up | weekly data refresh |
| `CF_ACCESS_CLIENT_ID` | §Access-gated non-prod step D.1 | dev/uat/stg smoke test |
| `CF_ACCESS_CLIENT_SECRET` | §Access-gated non-prod step D.1 | dev/uat/stg smoke test |

Quick CLI:
```bash
gh secret set CLOUDFLARE_API_TOKEN --body "$(< ~/.cf-token)"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "your-32-char-account-id"
gh secret set CONGRESS_API_KEY --body "your-congress-key"
gh secret set CF_ACCESS_CLIENT_ID --body "<from Service Token creation>"
gh secret set CF_ACCESS_CLIENT_SECRET --body "<from Service Token creation>"
```

## Routine operations

### Deploy

`main` is the trunk branch and is NOT a deploy target. Pushing to `main`
runs PR checks only. Deploys happen when `main` is promoted down the
ladder (`main → develop → uat → stg → prod`). Each rung push triggers
`.github/workflows/deploy.yml`:
  1. Typecheck + test
  2. `npm run build:lib`
  3. `npx tsx scripts/publish-to-kv.ts --env <env>` (ADR-011: KV is the
     sole datastore; R2 uploads were removed in v2.5.0)
  4. `wrangler deploy [--env <env>]` to push the Worker
  5. Post-deploy smoke

Standard ladder promotion:
```bash
# Promote main → develop (triggers dev deploy)
gh pr create --base develop --head main --title "promote main → develop"
# After dev is green, promote develop → uat, uat → stg, stg → prod.
# ladder-guard.yml enforces that each PR source is the previous rung
# (or `hotfix/*`).
```

To deploy manually (e.g. rolling back):
```bash
git checkout <good-commit>
npm run build:lib
npx tsx scripts/publish-to-kv.ts --env <env>
npx wrangler deploy [--env <env>]
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

### v2.5.2 rollout — KV roll-call rosters + state-members (ADR-012)

Adding or re-enabling the KV roll-call-roster + state-members path requires
a specific commit-order because the widget reads from KV records that the
curator writes. Shipping widget code before populating KV = 404s on every
roster / state-members fetch; shipping curator + Worker before widget = no
effect (nothing calls the new records yet).

**Correct order (per ADR-012 + tasks.md T-036..T-045):**

1. **Merge the feature branch into `main`** (Phase 1-3 all land together —
   spec, tests, Worker routes, curator phases, widget cutover).
2. **Deploy to `develop` → `dev.vote.cogs.it.com`** via the normal `main →
   develop` ladder rotation. At this point the new Worker routes exist but
   KV has no `roll-call-roster:v1:*` or `state-members:v1:*` records yet.
3. **Populate KV in dev** — one curator run per env, smallest blast radius
   first:
   ```bash
   cd voter-info-widget
   # Dev namespace uses a dev-scoped Congress.gov key.
   CONGRESS_API_KEY=$DEV_CONGRESS_KEY \
     npx tsx scripts/publish-to-kv.ts --env dev
   ```
   The curator writes the full set — `bill:v1:*`, `roll-call:v1:*`,
   `roll-call-roster:v1:*` (NEW), `state-members:v1:*` (NEW), `name-index:v1:*`
   shards + meta. ~2-3 minutes at default concurrency.
4. **Smoke-test the new routes against dev** via the Access service-token
   credentials:
   ```bash
   curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        "https://dev.vote.cogs.it.com/api/state-members/IL" | jq '.senators | length'
   # Expect: 2
   curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        "https://dev.vote.cogs.it.com/api/roll-call-rosters/house/118/2/151" | jq '.casts | length'
   # Expect: > 400 (full House roster)
   ```
5. **Optional: warm dev edge cache** (not required for correctness, but
   removes cold-start latency for any manual testing):
   ```bash
   node scripts/warm-member-cache.mjs --host https://dev.vote.cogs.it.com \
     --concurrency 4 --delay-ms 250
   ```
6. **Promote `develop → uat`** via the ladder. Re-run the curator for uat,
   re-smoke, re-warm as above:
   ```bash
   CONGRESS_API_KEY=$DEV_CONGRESS_KEY \
     npx tsx scripts/publish-to-kv.ts --env uat
   node scripts/warm-member-cache.mjs --host https://uat.vote.cogs.it.com \
     --concurrency 4 --delay-ms 250
   ```
7. **STOP at uat until explicitly approved to proceed.** Phase 9 ships
   to stg and prod as a separate, deliberate decision; the in-flight commits
   up to T-042 are safe to run in dev/uat in parallel with the v2.5.1
   implementation still live on stg/prod.
8. **Later — promote to stg, then prod.** For each: ladder PR, reviewer
   approval, curator run, smoke-test, optional warm. The widget-invariant
   test (T-042) and the AC-32.15/16 route tests should already be green at
   this point; CI flags regressions before the PR merges.

**If the curator fetch fails mid-run** (e.g., Congress.gov 429, transient
network error), the curator aborts the whole run and writes nothing — per
ADR-012. Re-run when the upstream recovers; no partial-write cleanup
needed.

**Adding a new curated vote during this phase** — if a new vote is added
to `src/data/ukraineBills.json` between curator runs, the widget will 404
on the roster fetch and treat the cast as "Did Not Vote." Re-run the
curator for each env to populate the new roster.

### Rotate the Congress.gov API key

See FR-31 AC-31.3. The key-holder is the only person who can regenerate
the key at api.congress.gov — the rotation procedure below is deliberately
step-by-step because a botched rotation means either (a) the widget is down
until the next deploy, or (b) the old key is still live somewhere and can be
used to drain quota. Both are bad, in different ways.

**Operator prerequisites:** login to api.congress.gov with the account that
owns the current key; `wrangler` authenticated as a Cloudflare user with
Worker-secret-write access; `gh` authenticated against this repo.

1. **Generate a new key** at https://api.congress.gov/sign-up (regenerate — do
   not create a second account). Note it once; it is not retrievable later.
2. **Rotate the prod Worker secret** — apply per env that holds prod-grade
   traffic:
   ```bash
   echo "NEW_KEY" | npx wrangler secret put CONGRESS_API_KEY
   echo "NEW_KEY" | npx wrangler secret put CONGRESS_API_KEY --env stg
   ```
   The dev/uat envs SHOULD use a distinct key from prod — see step 5.
3. **Rotate the GitHub Actions secret** (used by the weekly data-refresh job,
   NOT by the Worker — the Worker reads from the Cloudflare secret store):
   ```bash
   gh secret set CONGRESS_API_KEY --body "NEW_KEY"
   ```
4. **Verify the new key is live** on each env — `X-Proxy-Cache: MISS` on the
   first call proves it reached Congress.gov:
   ```bash
   curl -i -H "Origin: https://trackukraine.com" \
     "https://vote.cogs.it.com/api/congress/v3/bill?limit=1&nonce=rotate-$(date +%s)"
   # Expect: 200, `X-Proxy-Cache: MISS` on this request, 200 again on immediate retry with HIT.
   ```
5. **Dev key hygiene** — the local `.env` file SHOULD NOT contain the prod key
   (AC-31.3). Generate a *second* Congress.gov key (a second account, or ask
   Congress.gov support for a dev-scoped key) and put only that in `.env`:
   ```bash
   # voter-info-widget/.env
   VITE_CONGRESS_API_KEY=DEV_KEY_NOT_PROD
   ```
   Verify no occurrence of the old prod key remains anywhere:
   ```bash
   cd voter-info-widget
   grep -r "OLD_PROD_KEY" . --exclude-dir node_modules --exclude-dir dist 2>/dev/null
   # Expect: no output.
   ```
6. **Revoke the old key** at api.congress.gov (there's a "revoke" button next
   to each key). Do this AFTER the new key is confirmed live — otherwise the
   window between new-key-deployed and old-key-revoked is where production
   would break.

Widget bundle does not need redeployment — the key only lives server-side in
the Worker. The dev key never enters the bundle (AC-26.8 guards React against
`process.env` leaks but the key specifically is read only by dev scripts
like `scripts/build-vote-rosters.ts`).

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

## Zone-level hardening (v2.5.0)

This section is the runnable deployment checklist for FR-28. Every step
below has (a) the dashboard path or CF API call, (b) the expected end state,
(c) a verification command. Work through them in order. Steps marked
**[USER ONLY]** require dashboard / registrar access and cannot be done
from the repo.

The ADR for these choices is `docs/decisions/ADR-007-zone-level-security-posture.md`.
Revisit the full checklist at least annually (AC-28.13).

### 1. [USER ONLY] WAF Managed Rulesets (AC-28.1)

Enable OWASP Core Rule Set in Block mode.

1. Dashboard → `cogs.it.com` zone → **Security → WAF → Managed rules**.
2. Click **Deploy Cloudflare Managed Ruleset**.
3. Set **Action: Block**. Set **Sensitivity: Medium**.
4. Scope: default (entire zone). If traffic on other subdomains starts
   false-positiving, narrow with `hostname eq "vote.cogs.it.com" or
   hostname ends_with ".vote.cogs.it.com"`.
5. Save & Deploy.

**Verify** (after 24h of traffic): `Security → Events` — review any
`managed_challenge` or `block` actions. False positives on `/api/*` are
rare but should be scoped out via **Exceptions**, citing the event ID in
the inline comment.

### 2. [USER ONLY] Bot Fight Mode (AC-28.2)

1. Dashboard → zone → **Security → Bots**.
2. Toggle **Bot Fight Mode: On**. (If the plan supports **Super Bot Fight
   Mode**, use that instead — it has better signals.)
3. **Verified bots** (Googlebot, Bingbot, etc.): **Allow**.
4. **Definitely automated**: **Challenge** (or Block if SBFM).
5. **Likely automated**: **Challenge**.

**Verify**: `curl -A "python-requests/2.31" https://vote.cogs.it.com/` —
should get a challenge page. Legitimate browser UAs should pass through.

### 3. [USER ONLY] Rate Limiting on /api/* (AC-28.3, revised v2.5.1)

Layered with the in-Worker per-IP limit (AC-27.21) wired via wrangler.toml
— this zone rule is the blunt volumetric first line. Per env:

| Env | Hostname | Rate |
|-----|----------|------|
| prod | vote.cogs.it.com | **20 req / 60 s / IP** |
| stg | stg.vote.cogs.it.com | 20 req / 60 s / IP |
| uat | uat.vote.cogs.it.com | 120 req / 60 s / IP |
| dev | dev.vote.cogs.it.com | 1200 req / 60 s / IP |

Create one rule per hostname so the thresholds can differ.

1. Dashboard → zone → **Security → WAF → Rate limiting rules → Create rule**.
2. **Rule name**: `api-rate-limit-prod`.
3. **If incoming requests match**: `(http.host eq "vote.cogs.it.com"
   and starts_with(http.request.uri.path, "/api/"))`.
4. **Characteristics**: `IP source address` (default).
5. **Rate**: `20 requests per 1 minute`.
6. **Then take action**: `Block` for `10 minutes`.
7. Save & Deploy. Repeat for the three non-prod hostnames with the rates in
   the table above.

**Why 20/min/IP in prod**: the widget's intended use is **one address lookup
per visitor**, which fans out to roughly 7 upstream calls after the edge
cache warms. 20 gives ~2.5× headroom over a single legitimate burst and
catches diverse-IP attackers earlier than the previous 100/min threshold.
See ADR-010 for the full rationale.

**Verify prod**: `for i in {1..30}; do curl -o /dev/null -s -w "%{http_code}\n"
-H "Origin: https://trackukraine.com" "https://vote.cogs.it.com/api/census/geocoder/x?benchmark=Public_AR_Current&vintage=Current_Current&format=json&nonce=$i"; done`
— request ~21 should return 429.

**In-Worker rate limit binding** (AC-27.21): already declared per-env in
`wrangler.toml` as `[[unsafe.bindings]] type = "ratelimit"`. Each env has a
distinct `namespace_id` (1001 = prod, 1002 = dev, 1003 = uat, 1004 = stg,
1005 = preview) so the buckets don't collide across envs. No dashboard work
needed — the binding is deployed with the Worker via `wrangler deploy`.

### 4. [USER ONLY] Transform Rules — strip injected headers (AC-28.4)

Removes `Server`, `CF-RAY`, `Report-To`, `NEL`, `Reporting-Endpoints` which
Cloudflare injects *after* the Worker returns.

1. Dashboard → zone → **Rules → Transform Rules → Modify Response Header
   → Create rule**.
2. **Rule name**: `strip-fingerprinting-headers`.
3. **If incoming requests match**: `(http.host wildcard "*vote.cogs.it.com")`.
4. **Then modify response header**:
   - Action: Remove — Header name: `Server`
   - Action: Remove — Header name: `CF-RAY`
   - Action: Remove — Header name: `Report-To`
   - Action: Remove — Header name: `NEL`
   - Action: Remove — Header name: `Reporting-Endpoints`
5. Save & Deploy.

**Verify**: `curl -I https://vote.cogs.it.com/voter-info-widget.iife.js` —
none of the five headers should appear.

### 5. [USER ONLY] TLS min version 1.3 + HTTPS always (AC-28.5, AC-28.6)

1. Dashboard → zone → **SSL/TLS → Edge Certificates**.
2. **Minimum TLS Version**: `TLS 1.3`.
3. **Always Use HTTPS**: `On`.
4. **Automatic HTTPS Rewrites**: `On`.
5. **TLS 1.3**: `On`. **0-RTT**: `Off` (replay-attack concerns).
6. **Opportunistic Encryption**: `On` (harmless).

**Verify**: `openssl s_client -connect vote.cogs.it.com:443 -tls1_2 </dev/null 2>&1 | head -5`
should fail to negotiate. `openssl s_client -connect vote.cogs.it.com:443 -tls1_3 </dev/null 2>&1 | head -20`
should succeed.

### 6. [USER ONLY] Zone-level HSTS (AC-28.7)

Belt-and-braces with the Worker's own HSTS header.

1. Dashboard → zone → **SSL/TLS → Edge Certificates → HTTP Strict Transport
   Security (HSTS) → Enable HSTS**.
2. **Max Age**: `12 months` (31536000 seconds).
3. **Apply HSTS policy to subdomains (includeSubDomains)**: `On`.
4. **Preload**: `On`.
5. **No-Sniff Header**: `On`.
6. Read and accept the warnings. Save.

**Verify**: `curl -I https://vote.cogs.it.com/` — `Strict-Transport-Security`
should be present (the zone-level one reinforces the Worker's, they should
match).

### 7. [USER ONLY] DNSSEC on the apex (AC-28.8)

1. Dashboard → zone → **DNS → Settings → DNSSEC → Enable DNSSEC**.
2. CF shows a DS record. Copy the algorithm, key tag, digest type, digest.
3. Go to the registrar for `cogs.it.com` (wherever you bought the domain).
4. Registrar → DNS/Security → Add DS Record. Paste the values.
5. Wait for propagation (can take up to 48h depending on registrar).

**Verify**: `dig +dnssec cogs.it.com` — output includes `RRSIG` records
and the `ad` (authenticated data) flag. Also: https://dnssec-analyzer.verisignlabs.com/cogs.it.com
should show all green.

### 8. [USER ONLY] CAA records (AC-28.9)

First confirm which CAs Cloudflare is actually using for your cert:

```bash
curl -vI https://vote.cogs.it.com/ 2>&1 | grep -i "issuer:"
```

Expect `Let's Encrypt` or `Google Trust Services` (CF's two common CAs).
Add matching CAA records at the DNS layer:

1. Dashboard → zone → **DNS → Records → Add record**.
2. Add one record per CA:
   - Type: `CAA`, Name: `cogs.it.com`, Flags: `0`, Tag: `issue`, Value: `letsencrypt.org`
   - Type: `CAA`, Name: `cogs.it.com`, Flags: `0`, Tag: `issue`, Value: `pki.goog`
   - Type: `CAA`, Name: `cogs.it.com`, Flags: `0`, Tag: `iodef`, Value: `mailto:YOUR-EMAIL@example.com`
3. If CF ever issues from a third CA (e.g., DigiCert), add it; otherwise
   a cert rotation will fail.

**Verify**: `dig CAA cogs.it.com +short` — your records listed.

### 9. [USER ONLY] Cache Rule — respect origin cache-control (AC-28.10)

1. Dashboard → zone → **Caching → Cache Rules → Create rule**.
2. **Rule name**: `respect-worker-cache-control`.
3. **If incoming requests match**: `(http.host wildcard "*vote.cogs.it.com")`.
4. **Then**:
   - **Cache eligibility**: `Eligible for cache`.
   - **Edge TTL**: `Use cache-control header from origin`.
   - **Browser TTL**: `Respect origin TTL`.
5. Save & Deploy.

**Verify**: `curl -I https://vote.cogs.it.com/voter-info-widget.iife.js`
— `Cache-Control: public, max-age=600` (what the Worker sends), not a
CF-default override.

### 10. [USER ONLY] Geo-block RU and BY (AC-28.11)

1. Dashboard → zone → **Security → WAF → Custom Rules → Create rule**.
2. **Rule name**: `geo-block-ru-by`.
3. **If incoming requests match**: `(ip.geoip.country in {"RU" "BY"})`.
4. **Then take action**: `Block`.
5. **Response type**: Default (Cloudflare block page, 403).
6. Save & Deploy.

**Verify** (from a non-RU/BY IP): `curl -I -H "CF-IPCountry: RU"
https://vote.cogs.it.com/` — this does **not** actually spoof geo (CF
overrides the header), but you can confirm the rule is present in the
dashboard. For a real test, use a VPN exit in RU or BY and expect a 403
block page.

### 11. Submit apex to HSTS preload list (AC-28.7 tail)

The Worker + zone-level HSTS both send `preload`, but the `preload`
directive is advisory until the apex is actually enrolled.

**Prerequisites — verify ALL before submitting**:
- `cogs.it.com` and every subdomain serves valid HTTPS.
- No subdomain is ever intended to serve plaintext HTTP.
- You're committed to HTTPS-only for the apex indefinitely.

Submit at https://hstspreload.org. Approval propagates into Chrome in 1–2
weeks; Firefox and Safari follow. **Once enrolled, removal takes months
and affects every user who has fetched the preload list.** Only submit
when certain.

### 12. [USER ONLY] (Optional) Disable zone-level NEL

If `Report-To` or `NEL` still appear after step 4 (Transform Rules), zone-level
Network Error Logging is enabled. Disable: Dashboard → zone → **Analytics
& Logs → Network Error Logging → Off**. Stops users' browsers beaconing
failed-load telemetry to Cloudflare.

### Post-setup verification script

After completing steps 1–11, the following probes should all pass. Run
from a non-RU/BY IP with good network connectivity.

```bash
HOST=https://vote.cogs.it.com

# Static bundle: 200, strict headers, no CF fingerprints.
curl -sI "$HOST/voter-info-widget.iife.js" | grep -iE \
  "strict-transport|x-content-type|x-frame-options|referrer-policy|cross-origin-resource-policy"
curl -sI "$HOST/voter-info-widget.iife.js" | grep -iE "^(server|cf-ray|report-to|nel):" \
  && echo "FAIL: fingerprint headers still present" || echo "OK: fingerprints stripped"

# API with allowed origin: 200, CORS reflected.
curl -sI -H "Origin: https://trackukraine.com" \
  "$HOST/api/census/geocoder/geographies/onelineaddress?address=x&benchmark=Public_AR_Current&vintage=Current_Current&format=json" \
  | grep -iE "(access-control-allow-origin|vary)"

# API without origin: 403.
curl -sI "$HOST/api/census/x" | head -1

# API with localhost origin in prod: 403 (AC-25.9 regression guard).
curl -sI -H "Origin: http://localhost:9999" "$HOST/api/census/x" | head -1

# Congress non-v3: 400 with JSON envelope (AC-27.6/27.12).
curl -s -H "Origin: https://trackukraine.com" "$HOST/api/congress/admin"

# Encoded CRLF: 400 invalid_upstream_path (AC-27.7).
curl -s -H "Origin: https://trackukraine.com" \
  "$HOST/api/congress/v3/member/foo%0d%0aX-Injected"

# DNSSEC: ad flag set.
dig +dnssec cogs.it.com | grep -E "(ad|RRSIG)"

# TLS 1.2 blocked, 1.3 allowed.
openssl s_client -connect vote.cogs.it.com:443 -tls1_2 </dev/null 2>&1 | grep -E "(no protocols available|handshake failure)"
openssl s_client -connect vote.cogs.it.com:443 -tls1_3 </dev/null 2>&1 | grep "Protocol.*TLSv1.3"

# CAA records present.
dig CAA cogs.it.com +short
```

A full pass means FR-28 is satisfied. Any failure → check the corresponding
step's dashboard setting.

## Access-gated non-prod (FR-29 / ADR-008)

Non-prod Workers (`dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`)
are gated by Cloudflare Access. Prod (`vote.cogs.it.com`) stays public.

### A. [USER ONLY] Disable workers.dev for every project Worker (AC-28.14)

Do this before creating the Access Application — leaving `workers.dev`
enabled creates a public URL that bypasses Access and every zone-level
control.

Option 1 (recommended) — account-wide toggle:
1. Dashboard → **Workers & Pages → Settings → workers.dev preview subdomain
   → Disable**.

Option 2 — per Worker (if some Workers need the `.workers.dev` URL):
1. Dashboard → Workers & Pages → select the Worker.
2. Settings → Domains & Routes → find the `*.workers.dev` entry → Disable.
3. Repeat for `voter-info-widget-proxy` (prod), `-dev`, `-uat`, `-stg`,
   `-preview`.

**Verify:**
```bash
curl -sI https://voter-info-widget-proxy.<ACCOUNT-SUBDOMAIN>.workers.dev/ 2>&1 | head -3
# Expected: connection failure, DNS NXDOMAIN, or 404 — NOT a valid Worker response
```

### B. [USER ONLY] Create the Access Application (AC-29.1 – AC-29.4)

1. Dashboard → **Zero Trust → Access → Applications → Add an application**.
2. Type: **Self-hosted**. Continue.
3. **Application name**: `voter-info-widget-nonprod`.
4. **Session duration**: `24 hours`.
5. **Application domain(s)** — add all three, one at a time:
   - `dev.vote.cogs.it.com`
   - `uat.vote.cogs.it.com`
   - `stg.vote.cogs.it.com`
6. **Identity providers**: confirm **One-time PIN** is enabled. If not, go
   to Zero Trust → Settings → Authentication → Login methods → Add → One-time PIN.
7. **Application Launcher visibility**: off (we don't use the launcher).
8. Save & Continue to policies.

### C. [USER ONLY] Policy 1 — developer access (AC-29.3)

Still inside the Application editor:

1. **Policy name**: `nonprod-team`.
2. **Action**: `Allow`.
3. **Session duration**: inherit from Application (24 hours).
4. **Configure rules → Include**:
   - Selector: `Emails`
   - Value: `kody.manharth@gmail.com` (add one entry per authorized
     developer; keep this list in sync with §Access policy below)
5. Save.

### D. [USER ONLY] Policy 2 — CI service token (AC-29.5)

Service token is created first, then added to the policy.

**D.1 Create the service token:**

1. Dashboard → **Zero Trust → Access → Service Auth → Service Tokens → Create
   Service Token**.
2. **Token name**: `voter-info-widget-ci`.
3. **Duration**: `1 year` (matches the AC-29.11 rotation cadence).
4. Click Generate. **Copy both the Client ID and the Client Secret now** —
   the Secret is shown exactly once.

**D.2 Add the token to the Access Application:**

1. Back in the `voter-info-widget-nonprod` Application → Policies.
2. **Add a policy**:
   - Name: `ci-service-token`
   - Action: `Service Auth`
   - Configure rules → Include → Selector: `Service Token` → Value:
     `voter-info-widget-ci`.
3. Save.

**D.3 Store the token in GitHub Actions secrets:**

```bash
cd voter-info-widget
gh secret set CF_ACCESS_CLIENT_ID --body "<the client ID from D.1>"
gh secret set CF_ACCESS_CLIENT_SECRET --body "<the client secret from D.1>"
```

Verify both are set: `gh secret list` should show them.

### E. Verify the gate works (AC-29.14)

From a clean browser / curl (no Access session, no service token):

```bash
# Prod — still public, 200 with the bundle
curl -sI https://vote.cogs.it.com/voter-info-widget.iife.js | head -1
# Expected: HTTP/1.1 200 OK

# Dev — Access challenge (302 redirect to Access login, or 401 with CF HTML)
curl -sI https://dev.vote.cogs.it.com/voter-info-widget.iife.js | head -5
# Expected: 302 Location pointing at https://<team>.cloudflareaccess.com/...
#           OR 401 with "Cloudflare Access" in the body.
# NOT Expected: 200 OK with the bundle.

# Dev with service token — 200 with the bundle
curl -sI \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://dev.vote.cogs.it.com/voter-info-widget.iife.js | head -1
# Expected: HTTP/1.1 200 OK
```

### F. [ONE-TIME] Developer login for local work (AC-29.10)

For raw curl / browser inspection of non-prod from your dev machine:

```bash
# Install cloudflared (once per machine)
#   macOS:    brew install cloudflared
#   Windows:  choco install cloudflared  (or download binary)
#   Linux:    see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Log in — caches the JWT for 24h
cloudflared access login https://dev.vote.cogs.it.com/

# A browser window opens; complete the OTP challenge. JWT is now cached
# under ~/.cloudflared/. All subsequent curl/browser requests to
# dev.vote.cogs.it.com within 24h pass Access transparently.
```

After login, `curl https://dev.vote.cogs.it.com/...` works from the same
user account without further flags. The JWT is at
`~/.cloudflared/<host>.token`.

### G. Access policy snapshot (for git-reviewability)

Keep this block synced with the actual Access Application:

```
Application:     voter-info-widget-nonprod
Session:         24 hours
Domains:
  - dev.vote.cogs.it.com
  - uat.vote.cogs.it.com
  - stg.vote.cogs.it.com

Policy: nonprod-team (Allow)
  Include → Emails:
    - kody.manharth@gmail.com

Policy: ci-service-token (Service Auth)
  Include → Service Token:
    - voter-info-widget-ci

Identity providers:
  - One-time PIN (email)

Service tokens:
  - voter-info-widget-ci (rotates: yyyy-mm-dd, annually)
```

### H. Rotating Access service tokens (AC-29.11)

Annual (first of the new year) or within 24h of any suspected compromise.

```bash
# 1. Create the new token.
# Dashboard → Zero Trust → Access → Service Auth → Service Tokens → Create.
# Name: voter-info-widget-ci-<YYYY> (e.g., voter-info-widget-ci-2027)
# Copy both the Client ID and Secret.

# 2. Update GitHub secrets (rolling — both old and new valid briefly).
gh secret set CF_ACCESS_CLIENT_ID --body "<new client ID>"
gh secret set CF_ACCESS_CLIENT_SECRET --body "<new client secret>"

# 3. Add the new token to the Access Application policy (ci-service-token).
# Dashboard → Access → Applications → voter-info-widget-nonprod →
#   Policies → ci-service-token → edit Include → add the new Service Token.
# DO NOT remove the old one yet.

# 4. Trigger a CI run on any branch to confirm the new token works.
gh workflow run deploy.yml --ref develop

# 5. Once CI passes green with the new token, remove the old token from
#    the policy.
# Dashboard → policy → remove old Service Token entry.

# 6. Delete the old Service Token from the Service Tokens list.
# Dashboard → Zero Trust → Service Auth → select old token → Delete.
```

### I. Access audit review (AC-29.13)

Weekly sweep — 5 minutes:

1. Dashboard → **Zero Trust → Logs → Access**.
2. Filter: last 7 days.
3. Scan for:
   - Unknown emails attempting login (expected: only allow-list emails).
   - `Service Auth` denials (expected: zero — CI always presents valid token).
   - Logins from geos you don't operate in (expected: your own locations).
   - Unusual login times (3 AM PST while you were asleep).
4. Any anomaly → check whether it correlates with a known cause (a new
   teammate, CI outage, VPN). If not, rotate the service token (§H) and
   investigate.

## Security model

- **API keys** only exist as Worker secrets and GitHub Action secrets. Never
  in code, never in the widget bundle, never sent to the browser.
- **CORS** restricts `/api/*` access to whitelisted origins (default:
  `trackukraine.com`, `www.trackukraine.com`, `localhost`). Arbitrary
  third-party sites cannot use our proxy as a free Congress.gov proxy.
  Static-asset routes (JS, JSON) permit any origin so the bundle can be
  embedded wherever needed.
- **Static assets ship with the Worker.** Worker Sites serves `./dist`
  directly; no separate public R2 bucket, no separate CDN. A compromised
  Worker deploy is the only failure mode for static content.
- **Supply chain.** Our widget JS is served from our Worker, not a
  third-party CDN. Fourthwall operators SHOULD pin it with SRI:
  ```html
  <script src="https://vote.cogs.it.com/voter-info-widget.iife.js"
          integrity="sha384-..." crossorigin="anonymous"
          async></script>
  ```
  The current hash is published at
  `https://vote.cogs.it.com/voter-info-widget.iife.js.sri` (FR-26 AC-26.9).
  SRI intentionally breaks on deploy if the hash isn't updated — the
  embedder SHOULD automate fetching the current hash at their own build
  time.
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
- The static surface is Worker Sites (`./dist` at deploy time).
  Re-check the deploy: `ls dist/` locally before `wrangler deploy`, and
  confirm the workflow's "Stage static assets" / "Check build outputs"
  steps succeeded. `wrangler deploy` re-ships every file in `./dist`.
- For curated JSON specifically: `scripts/publish-to-kv.ts` populates
  KV; the *static* `/ukraineBills.json` and `/ukraineVotes.json` paths
  are served from Worker Sites, not KV.

**`X-Proxy-Cache: MISS` on every request**:
- Cache API writes happen in the background; first few requests per URL are
  expected misses. If misses persist, check the cache key — we strip
  `api_key` from the key so different users share cache entries.
