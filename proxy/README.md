# Voter Info Widget — Reference CORS Proxy

This is the production CORS proxy for the widget. It routes three API paths,
injects the Congress.gov API key server-side, and adds CORS headers so the
widget can call the APIs from a browser.

## Routes

| Path | Target | Auth |
|------|--------|------|
| `/api/census/*` | `https://geocoding.geo.census.gov/*` | none |
| `/api/congress/*` | `https://api.congress.gov/*` | `?api_key=` injected from `CONGRESS_API_KEY` |
| `/api/senate/*` | `https://www.senate.gov/*` | none |

The authoritative contract is in [`docs/api-contracts.md §4`](../docs/api-contracts.md).

## Deploy to Cloudflare Workers

1. Install wrangler: `npm install -g wrangler`
2. Create `wrangler.toml`:
   ```toml
   name = "voter-info-proxy"
   main = "worker.js"
   compatibility_date = "2024-09-01"
   ```
3. Set the API key secret:
   ```
   wrangler secret put CONGRESS_API_KEY
   ```
4. (Optional) Restrict CORS to your embed origin:
   ```
   wrangler secret put ALLOW_ORIGIN
   # enter https://your-site.example.com
   ```
5. Deploy:
   ```
   wrangler deploy
   ```
6. Point the widget at your proxy by setting the `api-base` attribute:
   ```html
   <voter-info-widget api-base="https://voter-info-proxy.example.workers.dev">
   </voter-info-widget>
   ```

## Manual testing

```bash
# Census (no auth)
curl "https://your-proxy.example.workers.dev/api/census/geocoder/geographies/onelineaddress?address=1+Penn+Ave&benchmark=Public_AR_Current&vintage=Current_Current&format=json"

# Congress.gov (key injected)
curl "https://your-proxy.example.workers.dev/api/congress/v3/member/congress/119/IL/7?currentMember=true&format=json"

# Senate XML
curl "https://your-proxy.example.workers.dev/api/senate/legislative/LIS/roll_call_lists/vote_menu_119_2.xml"
```

Each response should include `Access-Control-Allow-Origin: *` (or your configured origin).

## Port to another platform

The Worker uses only standard fetch + Request/Response APIs, so it ports directly to:

- **Vercel Edge Functions** — rename `export default` to `export const config = { runtime: 'edge' }; export default async function handler(...)` and adapt.
- **AWS Lambda@Edge / CloudFront Functions** — wrap in the CloudFront event shape.
- **Deno Deploy** — use `Deno.serve({ port: 8000 }, async (req) => { ... })`.
