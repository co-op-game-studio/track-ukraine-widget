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
Access-Control-Allow-Origin: * (or specific embed domain)
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

### 4.3 Error Handling

The proxy MUST:
- Strip API keys from any error response bodies
- Return `502 Bad Gateway` for upstream failures
- Return `429 Too Many Requests` if upstream returns rate limit errors
- Pass through upstream HTTP status codes otherwise

---

## 5. Spec Refresh Workflow

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
