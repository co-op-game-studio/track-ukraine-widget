# External API Contracts
# Voter Information Widget

**Version**: 2.0.0
**Date**: 2026-04-16

This document is the **authoritative API contract** for this project. External API vendors' own specs are vendored as reference inputs; any divergence between those and real API behavior is captured here as our source of truth.

---

## Source-of-Truth Hierarchy

1. **This document (`docs/api-contracts.md`)** — authoritative for our project
2. **Real API responses** — reality check; drives corrections to this doc
3. **Vendored external specs** — reference only, not canonical
   - Congress.gov OpenAPI 3.0.3: `docs/congress-api-openapi.json` (108 paths, 146 schemas)
     - Extract with: `node scripts/extract-openapi.mjs`
     - Source: embedded in https://api.congress.gov Swagger UI page
   - Census Bureau Geocoder: No machine-readable spec exists. Documented below from live observation.

When this document says something different from the vendored OpenAPI spec, this document wins. Every such divergence is annotated.

---

## 1. U.S. Census Bureau Geocoder

### 1.1 onelineaddress (Geographies)

**Endpoint**: `GET https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress`

**Auth**: None required (free government API)

> **Source note**: No OpenAPI / Swagger spec is published by Census. This contract is documented from live API observation (2026-04-16) against the benchmark `Public_AR_Current` and vintage `Current_Current`.

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| address | string | Yes | Full U.S. street address |
| benchmark | string | Yes | Use `Public_AR_Current` |
| vintage | string | Yes | Use `Current_Current` |
| format | string | Yes | Use `json` |

**Internal Proxy Path**: `GET /api/census/geocoder/geographies/onelineaddress?address={encoded}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`

**Response shape**:
```typescript
interface CensusGeocodeResponse {
  result: {
    input: {
      address: { address: string };
      benchmark: { benchmarkName: string };
      vintage: { vintageName: string };
    };
    addressMatches: CensusAddressMatch[];
  };
}

interface CensusAddressMatch {
  matchedAddress: string;
  coordinates: { x: number; y: number };
  addressComponents: {
    fromAddress: string; toAddress: string;
    preQualifier: string; preDirection: string; preType: string;
    streetName: string;
    suffixType: string; suffixDirection: string; suffixQualifier: string;
    city: string; state: string; zip: string;
  };
  geographies: Record<string, CensusGeography[]>;
}

interface CensusGeography {
  GEOID: string;
  NAME: string;
  BASENAME: string;
  STATE: string;       // FIPS state code (e.g., "17" for IL)
  CD119?: string;      // Congressional district (e.g., "07", "00" for at-large)
  CDSESSN?: string;    // Congress session (e.g., "119")
  FUNCSTAT: string;
  // Layer-specific extra fields (CENTLAT, INTPTLAT, AREALAND, etc.)
  [key: string]: string | number | undefined;
}
```

**Key geography layers**: The `geographies` map contains many layer names. We only use `"119th Congressional Districts"` (update key per Congress when the session changes). Real-observed layer names include:
- `"States"`
- `"Counties"`
- `"119th Congressional Districts"` ← **what we use**
- `"2024 State Legislative Districts - Upper"`
- `"2024 State Legislative Districts - Lower"`
- `"Census Tracts"`, `"2020 Census Blocks"`, `"Urban Areas"`, etc.

**Example** (2000 S State St, Chicago, IL 60616):
```json
{
  "result": {
    "addressMatches": [{
      "matchedAddress": "2000 S STATE ST, CHICAGO, IL, 60616",
      "geographies": {
        "States": [{ "STATE": "17", "NAME": "Illinois" }],
        "119th Congressional Districts": [{
          "STATE": "17", "CD119": "07", "CDSESSN": "119",
          "NAME": "Congressional District 7", "GEOID": "1707"
        }]
      }
    }]
  }
}
```

**At-large** (Wyoming): `CD119: "00"`
**DC delegate**: `NAME: "Delegate District (at Large)"`, `CD119: "98"` (yes, 98 — the Census convention for DC is different from state at-large)

> **Edge case**: DC uses `CD119: "98"` which `parseInt` yields `98`. Congress.gov accepts district `0` for DC. Map `>=90` to `0` when querying Congress.gov.

**Errors**:
- Empty `addressMatches` array — address not recognized
- Missing `"119th Congressional Districts"` layer — unincorporated area; no federal representation data
- HTTP errors are rare; timeouts (1-5s) are the primary failure mode

---

## 2. Congress.gov API (v3)

**Base URL**: `https://api.congress.gov`
**Auth**: `?api_key={key}` query parameter or `X-Api-Key: {key}` header
**Format**: Append `&format=json` to all requests (default is XML)
**Rate Limit**: 5,000 requests/hour per key
**Pagination**: `limit` (default 20, max 250), `offset` (default 0)

> **Source note**: Congress.gov publishes an OpenAPI 3.0.3 spec embedded in the Swagger UI at https://api.congress.gov. Vendored at `docs/congress-api-openapi.json`. Re-extract with `node scripts/extract-openapi.mjs`.

### 2.1 Divergences from Vendored OpenAPI Spec

The following have been observed in real API responses (2026-04-16) but are **wrong or missing** in the vendored OpenAPI spec. **Our types follow the real responses.**

| # | OpenAPI says | Reality | Where |
|---|-------------|---------|-------|
| D-1 | `Members` schema lacks `district` field | Real responses include `district: number \| null` (null for senators) | `/v3/member/congress/{congress}/{stateCode}` and related |
| D-2 | `Member` schema: `lastname` (lowercase) | Real responses use `lastName` (camelCase) | `/v3/member/{bioguideId}` |
| D-3 | `partyHistory.partyName` example says `"Democrat"` | Real responses use `"Democratic"` | `/v3/member/{bioguideId}` |
| D-4 | Member detail list endpoints don't document `pagination` | Real responses include `pagination: { count: number; next?: string }` | All list endpoints |
| D-5 | `houseVoteResults.voteCast` example shows `"Yea"` only | Full set observed: `"Yea"`, `"Nay"`, `"Present"`, `"Not Voting"` | `/v3/house-vote/.../members` |
| D-6 | `/member/{id}/sponsored-legislation` docs imply a homogenous `sponsoredLegislation: Bill[]` list | **Entries are a discriminated union of bills AND amendments.** Amendment entries have `amendmentNumber`, `type: null`, no `number` and no `title` (only `url` pointing at the `amendment` endpoint and `introducedDate`). Any code that reads `type.toLowerCase()` or `number` unconditionally will crash on amendment entries. Same for `/cosponsored-legislation`. | `/v3/member/{bioguideId}/sponsored-legislation` |

> **Principle**: When a divergence is found, add a row to this table and update the types in `src/types/api.ts`. Do not modify `docs/congress-api-openapi.json`.

### 2.2 Endpoints Used by This Project

Only the endpoints we actually use are documented here; the full spec has 108 endpoints.

#### 2.2.1 Members by State/District
**Endpoint**: `GET /v3/member/congress/{congress}/{stateCode}/{district}`
**Returns**: Single-member list (or empty) — the House rep for that district.

#### 2.2.2 Members by State
**Endpoint**: `GET /v3/member/congress/{congress}/{stateCode}?currentMember=true&limit=250`
**Returns**: All current members (senators + house reps) for the state. Filter client-side by `district === null` for senators.

#### 2.2.3 Member Detail
**Endpoint**: `GET /v3/member/{bioguideId}`
**Returns**: Full member detail (camelCase name fields, terms array, partyHistory, legislation counts).

#### 2.2.4 Sponsored / Cosponsored Legislation
**Endpoints**:
- `GET /v3/member/{bioguideId}/sponsored-legislation?limit={n}&offset={o}`
- `GET /v3/member/{bioguideId}/cosponsored-legislation?limit={n}&offset={o}`

**Returns**: `{ sponsoredLegislation: Bill[], pagination }` or `{ cosponsoredLegislation: Bill[], pagination }`

#### 2.2.5 House Vote List
**Endpoint**: `GET /v3/house-vote/{congress}/{session}?limit={n}&offset={o}`
**Returns**: `{ houseRollCallVotes: HouseVoteSummary[], pagination }`

#### 2.2.6 House Vote Detail (with party totals)
**Endpoint**: `GET /v3/house-vote/{congress}/{session}/{rollCallNumber}`
**Returns**: `{ houseRollCallVote: { ...HouseVoteNumberBase, votePartyTotal, voteQuestion } }`

#### 2.2.7 House Vote Members
**Endpoint**: `GET /v3/house-vote/{congress}/{session}/{rollCallNumber}/members`
**Returns**: `{ houseRollCallVoteMemberVotes: { ...base, results: HouseMemberVote[] } }`

### 2.3 Canonical Response Shapes

Full TypeScript types live in `src/types/api.ts`. These are the **authoritative** shapes for our project (corrected for divergences from the vendored OpenAPI spec).

---

## 3. Senate.gov Vote XML

**No authentication required.** No machine-readable spec; documented from live observation (2026-04-16).

### 3.1 Vote Index

**URL**: `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml`
**Internal Proxy Path**: `/api/senate/legislative/LIS/roll_call_lists/vote_menu_119_2.xml`

**XML Structure** (verified shape):
```xml
<vote_summary>
  <congress>119</congress>
  <session>1</session>
  <congress_year>2025</congress_year>
  <votes>
    <vote>
      <vote_number>00659</vote_number>
      <vote_date>18-Dec</vote_date>
      <issue>PN373</issue>
      <question>On the Cloture Motion</question>
      <result>Agreed to</result>
      <vote_tally>
        <yeas>51</yeas>
        <nays>42</nays>
      </vote_tally>
      <title>Motion to Invoke Cloture: ...</title>
    </vote>
  </votes>
</vote_summary>
```

**Notes**:
- `vote_number` in the **index** is zero-padded to 5 digits (`00659`)
- `vote_date` in the index is short form (`18-Dec`), not ISO
- `question` values may have trailing whitespace / embedded newlines — trim before use
- `issue` contains the bill or resolution reference (e.g., `H.R. 1234`, `PN373` for nominations)

### 3.2 Individual Vote Detail

**URL**: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{paddedNumber}.xml`
**Internal Proxy Path**: `/api/senate/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00659.xml`
**Padding**: Vote number in the URL path is zero-padded to 5 digits.

**XML Structure** (verified shape):
```xml
<roll_call_vote>
  <congress>119</congress>
  <session>1</session>
  <congress_year>2025</congress_year>
  <vote_number>659</vote_number>               <!-- NOT padded in the body -->
  <vote_date>December 18, 2025,  09:42 PM</vote_date>
  <modify_date>December 18, 2025,  10:15 PM</modify_date>
  <vote_question_text>On the Cloture Motion PN373</vote_question_text>
  <vote_document_text>Sara Bailey, of Texas, ...</vote_document_text>
  <vote_result_text>Cloture Motion Agreed to (51-42)</vote_result_text>
  <question>On the Cloture Motion</question>
  <vote_title>...</vote_title>
  <majority_requirement>1/2</majority_requirement>
  <vote_result>Cloture Motion Agreed to</vote_result>
  <document>...</document>
  <amendment>...</amendment>
  <count>
    <yeas>51</yeas>
    <nays>42</nays>
    <present/>                                  <!-- self-closing when zero -->
    <absent>7</absent>
  </count>
  <members>
    <member>
      <member_full>Alsobrooks (D-MD)</member_full>
      <last_name>Alsobrooks</last_name>
      <first_name>Angela</first_name>
      <party>D</party>                          <!-- "D" | "R" | "I" -->
      <state>MD</state>                         <!-- two-letter code -->
      <vote_cast>Nay</vote_cast>
      <lis_member_id>S428</lis_member_id>       <!-- Senate's own ID, not bioguide -->
    </member>
  </members>
</roll_call_vote>
```

**Differences from the index** (important):
- S-1: `vote_number` inside the detail body is **unpadded** (`659`), but the URL path requires **padded** (`00659`)
- S-2: `vote_date` in detail is long form with double-space: `"December 18, 2025,  09:42 PM"`
- S-3: `<present/>` and other count fields are **self-closing when zero** — parsers must handle empty text content as `0`
- S-4: No `<not_voting>` field exists; `<absent>` covers both absent + not voting
- S-5: `lis_member_id` field (e.g., `S428`) is Senate's internal ID, distinct from Congress.gov `bioguideId`. We match senators by `last_name` + `state` since we don't have an `lis_member_id` ↔ `bioguideId` mapping.

**Vote cast values** (observed): `Yea`, `Nay`, `Present`, `Not Voting`, `Guilty`, `Not Guilty` (impeachment)

**Normalization**: Senate XML uses `Yea`/`Nay`; House uses `Yea`/`Nay` too in the modern API (earlier endpoints used `Aye`). Domain types normalize everything to `Aye`/`Nay` for consistency. Mapping: `Yea` → `Aye`, all others preserved.

---

## 4. Internal Proxy Contract

All external API calls are routed through a unified proxy. The proxy adds CORS headers and injects API keys.

### 4.1 Route Mapping

| Client Path | Target | API Key Injection |
|------------|--------|-------------------|
| `/api/census/*` | `https://geocoding.geo.census.gov/*` | None (no auth required) |
| `/api/congress/*` | `https://api.congress.gov/*` | `?api_key={CONGRESS_API_KEY}` appended |
| `/api/senate/*` | `https://www.senate.gov/*` | None (no auth required) |

### 4.2 Proxy Response Headers

```
Access-Control-Allow-Origin: <matched allowlist entry>
Access-Control-Allow-Methods: GET, HEAD, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Trace-Id
Access-Control-Expose-Headers: X-Trace-Id, X-Cache, X-Cache-Tier, Retry-After
Vary: Origin
X-Trace-Id: tr_<16hex>                              # FR-36 — every response
X-Cache: HIT | MISS                                 # FR-40 — cacheable routes
X-Cache-Tier: edge | kv | r2 | upstream             # FR-40 — cacheable routes
```

`X-Trace-Id` is set on every response. `X-Cache` and `X-Cache-Tier` appear on responses served via the tiered cache pipeline (`serveCached` from `proxy/cache/pipeline.ts`); they are absent on non-cacheable routes like `OPTIONS` preflights and the preview HTML.

### 4.3 Canonical Error Envelope (v2.6.0 — FR-37)

Every non-2xx, non-304 Worker response with a body uses this envelope:

```json
{
  "error": {
    "code": "<enum>",
    "message": "<operator-facing detail>",
    "userMessage": "<end-user-safe message>",
    "upstream": "congress" | "senate" | "census" | null,
    "retryable": true | false,
    "traceId": "tr_<16hex>"
  }
}
```

**Closed enumeration of `code` values** (FR-37 AC-37.2):

| `code` | HTTP status | `retryable` | Meaning |
|--------|-------------|-------------|---------|
| `bad_request` | 400 | false | Malformed client input (bad path, bad query param) |
| `origin_not_allowed` | 403 | false | CORS origin allowlist rejected the request |
| `rate_limited` | 429 | true | In-Worker or upstream rate limit hit; carries `Retry-After` header |
| `not_found` | 404 | false | Requested KV key or R2 object absent; no upstream fallback applied |
| `upstream_4xx` | 502 (gateway-style) | false | Upstream returned 4xx other than 429; not retryable at the widget level |
| `upstream_5xx` | 502 | true | Upstream returned 5xx |
| `upstream_timeout` | 504 | true | Upstream fetch exceeded 15s abort timeout |
| `upstream_parse_error` | 502 | false | Upstream response body failed to parse (truncation, malformed JSON/XML) |
| `internal_error` | 500 | true | Uncaught exception at Worker level |

**Widget contract (FR-37 AC-37.5, AC-37.8):**
- On `response.ok === false`, the widget parses the envelope.
- On `retryable: true`, the widget renders a "Try again" button that re-issues the original request.
- On `retryable: false`, the widget renders `userMessage` with no retry affordance.
- The widget SHALL display the trace ID below the error message in the form `Reference: tr_<id>` — muted, monospace, selectable.
- The widget SHALL NOT display `error.message` (operator context).

**Removed (v2.6.0):** The legacy shape `{ error: 'upstream_error', status, upstream }` used prior to v2.6.0 is gone. No dual-shape compatibility window — the widget is the sole consumer.

### 4.4 Trace-ID Header (v2.6.0 — FR-36)

- The Worker generates `X-Trace-Id: tr_<16hex>` on every inbound request. Clients MAY supply `X-Trace-Id` on the request; the Worker echoes the supplied value if it matches `/^tr_[0-9a-f]{16}$/`, else generates a new one (client-supplied IDs of any other shape are silently replaced).
- The trace ID is forwarded as `X-Trace-Id` on every upstream fetch the Worker makes on behalf of the request.
- The trace ID appears in every structured log line (`proxy/observability/log.ts`) and every Analytics Engine data point (`proxy/observability/analytics.ts`) for the request.

### 4.5 Cache Tier Header (v2.6.0 — FR-40)

`X-Cache-Tier` is set on every response served through the tiered cache pipeline:

- `edge` — `caches.default` hit (per-POP).
- `kv` — `KV_VOTER_INFO` hit (global).
- `r2` — `R2_STATIC` hit (global, durable archive).
- `upstream` — all tiers missed; response came from live upstream.

Paired with `X-Cache: HIT` (tiers 0–2) or `X-Cache: MISS` (upstream).

---

## 5. KV-Backed Internal Routes (v2.5.x)

Routes under this section are served directly from the Worker's `KV_VOTER_INFO` namespace — no upstream call on a cache hit. Cache-Control values here are the Worker-emitted values that govern CDN/browser caching of these routes; they differ from the upstream pass-through routes in §4 because the KV routes are authoritative (their freshness is driven by curator runs, not upstream staleness).

### 5.1 `GET /api/members/{bioguideId}`

**Spec anchor:** FR-32 AC-32.1, AC-32.14, AC-32.18, AC-32.19.

**Backing key:** `member:v1:{bioguideId}`.

**Response (200):**

```json
{
  "bioguideId": "D000563",
  "first": "Richard",
  "last": "Durbin",
  "officialName": "Richard J. Durbin",
  "state": "IL",
  "district": null,
  "chamber": "Senate",
  "party": "D",
  "photoUrl": "https://www.congress.gov/img/member/d000563_200.jpg",
  "website": "https://www.durbin.senate.gov",
  "searchKey": "richard durbin",
  "sponsored":   [ /* CongressLegislationRawEntry[], up to 250 */ ],
  "cosponsored": [ /* CongressLegislationRawEntry[], up to 250 */ ],
  "generatedAt": "2026-04-18T18:01:40.123Z",
  "schemaVersion": 1
}
```

`sponsored[]` / `cosponsored[]` carry the raw Congress.gov entry shape (§2.2 table of sponsored-legislation endpoints). Consumers filter these to the curated Ukraine set and compute per-bill valence at render time; the Worker does not pre-filter.

**Response (404):** `{"error":"member_not_found","bioguideId":"<id>"}` when no `member:v1:<id>` key exists and the Worker's read-through returned a 404 from `/v3/member/{id}`.

**Response (502):** `{"error":"upstream_error","detail":"upstream_body_invalid"}` when the required `/v3/member/{id}` upstream returned a malformed JSON body during the read-through write. Optional legs (sponsored, cosponsored) degrade to `[]` on parse failure per AC-32.19.

**Response (504):** `{"error":"upstream_timeout","upstream":"member detail"}` on AC-27.18 15-second timeout of the required detail leg.

**Cache-Control:** `public, max-age=60, s-maxage=300` (AC-32.14). The Worker also writes the resulting record back to KV with a 30-day `expirationTtl` (AC-32.18).

### 5.2 `GET /api/name-search?q={query}`

**Spec anchor:** FR-31, AC-32.4, AC-32.14.

**Backing keys:** `name-index:v1:meta`, `name-index:v1:{letter}`.

**Response (200):**

```json
{
  "results": [
    {
      "bioguideId": "J000289",
      "displayName": "Jim Jordan",
      "first": "Jim",
      "last": "Jordan",
      "state": "OH",
      "chamber": "House",
      "district": 4,
      "party": "R",
      "photoUrl": "https://www.congress.gov/img/member/j000289_200.jpg",
      "searchKeys": ["jim", "jordan"]
    }
  ],
  "truncated": false
}
```

`district` is `number | null` — House members emit the district number; senators and non-voting delegates emit `null` (AC-32.4 v2.5.2).

**Response (400):** `{"error":"query_too_short"}` when the normalized query is fewer than 2 characters.

**Response (503):** `{"error":"index_not_ready"}` when `name-index:v1:meta` is absent (curator has not yet populated the namespace). Widget behavior: disable input and show hint per AC-31.9.

**Cache-Control:** `public, max-age=60, s-maxage=300` (AC-32.14).

### 5.3 `GET /api/bills/{billId}`

**Spec anchor:** FR-32 AC-32.2.

**Backing key:** `bill:v1:{billId}` — canonical curated-bill metadata. `billId` is the concatenated uppercase type + number, e.g., `HR815`, `HR7691`, `SRES412`.

**Response (200):** the verbatim KV record (see AC-32.2 shape).

**Response (400):** `{"error":"invalid_bill_id"}` for malformed IDs (fails the `/^[A-Z]+\d+$/i` shape check).

**Response (404):** `{"error":"bill_not_found","billId":"<id>"}` when no record exists (uncurated bill).

**Cache-Control:** `public, max-age=60, s-maxage=300`.

### 5.4 `GET /api/roll-calls/{chamber}/{congress}/{session}/{rollCall}`

**Spec anchor:** FR-32 AC-32.3.

**Backing key:** `roll-call:v1:{chamber}:{congress}:{session}:{rollCall}` — curated roll-call metadata (question, result, totals, linked billId). `chamber` is `house` or `senate` (lowercase); all four path segments are required.

**Response (200):** the verbatim KV record (AC-32.3 shape).

**Response (400):** `{"error":"invalid_roll_call_key"}` when any path segment fails shape validation.

**Response (404):** `{"error":"roll_call_not_found"}` when the record does not exist.

**Cache-Control:** `public, max-age=60, s-maxage=300`.

### 5.5 `GET /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall}` (NEW v2.5.2)

**Spec anchor:** FR-32 AC-32.15.

**Backing key:** `roll-call-roster:v1:{chamber}:{congress}:{session}:{rollCall}`.

**Response (200) — House:**

```json
{
  "rollCallId": "house:118:2:151",
  "chamber": "house",
  "congress": 118,
  "session": 2,
  "rollCall": 151,
  "casts": { "J000289": "Nay", "D000096": "Yea", /* ...all House members... */ },
  "generatedAt": "2026-04-19T02:00:00Z",
  "schemaVersion": 1
}
```

**Response (200) — Senate:** same envelope with `"chamber":"senate"` and `casts` as an array of `{ lastName, state, cast, firstName?, party? }` entries (Senate XML carries no bioguide — see design.md §4.3 for lastName+state matching).

**Response (400):** `{"error":"invalid_roll_call_key"}` on malformed path.

**Response (404):** `{"error":"roll_call_roster_not_found"}` — means the curator has not yet written a roster for this roll-call. Client behavior: treat as "Did Not Vote" for any member, surface a non-blocking warning to observability.

**Cache-Control:** `public, max-age=86400, s-maxage=31536000, immutable` — roll-call rosters are historical and never change.

### 5.6 `GET /api/state-members/{stateCode}` (NEW v2.5.2)

**Spec anchor:** FR-32 AC-32.16.

**Backing key:** `state-members:v1:{stateCode}`.

**Response (200):**

```json
{
  "stateCode": "IL",
  "senators": [
    { "bioguideId": "D000563", "first": "Richard", "last": "Durbin", /* ... */ },
    { "bioguideId": "D000622", "first": "Tammy",   "last": "Duckworth", /* ... */ }
  ],
  "house": [
    { "bioguideId": "J000309", "district": 1, /* ... */ },
    /* ...sorted by district asc... */
  ],
  "generatedAt": "2026-04-19T02:00:00Z",
  "schemaVersion": 1
}
```

`MemberSummary` shape: `{ bioguideId, first, last, officialName, state, district: number | null, chamber, party, photoUrl, website }`. `house[]` is sorted by district ascending. `senators[]` is sorted by last name ascending (Congress.gov does not expose seniority class on the member-list endpoint; if seniority sort is required, the widget can sort client-side after cross-referencing the individual member records).

**Response (400):** `{"error":"invalid_state_code"}` when `stateCode` fails the `/^[A-Z]{2}$/` check (case-insensitive accepted, normalized on read).

**Response (404):** `{"error":"state_members_not_found"}` when no record exists (curator has not written yet, or stateCode is valid syntax but not a U.S. state/territory).

**Cache-Control:** `public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600`.

---

## 7. V4 Admin + Editorial Routes (NEW v2.7.0)

These routes are introduced by V4 (FR-49..FR-58). They split into three classes:

- **Admin write API** (`/api/admin/*`) — gated by Cloudflare Access at the edge AND independently JWT-verified by the Worker (FR-50). Source of truth is D1.
- **Embed read API** (`/api/comments/*`, `/api/social-posts/*`, `/api/quotes/*`) — public; reads from KV records written by the publish pipeline (FR-51). Tolerates 404 as "empty list" per AC-53.5.
- **Stats + audit feed** (`/api/stats/*`, `/api/audit/public`) — public-aggregate; the authenticated audit feed is `/api/admin/audit`.

### 7.1 Admin auth (Cloudflare Access JWT)

Every admin request carries two CF-set headers:

```
Cf-Access-Jwt-Assertion: <RS256 JWT signed by team key>
Cf-Access-Authenticated-User-Email: alice@example.com   (informational only)
```

The Worker uses **only the JWT** to identify the actor — the plain email header is ignored to prevent spoofing on a misconfigured route. The verify path:

1. Extract `Cf-Access-Jwt-Assertion` (missing → `401 admin_jwt_required`).
2. Verify RS256 signature against the team JWKS at `https://<CF_ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs` (cached in module-scope memo + KV `cache:v1:cf-access-jwks`, 1 h TTL).
3. Check `aud` claim matches `CF_ACCESS_AUD`.
4. Check `iss` claim matches `https://<CF_ACCESS_TEAM>.cloudflareaccess.com`.
5. Check `exp` is in the future, `iat`/`nbf` are not in the future (60 s clock skew).
6. Read `email` from the verified claims.

Failure modes (FR-37 envelope):

| Status | `error` | When |
|--------|---------|------|
| 500 | `admin_misconfigured` | `CF_ACCESS_TEAM` or `CF_ACCESS_AUD` env not set |
| 401 | `admin_jwt_required` | `Cf-Access-Jwt-Assertion` header absent |
| 401 | `admin_jwt_invalid` | Signature / `aud` / `iss` / `exp` / `iat` / `nbf` check failed; `detail` carries a stable reason code |
| 503 | `admin_jwks_unavailable` | JWKS endpoint unreachable |
| 500 | `admin_actor_missing` | JWT verified but lacks `email` claim (CF Access shape changed) |

The Worker does NOT consult any env-var email allowlist — that policy lives in Cloudflare Access. Disabling `*.workers.dev` and preview URLs in `wrangler.toml` (`workers_dev = false`, `preview_urls = false`) is the matching infrastructure-side hardening so the only inbound path to the Worker is the gated zone hostname.

### 7.2 `GET /api/admin/whoami`

Returns the validated identity for the SPA's header badge.

```json
{ "email": "alice@example.com" }
```

`Cache-Control: no-store`.

### 7.3 Researcher CRUD: bills / votes / comments / social-posts / quotes

Each resource exposes the same shape:

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/admin/{resource}?limit=&offset=&q=&billId=&bioguideId=` | — | `{ items: T[], total: number }` |
| GET | `/api/admin/{resource}/{id}` | — | `T` |
| POST | `/api/admin/{resource}` | `Partial<T>` (server fills id, timestamps) | `{ row: T, audit: AuditRow }` |
| PATCH | `/api/admin/{resource}/{id}` | `Partial<T>` | `{ row: T, audit: AuditRow }` |
| DELETE | `/api/admin/{resource}/{id}` | — | `{ deleted: true, audit: AuditRow }` |

Resources and their D1 row shapes (see design.md §4.16 for SQL):

```ts
// /api/admin/bills
interface Bill {
  id: string;                  // ULID, server-assigned
  bill_id: string;             // e.g. "117-HR-2471"
  congress: number;
  type: string;                // "HR" | "S" | "HJRES" | …
  number: string;
  featured: boolean;
  label: string | null;
  title: string;
  latest_action: string | null;
  latest_action_date: string | null;
  became_law: boolean;
  congress_gov_url: string | null;
  direction: "pro-ukraine" | "anti-ukraine" | "ambiguous";
  direction_reason: string | null;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
}

// /api/admin/votes
interface Vote {
  id: string;
  bill_id: string;
  chamber: "House" | "Senate";
  congress: number;
  session: number;
  roll_call: number;
  date: string;
  url: string | null;
  action: string | null;
  action_date: string | null;
  weight: number;              // FR-54: 0..5
  direction_multiplier: -1 | 0 | 1;
  kind: string;                // "final-passage" | "concur" | …
  weight_reason: string | null; // FR-54 AC-54.6: standing rationale for the current weight + multiplier
  created_at: string;
  updated_at: string;
}

// /api/admin/comments
interface Comment {
  id: string;
  bill_id: string;
  attached_to_roll_call_id: string | null;  // "{chamber}:{congress}:{session}:{rollCall}" when scoped to a vote
  body_markdown: string;
  score_adjustment: number;
  author_email: string;
  created_at: string;
  updated_at: string;
}

// /api/admin/social-posts
interface SocialPost {
  id: string;
  bioguide_id: string;
  platform: "x" | "facebook" | "youtube" | "instagram" | "other";
  url: string;
  posted_at: string | null;
  body_text: string;
  score_adjustment: number;
  comment: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

// /api/admin/quotes
interface Quote {
  id: string;
  bioguide_id: string;
  media_kind: "video" | "audio" | "text" | "image";
  source_url: string;
  source_label: string | null;
  quoted_at: string | null;
  body_text: string;
  score_adjustment: number;
  comment: string | null;
  author_email: string;
  created_at: string;
  updated_at: string;
}

interface AuditRow {
  id: string;
  actor_email: string;
  action: "create" | "update" | "delete";
  target_table: string;
  row_id: string;
  row_title: string | null;
  before: unknown | null;
  after: unknown | null;
  reason: string | null;
  created_at: string;
}
```

**Validation rules:**

- `Vote.weight ∈ [0, 5]` — clamp negative; reject above 5 with `400 invalid_weight`.
- `Vote.direction_multiplier ∈ {-1, 0, 1}` — reject other values with `400 invalid_direction_multiplier`.
- `Comment.bill_id` MUST reference an existing `bills.bill_id` — `400 unknown_bill_id` if not.
- `Comment.attached_to_roll_call_id` MAY be `null`; when set, MUST match an existing `votes` row — `400 unknown_roll_call_id` if not.
- `SocialPost.url` MUST pass `sanitizeUrl` (existing utility) — `400 invalid_url` if not.
- `SocialPost.platform` MUST be one of the enum values — `400 invalid_platform`.
- All POST / PATCH bodies MUST be `Content-Type: application/json` — `415 unsupported_media_type` if not.

**Audit `reason` (change notes) — FR-50 AC-50.8.**

Every body MAY carry a leading-underscore namespaced field `_reason: string` carrying the audit-log change notes. `_reason` is stripped from the body before it reaches the resource validators, so it never collides with a column. Posture per method:

| Method | `_reason` posture |
|--------|-------------------|
| `POST` (create) | optional |
| `PATCH` (update) | **required**; missing or whitespace-only → `400 reason_required` |
| `DELETE` | **required**; supply via body OR `?reason=…` query param; missing → `400 reason_required` |

The reason flows into `audit_log.reason` and is exposed on the authenticated audit feed (`/api/admin/audit`) — never on the public feed (`/api/audit/public`).

**Errors** all follow the FR-37 envelope shape: `{ error, traceId, ...optional fields }`.

### 7.4 `GET /api/admin/audit`

Authenticated audit feed — full row data including `before` / `after` JSON.

**Query params:** `?limit=N` (max 100, default 50), `?since=ISO`.

**Response (200):**

```json
{ "items": [ AuditRow, … ] }
```

`Cache-Control: no-store` (always-fresh for the SPA's Recent Activity tab).

### 7.5 `GET /api/audit/public`

Public, redacted audit feed for the embed's "Recent researcher updates" panel (AC-53.4).

**Query params:** `?limit=N` (max 50, default 20).

**Response (200):**

```json
{
  "items": [
    {
      "id": "01HQXYZ…",
      "actorLocalPart": "alice",
      "action": "update",
      "table": "votes",
      "rowTitle": "117-HR-2471 / House roll 65",
      "createdAt": "2026-05-02T18:43:21Z"
    }
  ]
}
```

**Redactions:** email domain stripped (`alice@example.com → "alice"`); `before` / `after` / `reason` NOT exposed. Per AC-58.2.

**Cache-Control:** `public, max-age=60, s-maxage=120`.

### 7.6 `GET /api/comments/{billId}`

Public read of researcher comments attached to a bill — consumed by `VoteList` row expand (AC-53.1).

**Path param:** `billId` — e.g. `117-HR-2471`.

**Response (200):**

```json
{
  "billId": "117-HR-2471",
  "comments": [
    {
      "id": "01HQXYZ…",
      "bodyMarkdown": "This was the floor vote that …",
      "scoreAdjustment": -0.05,
      "attachedToRollCallId": "house:117:2:65",
      "authorEmail": "alice@example.com",
      "createdAt": "2026-05-02T18:43:21Z",
      "updatedAt": "2026-05-02T18:43:21Z"
    }
  ],
  "generatedAt": "2026-05-02T19:00:00Z",
  "schemaVersion": 1
}
```

**Response (404):** treated by callers as `{ comments: [] }` per AC-53.5. Worker SHALL still return `404` with FR-37 envelope so trace correlation works.

**Cache-Control:** `public, max-age=60, s-maxage=300`.

### 7.7 `GET /api/social-posts/{bioguideId}`

Public read of curated social posts for a representative — consumed by the Statements tab (AC-53.2).

**Path param:** `bioguideId` — e.g. `D000563`.

**Response (200):**

```json
{
  "bioguideId": "D000563",
  "posts": [
    {
      "id": "01HQXYZ…",
      "platform": "x",
      "url": "https://x.com/SenatorDurbin/status/…",
      "postedAt": "2026-04-28T12:00:00Z",
      "bodyText": "…",
      "scoreAdjustment": 0.02,
      "comment": "Cited HR 815 floor speech",
      "authorEmail": "alice@example.com",
      "createdAt": "2026-05-02T18:43:21Z"
    }
  ],
  "generatedAt": "2026-05-02T19:00:00Z",
  "schemaVersion": 1
}
```

**Cache-Control:** `public, max-age=60, s-maxage=300`.

### 7.8 `GET /api/quotes/{bioguideId}`

Public read of curated quotes for a representative — consumed by the Quotes tab (AC-53.2).

**Path param:** `bioguideId`.

**Response (200):**

```json
{
  "bioguideId": "D000563",
  "quotes": [
    {
      "id": "01HQXYZ…",
      "mediaKind": "video",
      "sourceUrl": "https://www.c-span.org/video/?…",
      "sourceLabel": "C-SPAN floor speech, 2024-02-13",
      "quotedAt": "2024-02-13",
      "bodyText": "…",
      "scoreAdjustment": 0.05,
      "comment": null,
      "authorEmail": "alice@example.com",
      "createdAt": "2026-05-02T18:43:21Z"
    }
  ],
  "generatedAt": "2026-05-02T19:00:00Z",
  "schemaVersion": 1
}
```

**Cache-Control:** `public, max-age=60, s-maxage=300`.

### 7.9 `GET /api/stats/v1/summary`

Public statistics blob (FR-56). Returned from a single KV record `stats:v1:summary` updated by the publish pipeline.

**Response (200):**

```json
{
  "generatedAt": "2026-05-02T19:00:00Z",
  "schemaVersion": 1,
  "perBill": [
    { "billId": "117-HR-2471", "voteCount": 5, "weightTotal": 2.8, "directionPro": 5, "directionAnti": 0 }
  ],
  "perRepHistogram": {
    "buckets": [-1.0, -0.9, -0.8, …, 0.9, 1.0],
    "counts":  [12, 5, 4, …, 22, 31]
  },
  "topAntiUkraine": [
    { "bioguideId": "X000123", "displayName": "…", "score": -0.94, "weightedAntiActions": 8.2 }
  ],
  "commentsTimeseries": [
    { "date": "2026-04-25", "count": 3 },
    { "date": "2026-04-26", "count": 7 }
  ],
  "partyPriors": { "D": 0.71, "R": -0.42, "I": null }
}
```

**Response (503):** `{ error: "stats_not_ready", traceId, retryAfterSeconds: 60 }` with `Retry-After: 60`. Per AC-56.4.

**Cache-Control:** `public, max-age=300, s-maxage=900`.

**Rate limit:** 30 requests / 60s per IP, separate budget from the other public routes.

---

## 6. Spec Refresh Workflow

When we suspect the external OpenAPI spec has changed:

```bash
node scripts/extract-openapi.mjs
git diff docs/congress-api-openapi.json
```

Review the diff. If it affects endpoints we use:
1. Update §2.2 endpoint descriptions if behavior changed
2. Update §2.1 divergence table if new mismatches appear
3. Update `src/types/api.ts` if shapes changed
4. Update/add tests to lock in the new contract
5. Run `npm test` to catch breakage

Vendored spec last extracted: **2026-04-16** (108 paths, 146 schemas)
