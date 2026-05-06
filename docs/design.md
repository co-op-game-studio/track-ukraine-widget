# Software Design Document (SDD)
# Voter Information Widget — Ukraine Focus

**Version**: 2.0.0
**Date**: 2026-04-16
**Status**: Active
**Based on**: IEEE 1016-2009

---

## 1. Introduction

### 1.1 Purpose

This document describes the software architecture and detailed design of the Voter Information Widget. It serves as the technical blueprint for implementation and provides traceability to the requirements defined in [spec.md](spec.md).

### 1.2 Scope

Covers the complete system design including: component architecture, data flow, external API integration, CORS proxy strategy, embedding mechanism, and algorithmic design for party alignment scoring.

### 1.3 References

- [spec.md](spec.md) — Software Requirements Specification
- [api-contracts.md](api-contracts.md) — External API Contracts
- [ADR-001](decisions/ADR-001-framework-choice.md) — Framework Choice
- [ADR-002](decisions/ADR-002-cors-proxy-strategy.md) — CORS Proxy Strategy
- [ADR-003](decisions/ADR-003-senate-vote-source.md) — Senate Vote Source
- [ADR-004](decisions/ADR-004-embed-strategy.md) — Embed Strategy

---

## 2. Architecture Overview

### 2.1 System Context

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│                 │     │                  │     │                     │
│  Host Website   │────▶│  CORS Proxy      │────▶│  External APIs      │
│  (embeds widget)│     │  (CF Worker)     │     │  - Census Geocoder  │
│                 │     │                  │     │  - Congress.gov     │
└─────────────────┘     └──────────────────┘     │  - Senate.gov       │
                                                  └─────────────────────┘
```

The widget runs entirely in the browser. All API calls route through a CORS proxy that injects API keys server-side and adds CORS headers to responses.

### 2.2 High-Level Component Diagram

```
VoterInfoWidget (root)
├── AddressInput
│     └── Form with text input + submit button
├── ErrorBanner
│     └── Displays API errors and invalid input messages
└── ResultsPanel
      │ // v2: explicit 2-up layout
      │ ┌────────────────────────────────┐
      │ │ RepCard (Senator 1)  │ RepCard (Senator 2) │   ← row 1 (2-up grid)
      │ ├────────────────────────────────┤
      │ │       RepCard (House Rep)      │            ← row 2 (full width)
      │ └────────────────────────────────┘
      │
      │ Expansion state lifted to ResultsPanel: `openId: bioguideId | null`.
      │ Clicking a card header sets openId (or clears it if clicking the same one).
      │ Only the card whose bioguideId === openId renders its body (Votes + Legislation).
```

---

## 3. Design Views

### 3.1 Logical View — Module Structure

```
src/
├── VoterInfoWidget.tsx          # Root component, manages top-level state
├── embed.tsx                    # Web Component wrapper (Shadow DOM)
├── main.tsx                     # Dev-mode React mount point
│
├── types/
│   ├── api.ts                   # TypeScript types matching external API responses
│   └── domain.ts                # Application domain types (Representative, VoteRecord, etc.)
│
├── services/                    # Pure functions — no React, no state
│   ├── censusApi.ts             # Census Bureau Geocoder — address → state FIPS + district
│   ├── congressApi.ts           # Congress.gov API caller (members, votes, bills)
│   ├── senateVotesApi.ts        # Senate.gov XML fetcher + parser
│   └── partyAlignment.ts        # Party alignment score calculator
│
├── hooks/                       # React hooks — orchestrate services + manage state
│   ├── useAddressLookup.ts      # Address → Census geocode → state/district → members pipeline
│   ├── useVotingRecord.ts       # Fetch + cache vote history for a member
│   └── useSponsoredBills.ts     # Fetch + cache legislation for a member
│
├── components/                  # Presentational React components
│   ├── AddressInput.tsx
│   ├── ResultsPanel.tsx
│   ├── RepCard.tsx
│   ├── RepCardSkeleton.tsx      # Loading placeholder
│   ├── VoteList.tsx
│   ├── BillList.tsx
│   ├── PartyAlignmentBadge.tsx
│   └── ErrorBanner.tsx
│
├── utils/
│   ├── fipsMap.ts               # FIPS code → state abbreviation + state name ↔ code lookups
│   └── formatters.ts            # Date, bill number, percentage formatting
│
└── styles/
    └── widget.css               # All widget styles (loaded into Shadow DOM)
```

**Design principle**: Services are pure async functions with no framework dependencies. Hooks compose services into stateful workflows. Components are presentational — they receive data and callbacks via props.

### 3.2 Process View — Data Flow

#### 3.2.1 Address Lookup Pipeline

```
1. User submits address string
         │
2. censusApi.geocodeAddress(address)
   GET /api/census/geocoder/geographies/onelineaddress
       ?address={encoded}&benchmark=Public_AR_Current&vintage=Current_Current&format=json
         │
3. Extract from response.result.addressMatches[0].geographies:
   - "119th Congressional Districts"[0].STATE → FIPS code (e.g., "17")
   - "119th Congressional Districts"[0].CD119 → district (e.g., "07")
   - fipsMap.fipsToStateCode("17") → "IL"
   - parseInt("07") → 7 (or "00" → 0 for at-large)
         │
   Returns: { state: "IL", district: 7 }
         │
4. Parallel:
   ├── congressApi.fetchHouseRep("IL", 7)
   │   GET /api/congress/v3/member/congress/119/IL/7?currentMember=true&format=json
   │
   └── congressApi.fetchSenators("IL")
       GET /api/congress/v3/member/congress/119/IL?currentMember=true&format=json
       → filter response to members with Senate terms (district === null)
         │
5. Return: Representative[] (member list already includes photo, party, terms)
```

#### 3.2.2 Voting Record Pipeline

Triggered lazily when user selects the "Votes" tab on a RepCard.

**House Members:**
```
1. congressApi.fetchHouseVotes(119, 1, offset=0, limit=250)
   GET /api/congress/v3/house-vote/119/1?limit=250&offset=0&format=json
   → Returns list of roll call vote summaries
         │
2. For the 20 most recent votes (concurrency limit: 5):
   congressApi.fetchHouseVoteMembers(119, 1, rollCallNumber)
   GET /api/congress/v3/house-vote/119/1/{rollCall}/members?format=json
         │
3. From each response:
   - Find this member's vote by bioguideId
   - Extract party totals for alignment calculation
         │
4. Return: VoteRecord[] + feed data to partyAlignment calculator
```

**Senate Members:**
```
1. senateVotesApi.fetchVoteIndex(119, 2)
   GET /api/senate/legislative/LIS/roll_call_lists/vote_menu_119_2.xml
   → Parse XML, extract list of vote numbers
         │
2. For the 20 most recent votes (concurrency limit: 5):
   senateVotesApi.fetchVoteDetail(119, 2, voteNumber)
   GET /api/senate/legislative/LIS/roll_call_votes/vote1192/vote_119_2_{padded}.xml
         │
3. Parse XML:
   - Find member's vote by last name + state (no bioguide in Senate XML)
   - Extract party totals from <count> elements
         │
4. Return: VoteRecord[] + feed data to partyAlignment calculator
```

#### 3.2.3 Legislation Pipeline (REVISED v2.5.2)

Triggered eagerly when `RepDetail` mounts (alongside the voting-record pipeline) and stored in the hook's state for both the score-bar and the "Legislation" tab.

```
1. useSponsoredBills.load(bioguideId):
   GET /api/members/{bioguideId}
     → KV read (member:v1:{bioguideId}); Worker read-through from Congress.gov on cache miss.
     → Response carries up to 250 sponsored + 250 cosponsored raw CongressLegislationRawEntry items.
2. tryBuildUkraineBill(entry, relationship) for each raw entry:
   - Filter out amendments (type === null) per AC-4.1 and the "D-6" regression.
   - Filter against curated Ukraine bill set (isCuratedBill) — drop non-matches silently.
   - Lookup curated metadata (direction, featured flag, CRS summary) via lookupCuratedBill.
   - Compute valence via computeValence(direction, relationship).
3. Sort: featured first, then newest introducedDate.
4. Return: { sponsored: UkraineBill[], cosponsored: UkraineBill[] }
```

**Retired (v2.5.1):** the prior pipeline paginated sponsored/cosponsored live via five 100-entry pages against Congress.gov (10 round-trips per rep click). That path is removed; the legacy cache contract on `/api/congress/v3/member/*/sponsored-legislation` and `/cosponsored-legislation` remains in force for admin/debugging per AC-25.3 but is not called by the widget. See spec.md FR-7 v2.5.2 for the source-of-truth clause.

#### 3.2.4 Roll-Call Roster Pipeline (NEW v2.5.2)

Triggered eagerly when `RepDetail` mounts; populates the Ukraine-votes tab and feeds the score computation.

```
1. useVotingRecord.load(member):
   For each curated vote V in getCuratedVotesForChamber(member.chamber):
     GET /api/roll-call-rosters/{chamber}/{V.congress}/{V.session}/{V.rollCall}
       → KV read (roll-call-roster:v1:{chamber}:{c}:{s}:{rc}); no upstream fetch on cache miss — the curator populates.
     Extract the member's cast:
       - House: rosterData.casts[member.bioguideId]
       - Senate: rosterData.casts.find(r => r.lastName === lastNameOf(member.name) && r.state === member.state)
     If member not found in roster:
       - Cross-check state-members:v1:{member.state} to distinguish Did Not Vote (in roster, no ballot) from Did Not Serve (not in that Congress).
2. voteClustering.clusterMemberVotes(rows):
   - Group by billId; primary = highest-weight row, procedurals = the rest.
3. valence.computeValence(direction, action, directionMultiplier) per row.
4. obstruction.isObstructionVote per row.
5. Return: { clusters, flat, voteScore, obstructionCount, primaryAbstentionCount }.
```

**Retired (v2.5.1):** the prior pipeline fetched each roll-call's full roster live via `/api/congress/v3/house-vote/{c}/{s}/{rc}/members` (House) or `/api/senate/legislative/LIS/.../xml` (Senate), producing 18-27 upstream round-trips per cold rep click. See spec.md FR-12 v2.5.2 for the source-of-truth clause.

### 3.3 Data View — Domain Types

Defined in `src/types/domain.ts`. See [spec.md §6 Data Dictionary](spec.md#6-data-dictionary) for field definitions.

Core types: `Representative`, `VoteRecord`, `Bill`, `PartyAlignment`, `LookupResult`.

API response types in `src/types/api.ts` mirror the external API structures documented in [api-contracts.md](api-contracts.md).

---

## 4. Detailed Design

### 4.1 Census Geocoder Service (`services/censusApi.ts`) and FIPS Map (`utils/fipsMap.ts`)

The Census Bureau Geocoder returns geographies that include a `119th Congressional Districts` entry with fields `STATE` (FIPS code) and `CD119` (district number as zero-padded string).

**`censusApi.geocodeAddress(address)`**:
```
function geocodeAddress(address, apiBase):
  response = fetch(`${apiBase}/api/census/geocoder/geographies/onelineaddress
    ?address=${encodeURIComponent(address)}
    &benchmark=Public_AR_Current
    &vintage=Current_Current
    &format=json`)

  matches = response.result.addressMatches
  if matches.length === 0:
    throw AddressNotFoundError

  geographies = matches[0].geographies
  cdLayer = geographies["119th Congressional Districts"]
  if !cdLayer or cdLayer.length === 0:
    throw DistrictNotFoundError

  stateFips = cdLayer[0].STATE      // e.g., "17"
  districtRaw = cdLayer[0].CD119    // e.g., "07" or "00" for at-large

  return {
    stateFips,
    district: parseInt(districtRaw, 10),  // 7 or 0
    matchedAddress: matches[0].matchedAddress
  }
```

**`fipsMap.fipsToStateCode(fips)`**: Static lookup — `"17"` → `"IL"`, `"56"` → `"WY"`, `"11"` → `"DC"`, etc. Covers all 50 states + DC + territories.

**Edge cases**:
- At-large districts: Census returns `CD119: "00"` → `parseInt("00")` = `0` → Congress.gov accepts district `0`
- Territories (DC, PR, GU, etc.): Census returns FIPS codes for these; FIPS map includes them
- No address match: Census returns empty `addressMatches` array — show clear error
- Address matches but no congressional district layer: Possible for unincorporated areas — show error

### 4.2 Congress.gov API Service (`services/congressApi.ts`)

All functions accept an `apiBase` parameter (the proxy base URL) and append the Congress.gov API key server-side via the proxy.

**Request queue**: A shared concurrency limiter (max 5 concurrent requests) wraps all Congress.gov calls to respect rate limits.

```typescript
// Concurrency limiter pattern
class RequestQueue {
  private active = 0;
  private queue: (() => void)[] = [];

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
```

### 4.3 Senate XML Parser (`services/senateVotesApi.ts`)

Uses the browser's `DOMParser` to parse XML responses.

**Vote Index XML** (`vote_menu_{congress}_{session}.xml`):
```xml
<vote_summary>
  <votes>
    <vote>
      <vote_number>00123</vote_number>
      <vote_date>April 15, 2026</vote_date>
      <issue>H.R. 1234</issue>
      <question>On Passage</question>
      <result>Agreed to</result>
    </vote>
  </votes>
</vote_summary>
```

**Individual Vote XML** (`vote_{congress}_{session}_{number}.xml`):
```xml
<roll_call_vote>
  <vote_title>...</vote_title>
  <members>
    <member>
      <member_full>Smith, John</member_full>
      <last_name>Smith</last_name>
      <first_name>John</first_name>
      <party>D</party>
      <state>IL</state>
      <vote_cast>Yea</vote_cast>
    </member>
  </members>
  <count>
    <yeas>52</yeas>
    <nays>48</nays>
  </count>
</roll_call_vote>
```

**Member matching**: Senate XML does not use bioguide IDs. Match by `last_name` + `state`. In rare cases of two senators from the same state with the same last name, fall back to `first_name` disambiguation.

### 4.4 CORS Proxy Design

See [ADR-002](decisions/ADR-002-cors-proxy-strategy.md) for original decision rationale. See [ADR-005](decisions/ADR-005-proxy-security-hardening.md) for the v2.4.1 security hardening.

**Development**: Vite proxy configuration in `vite.config.ts`:
```
/api/census/*   → https://geocoding.geo.census.gov/*
/api/congress/* → https://api.congress.gov/*
/api/senate/*  → https://www.senate.gov/*
```

**Production**: Cloudflare Worker at `proxy/worker.ts`. Four concerns, layered:

1. **Routing layer** — prefix-match on `url.pathname`. KV-backed routes (`/api/members/{id}`, `/api/bills/{id}`, `/api/roll-calls/{key}`, `/api/name-search`) matched first. `/api/*` upstream-proxy routes dispatched to `handleApi()`. Browser-style navigation to `/` / `/embed` serves preview or embed HTML depending on env; any other text/html GET returns a 301 to `trackukraine.com`. Unknown paths delegate to Worker Sites (`env.ASSETS.fetch`) which serves `./dist` static files (widget bundle, SRI sidecar, curated JSON). Everything else: 404.
2. **Origin layer** — `/api/*` gated by `isOriginAllowed(origin, allowedOrigins, allowLocalhost)`. Exact string match (AC-25.7). Localhost bypass only when `ALLOW_LOCALHOST === "true"` (AC-25.9). Reflected allowed-origin value written to `Access-Control-Allow-Origin` + `Vary: Origin` (AC-25.8).
3. **Upstream layer** — `upstreamPath` validated against AC-27.7 (reject `..`, `//`, `@`, control chars). For `/api/congress/*`, path must start with `v3/` (AC-27.6) or 400. `CONGRESS_API_KEY` injected as `?api_key=` query param. Cache key built from upstream URL with `api_key` stripped (so cache is shared across users but not tied to origin).
4. **Response layer** — every response passes through `applySecurityHeaders()` which sets the AC-27.1 baseline. Error bodies normalized to JSON (AC-27.5). Sensitive/fingerprinting upstream headers stripped (AC-27.4). API key defense-in-depth redacted from any body that still contains it.

**Environment-variable surface (Worker env):**
- `CONGRESS_API_KEY` — Worker secret. Required in prod; the Worker returns 500 if unset at request time.
- `ALLOWED_ORIGINS` — comma-separated exact `scheme://host[:port]` values. Defaults to `https://trackukraine.com,https://www.trackukraine.com` if unset (matches prod intent; defense-in-depth if misconfigured).
- `ALLOW_LOCALHOST` — exact string `"true"` permits `http://localhost[:port]` and `http://127.0.0.1[:port]`. Default unset = denied.

**Testability.** The Worker module SHALL export (in addition to the default `fetch` handler) the pure helper functions (`isOriginAllowed`, `isValidUpstreamPath`, `normalizeUpstreamErrorBody`, `applySecurityHeaders`, `stripFingerprintingHeaders`) so unit tests can assert each concern independently without needing a Worker runtime. The default export is also testable by constructing a `Request` and a fake `Env` object; `caches.default` is mocked via a `Cache`-compatible stub injected at test time.

**What is deliberately NOT in the Worker:**
- No auth (the widget is a public embed).
- No rate-limiting (Cloudflare zone defaults; edge cache absorbs the common case).
- No request logging (stateless; no observability sink would change behavior, and AC-27.8 locks that down for future changes).
- No cookies / sessions / CSRF (no state; every request is independent).

### 4.4b Ukraine Bill Filter & Curated Data (v2)

**Goal**: Restrict both `useSponsoredBills` and `useVotingRecord` to entries that touch our curated Ukraine bill set.

**Data source**: `src/data/ukraineBills.json` — built by `scripts/build-curated-bills.mjs`. Each entry has shape:
```ts
interface CuratedBill {
  congress: number;
  type: string;               // "HR" | "S" | "HJRES" | "HRES" | …
  number: string;             // "7691"
  featured: boolean;          // top-5 flag
  label: string;              // our concise human label
  title: string | null;       // API-derived title
  latestAction: string | null;
  latestActionDate: string | null;
  becameLaw: boolean;
  congressGovUrl: string;
  votes: CuratedBillVote[];   // pre-resolved roll-call numbers
}

interface CuratedBillVote {
  chamber: 'House' | 'Senate';
  congress: number;
  session: number;
  rollCall: number;
  date: string;                      // ISO datetime
  url: string;                       // API URL for the vote
  action: string;                    // action text from the bill's actions feed
  actionDate: string;
  weight: number;                    // [0, 1] — see §4.7
  directionMultiplier: -1 | 0 | 1;   // flips vote direction for inverse procedurals
  kind: VoteKind;                    // procedural/passage/amendment classifier
}
```

**Filter logic**:
- Build a Set keyed `${congress}|${type.toUpperCase()}|${number}` for fast O(1) lookup
- `useSponsoredBills`: keep only raw entries whose identity is in the set; drop amendments (see D-6)
- `useVotingRecord`: iterate the curated bills' `votes` array (not the most-recent-N list), filter by chamber matching the member, fetch the member's vote on each roll call

**Sort order**: featured-first, then chronological descending (newest votes and bills up top within each bucket).

**Rebuild**: `node scripts/build-curated-bills.mjs` refreshes the JSON from the live API. Re-run whenever we add/remove bills from the curated list.

### 4.6 Bill Direction Classifier (`scripts/build-curated-bills.mjs`) — v2.1

Each curated bill is classified at **build time** (not runtime) by matching keywords in its title and latest action against ordered rule sets. Rules are applied in order; first match wins. Manual override via a `direction` field in the CURATED array skips the classifier.

**Rule order (most-specific first):**
1. **`anti-ukraine`** if title/action contains any of:
   - `/strike.*ukraine/i`, `/prohibit.*security assistance/i`, `/prohibit.*ukraine/i`, `/remove.*ukraine.*(funding|assistance|aid)/i`, `/block.*ukraine/i`, `/end.*ukraine.*aid/i`, `/no.*funding.*ukraine/i`
   - Any amendment from Gaetz/Greene/Massie/Biggs/Ogles/Roy/Perry that explicitly cuts Ukraine funding (captured as part of the NDAA amendment votes in our data)
2. **`pro-ukraine`** if title/action contains any of:
   - `/ukraine.*(supplemental|appropriation|aid|assistance|support|security)/i`
   - `/lend-lease.*ukraine/i`, `/repo.*ukrainians/i`, `/russian.*(sanctions|asset.*seizure|confiscation)/i`
   - `/defending ukraine sovereignty/i`, `/sanctioning russia/i`, `/stand with ukraine/i`
   - Or the bill simply `becameLaw` as one of our explicit pro-UA bills
3. **`neutral`** otherwise — mostly oversight (`/oversight.*ukrainian/i`), symbolic resolutions (`recognizing|reaffirming`), and reporting requirements (`/disapproval of.*report/i`)

Output shape on each curated bill:
```json
{ "direction": "pro-ukraine" | "anti-ukraine" | "neutral", "directionReason": "matched rule: ukraine supplemental" }
```

### 4.7 Vote Weighting (`scripts/build-curated-bills.mjs`) — v2.1

Each extracted roll-call vote gets a `weight` in [0, 1] derived from the action text:

```
function classifyVote(actionText):
  t = actionText.toLowerCase()

  // Ambiguous procedurals — shown in UI, excluded from scoring (weight=0)
  if /motion to table/.test(t):       return { weight: 0,    dirMult:  0, kind: 'motion-to-table'       }
  if /motion to reconsider/.test(t):  return { weight: 0,    dirMult:  0, kind: 'motion-to-reconsider'  }
  if /motion to insist|motion to close portions/.test(t):
                                      return { weight: 0,    dirMult:  0, kind: 'other-procedural'      }

  // Inverse-direction: Aye on motion-to-recommit is an attempt to kill the bill.
  if /motion to recommit/.test(t):    return { weight: 0.3,  dirMult: -1, kind: 'motion-to-recommit'    }

  // Directional procedurals — normal direction; moderate weight.
  if /cloture/.test(t):               return { weight: 0.45, dirMult: +1, kind: 'cloture'               }
  if /waive.*budgetary/.test(t):      return { weight: 0.25, dirMult: +1, kind: 'waive-budget'          }
  if /motion to proceed/.test(t):     return { weight: 0.3,  dirMult: +1, kind: 'motion-to-proceed'     }

  // Resolving differences / concurring with other chamber — high weight.
  if /resolving differences|concur|conference report|senate agreed to|house agreed to|house (agree|disagree)|agreed to conference/.test(t):
                                      return { weight: 0.9,  dirMult: +1, kind: 'concur'                }

  // Final passage — full weight.
  if /on passage|passed|became public law/.test(t):
                                      return { weight: 1.0,  dirMult: +1, kind: 'passage'               }

  // Floor amendment (e.g., strip-funding amendment) — bill direction already
  // encodes pro/anti. Member voting Aye on anti-UA amendment → voted-anti.
  if /amendment|amdt\./.test(t):      return { weight: 0.7,  dirMult: +1, kind: 'amendment'             }

  if /agreed to/.test(t):             return { weight: 0.7,  dirMult: +1, kind: 'other'                 }
  return { weight: 0.5, dirMult: +1, kind: 'other' }
```

**Scoring rule**: `PROCEDURAL_THRESHOLD = 0`. Votes with `weight === 0` are excluded from the score. Everything else contributes at its weight. `directionMultiplier: -1` inverts the valence for that row (see §4.9 `computeValence`).

### 4.8 Procedural Vote Clustering (`services/voteClustering.ts`) — v2.1

Runtime clustering in the UI: group votes by `(bill.congress, bill.number, chamber)`. Within each group:
- Identify the `primary` vote = highest weight (ties broken by latest date)
- All other votes in the group become `procedural` children of the primary
- If all votes in a group are procedural (no weight ≥ 0.7), the highest-weight one is still promoted to primary

This is a pure function over the already-filtered vote list; see `tests/unit/voteClustering.test.ts`.

### 4.9 Valence Computation (`services/valence.ts`) — v2.1

```ts
type Valence = 'sponsor-pro' | 'voted-pro' | 'unstated' | 'voted-anti' | 'sponsor-anti';

function computeValence(
  billDirection: 'pro-ukraine' | 'anti-ukraine' | 'neutral',
  action: 'sponsored' | 'cosponsored' | 'voted-aye' | 'voted-nay' | 'voted-present' | 'not-voted',
  directionMultiplier: -1 | 0 | 1 = 1,  // -1 flips valence; 0 = ambiguous
): Valence {
  if (directionMultiplier === 0) return 'unstated';
  if (billDirection === 'neutral') return 'unstated';

  const isPro = billDirection === 'pro-ukraine';
  const sponsored = action === 'sponsored' || action === 'cosponsored';

  if (action === 'not-voted' || action === 'voted-present') return 'unstated';

  const effectivePro = directionMultiplier === +1 ? isPro : !isPro;

  if (effectivePro) {
    if (sponsored) return 'sponsor-pro';
    if (action === 'voted-aye') return 'voted-pro';
    if (action === 'voted-nay') return 'voted-anti';
  } else {
    // anti-ukraine bill
    if (sponsored) return 'sponsor-anti';
    if (action === 'voted-aye') return 'voted-anti';
    if (action === 'voted-nay') return 'voted-pro';  // nay on anti-UA = pro-UA
  }
  return 'unstated';
}
```

### 4.10 Ukraine Support Score (`services/ukraineScore.ts`) — v2.1

Aggregate every action (sponsorships + votes) into a single [-1.0, +1.0] score:

```ts
function computeUkraineScore(actions: Array<{ valence: Valence; weight: number }>): number | null {
  const VALENCE_TO_SIGN: Record<Valence, number> = {
    'sponsor-pro':  +1, 'voted-pro':  +1,
    'unstated':      0,
    'voted-anti':   -1, 'sponsor-anti': -1,
  };
  const VALENCE_AMPLIFIER: Record<Valence, number> = {
    'sponsor-pro': 1.5, 'sponsor-anti': 1.5,
    'voted-pro':   1.0, 'voted-anti':   1.0,
    'unstated':    0,   // excluded
  };

  let num = 0, denom = 0;
  for (const a of actions) {
    const sign = VALENCE_TO_SIGN[a.valence];
    const amp  = VALENCE_AMPLIFIER[a.valence];
    if (sign === 0) continue;
    const magnitude = amp * a.weight;
    num   += sign * magnitude;
    denom += magnitude;
  }
  return denom === 0 ? null : num / denom;
}
```

The score is rendered as a red→yellow→green gradient in `UkraineScoreBadge`.

Additional runtime behavior (v2.1.2+):
- `PROCEDURAL_THRESHOLD = 0`: votes with `weight === 0` are skipped (motion-to-table, motion-to-reconsider). Non-zero weights contribute at their assigned magnitude.
- `lowConfidence`: set when `contributing < 3`. The badge label is downgraded to a "Limited record" bucket so we never call a member "Strong supporter" off a single vote.

### 4.11 Obstruction Events (`services/obstruction.ts`) — v2.1.3

Traces to: **FR-21**.

Pure predicate over already-classified data. No new runtime classification.

```ts
function isObstructionVote(bill, vote, memberVote, valence): boolean {
  const isProcedural = PROCEDURAL_KINDS.has(vote.kind);
  if (isProcedural && valence === 'voted-anti') return true;      // procedural obstruction
  if (!isProcedural && bill.direction === 'anti-ukraine' && memberVote === 'Aye') return true;  // active anti-UA vote
  return false;
}

function isObstructionBill(direction, relationship): boolean {
  return direction === 'anti-ukraine' && (relationship === 'sponsored' || relationship === 'cosponsored');
}
```

**Procedural kinds** that qualify: `cloture`, `motion-to-proceed`, `motion-to-recommit`, `waive-budget`, `motion-to-table`, `motion-to-reconsider`, `other-procedural`.

**What does NOT count as obstruction**:
- A direct **Nay on pro-UA passage** — that's an on-the-record opposition vote, not indirect obstruction. Already scored.
- **Sponsoring/cosponsoring a pro-UA bill** — that's the opposite.

**UI effects (pure display, no score change)**:
- Each obstruction row gets an `OBSTRUCTION` tag.
- When the member has ≥ 2 obstruction events, the score badge's context line calls it out so voters can see the pattern.
- Obstruction does **not** change the score; the score already reflects these actions at their assigned valence × weight.

### 4.12 Party Alignment Algorithm (`services/partyAlignment.ts`) — legacy secondary metric

**Definition**: The party alignment score is the percentage of **party-line votes** on which the member voted with their own party's majority position.

**Algorithm**:
```
function calculatePartyAlignment(votes: VoteWithPartyData[], memberParty: string):
  partyLineVotes = 0
  votesWithParty = 0

  for each vote in votes:
    // Determine each party's majority position
    demMajority = vote.democratYeas > vote.democratNays ? "Aye" : "Nay"
    repMajority = vote.republicanYeas > vote.republicanNays ? "Aye" : "Nay"

    // Skip if not a party-line vote (both parties voted the same way)
    if demMajority == repMajority:
      continue

    // Skip if member didn't vote
    if vote.memberVote in ["Present", "Not Voting"]:
      continue

    partyLineVotes++

    // Did member vote with their party's majority?
    ownPartyMajority = memberParty starts with "D" ? demMajority : repMajority
    if vote.memberVote matches ownPartyMajority:
      votesWithParty++

  score = partyLineVotes > 0 ? (votesWithParty / partyLineVotes) * 100 : null
  return { score, totalPartyLineVotes: partyLineVotes, votesWithParty }
```

**"Aye" vs "Yea" normalization**: House uses "Aye"/"Nay", Senate uses "Yea"/"Nay". The service layer normalizes these to "Aye"/"Nay" before passing to this function.

### 4.13 Web Component Embed Design

See [ADR-004](decisions/ADR-004-embed-strategy.md) for decision rationale.

```typescript
// embed.tsx
class VoterInfoElement extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: 'open' });

    // Inject scoped styles
    const style = document.createElement('style');
    style.textContent = WIDGET_CSS; // imported as raw string via Vite
    shadow.appendChild(style);

    // Mount React into Shadow DOM
    const container = document.createElement('div');
    shadow.appendChild(container);
    createRoot(container).render(
      <VoterInfoWidget apiBase={this.getAttribute('api-base') || ''} />
    );
  }

  disconnectedCallback() {
    // Unmount React
  }

  static get observedAttributes() { return ['api-base']; }
}

customElements.define('voter-info-widget', VoterInfoElement);
```

**Vite library build config**:
```typescript
build: {
  lib: {
    entry: 'src/embed.tsx',
    name: 'VoterInfoWidget',
    fileName: 'voter-info-widget',
    formats: ['iife'],
  },
  cssCodeSplit: false, // inline CSS into JS
}
```

### 4.14 KV Data Architecture (v2.5.2) — App-Data vs. Edge-Cache Boundary

**Principle.** Every datum the widget needs to render SHALL live in `KV_VOTER_INFO` under one of the curator-managed prefixes (or — for now — the Worker's read-through-written `member:v1:` prefix). Edge caching (Cloudflare's `caches.default` and CDN-layer caching via `Cache-Control`) SHALL be treated as a **performance optimization only** — a layer that makes warm reads fast but whose absence never causes a widget render to fail or to fall back to a live upstream API call in the hot path.

This is the formalization of ADR-011's "KV as sole first-class datastore" decision. The v2.5.1 implementation partially met this bar: `bill:v1:`, `roll-call:v1:`, `name-index:v1:`, and `member:v1:` records were in KV, but the widget still reached upstream via the Worker proxy for roll-call rosters (House `members`, Senate XML) and for the per-state member directory. v2.5.2 closes those gaps with the `roll-call-roster:v1:` and `state-members:v1:` families below.

**Key families and writers:**

| Prefix | Writer | Purpose | TTL / refresh cadence |
|---|---|---|---|
| `cache:v1:` | Worker (ADR-009 response cache) | Incidental upstream-response cache for non-authoritative routes | 30d `expirationTtl`, write-on-read-miss |
| `member:v1:{bioguideId}` | Worker read-through (interim, AC-32.18) → Curator (AC-32.17, deferred) | Per-member profile, raw sponsored/cosponsored arrays | 30d `expirationTtl` (Worker); weekly refresh by curator (future) |
| `bill:v1:{billId}` | Curator | Curated Ukraine-bill metadata + CRS summary + linked roll calls | Rewritten each curator run (~weekly) |
| `roll-call:v1:{chamber}:{c}:{s}:{rc}` | Curator | Curated Ukraine-vote metadata (question, result, totals, billId) | Rewritten each curator run; historical roll-calls are stable |
| `roll-call-roster:v1:{chamber}:{c}:{s}:{rc}` | Curator (NEW v2.5.2) | Full per-roll-call cast map, House keyed by bioguide, Senate keyed by lastName+state | Rewritten each curator run; historical roll-calls are stable |
| `name-index:v1:{letter}` + `:meta` | Curator | First- and last-letter-keyed shards of the current-Congress directory | Rewritten each curator run |
| `state-members:v1:{stateCode}` | Curator (NEW v2.5.2) | Pre-computed per-state Senate/House roster | Rewritten each curator run |

**Widget → KV route map (v2.5.2 target state):**

| Widget call | KV route | Backing key(s) |
|---|---|---|
| Address → list state's senators + district rep | `GET /api/state-members/{state}` | `state-members:v1:{state}` |
| Open rep card | `GET /api/members/{bioguideId}` | `member:v1:{bioguideId}` |
| Populate voting record (per curated vote) | `GET /api/roll-call-rosters/{chamber}/{c}/{s}/{rc}` | `roll-call-roster:v1:{chamber}:{c}:{s}:{rc}` |
| Populate sponsored/cosponsored bills | (read from member profile, no extra fetch) | `member:v1:{bioguideId}` |
| Name search | `GET /api/name-search?q=` | `name-index:v1:meta`, `name-index:v1:{letter}` |
| Bill detail (rare, admin/debug) | `GET /api/bills/{billId}` | `bill:v1:{billId}` |
| Roll-call metadata (rare, admin/debug) | `GET /api/roll-calls/{chamber}/{c}/{s}/{rc}` | `roll-call:v1:{chamber}:{c}:{s}:{rc}` |

**Upstream pass-through routes (`/api/census/*`, `/api/congress/*`, `/api/senate/*`) remain available** for:
- The address geocode (`/api/census/...`) — address space is unbounded, pre-populating KV is not viable.
- The Worker's own read-through into `member:v1:` (until AC-32.17 lands, the Worker still hits Congress.gov when an uncached member is requested).
- The curator itself — `scripts/publish-to-kv.ts` runs outside the Worker and calls Congress.gov directly with its own API key.
- Debugging / admin tools that want the raw upstream shape.

The widget SHALL NOT call the upstream pass-through routes. Tests SHALL enforce this (see tasks.md T-050 in Phase 8).

**Per-visit fan-out contract (v2.5.2 target):**
- Address flow resolving 3 reps: 1 census + 1 `/api/state-members/{state}` + 3 `/api/members/{bioguideId}` = **5 requests**.
- Exploring one rep with N curated Ukraine votes: 1 `/api/members/{bioguideId}` (if not already fetched by the chip list, which pre-fetches for enrichment) + N `/api/roll-call-rosters/...` = **up to N+1 requests**.
- Exploring all 3 reps from an address lookup, where the Senate has M curated votes and the House has H curated votes, worst-case cold KV cache: `5 + (M+H)*avg_reps_per_chamber` ≈ 5 + 26 + 18 = **~49 requests**.

This is a **35%** reduction from the v2.5.1 worst case (~70+ per fully cold visit). The absolute number is still large-ish, but every one of those requests is a single KV read (~10 ms edge-local) rather than a multi-hundred-ms cross-origin Congress.gov round-trip. The rate-limit budget (AC-27.21) is set to comfortably exceed this worst case. Post-AC-32.17 (curator-baked member profiles with pre-joined votes), the per-visit count drops further to ~5 requests regardless of curated-vote count.

---

### 4.15 Tiered Cache + R2 Static Archive (v2.6.0 — ADR-014)

See FR-40 + FR-41 for the spec. This section describes the runtime topology.

**Tier hierarchy (fastest → slowest):**

```
[request in]
    │
    ▼
┌─────────────────────────┐
│  Tier 0: EdgeTier       │  caches.default, per-POP, ~5 ms
│  (caches.default)       │
└─────────────────────────┘
    │ miss
    ▼
┌─────────────────────────┐
│  Tier 1: KvTier         │  KV_VOTER_INFO, global, ~30 ms
│  cache:v1:{kind}:{...}  │
└─────────────────────────┘
    │ miss
    ▼
┌─────────────────────────┐
│  Tier 2: R2Tier         │  R2_STATIC bucket, global, ~50 ms
│  archive/{kind}/{...}   │  gated: immutable policy + frozen session
└─────────────────────────┘
    │ miss (or ineligible for R2)
    ▼
┌─────────────────────────┐
│  UpstreamFetcher        │  senate.gov / api.congress.gov / geocoding
│  (one per upstream)     │  400–1200 ms, rate-limited
└─────────────────────────┘
```

**Read path.** `TieredCache.get(key)` iterates tiers top-down, returns the first hit, records `servedBy`.

**Promote on hit.** When tier N serves, `promote` writes the entry to tiers 0..N-1 via `ctx.waitUntil` — never blocks the response. Next request gets a faster-tier hit.

**Store on miss.** When all tiers miss and the upstream fetcher resolves, `storeFromUpstream` writes to every writable tier whose `policy.eligibleTiers` permits, via `ctx.waitUntil`. The R2Tier's own `put` additionally gates on `policy.immutable && entry.sessionStatus === 'frozen'` — open-session data flowing through the same pipeline is silently skipped at the R2 boundary (not an error; it's the right semantics for non-frozen data).

**Single pipeline.** `serveCached(request, key, cache, fetcher, policy, ctx, env)` is the only code path any cacheable route uses. Per-route policy lives in `proxy/routes/cache-config.ts`. Handlers do not call upstream directly; they supply a `CacheKey` and an `UpstreamFetcher`.

**No curator.** Prewarming (`scripts/warm.ts`, T-063) issues standard GETs to the Worker's public API. Each GET flows through `serveCached`, triggering the same store-on-miss logic a real visitor's request would. R2 gets populated as a byproduct of traffic — organic or synthetic. There is no second write path.

**Data-type eligibility matrix.** See FR-41 exhaustively. Summary:

- **R2-eligible (tier 0+1+2):** Senate roll-call XML, House roll-call rosters, House roll-call details (all gated by session-closed). Bill actions/summaries (gated by `latestActionDate > 180d ago`).
- **No R2 (tier 0+1 only):** Member detail, sponsored-legislation, cosponsored-legislation, census geocoder, bill metadata.
- **KV-owner (tier 1 only, domain records):** `member:v1:*`, `bill:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`, `name-index:v1:*`. These are curator-projected domain records, not response cache entries — same backing (KV), different abstraction layer.

**Parse-on-demand for Senate XML.** When a request for `/api/roll-call-rosters/senate/...` misses KV but hits R2 (raw XML bytes), the R2 tier returns the XML; the pipeline parses it via `proxy/upstreams/senate-xml-parser.ts` into the JSON roster shape, responds to the client, and writes the parsed `RollCallRosterRecord` to KV via `ctx.waitUntil` for the next request (AC-41.7).

**Session-status computation.** `proxy/upstreams/congress-calendar.ts` exposes pure helpers `currentCongress(now)`, `currentSession(now)`. A roll-call is frozen when `(congress, session) < (currentCongress, currentSession)` at fetch time. Bill actions are frozen when `latestActionDate + 180d < now`. The session-status value is computed by the upstream fetcher and carried on the `CacheEntry`; every tier treats it the same way.

**Observability.** Every response served via `serveCached` carries `X-Cache: HIT|MISS` and `X-Cache-Tier: edge|kv|r2|upstream`. The `cacheTier` value also lands in the `blobs[4]` slot of the per-request Analytics Engine data point (FR-38) for aggregate queries like "what percent of Senate XML requests are served from R2 today?"

---

### 4.16 D1 Editable Source of Truth (v2.7.0 — FR-49 / ADR-017)

V4 introduces a writable, audited backing store for the curated content that previously lived in `src/data/ukraineBills.json`. **Cloudflare D1** is the source of truth; **KV** is a denormalized read-snapshot. Researchers write to D1 via `/api/admin/*`; the curator publish script (§4.17) projects D1 state into the FR-32 KV record shapes.

**Why D1 and not "more KV prefixes":**

- Audit-log queries (last 50 actions by researcher X, all weight changes in the last week) are SQL-shaped. KV's only query primitive is prefix scan, which makes audit traversal `O(N)` over the whole namespace.
- The relational integrity between `bills`, `votes`, `comments`, `social_posts`, `quotes`, and `score_adjustments` is real. Comments attach to a bill (and optionally a roll call within it); quotes and posts attach to a member; weight overrides attach to a vote. Foreign keys with CASCADE eliminate a class of orphan-row bugs.
- Future stats (FR-56) want aggregates: per-bill cast distribution, per-rep histograms, top-N anti-Ukraine. SQL aggregates are one `GROUP BY`; the KV-only equivalent is a curator-time precomputation that has to be redone on every tweak.

**Why not "skip KV, read D1 directly from the embed":**

- D1 is regional, not edge-replicated. A widget loaded from Sydney would round-trip to a North-American D1 region per request. KV is replicated to every POP and serves in single-digit ms.
- KV records are immutable from the embed's perspective — the existing tiered-cache pipeline (§4.15) caches them at the edge for 5 minutes. D1 reads cannot be safely cached at the edge across POPs without inventing an invalidation story.
- The FR-32 read-path contract (atomic per-member / per-bill records, served from KV) is hard-won and well-tested. V4 should not regress it.

**Schema (D1, `viw_researcher`):**

```sql
CREATE TABLE researchers (
  email TEXT PRIMARY KEY,           -- lowercased
  display_name TEXT,
  created_at TEXT NOT NULL          -- ISO-8601
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,              -- ULID
  bill_id TEXT UNIQUE NOT NULL,     -- e.g. "117-HR-2471" — the FR-12 bill key
  congress INTEGER NOT NULL,
  type TEXT NOT NULL,               -- "HR", "S", "HJRES", etc.
  number TEXT NOT NULL,
  featured INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  title TEXT NOT NULL,
  latest_action TEXT,
  latest_action_date TEXT,
  became_law INTEGER NOT NULL DEFAULT 0,
  congress_gov_url TEXT,
  direction TEXT NOT NULL,          -- "pro-ukraine" | "anti-ukraine" | "ambiguous"
  direction_reason TEXT,
  summary_json TEXT,                -- full summary blob, JSON-encoded
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,              -- ULID
  bill_id TEXT NOT NULL,            -- FK → bills.bill_id
  chamber TEXT NOT NULL,            -- "House" | "Senate"
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  roll_call INTEGER NOT NULL,
  date TEXT NOT NULL,
  url TEXT,
  action TEXT,
  action_date TEXT,
  weight REAL NOT NULL,             -- FR-54: researcher-tunable
  direction_multiplier REAL NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,               -- "final-passage", "concur", "amendment", "cloture", "motion-to-proceed", etc.
  weight_reason TEXT,               -- FR-54 AC-54.6: standing rationale for the current weight + direction_multiplier; nullable
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chamber, congress, session, roll_call),
  FOREIGN KEY (bill_id) REFERENCES bills (bill_id) ON DELETE CASCADE
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,              -- ULID
  bill_id TEXT NOT NULL,            -- FK → bills.bill_id
  attached_to_roll_call_id TEXT,    -- nullable; when set, scoped to a specific vote (chamber:congress:session:rollCall)
  body_markdown TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  author_email TEXT NOT NULL,       -- FK → researchers.email
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (bill_id) REFERENCES bills (bill_id) ON DELETE CASCADE,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- "x" | "facebook" | "youtube" | "instagram" | "other"
  url TEXT NOT NULL,
  posted_at TEXT,
  body_text TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  comment TEXT,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,         -- VALID_MEDIA_KINDS (proxy/d1/admin-store.ts): text | news | social | video | audio | speech | press | interview | image | letter
  source_url TEXT NOT NULL,
  source_label TEXT,
  quoted_at TEXT,
  body_text TEXT NOT NULL,
  score_adjustment REAL NOT NULL DEFAULT 0,
  comment TEXT,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (author_email) REFERENCES researchers (email)
);

CREATE TABLE score_adjustments (
  -- Reserved for future per-rep manual adjustments. Empty in v2.7.0.
  id TEXT PRIMARY KEY,
  bioguide_id TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  author_email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,              -- ULID
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,             -- "create" | "update" | "delete"
  target_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  row_title TEXT,                   -- denormalized — bill title, social post body excerpt, etc.
  before_json TEXT,                 -- nullable on create
  after_json TEXT,                  -- nullable on delete
  reason TEXT,
  trace_id TEXT NOT NULL,           -- FR-50 AC-50.7 — request trace ID for log correlation
  created_at TEXT NOT NULL
);

CREATE INDEX idx_votes_bill ON votes (bill_id);
CREATE INDEX idx_comments_bill ON comments (bill_id);
CREATE INDEX idx_social_posts_bioguide ON social_posts (bioguide_id);
CREATE INDEX idx_quotes_bioguide ON quotes (bioguide_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor_email, created_at DESC);
CREATE INDEX idx_audit_trace ON audit_log (trace_id);
```

**ULIDs over autoincrement.** ULID strings are 26 chars, sortable, and globally unique without a coordination round-trip. Autoincrement IDs in D1 are per-database and would collide if we ever fan out to multiple D1s. ULIDs survive that scenario unchanged.

**Foreign-key cascades.** `votes`, `comments`, `social_posts`, `quotes` cascade on parent delete (deleting a bill cleans up its votes and comments). `audit_log` does NOT cascade — audit records must outlive their target. Tests SHALL assert both directions.

### 4.17 D1→KV Publish Pipeline (v2.7.0 — FR-51)

The publish script `scripts/publish-d1-to-kv.ts` is a curator-side Node program that connects to D1 and KV via wrangler bindings (or via direct API in CI). It performs a full read of the editable tables and writes the projected records into KV. The transformation is deterministic — the same D1 state produces byte-identical KV bytes across runs.

**Pseudocode (single env, `--dry-run` shown last):**

```
const bills = SELECT * FROM bills
const votes = SELECT * FROM votes ORDER BY bill_id, chamber, congress, session, roll_call
const comments = SELECT * FROM comments ORDER BY created_at
const posts   = SELECT * FROM social_posts ORDER BY bioguide_id, posted_at
const quotes  = SELECT * FROM quotes ORDER BY bioguide_id, created_at

for each bill:
  group votes by bill_id
  write KV `bill:v1:{bill.bill_id}` = projectBill(bill, billVotes)   // matches AC-32.2

for each bill with comments:
  group comments by bill_id
  write KV `comment:v1:{bill.bill_id}` = projectComments(billComments)  // AC-51.4

for each bioguide with posts:
  write KV `social-post:v1:{bioguide_id}` = projectPosts(byBioguide[bg])  // AC-51.5

for each bioguide with quotes:
  write KV `quote:v1:{bioguide_id}` = projectQuotes(byBioguide[bg])  // AC-51.6

compute partyPriors from member:v1:* full-confidence reps + recompute member:v1:*.partyPrior
compute stats:v1:summary from D1 aggregates  // FR-56 AC-56.1
compute audit-feed:v1:full + audit-feed:v1:public from audit_log  // FR-58 AC-58.3
```

**Diff-skip.** Before each `KV.put`, the script reads the current KV value and compares JSON-canonicalized bytes. Identical → skip. Different or missing → write. The skipped count is reported in the run summary so noisy runs (mass writes) are visible.

**Determinism.** Every projector function is pure: it takes only the D1 rows it needs and returns the JSON shape. Field ordering is alphabetical via `JSON.stringify(value, sortedKeys)`. Tests assert byte-identical output across two consecutive runs against an unchanged seed (AC-56.5 covers the stats path; analogous tests cover bill / comment / post / quote projection).

**Cron and triggers.** `.github/workflows/publish-d1.yml` runs the script every 15 minutes against dev and uat. Stg and prod runs are manual triggers via `workflow_dispatch` to keep deploy-ladder discipline (see project_branch_model memory; ladder is `main → develop → uat → stg → prod`).

### 4.18 Admin API + Auth Flow (v2.7.0 — FR-50, REVISED 2026-05-02)

The researcher API lives under `/api/admin/*` with these endpoints (all behind Cloudflare Access):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/whoami` | Echo the validated email (`{ email }`); used by SPA for header badge |
| GET | `/api/admin/bills` | List bills, paginated (`?limit&offset&q`) |
| POST | `/api/admin/bills` | Create a bill |
| PATCH | `/api/admin/bills/{id}` | Update a bill (partial; specify fields) |
| DELETE | `/api/admin/bills/{id}` | Delete a bill (cascades to votes / comments) |
| GET | `/api/admin/votes?billId=…` | List votes (filter by bill) |
| POST/PATCH/DELETE | `/api/admin/votes/{id}` | Manage votes |
| GET | `/api/admin/comments?billId=…` | List comments |
| POST/PATCH/DELETE | `/api/admin/comments/{id}` | Manage comments |
| GET | `/api/admin/social-posts?bioguideId=…` | List posts |
| POST/PATCH/DELETE | `/api/admin/social-posts/{id}` | Manage posts |
| GET | `/api/admin/quotes?bioguideId=…` | List quotes |
| POST/PATCH/DELETE | `/api/admin/quotes/{id}` | Manage quotes |
| GET | `/api/admin/audit?limit&since` | Authenticated audit feed (full data) |

Public endpoints (no auth, for embed consumption):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/audit/public` | Redacted audit feed |
| GET | `/api/comments/{billId}` | Researcher comments for a bill (used by VoteList expand) |
| GET | `/api/social-posts/{bioguideId}` | Researcher-curated social posts for a rep |
| GET | `/api/quotes/{bioguideId}` | Researcher-curated quotes for a rep |
| GET | `/api/stats/v1/summary` | Stats blob (FR-56) |

**Auth flow (revised — JWT verify, no Worker-side allowlist):**

```
Browser → /admin
   ↓
Cloudflare Access challenges (IdP per Access app — email PIN, Google, Discord, …)
On success, sets `CF_Authorization` cookie + signs JWT with team key
   ↓
Browser → /admin (with cookie) → CF Edge → Worker (sees `Cf-Access-Jwt-Assertion`
                                                    + `Cf-Access-Authenticated-User-Email`)
   ↓
Worker serves the SPA from ASSETS (assets path is also gated by CF Access)
   ↓
SPA → /api/admin/whoami → Worker
   ↓
Worker `extractAdminActor(request, env)` (proxy/security/admin-actor.ts):
  - require `CF_ACCESS_TEAM` and `CF_ACCESS_AUD` env config (or 500 admin_misconfigured)
  - extract `Cf-Access-Jwt-Assertion` (or 401 admin_jwt_required)
  - verify signature via `verifyCfAccessJwt` against the team JWKS
    (cached in module-scope memo + KV key `cache:v1:cf-access-jwks`, 1h TTL)
  - check `aud` claim equals `CF_ACCESS_AUD`
  - check `iss` claim equals `https://<team>.cloudflareaccess.com`
  - check `exp` is in the future (60s skew); `iat`/`nbf` not in the future
  - any failure → 401 admin_jwt_invalid (with stable `detail` reason code)
                  or 503 admin_jwks_unavailable
  - read `email` claim from VERIFIED JWT (not from the loose plain header)
  - if missing → 500 admin_actor_missing (CF Access shape changed; fail loud)
  - return { email: <lowercased> }
   ↓
Worker route handler executes mutation under D1 batch (atomic):
  D1.batch([
    UPDATE / INSERT row,
    INSERT audit_log (actor_email, action, table, row_id, before, after, reason, trace_id),
  ])
   ↓
Any batch statement fails → all rollback → 500 with FR-37 envelope
On success → 200 with { row, audit }
```

**Change-notes (`audit_log.reason`) flow (FR-50 AC-50.8 / AC-50.9).** The admin SPA editor renders a "Change notes" textarea on every drawer. On `update` and `delete` flows the field is required; on `create` it is optional. The SPA sends the value in the body's `_reason` field (leading-underscore namespace so it can never collide with a resource column). The Worker's `readBody` helper strips `_reason` off the body before passing the payload to the D1 store, and stamps it onto the per-request `AdminCtx.reason`, which the store reads when assembling the `audit_log` row inside the same `D1.batch([mutation, audit])` call. For `DELETE` (which conventionally has no body), the SPA sends `?reason=…` as a query param; the Worker's delete handler reads it from the URL the same way. Whitespace-only reasons are treated as missing and produce a `400 reason_required` envelope on update / delete.

**Why JWT verify in addition to CF Access at the edge.** Defense in depth against direct-origin bypass — an attacker who finds a path that skips the Access app (e.g. a `*.workers.dev` URL, a misconfigured DNS rule, or an upcoming Cloudflare account-resource-binding leak) can trivially set the loose `Cf-Access-Authenticated-User-Email` header. Without the JWT verify, that gets them admin write access. With it, they additionally need a private key Cloudflare holds. The verify is one round of RS256 (~1ms with a warm JWKS cache) and uses module-scope + KV caching so JWKS fetches are rare. `workers_dev = false` + `preview_urls = false` in `wrangler.toml` are the matching infrastructure-side hardening (FR-50 AC-50.1).

**Rate-limit budget.** Admin routes use the existing `applyRateLimit` (FR-27 AC-27.21) under the same per-IP budget as other routes. Cloudflare Access already throttles authenticated traffic, and the JWT verify itself bounds the cost of a runaway client. A separate per-email budget is not introduced.

### 4.19 Score Update — Researcher-Tunable Weights + Bayesian Shrink (v2.7.0 — FR-54, FR-55)

**FR-54 — Per-vote weight from D1.** No code change in `computeUkraineScore`. The data path changes: `weight` and `directionMultiplier` come from D1 `votes` rows (via the publish script, into KV `bill:v1:*`, into the embed via `useVotingRecord`). The score formula remains `Σ(sign × amp × weight) / Σ(amp × weight)`. Researchers raise weight on votes that deserve outsized influence; combined with the existing `direction` tag, raising weight on an anti-Ukraine vote pulls the score lower more strongly. This delivers the user's "negative signals more pronounced" without inventing a separate global amplifier knob.

**FR-55 — Bayesian shrink toward party prior.** Two changes to `computeUkraineScore`:

1. New parameter `priors?: { partyPrior: number | null }`.
2. New tier `'insufficient'` extending `ConfidenceTier`. `deriveConfidenceTier(0)` and `deriveConfidenceTier(1)` return `'insufficient'`.

Algorithm:

```
contributing = (count of valid contributing actions, as before)
rawScore = Σ(sign × amp × weight) / Σ(amp × weight)        // unchanged

if contributing < NEW_REP_THRESHOLD (= 2):
  return { score: null, rawScore, contributing, confidenceTier: 'insufficient', confidence: 0, ... }

if priors?.partyPrior == null:
  return { score: rawScore, rawScore, contributing, ... }   // cold-start; no shrink

if confidenceTier == 'full':
  return { score: rawScore, rawScore, ... }                  // saturated; no shrink

w = 1 / (1 + contributing / 4)
return { score: (1 - w) * rawScore + w * priors.partyPrior, rawScore, ... }
```

The party prior is computed at publish time. The publish script (§4.17):

1. Reads every existing `member:v1:*` record's pre-V4 score field (or recomputes from D1-driven votes if needed).
2. Filters to members with `confidenceTier === 'full'`.
3. Groups by party (D / R / I / L / …).
4. Computes the mean score per party.
5. Writes `partyPrior: number | null` into each member's record under the same `member:v1:*` key.

The embed reads `partyPrior` from the member record and passes it to `computeUkraineScore` as `priors.partyPrior`. Cold-start (no full-confidence reps in a party yet) yields `partyPrior: null`, the algorithm degenerates to current behavior, and tests cover this branch explicitly so we don't NaN.

**Visualization.** When `score === null` and `confidenceTier === 'insufficient'`, `UkraineScoreBadge` renders the neutral gray (`hsl(220, 10%, 55%)`) with copy "Insufficient record". The continuous `confidence` field is 0 in this case, so the saturation gradient (FR-43) reads as desaturated.

### 4.20 Admin SPA Layout (v2.7.0 — FR-52, REVISED 2026-05-04 — megamenu nav)

The SPA is intentionally austere. The top-level nav is a **single megamenu** (one trigger button in the header) opening a 3-column panel; each destination is a list-detail surface with plain HTML controls. The early-draft six-tab strip layout is superseded; the megamenu invariant is normative per spec.md AC-52.69, hash-routing per AC-52.70.

```
+-----------------------------------------------------------+
| [≡ People · B001234 ▾]              alice@…   [theme]     |
+-----------------------------------------------------------+
                                                             ← trigger above
+-----------------------------------------------------------+
| Workspace      | Curation       | Admin                   |
|   People       |   Inbox        |   Keywords              |
|   Bills        |   Add quote    |   Tags                  |
|   Activity     |   All quotes   |   Poll status           |
|                |   Research     |   App config            |
|                |   Add by URL   |                         |
+-----------------------------------------------------------+   ← panel (open)

+--------------------+--------------------------------------+
| List               |  Detail / editor                     |
|  ─ row             |   field 1 [____________]             |
|  ─ row (selected)  |   field 2 [____________]             |
|  ─ row             |   ...                                |
|  ...               |   [save]  [revert]  [delete]         |
+--------------------+--------------------------------------+
```

**Destinations and their CRUD shape:**

| Group · Destination | List columns | Editor fields |
|---------------------|--------------|---------------|
| Workspace · People | bioguide, displayName, party, state | profile pane (read-only summary + curated content drilldowns) |
| Workspace · Bills | `bill_id`, `title`, `direction`, `featured` | id, title, direction, direction_reason, featured, label, congress_gov_url, summary_json (textarea), inline Votes section, inline Comments section (per AC-52.16) |
| Workspace · Activity | actor, action, target, when | (read-only audit feed) |
| Curation · Inbox | source, captured_at, status | (queue triage; Curate → Add quote prefilled) |
| Curation · Add quote | — | bioguide_id, media_kind, source_url, source_label, body_text, weight, direction, comment |
| Curation · All quotes | bioguide, body excerpt, weight, direction | same fields as Add quote |
| Curation · Research | — | research scratch surface (notes, candidates) |
| Curation · Add by URL | — | URL → fetch → quote prefill |
| Admin · Keywords | term, hits | term, weight |
| Admin · Tags | name, color, count | name, color (hex), description |
| Admin · Poll status | source, last_run, status | (read-only) |
| Admin · App config | key, value | key, value, description |

Standalone Votes / Comments / Social Posts / Quotes / "Recent Activity" top-level destinations from the early FR-52 draft no longer exist as nav entries — Votes and Comments are inline under the Bills editor (AC-52.16, AC-52.65); Quotes are reached via Curation; Social Posts and the audit feed live under Workspace.

**Optimistic update pattern.** On save, the editor PATCHes the server, optimistically updates the list and detail, and on non-2xx response reverts and surfaces a toast with `{ error, traceId }` from the FR-37 envelope. The toast lets the researcher copy the trace ID for debugging.

**Hash routing.** Top-level destinations are addressable via `#/<section>[/<sub>]` (per AC-52.70) — e.g. `#/people/B001234`, `#/curation/inbox`, `#/settings/tags`. The root component parses `window.location.hash` on mount and on `hashchange`, and writes the hash on every navigation. There is no client-side router library; a small `parseHash` / `buildHash` pair in `src/admin/App.tsx` is the entire implementation.

### 4.21 Embed Tab Restructure (v2.7.0 — FR-53)

`RepDetail` previously rendered the score badge, member website link, the `VoteList`, and the `BillList` stacked vertically. V4 introduces a tab strip:

```
+-------------------------------------------------+
| Score badge | name | website | socials          |
+-------------------------------------------------+
| [Record]  [Statements]  [Quotes]                |
+-------------------------------------------------+
| (Record)                                        |
| Ukraine voting record                           |
|   <VoteList />                                  |
| Ukraine legislation                             |
|   <BillList />                                  |
+-------------------------------------------------+
```

The Statements tab renders `<SocialPostsList />`; the Quotes tab renders `<QuotesList />`. Each list is fed by a new hook (`useRepStatements`, `useRepQuotes`) that calls the corresponding read endpoint and tolerates 404 / empty per AC-53.5.

The `VoteList` row gains an inline expand affordance only on rows with comments. Expanded state shows the comment text + score-adjustment chip. The procedural-cluster collapse pattern (FR-17) is unchanged.

**Mobile (≤ 640px).** The tab strip is `overflow-x: auto; flex-wrap: nowrap` — three tabs fit in 375px without overflow today, but the rule guards against future tabs. List contents inside each tab inherit the FR-34 stacked-card treatment.

---

## 5. Design Decisions

| Decision | Choice | Rationale | ADR |
|----------|--------|-----------|-----|
| UI Framework | React + TypeScript | Widely known, rich ecosystem, user may port later | ADR-001 |
| Build Tool | Vite | Fast dev server, native proxy support, library build mode | ADR-001 |
| CORS Strategy | Vite dev proxy + CF Worker prod | Keeps API keys server-side in prod, zero-config dev | ADR-002 |
| Senate Votes | Senate.gov XML parsing | Only public source; Congress.gov API lacks Senate vote data | ADR-003 |
| Embed Method | Web Component + Shadow DOM + IIFE | Single-file distribution, style isolation, framework-agnostic | ADR-004 |
| Test Framework | Vitest | Native Vite integration, Jest-compatible API | ADR-001 |
| State Management | React hooks (useState/useReducer) | Simple enough — no Redux/Zustand needed for this scope | — |
| Concurrency Control | Custom request queue | Respect Congress.gov 5K/hr rate limit without external deps | — |
| Editable Source of Truth | Cloudflare D1 (SQL) | Audit + relations + aggregates; KV stays as edge-cached read-snapshot | ADR-017 |
| Researcher Auth | Cloudflare Access + email allowlist | Reuses non-prod gating pattern; no custom OAuth on the Sunday clock; Discord deferred (FR-57) | ADR-017 |
| Newer-Rep Score | Bayesian shrink toward party prior, k=4, NEW_REP_THRESHOLD=2 | Single-vote new reps no longer read as "Strong supporter" | ADR-018 |
| Negative-Signal Amplification | Per-vote researcher-tunable weight (FR-54), no global amplifier | One knob, preserves [-1,+1] range, transparent to readers via score-adjustment chips | ADR-017 |

---

## 6. Error Handling Strategy

| Scenario | Handling |
|----------|---------|
| Invalid address | Show inline error: "Please enter a full U.S. street address (e.g., 123 Main St, Springfield, IL 62701)" |
| Address outside US | Show error: "This tool is for U.S. federal representatives only" |
| Census geocoder failure | Show banner: "Unable to look up your district. Please try again." |
| Census geocoder no match | Show error: "Address not found. Please enter a valid U.S. street address." |
| Congress.gov API failure | Show rep cards with error state on the failed section (votes or bills) |
| Senate XML unavailable | Show message: "Senate vote data is temporarily unavailable" |
| Vacant seat | Show card: "This seat is currently vacant" with last known occupant if available |
| Non-voting delegate | Show card normally but disable Votes tab with note: "Non-voting delegate" |
| Rate limit exceeded | Show banner: "Too many requests. Please wait a moment and try again." |
| Network timeout | Retry once after 3 seconds, then show error |

### 6.1 Canonical Error Envelope (v2.6.0 — FR-37)

As of v2.6.0 every error emission from the Worker uses a single envelope (see FR-37 for ACs). The table above describes what the user sees; it's backed by the envelope's `userMessage` field. The widget parses `error.code` and `error.retryable` to decide whether to render a "Try again" affordance. The trace ID (`error.traceId`) renders as a muted, monospace, selectable "Reference: tr_..." line below the user message, so users can quote it when reporting a bug. Operator-internal detail (`error.message`, upstream identity, status code) ends up in Workers Logs and the Analytics Engine data point for the request — not the UI.
