# Software Requirements Specification (SRS)
# Voter Information Widget — Ukraine Focus

**Version**: 2.5.1
**Date**: 2026-04-17
**Status**: Active

---

## 1. Introduction

### 1.1 Purpose

This document defines the requirements for the Voter Information Widget — an embeddable, stateless web component that enables U.S. voters to look up their federal representatives and see **their votes and legislative activity on Ukraine-related bills**.

### 1.2 Focus (NEW in v2.0)

The widget is scoped to **Ukraine aid and Russia-related legislation** — it does not show every vote or every bill a representative has worked on. Both the vote list and the sponsored/cosponsored bill list are filtered to our **curated Ukraine bill set** (`src/data/ukraineBills.json`):

- **~27 curated bills** spanning 117th, 118th, and 119th Congresses
- **5 featured bills** — the major supplementals and the Lend-Lease Act
- Each curated bill has pre-resolved roll-call numbers (House + Senate) from Congress.gov's `/bill/{id}/actions` endpoint, so vote lookups are deterministic

### 1.3 Scope

The widget covers **federal-level representation only**:
- U.S. Senators (2 per state)
- U.S. House Representatives (1 per congressional district)

Out of scope: state legislators, local officials, judicial appointments, executive branch.

### 1.3 Definitions

| Term | Definition |
|------|-----------|
| FIPS code | Federal Information Processing Standard code — numeric identifiers for states (e.g., `17` = Illinois) |
| Bioguide ID | Unique identifier for members of Congress maintained by the Biographical Directory |
| Party-line vote | A roll call vote where the majority of each major party voted on opposite sides |
| Party alignment score | Percentage of party-line votes where a member voted with their party's majority |
| At-large district | A congressional district that covers an entire state (states with only 1 House seat). Census returns `CD119: "00"`, Congress.gov uses district `0`. |
| Non-voting delegate | A representative from a U.S. territory who may participate in debate but cannot vote on the House floor |

### 1.4 Stakeholders

- **Voters**: Primary end users who want to understand their representatives' records
- **Political organizers**: Deploy the widget on advocacy sites to inform constituents
- **Website operators**: Embed the widget on their sites with minimal integration effort

---

## 2. User Stories & Scenarios

### US-1: Address Lookup
**As a** voter, **I want to** enter my home address **so that** the tool identifies my congressional district and federal representatives.

**Acceptance Criteria:**
- AC-1.1: User can enter a full U.S. street address in a single text field
- AC-1.2: System returns the user's state and congressional district number
- AC-1.3: System displays the user's 2 senators and 1 house representative (or delegate)
- AC-1.4: For at-large states, the system correctly identifies the single at-large representative
- AC-1.5: Invalid or incomplete addresses produce a clear, actionable error message

### US-2: Representative Overview
**As a** voter, **I want to** see basic information about each representative **so that** I know who they are.

**Acceptance Criteria:**
- AC-2.1: Each representative card shows: full name, party affiliation, state, district (if House), official photo
- AC-2.2: Party affiliation is visually color-coded (blue=Democrat, red=Republican, gray=other)
- AC-2.3: Chamber (Senate/House) is clearly indicated

### US-3: Ukraine Voting Record (updated v2)
**As a** voter, **I want to** see how my representatives voted on **major Ukraine-related bills** **so that** I can evaluate their position on Ukraine aid.

**Acceptance Criteria:**
- AC-3.1: Votes are displayed in a table with: date, bill number/title, the member's vote, and the overall result
- AC-3.2: Member votes are color-coded (green=Aye, red=Nay, gray=Present/Not Voting/Did Not Vote)
- AC-3.3: **Only votes on curated Ukraine bills are shown** — other votes are hidden
- AC-3.4: **Featured votes (top 5 bills) appear first and are visually emphasized**, followed by other Ukraine-related votes
- AC-3.5: House votes sourced from Congress.gov API; Senate votes sourced from Senate.gov XML
- AC-3.6: If the member did not vote on a given curated bill, the row shows "Did Not Vote" (distinct from "Not Voting")

### US-4: Ukraine Legislation (updated v2)
**As a** voter, **I want to** see which **Ukraine-related bills** my representatives sponsored or co-sponsored **so that** I understand their legislative engagement on Ukraine.

**Acceptance Criteria:**
- AC-4.1: Display sponsored and co-sponsored Ukraine bills only (filtered against curated set by bill ID)
- AC-4.2: Each bill shows: bill number, title, date introduced, latest action
- AC-4.3: Bill numbers link to the full text on congress.gov
- AC-4.4: Featured (top-5) bills are visually emphasized
- AC-4.5: **Pagination**: show 5 results per page with next/prev controls
- AC-4.6: **(v2.2.1)** If the default tab (Sponsored) has zero entries and the other tab (Cosponsored) has at least one entry, the BillList SHALL open to the non-empty tab so the voter sees real content first. If both are empty, the Sponsored tab is selected (showing the standard empty state). If both have content, Sponsored wins as the default.

### US-5: Party Alignment
**As a** voter, **I want to** see how often my representatives vote with their party **so that** I can gauge their independence or partisanship.

**Acceptance Criteria:**
- AC-5.1: A party alignment percentage is displayed for each representative
- AC-5.2: The score is calculated from party-line votes only (where parties voted on opposite sides)
- AC-5.3: The number of party-line votes used in the calculation is displayed for context
- AC-5.4: The score is visually represented (e.g., progress bar or gauge)

### US-7: Chip Grid Layout (REVISED v2.2.0)
**As a** voter, **I want** a compact overview of my three federal representatives with a clear visual grouping of senators vs. the house rep **so that** I can pick one to drill into.

**Acceptance Criteria (v2.2.0 redesign):**
- AC-7.1: On desktop (≥ 720px), the widget displays a two-column chip grid:
  - **Left column**: both senators
  - **Right column**: the house representative
  Each member is rendered as a **chip** — circular photo on top, name in bold italic uppercase below, centered, with a party tag.
- AC-7.2: Clicking a chip reveals a **single full-width detail panel** beneath the chip grid showing votes, legislation, score badge, and member website link.
- AC-7.3: Only **one detail panel is open at a time**. Clicking a different chip closes the previous panel and opens the new one. Clicking the already-open chip closes it.
- AC-7.4: The expansion transition SHALL be smooth (height + opacity) at ~250ms ease-out.
- AC-7.5: On narrow viewports (< 720px), the chip grid collapses to a single column (senators first, rep below).
- AC-7.6: Widget root max-width SHALL be ≥ 1280px on large viewports.
- AC-7.7: Vacant senator seats render as a disabled chip with placeholder text.

### US-8: One Detail Panel at a Time (REVISED v2.2.0)
**As a** voter, **I want** to click a member's chip to reveal their Ukraine record **so that** the overview stays compact until I pick someone to study.

**Acceptance Criteria (v2.2.0):**
- AC-8.1: Chips start as overview-only (photo + name).
- AC-8.2: Clicking a chip opens the full-width detail panel below the grid.
- AC-8.3: Clicking the currently-open chip closes the panel.
- AC-8.4: Only one panel is open at a time — clicking another chip switches.
- AC-8.5: Transition is smooth (~250ms).

### US-9: Track Ukraine Visual Identity (NEW v2.2.0)
**As a** site operator (trackukraine.com), **I want** the embedded widget to feel native to the host site **so that** it blends into the page visually.

Reference palette + typography **observed on the live trackukraine.com coming-soon page** (Fourthwall host, overlay palette — supersedes the default Fourthwall theme colors):
- Font: **Hanken Grotesk** (weights 500/700; 900 italic for hero headings)
- Background surface: **sky cyan ≈ `#00B4E6`** (when widget is embedded on their homepage)
- Widget embedded background: transparent so host color shows through
- Text on cyan: **white**, **bold** or **bold italic**, with a **hard black offset drop shadow** (`1px 1px 0 #000`) for heading treatments
- Primary button: **yellow `#fff100`** bg, **black uppercase bold text**, flat square (0 border-radius)
- Secondary button: **black bg, white uppercase bold text**, flat square
- Headings: **italic, uppercase, weight 900**
- Corners: **flat — 0px border-radius everywhere**
- Tables / rows: square edges, 1px borders, no shadows

**Acceptance Criteria:**
- AC-9.1: The widget SHALL use Hanken Grotesk (loaded from Google Fonts or the host's font stack) as its primary typeface.
- AC-9.2: Border-radius on cards, buttons, tables, pills, and inputs SHALL be 0px.
- AC-9.3: Headings SHALL be uppercase italic weight 900.
- AC-9.4: Primary action buttons SHALL render as **yellow bg + black text + uppercase bold** (matches the observed SIGN UP button). Secondary buttons: black bg + white uppercase.
- AC-9.5: Party tags keep functional color coding (blue/red) but use the flat-box shape (no pill, no border-radius).
- AC-9.6: The widget SHALL expose a `font-family: inherit` fallback for key text elements so it picks up the host's font when embedded into a page that sets `--font-family-base` or body font-family.
- AC-9.7: Box shadows SHALL be removed from all components (flat design). The *only* shadow permitted is the **hard black offset drop shadow on headings** (`1px 1px 0 #000`) when the widget is rendered on a dark/saturated host background.
- AC-9.8: The widget root SHALL NOT set its own `background-color` (remain transparent) so the host's background color — such as trackukraine.com's sky cyan — shows through. Chip/panel surfaces that need their own bg (for contrast against voter photos, tables) SHALL use **white (`#ffffff`)** with black borders.
- AC-9.9: Hero heading copy ("HOW YOUR MEMBERS OF CONGRESS VOTED ON UKRAINE") SHALL render as **white, italic, uppercase, weight 900, with a 1px 1px hard black drop shadow** — mirroring the host's COMING SOON treatment.

### US-6: Embeddable Widget
**As a** website operator, **I want to** embed the voter info tool on my site with a single script tag **so that** my visitors can use it without leaving my site.

**Acceptance Criteria:**
- AC-6.1: Widget is distributed as a single JavaScript file
- AC-6.2: Widget mounts via `<voter-info-widget>` custom element
- AC-6.3: Widget accepts an `api-base` attribute for the CORS proxy URL
- AC-6.4: Widget styles are scoped via Shadow DOM (no CSS leakage)
- AC-6.5: Widget works in all modern browsers (Chrome, Firefox, Safari, Edge — last 2 versions)

---

## 3. Functional Requirements

### FR-1: Address Resolution
The system SHALL accept a U.S. street address and resolve it to a state code and congressional district number using the U.S. Census Bureau Geocoder API. The system SHALL extract the state FIPS code and congressional district number from the `119th Congressional Districts` geography layer and convert the FIPS code to a two-letter state abbreviation.

### FR-2: FIPS-to-State Mapping
The system SHALL map state FIPS codes (e.g., `17`) to two-letter state abbreviations (e.g., `IL`) using a static lookup table covering all 50 states, DC, and U.S. territories. The system SHALL handle at-large districts (Census returns `CD119: "00"`) by converting to district `0` for Congress.gov queries.

### FR-3: Member Lookup
The system SHALL query the Congress.gov API to retrieve current members of Congress for the resolved state and district. The system SHALL return both senators and the house representative for the user's location.

### FR-4: Member Detail
The system SHALL retrieve detailed information for each member including: full name, party, state, district, chamber, official photograph URL, and terms served.

### FR-5: House Vote Retrieval
The system SHALL retrieve House roll call vote data from the Congress.gov API, including each member's individual vote cast on each roll call.

### FR-6: Senate Vote Retrieval
The system SHALL retrieve Senate roll call vote data from Senate.gov XML publications, parsing the XML client-side.

### FR-7: Sponsored Legislation
The system SHALL retrieve lists of sponsored and co-sponsored legislation for each member from the Congress.gov API.

### FR-8: Party Alignment Calculation
The system SHALL calculate a party alignment score for each member **over the curated Ukraine roll-call votes only**. The algorithm is defined in the Design Document (design.md §4.5).

### FR-11: Ukraine Bill Filter (NEW v2)
The system SHALL filter both sponsored/cosponsored legislation lists and the voting record to entries whose `{congress, type, number}` matches an entry in the curated Ukraine bill set (`src/data/ukraineBills.json`). Non-matching entries SHALL NOT be shown.

### FR-12: Curated Bill Set as Source of Truth for Votes (NEW v2)
The system SHALL build the voting record by iterating the curated bill set's pre-resolved roll-call numbers (not by fetching the most recent N votes). For each curated vote, the system SHALL look up the member's individual vote (House via Congress.gov `/members` endpoint, Senate via Senate.gov XML). If the member is missing from the result list, the row SHALL show "Did Not Vote".

### FR-13: Bill Direction Classification (NEW v2.1)
Each curated bill SHALL be classified into one of three **directions**:
- `pro-ukraine` — the bill adds or authorizes Ukraine aid, sanctions against Russia, asset seizure from Russia, or affirmative support
- `anti-ukraine` — the bill or amendment removes/reduces Ukraine funding, lifts or blocks Russia sanctions, or prohibits specific assistance
- `neutral` — oversight/reporting requirements, symbolic resolutions, or mixed

Classification is performed at curator-build time by `scripts/build-curated-bills.mjs` using a keyword rule-set over the bill title and action text. Results are stored in the JSON and reviewable/overridable manually.

### FR-14: Vote Weighting (NEW v2.1)
Each vote SHALL carry a **weight** in [0, 1] based on its legislative significance:

| Category | Weight | Examples |
|---|---|---|
| Final passage / became law | 1.0 | "Passed", "Became Public Law" |
| Motion to concur / agreed to conference | 0.9 | "Senate agreed to House amendment" |
| Amendment with real effect | 0.7 | "Amendment to strike $300M Ukraine funding" |
| Motion to recommit | 0.4 | Often symbolic but occasionally impactful |
| Cloture / motion to proceed / budget waiver / reconsideration | 0.15 | Procedural |

Weights are assigned by the curator script from action-text keywords. They feed the Ukraine Support Score (FR-16) and are shown in the UI as a badge next to each row.

### FR-15: Valence (5-Color Scheme) (NEW v2.1)
Each member-action pair (their vote on a bill, or their sponsorship/cosponsorship) SHALL be assigned a **valence** with 5 visual levels:

| Level | Color | Meaning |
|---|---|---|
| `sponsor-pro` | Dark green | Member sponsored a pro-Ukraine bill (strongest positive signal) |
| `voted-pro` | Green | Member voted to support Ukraine (Yea on pro-UA, or Nay on anti-UA) |
| `unstated` | Yellow | Member did not vote, was Present, or the bill had no recorded position |
| `voted-anti` | Red | Member voted against Ukraine (Nay on pro-UA, or Yea on anti-UA) |
| `sponsor-anti` | Dark red | Member sponsored an anti-Ukraine bill (strongest negative signal) |

Cosponsor counts as sponsor for valence purposes (the messaging: owning the bill is worse than just voting). Rationale lives in design.md §4.6.

### FR-16: Ukraine Support Score (NEW v2.1, replaces party-alignment-only scoring)
For each member, the system SHALL compute a **Ukraine Support Score** in [-1.0, +1.0]:

```
signed_contribution = +1 if valence is pro, -1 if anti, 0 if unstated
amplifier           = 1.5 if sponsored/cosponsored, else 1.0
weighted            = signed_contribution × amplifier × vote_weight
score               = sum(weighted) / sum(abs_max(weighted))  // normalized to [-1, 1]
```

The score SHALL be displayed as a badge with a continuous **red → yellow → green gradient**. The numeric score and the number of underlying actions SHALL also be shown for transparency.

**This replaces party alignment as the primary metric.** Party alignment may still be shown as a secondary data point but is no longer the headline number.

### FR-17: Procedural Vote Grouping (NEW v2.1)
Votes on the same bill SHALL be grouped in the UI such that **procedural precursors** (weight ≤ 0.2) are nested under their passage vote and hidden by default. A chevron next to the passage vote row SHALL reveal the procedural cluster. This prevents the 7-row cascade we observed on H.R. 815 where 5 of 7 rows were procedural.

### FR-18: Inline Bill Summaries (NEW v2.1)
Clicking a bill row in the Legislation tab SHALL expand the row inline to reveal the **CRS summary** from the Congress.gov `/bill/{congress}/{type}/{number}/summaries` endpoint. Summaries are lazy-fetched on first expansion and cached for the session. If no summary is available, the expansion area shall say so explicitly.

### FR-19: Party ID Source (BUG FIX v2.1)
Party classification for score / alignment calculation SHALL be derived from the member's `partyHistory` array (specifically the most recent entry's `partyAbbreviation`: `"D"`, `"R"`, `"I"`). The system SHALL NOT infer party from prefix matching on `partyName` (`"Democratic"` vs `"Democrat"` vs `"Democratic-Farmer-Labor"` are all D; the old implementation's `.startsWith('D')` heuristic was fragile).

### FR-20: Member Website Link (NEW v2.1)
Each member's card SHALL display a link to their `officialWebsiteUrl` (from the member detail endpoint) when available. This lets voters go read the member's own statements on Ukraine.

### FR-22: Per-Roll-Call Vote Overrides (NEW v2.3.0)

**Problem.** Our regex-based classifier in `scripts/build-curated-bills.mjs` assigns `weight` and `directionMultiplier` from the action-text string. That works for most votes but fails when the same bill number goes through multiple legislative iterations. Example: Senate roll call 39 on HR 815 (Feb 2024) is a cloture that *failed* and killed a bad version of the bill; senators who voted Aye on passage of the *final* April 2024 HR 815 routinely voted Nay on that February cloture as part of the maneuver to get a better bill. The regex reads both as `cloture` with weight 0.45 and `directionMultiplier +1`, making Schumer and McConnell look anti-Ukraine on votes that were actually pro-Ukraine in context.

**Solution.** Introduce a YAML override file — `scripts/vote-overrides.yaml` — keyed by `(congress, session, rollCall, chamber)`. Each entry can override `weight`, `directionMultiplier`, and attach a `kind` label and free-text `note`. The curator applies overrides *after* the regex classifier, so the override always wins.

Inspired by slava-ukrani's `weighting_scheme.yaml` approach (explicit, editable per-measure weights) but applied at the finer roll-call granularity our fine-grained `kind` vocabulary requires.

**Acceptance criteria:**
- AC-22.1: An override entry SHALL be keyed by `chamber`, `congress`, `session`, and `rollCall`. Bill references (`bill: HR815`) are optional documentation but not used for lookup — a roll call number uniquely identifies the vote.
- AC-22.2: An override MAY set any subset of `{weight, directionMultiplier, kind, note}`. Unset fields inherit from the classifier.
- AC-22.3: The curator SHALL log every applied override to stdout during build so editors can verify the overrides are reaching the data.
- AC-22.4: If the YAML file is missing, the curator SHALL fall back to classifier-only behavior (no error).
- AC-22.5: If an override refers to a roll call that doesn't appear in any curated bill's action list, the curator SHALL emit a warning but continue — the override is dormant, not broken.
- AC-22.6: The curated JSON output SHALL include a `overrideApplied: true` marker on any vote whose fields were overridden, so downstream code / tests can assert on it.
- AC-22.7: The override file SHALL be checked into source control and reviewed like code. Overrides are editorial decisions and belong in the repo history.

### FR-23: Distinguish "Did Not Serve" from "Did Not Vote" (NEW v2.3.1)

**Problem.** Until v2.3.0 the system collapsed two very different things into a single `'Not Voting'` display:

- Members who were seated in Congress at the time and chose not to cast a ballot (meaningful abstention)
- Members who weren't in Congress yet (or had already left) — they *couldn't* have voted

A freshman senator who joined in 2025 ends up with "Did Not Vote" on every 2022 and 2024 Ukraine supplemental, which visually punishes them for votes they were literally ineligible to cast.

**Solution.** Expose a third state — `'Did Not Serve'` — distinct from `'Not Voting'`.

**Acceptance criteria:**
- AC-23.1: The service layer SHALL distinguish "member not in the roll-call roster at all" (Did Not Serve) from "member in roster with `vote_cast: Not Voting`" (real abstention). The House `/v3/house-vote/{c}/{s}/{rc}/members` endpoint returns every member present; anyone not in that array wasn't a member of that session. The Senate XML likewise includes the full roster; an absent bioguide means "not a senator at that time."
- AC-23.2: `MemberVoteRow.memberVote` SHALL accept a new value `'Did Not Serve'` in addition to the existing `'Aye' | 'Nay' | 'Present' | 'Not Voting'`.
- AC-23.3: Rows with `memberVote === 'Did Not Serve'` SHALL be **filtered out** of the `clusters` and `flat` arrays returned by `useVotingRecord`. They do not appear in the UI, do not contribute to the score (already true since they score 0), and do not inflate any "action count" metrics shown to the voter.
- AC-23.4: Real abstentions (`'Not Voting'` with the member in roster) SHALL remain visible in the UI as "Did Not Vote" and continue to score 0.
- AC-23.5: When a member has **≥ 3 abstentions on primary-weight votes** (weight ≥ 0.7), the Ukraine Support Score badge SHALL include a context note — e.g., "Abstained on 3 primary Ukraine votes" — flagging the pattern. Abstention on primary votes is a weak signal of disengagement; voters should see it.
- AC-23.6: The `UkraineScore.total` count SHALL exclude Did-Not-Serve rows but INCLUDE real abstentions (so the "(N excluded: unstated, procedural, or neutral)" note in the badge accurately reflects abstentions the voter can see).

### FR-24: Baked Vote Rosters (REVISED v2.5.0 — see ADR-011)

**Problem.** Opening a rep card originally fired 26–36 HTTP requests per card (one per curated roll call). The v2.4.0 solution (bundled `ukraineVotes.json` blob on R2) fixed the upstream round-trip problem but introduced a new one: the widget pulled ~790KB on every cold boot to serve ~45 cast lookups per user (~99% waste). See ADR-011 for the full reasoning.

**Solution (v2.5.0).** The curator SHALL emit **atomic per-member records** into KV (`member:v1:{bioguideId}` — see FR-32 for the storage model). Each member record includes the member's identity, their curated-roll-call votes (pre-joined with roll-call metadata), their Ukraine score, and their sponsored/cosponsored bills. The widget SHALL fetch exactly one member record per rendered rep card — no bulk blob, no client-side joins, no per-roll-call fan-out.

**Acceptance criteria:**
- AC-24.1: The curator SHALL write one `member:v1:{bioguideId}` KV record per current-Congress member. Each record SHALL contain all data needed to render that member's rep card. (See FR-32 AC-32.1 for the canonical record shape.)
- AC-24.2: The widget SHALL fetch `/api/members/{bioguideId}` for each representative resolved from an address lookup or name search. The endpoint SHALL return the corresponding KV record, or 404 if no such record exists.
- AC-24.3: `useVotingRecord` SHALL read roll-call votes from the fetched member record. The hook SHALL NOT call Congress.gov or Senate.gov for curated roll calls. A network fallback SHALL remain only for non-curated roll calls explicitly requested by the UI (if any such code path exists post-cutover).
- AC-24.4: A member record's `ukraineVotes[]` SHALL distinguish "member did not serve during this Congress/session" (entry absent from `ukraineVotes`) from "member in office but did not vote" (entry present with `cast = "Not Voting"`) so FR-23's Did-Not-Serve logic remains intact.
- AC-24.5: The curator SHALL emit a diff summary to stdout on each run: count of member records written, count of bill records written, count of roll-call records written, and total KV-write bytes. The summary SHALL also list any members whose `ukraineScore.value` changed by more than 5 points since the previous run.
- AC-24.6: The widget bundle SHALL remain under **250KB gzipped**. With `initRosters()` and `src/data/*.json` removed, the expected bundle size is ~200KB gzipped. `bundle-size.test.ts` (in `tests/unit/`) SHALL enforce this ceiling.
- AC-24.7: `src/data/ukraineBills.json` and `src/data/ukraineVotes.json` files SHALL be removed from the repository. Their content lives in KV exclusively, written by the curator.
- AC-24.8: `src/services/bundledRosters.ts` and the `initRosters()` API SHALL be removed. Any remaining references in `src/embed.tsx`, `src/main.tsx`, or hooks SHALL be deleted.

### FR-25: Edge-Cached CORS Proxy (NEW v2.4.0)

**Problem.** The Cloudflare Worker proxy currently pass-through-fetches every request to the upstream (Census, Congress.gov, Senate.gov). No caching. Every user pays the upstream round-trip.

**Solution.** Wrap upstream fetches in Cloudflare's `caches.default` API. For immutable data (roll-call rosters, historical bill actions) return `Cache-Control: public, max-age=31536000, immutable`. For mutable data (sponsored legislation lists) use `max-age=300` to keep rosters fresh without overwhelming upstreams.

**Acceptance criteria:**
- AC-25.1: The Worker SHALL wrap each upstream fetch in `caches.default.match(req) ?? fetchAndStore(req)`.
- AC-25.2: Responses from immutable routes (`/api/senate/legislative/LIS/*`, `/api/congress/v3/house-vote/*`, `/api/congress/v3/bill/*/actions`, `/api/congress/v3/bill/*/summaries`) SHALL return `Cache-Control: public, s-maxage=31536000, max-age=31536000, immutable`.
- AC-25.3: Responses from semi-mutable routes (`/api/congress/v3/member/*/sponsored-legislation`, `/api/congress/v3/member/*/cosponsored-legislation`) SHALL return `Cache-Control: public, s-maxage=3600, max-age=300`.
- AC-25.4: Responses from the Census geocoder SHALL return `Cache-Control: public, s-maxage=86400, max-age=3600` (address-to-district mappings change slowly with redistricting).
- AC-25.5: The Worker SHALL restrict CORS on `/api/*` to a whitelist of allowed origins. Requests whose `Origin` header is absent or not on the whitelist SHALL receive a `403 Forbidden` response with body `Origin not allowed`. (Revised v2.4.1 — previously this clause unconditionally allowed `http://localhost:*` and `http://127.0.0.1:*` in every environment, which turned prod into a free Congress.gov gateway for any page served from a local webserver; see AC-25.9.)
- AC-25.6: The allowed-origin whitelist SHALL be configurable via the `ALLOWED_ORIGINS` Worker environment variable (comma-separated list of `scheme://host[:port]` values; exact match, no wildcards, no suffix matching). The value in `wrangler.toml`'s top-level `[vars]` block SHALL be the production whitelist (`https://trackukraine.com,https://www.trackukraine.com`). Non-prod environments (`dev`, `uat`, `stg`, `preview`) MAY widen this via their `[env.<name>.vars]` block.
- AC-25.7: The Worker SHALL perform origin matching as **case-sensitive exact equality** on the full `scheme://host[:port]` string. The Worker SHALL NOT perform prefix-, suffix-, or substring-matching against the whitelist. (Closes an attacker-controlled suffix-bypass like `Origin: https://trackukraine.com.evil.example`.)
- AC-25.8: The Worker SHALL reflect the matched whitelist entry back in `Access-Control-Allow-Origin` (not a wildcard, not the raw `Origin` header). The Worker SHALL set `Vary: Origin` on every `/api/*` response so shared caches key on origin.
- AC-25.9: Localhost origins (`http://localhost[:port]`, `http://127.0.0.1[:port]`) SHALL be permitted **only** when the Worker environment variable `ALLOW_LOCALHOST` is set to the exact string `"true"`. `ALLOW_LOCALHOST` SHALL default to unset (i.e., localhost is denied). The `dev` and `preview` environments SHALL set `ALLOW_LOCALHOST="true"` in `wrangler.toml`; `prod`, `stg`, and `uat` SHALL NOT. (Rationale: `dev`/`preview` exist to let a developer point any local harness at the Worker; prod/stg/uat model real embed traffic where a localhost `Origin` is always either a misconfiguration or an attacker.)
- AC-25.10: The Worker SHALL NOT forward client-supplied query parameters named `api_key` to the upstream. The Worker SHALL always overwrite `api_key` with the configured `CONGRESS_API_KEY` secret for `/api/congress/*` and SHALL strip `api_key` from any upstream URL for `/api/census/*` and `/api/senate/*` (neither accepts or requires it). This prevents an attacker-supplied key from reaching upstream, and prevents our key from leaking to upstreams that don't expect it.

### FR-27: Proxy Security Hardening (NEW v2.4.1)

**Problem.** The Worker returns responses without setting a consistent security header baseline, leaks some upstream headers that fingerprint the upstream provider, and passes arbitrary upstream-path segments into the Congress.gov API-key injection logic. The CORS proxy is the only user-facing surface that carries a secret (`CONGRESS_API_KEY`), so its defensive posture needs to be explicit and testable.

**Solution.** Set a fixed security-header baseline on every Worker response (success, client error, server error, static, API). Normalize error bodies so upstream HTML error pages don't leak through with `Content-Type: text/html`. Restrict Congress.gov API-key injection to the `/v3/*` upstream path, refusing to inject the key on any other upstream path.

**Acceptance criteria:**

- AC-27.1: Every response emitted by the Worker SHALL carry the following **universal security-header baseline**, regardless of status code or route:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` — enforce HTTPS; preload-eligible (v2.4.2 added `preload` after committing to HTTPS-only on the apex).
  - `X-Content-Type-Options: nosniff` — defeat MIME-sniff confusion attacks.
  - `Referrer-Policy: no-referrer` — emit no referrer on outbound navigation from our origin.
  - `X-Frame-Options: DENY` — deny all framing of our origin.
  - `X-DNS-Prefetch-Control: off` — suppress automatic DNS prefetching for embedded links.
  - `X-Permitted-Cross-Domain-Policies: none` — block legacy Flash/Silverlight/Adobe cross-domain policy lookups.
  - `Cross-Origin-Opener-Policy: same-origin` — window-level process isolation.
  - `Origin-Agent-Cluster: ?1` — request origin-keyed agent cluster (defence-in-depth for process isolation).
- AC-27.1a: For responses the Worker **emits itself** (not upstream proxied content) — i.e., 4xx/5xx JSON envelopes, the `/` → trackukraine.com redirect, and any future Worker-generated HTML — the Worker SHALL additionally set:
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  - `Permissions-Policy: accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), interest-cohort=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()`
  - `Cross-Origin-Resource-Policy: same-origin` — Worker-emitted content is not meant to be read cross-origin (errors / redirects).
  - `Cache-Control: no-store` on all 4xx/5xx responses.
- AC-27.1b (revised 2026-04-18): Static-file responses served via Worker Sites `ASSETS` binding (`/voter-info-widget.iife.js`, `/voter-info-widget.iife.js.sri`, `/ukraineBills.json`, `/ukraineVotes.json`) SHALL carry `Cross-Origin-Resource-Policy: cross-origin` (so the bundle is embeddable from any host) and `Access-Control-Allow-Origin: *`. CSP and Permissions-Policy SHALL NOT be set on static responses (they apply to documents, not subresources, and would confuse static analyzers). **Historical note:** original v2.5.1 wording referenced "R2"; the ADR-011 migration replaced R2 with Worker Sites before this AC landed.
- AC-27.1c: Successful `/api/*` responses SHALL carry `Cross-Origin-Resource-Policy: cross-origin` so browser fetch from allowed embedder origins can read them. CSP and Permissions-Policy SHALL NOT be set on API responses (non-document content).
- AC-27.2: `/api/*` responses SHALL additionally carry the headers in AC-25.8 (CORS reflection + `Vary: Origin`).
- AC-27.3: The Worker SHALL strip the following upstream-provided response headers before responding: `Set-Cookie`, `Access-Control-Allow-Credentials`, `Server`, `Via`, `Link`, `Report-To`, `NEL`, `Reporting-Endpoints`, `P3P`, `X-Powered-By`, `X-AspNet-Version`, `X-AspNetMvc-Version`, and any header matching `/^x-(vcap|api-umbrella|amz|azure|appengine|request-id|correlation-id|trace-id|b3)/i`. Rationale: these fingerprint the upstream provider, leak internal routing metadata, or (in the case of `Report-To`/`NEL`) tell the browser to beacon user data to an endpoint we do not control.
- AC-27.4: (Superseded by AC-27.3 in v2.4.2; the header list is expanded and consolidated there.)
- AC-27.5: When the upstream returns a non-2xx response, the Worker SHALL normalize the body to JSON of the form `{"error":"upstream_error","status":<int>,"upstream":"<prefix>"}` and emit `Content-Type: application/json; charset=utf-8`. The Worker SHALL NOT pass the raw upstream body through on error (closes HTML-error-page flows and removes the need for regex-based `CONGRESS_API_KEY` redaction in the common path — although redaction SHALL remain as a defense-in-depth step for any case where the key appears in our own error string).
- AC-27.6: The Worker SHALL only inject `CONGRESS_API_KEY` into the upstream URL when the `/api/congress/*` path maps to an upstream path starting with `v3/`. Any other upstream path on `api.congress.gov` SHALL be rejected with `400 Bad Request` and body `{"error":"unsupported_upstream_path"}` — the key SHALL NOT be sent. (Closes a class of bugs where an attacker could attach our credential to arbitrary non-v3 endpoints on the same host.)
- AC-27.7: The Worker SHALL reject any `/api/*` request whose `upstreamPath` (the portion after the route prefix) contains any of: `//`, `@`, any control character (`\x00-\x1f` or `\x7f`) after percent-decoding, or any of the percent-encoded control-byte sequences `%00`–`%1f` or `%7f` in the raw pathname (case-insensitive). Rejection returns `400 Bad Request` with body `{"error":"invalid_upstream_path"}`. (Defensive: `URL` constructor normalization already prevents host-switching and collapses `..` segments before the worker sees the path; this check additionally closes CRLF-injection via `%0d%0a`, null-byte smuggling via `%00`, and other encoded-control-byte tricks. The pure helper `isValidUpstreamPath` also rejects `..` substrings as belt-and-braces for any future code path that bypasses URL parsing.)
- AC-27.8: The Worker SHALL NOT log request URLs, response bodies, or any header value to any observability sink without first redacting `CONGRESS_API_KEY`. (Current code has no logging; this AC pins the invariant for future changes.)
- AC-27.9: The Worker SHALL return `405 Method Not Allowed` with an `Allow` response header for any request whose method is not supported on that route. The Worker SHALL accept the following methods:
  - **`/api/*`** — `GET`, `HEAD` (HEAD SHALL be treated identically to GET except the body is omitted, per RFC 7231 §4.3.2), `OPTIONS` (preflight). 405 Allow: `GET, HEAD, OPTIONS`.
  - **Static files (Worker Sites `ASSETS`)** — `GET`, `HEAD`, `OPTIONS`. 405 Allow: `GET, HEAD, OPTIONS`.
  - **Unknown paths** — fall through to dispatch's text/html redirect or 404; no method-specific 405.
  - OPTIONS responses from the Worker — whether 204 preflight-success, 403 disallowed-origin, or any other OPTIONS-generated response — SHALL include `Allow` per above when the response status is 4xx. (Previously the 405 response omitted `Allow`, which violates RFC 7231 §7.4.1.)
- AC-27.10: The `ALLOW_LOCALHOST` and `ALLOWED_ORIGINS` environment variables SHALL be parsed exactly once per request (no dynamic reload, no module-scope memoization that could leak across isolates). This keeps the Worker stateless and makes `wrangler deploy --env <name>` the single source of truth for the whitelist.
- AC-27.11: The Worker's outbound `fetch()` to upstream SHALL pin `Accept: application/json` for `/api/congress/*` and `/api/census/*` routes, and `Accept: application/xml, text/xml, */*` for `/api/senate/*`. The Worker SHALL NOT forward the client's `Accept` header to upstream. Rationale: a client-controlled `Accept` header on a shared-cache proxy lets an attacker poison the cache by requesting the same URL with a non-default Accept value (e.g., `Accept: text/html`), getting upstream to respond with a differently-shaped body that is then cached and served to subsequent legitimate clients. Pinning Accept server-side makes the cache key semantically complete without including Accept explicitly.
- AC-27.12: For `/api/congress/*`, the upstream-path regex SHALL require at least one alphabetic character after `v3/`. The regex is `^v3\/[a-z]`. A request to `/api/congress/v3/` (trailing slash, no path) or `/api/congress/v3/0` (non-alpha first char) SHALL return 400 `{"error":"unsupported_upstream_path"}` without attaching `CONGRESS_API_KEY` to the upstream fetch. (Closes a bug where attackers could attach our credential to `https://api.congress.gov/v3/` root or non-API endpoints.)
- AC-27.13: For `/api/*` requests with an allowed origin but a path whose first segment (after `/api/`) is not a known route prefix (`census`, `congress`, `senate`), the Worker SHALL return 404 `{"error":"no_such_api_route"}` for both GET/HEAD **and** OPTIONS preflight. An unknown `/api/<foo>/*` path SHALL NOT return a 204 preflight-success, because doing so advertises to attackers that any `/api/*` path is CORS-enabled. (Previously the preflight check ran before route matching, returning 204 on unknown paths.)
- AC-27.14: Cloudflare itself injects the following response headers **after** our Worker returns: `Server: cloudflare`, `CF-RAY`, and (when the zone has Network Error Logging enabled) `Report-To`, `NEL`. Our Worker cannot strip these in-code. The deployment SHALL suppress them at the zone level via a Cloudflare Transform Rule (`docs/deployment.md §Zone-level header scrubbing`). This is a deploy-time configuration, not a runtime behavior.
- AC-27.15: HSTS `preload` directive on the Worker's responses is advisory only — the apex domain must be **submitted** to https://hstspreload.org for the preload list to take effect. `docs/deployment.md` SHALL document the submission steps for `cogs.it.com`. Until submitted, the `preload` directive is a no-op that simply signals intent.
- AC-27.16 (v2.5.1): The Worker SHALL strip the following additional upstream-provided response headers on top of AC-27.3: `Clear-Site-Data`, `Refresh`, `Content-Location`, and any header matching `/^x-ratelimit-/i`. Rationale: `Clear-Site-Data` would let upstream wipe cookies/storage on our domain; `Refresh` is a meta-refresh analogue some browsers honor; `Content-Location` confuses caching proxies; `x-ratelimit-*` headers from Congress.gov leak quota state (proves the key exists and how much remains) and are directly useful to an attacker timing a denial-of-wallet attack. Verification: a 2xx `/api/congress/*` response with upstream `x-ratelimit-limit` header SHALL NOT carry that header after the Worker processes it.
- AC-27.17 (v2.5.1): The Worker SHALL strip **all** upstream-provided headers matching `/^access-control-/i` before layering its own CORS response headers. Previously the Worker preserved upstream `Access-Control-Expose-Headers` and `Access-Control-Max-Age`, letting upstream decide which response headers were exposed to embedder JS. The Worker SHALL be the sole authority on every `Access-Control-*` header it emits.
- AC-27.18 (v2.5.1): The Worker's outbound `fetch()` to upstream SHALL carry an `AbortSignal.timeout(15000)` (15-second wall clock). If the upstream does not respond within 15 s, the Worker SHALL return `504 Gateway Timeout` with body `{"error":"upstream_timeout","upstream":"<name>"}` and `Cache-Control: no-store`. Rationale: without a timeout a slow upstream ties up Worker concurrency; Cloudflare's 30 s platform limit is a cliff, not a guard. 15 s is 3× the documented p99 of Congress.gov and Census and still well under the platform limit, leaving headroom for the rest of the Worker's processing.
- AC-27.19 (v2.5.1, superseded 2026-04-18): The Worker SHALL perform static-file lookups via `Object.hasOwn` (or an equivalent `Map.has` check) rather than plain-object property access. Rationale: `STATIC_FILES['__proto__']` would return `Object.prototype` (truthy), bypassing the `if (!fileMeta) return null` guard and producing a malformed response with `Content-Type: undefined`. **Supersedure note:** the R2-backed `STATIC_FILES` map that this AC guarded was replaced by Worker Sites (`env.ASSETS.fetch`) prior to v2.5.1 landing. Static-file resolution is now delegated to Cloudflare's runtime, which does not expose a keyed JavaScript object to user-supplied path segments; the prototype-lookup confusion cannot occur in our code. This AC is retained as a **forward-looking constraint**: any future in-Worker static map SHALL use `Object.hasOwn` / `Map.has`. See ADR-010 for history.
- AC-27.20 (v2.5.1): The Worker SHALL canonicalize the upstream query string per-route before forwarding and before computing the cache key. For each route, a fixed allowlist of query-parameter names SHALL be defined; unknown parameters SHALL be dropped silently; allowed parameters SHALL be sorted by name and serialized with `URLSearchParams` to produce a stable, canonical form. Rationale: (a) prevents cache-fragmentation DoS where an attacker walks `&nonce=1..N`, forcing cache misses and upstream fetches that drain quota; (b) prevents query-string smuggling of parameters we don't intend to forward to upstream; (c) makes the cache key a function of meaningful inputs only. Allowlists per route:
  - **census**: `address`, `street`, `city`, `state`, `zip`, `benchmark`, `vintage`, `layers`, `format`.
  - **congress**: `limit`, `offset`, `format`, `fromDateTime`, `toDateTime`, `sort`, `chamber`, `congress`, `currentMember`.
  - **senate**: (none — Senate.gov XML endpoints are path-keyed, no query params are expected or forwarded).
  An AC amendment is the right path to add parameters; silently widening the allowlist in code without spec update is a spec violation.
- AC-27.21 (v2.5.1): The Worker SHALL enforce a **per-IP in-Worker rate limit** on `/api/*` requests via the Cloudflare Workers Rate Limiting API binding (`RATE_LIMITER`). The binding SHALL be declared in `wrangler.toml` with a key derived from `cf.connecting_ip` (falling back to the `CF-Connecting-IP` header) for every `/api/*` request, evaluated **after** origin validation (so rejected-origin requests do not consume the budget). On limit exceeded, the Worker SHALL return `429 Too Many Requests` with body `{"error":"rate_limited","retry_after":<seconds>}`, `Retry-After: <seconds>` header, and `Cache-Control: no-store`. Per-env limits:
  - **prod**: 10 requests / 60 s / IP. (The widget's intended use is one address lookup per visitor; 10 requests covers the lookup + its triggered fan-out — /census, /congress/member list, /congress/member/{id} detail, sponsored-legislation, cosponsored-legislation, house-vote, senate roll-call — with margin. Beyond that is either hostile or a stuck client.)
  - **stg**: identical to prod (stg mirrors prod per FR-30).
  - **uat**: 60 requests / 60 s / IP. (UAT reviewers need a looser budget to exercise the widget repeatedly during review sessions.)
  - **dev**, **preview**: 600 requests / 60 s / IP. (Local and dev harnesses iterate fast.)
  Rationale: layered with the zone-level rate limit in AC-28.3 — defense-in-depth. The zone rule is a blunt volumetric filter running before the Worker; the in-Worker rule is fine-grained, environment-aware, and survives zone-config drift. See ADR-010 for the binding vs. token-bucket-via-KV tradeoff.
- AC-27.22 (v2.5.1): The Worker SHALL NOT consume the AC-27.21 rate-limit budget for requests rejected at a cheaper earlier stage (missing Origin, non-allowlisted Origin, unknown `/api/<foo>` route, disallowed method). Rationale: rate limiting gates expensive upstream fetches; spending the budget on responses the Worker can reject in a few microseconds would let an attacker exhaust legitimate users' budget by flooding with cheap-to-reject requests.

### FR-28: Zone-Level Security Posture (NEW v2.5.0)

**Problem.** The Worker's defensive posture is now solid at the code layer, but several classes of threat are best handled at the Cloudflare zone layer — ahead of the Worker — where they cost zero code, produce no false positives against our known-good traffic, and cannot be accidentally regressed by a Worker deploy. The full Worker hardening pass (FR-27) assumes these zone-level controls are also in place; without them, attacks that should never reach the Worker's Origin-allowlist code (volumetric abuse, stale TLS, bot scraping, known-bad-actor geos) still consume Worker invocations and Congress.gov quota.

**Solution.** Commit to a specified zone-level posture documented in `docs/deployment.md §Zone-level hardening` and captured as ACs here. These are **configuration, not code** — the ACs describe the intended setting; the verification is a manual dashboard check or a `gh`/`wrangler`/CF API assertion in CI if we ever add one. ADR-007 records the choice rationale.

**Scope:** All ACs apply to the `cogs.it.com` Cloudflare zone and to every subdomain that serves the Worker (`vote.cogs.it.com`, `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`). Where an AC needs per-env differentiation, the AC calls it out explicitly.

**Acceptance criteria:**

- AC-28.1: The zone SHALL have the **Cloudflare Managed Ruleset** (OWASP Core Rule Set) enabled in **Block** mode on `vote.cogs.it.com` and all env subdomains. Sensitivity: "Medium". Exceptions: none initially — monitor WAF events for 7 days post-enable; add scoped exclusions only for confirmed false positives against `/api/*` with an inline comment citing the event ID.
- AC-28.2: The zone SHALL have **Bot Fight Mode** enabled (or Super Bot Fight Mode if the plan supports it). Challenges for verified-bot traffic: allowed (Googlebot, Bingbot, legitimate crawlers). Definitely-automated traffic: challenged. This is a blunt tool; revisit if legitimate automation (e.g., uptime monitors) triggers it — whitelist by IP or User-Agent rather than disabling.
- AC-28.3 (REVISED v2.5.1): The zone SHALL have a **Rate Limiting Rule** on `/api/*` tightened to **20 requests per 60 seconds per client IP in prod**, **20 rpm in stg**, **120 rpm in uat**, **1200 rpm in dev**. Match expression: `(starts_with(http.request.uri.path, "/api/") and http.host eq "<env-hostname>")` — one rule per env hostname to permit per-env thresholds. Action: `Block` with a 10-minute timeout. Response: `429 Too Many Requests` (CF default block page; our Worker's JSON envelope doesn't apply at this layer). Rationale (revised): the widget's intended use is **a single address lookup** per visitor, which fans out to roughly 7 upstream calls (1× census, 1× congress member-list, 3× congress member-detail, 1× congress sponsored-legislation, 1× senate roll call). The edge cache absorbs nearly all repeat reads, so a legitimate user's uncached footprint is ≤ 10 requests in a few seconds. 20/min/IP in prod gives a 2× headroom over that worst-case legitimate burst and anything above is hostile or broken. **Layered with AC-27.21** (in-Worker per-IP limit of 10/60 s/IP in prod): the zone rule is the blunt volumetric filter; the Worker rule is the fine-grained, per-env, per-route budget. An attacker coming from one IP hits the zone limit first; an attacker coming from diverse IPs that each stay under the zone limit still hits the Worker's quota-aware limiter on upstream calls.
- AC-28.4: The zone SHALL have **Transform Rules** that remove the following response headers on all responses from `*.vote.cogs.it.com`: `Server`, `CF-RAY`, `Report-To`, `NEL`, `Reporting-Endpoints`. Rationale: completes AC-27.14 (Cloudflare injects these after our Worker and we cannot strip them in code).
- AC-28.5: The zone's **Edge Certificates → Minimum TLS Version** SHALL be `TLS 1.3`. Legacy-browser support (< Chrome 70, < Firefox 63, < Safari 12.1) is out of scope for a 2026 deploy — voters on those browsers cannot render React 19 regardless.
- AC-28.6: The zone SHALL have **Always Use HTTPS: On** and **Automatic HTTPS Rewrites: On**. TLS 1.3 0-RTT SHALL be **Off** (replay-attack concerns on cache-warm proxy paths).
- AC-28.7: The zone SHALL have **HSTS enabled at the zone level** with: `max-age=31536000`, `includeSubDomains`, `preload`, `noSniff: On`. This is belt-and-braces with AC-27.1 (the Worker also emits STS) — if a future non-Worker response ever serves from this zone, STS is still enforced. The `preload` directive SHALL match the Worker's value so there's no diverging advertisement.
- AC-28.8: The apex `cogs.it.com` SHALL have **DNSSEC enabled** at the Cloudflare DNS layer, with the DS record published at the registrar. Verification: `dig +dnssec cogs.it.com` shows `RRSIG` records and `ad` flag set.
- AC-28.9: The apex `cogs.it.com` SHALL have a **CAA DNS record set** restricting certificate issuance to the CAs Cloudflare actually uses. Default: `0 issue "letsencrypt.org"`, `0 issue "pki.goog"` (Google Trust Services — CF uses this for some certs), `0 issue "digicert.com"`, plus an `iodef` contact. Exact CA list SHALL be confirmed against the certificate chain of `curl -vI https://vote.cogs.it.com/` before publishing.
- AC-28.10: The zone SHALL have a **Cache Rule** on `hostname matches "^.*vote\.cogs\.it\.com$"` that sets "Respect origin cache-control headers". Rationale: the Worker sets deliberate `Cache-Control` values per AC-25.2/25.3/25.4; zone-default behavior for `*.js` and `*.json` must not override. Without this rule CF's default cache behaviour may cache beyond our intent.
- AC-28.11: The zone SHALL have a **Geo-Block Firewall Rule**:
  - Match expression: `(ip.geoip.country in {"RU" "BY"})`
  - Action: `Block`
  - Response: Cloudflare default block page (a 403) — the Worker is never invoked on matching requests, so our JSON error envelope doesn't apply.
  - Scope: entire zone (all hostnames, all paths). Rationale: blocking at the zone edge is simpler than per-path carve-outs, and the widget has no legitimate audience in RU/BY — U.S. voters looking up U.S. representatives.
  - Exceptions: none initially. A later AC MAY introduce an allowlist (e.g., for a known researcher or journalist IP range) if a concrete case surfaces; this SHALL be recorded in `docs/decisions/ADR-007-zone-level-security-posture.md` with justification.
  - Occupied regions of Ukraine (Crimea, Donetsk, Luhansk) are **not separately blocked** by this AC because CF's geo-IP for those regions is unreliable (often labeled `UA` or `RU` inconsistently) and blocking `UA` would defeat the widget's stated audience. Revisit if CF adds reliable sub-country geo.
- AC-28.12: All AC-28.* controls SHALL be documented in `docs/deployment.md §Zone-level hardening` as an ordered checklist, one heading per AC, with (a) the exact dashboard path or API call, (b) the expected end-state, (c) a one-liner verification command (`curl`, `dig`, or CF API `GET`). This turns the spec into runnable deployment ops.
- AC-28.13: Zone-level controls SHALL be reviewed after every incident and at least **annually**. The review output is either (a) no change, captured as a dated note in ADR-007, or (b) AC amendments under this FR with the dated rationale. Rationale: zone-level posture drifts — CF adds features, threat landscape changes, our traffic profile evolves.
- AC-28.14: The `*.workers.dev` preview subdomain SHALL be disabled for every Worker in this project (`voter-info-widget-proxy`, `voter-info-widget-proxy-dev`, `voter-info-widget-proxy-uat`, `voter-info-widget-proxy-stg`, `voter-info-widget-proxy-preview`). Rationale: the `workers.dev` URL bypasses the custom domain — and therefore bypasses every zone-level control in FR-28 (WAF, rate limit, Transform Rules, geo-block) and every Access policy in FR-29. An enabled `workers.dev` URL is a permanent end-run around the security posture. Verification: `curl -sI https://<worker-name>.<account-subdomain>.workers.dev/` SHALL return a connection failure or 404, not a valid response from our Worker code.

### FR-31: Post-Audit Hardening (NEW v2.5.1)

**Problem.** A security audit on 2026-04-17 (see `docs/decisions/ADR-010-post-audit-hardening.md`) identified eleven finite, remediable gaps in the widget + Worker + zone posture: response-header leaks (`x-ratelimit-*`, `Access-Control-Expose-Headers`), an unsanitized API-derived URL rendered as a clickable `<a href>`, a missing upstream-fetch timeout, a prototype-lookup confusion on static paths, broad query-param passthrough enabling cache-fragmentation DoS, missing SRI on the integrator embed snippet, R2 datasets not uploaded to prod, a Worker/static-bundle deploy-path drift, and no in-Worker rate limit (single-layer zone limit only). Each is small in isolation; together they constitute the remaining attack surface after FR-27's hardening pass. This FR enumerates the client-side and key-management ACs; the Worker-side ACs are filed under FR-27 (AC-27.16 through AC-27.22), the zone-side under FR-28 (AC-28.3 revision), and the deploy-side under FR-26 (AC-26.9 through AC-26.12). Grouping by layer keeps each layer's ACs co-located with the rest of that layer's contract.

**Acceptance criteria:**

- AC-31.1: The client SHALL sanitize every URL sourced from an external API response (Congress.gov, Census, Senate.gov) before rendering it as an `href`, `src`, or other URL-bearing DOM attribute. Sanitization: accept only URLs whose scheme is `https:` or `http:` after `new URL(u)` parsing; reject `javascript:`, `data:`, `vbscript:`, `file:`, and any scheme that does not parse as an absolute HTTP(S) URL. A rejected URL SHALL be treated as absent (rendered as no link, no image, no icon — the component gracefully degrades). Rationale: React 19 emits a dev-mode warning for `javascript:` hrefs but still sets the attribute in prod; reliance on the framework's implicit behavior is not a defensive posture. Specifically (non-exhaustive list — any future URL-from-API field is in scope):
  - `Representative.officialWebsiteUrl` rendered in `components/RepDetail.tsx`.
  - Any future `Representative.photoUrl` / `Member.imageUrl` if rendered as `<img src>`.
  - `Bill.congressGovUrl` is sourced from the committed curated dataset and is already safe by provenance, but SHALL use the same sanitizer for defense-in-depth and to make the rule uniform.
- AC-31.2: The sanitizer SHALL be exported from `src/utils/sanitizeUrl.ts` as `sanitizeUrl(value: string | null | undefined): string | null`. Contract: returns the input verbatim if it parses as an `http(s):` absolute URL; returns `null` otherwise. The helper SHALL have unit tests covering the full enumerated scheme list above, a handful of malformed inputs (empty string, whitespace, null), and the happy path. Rationale for a dedicated helper: one line of defense, easy to audit, easy to test.
- AC-31.3: The `.env` file at the project root SHALL never contain a production Congress.gov API key. Dev keys SHALL be distinct from prod keys. The deployment playbook (`docs/deployment.md §Rotating the Congress.gov API key`) SHALL document the rotation procedure: (a) log in at api.congress.gov with the key-holder identity, (b) regenerate the key, (c) `wrangler secret put CONGRESS_API_KEY --env <env>` for prod/stg, (d) update the dev `.env` with the new dev key (which is a *different* key), (e) verify `curl -i ...` against each deployed Worker returns 200 with the new key in effect, (f) confirm no reference to the old key remains anywhere in the repo or in any CI artifact. Rationale: the 2026-04-17 audit observed a live production-grade key in the dev `.env` — it's in the working tree, it's readable by every local process, and it would appear in crash dumps / backup tools / mis-scoped tmpfs. Rotation is cheap; confusion about which key is which is expensive.
- AC-31.4: The audit report (`docs/decisions/ADR-010-post-audit-hardening.md`) SHALL be appended to, not rewritten, if new findings surface. ADRs are append-only; supersede, don't rewrite. Rationale: the durable value of the audit is the decisions that came out of it — the appended record is what lets a future reviewer understand *why* each AC in this section exists.

### FR-29: Cloudflare Access Gating of Non-Prod Environments (NEW v2.5.0)

**Problem.** The dev, uat, and stg Workers (on `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`) are currently as publicly reachable as prod. They host pre-release code, permissive CORS (`ALLOWED_ORIGINS` wildcarded in dev), and `ALLOW_LOCALHOST=true` in dev/preview. Exposing them publicly gives attackers a soft-target equivalent of prod — same Congress.gov key pool, weaker defensive posture — and leaks the existence of pre-release changes via observable URL probes.

**Solution.** Put Cloudflare Access in front of every non-prod Worker hostname. Prod (`vote.cogs.it.com`) remains publicly reachable — it must, because the widget is a third-party embed on trackukraine.com and random voters cannot be expected to pass an Access login. Non-prod access is granted to named humans via the project's identity provider (initially: Cloudflare one-time-PIN email, to be upgraded to SSO when an IdP exists), and to CI/automation via Cloudflare Access Service Tokens.

**Scope:** Zero Trust "Self-hosted" Access Application covering `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`. The prod hostname `vote.cogs.it.com` SHALL NOT appear in any Access Application.

**Acceptance criteria:**

- AC-29.1: A single Access Application named `voter-info-widget-nonprod` SHALL cover all three non-prod hostnames. Using one Application for all three avoids policy drift across environments.
- AC-29.2: The Access Application's `Session duration` SHALL be `24 hours`. Longer sessions reduce IdP round-trips; shorter sessions reduce stolen-cookie blast radius. 24h is the conventional balance for a non-public-facing control surface used by developers.
- AC-29.3: The Access policy SHALL include at minimum the developer's email (`kody.manharth@gmail.com` initially) via the `Include → Emails` rule. Adding team members happens by email-rule amendment; the list of authorized emails SHALL be captured in `docs/deployment.md §Access policy` so it's reviewable in git.
- AC-29.4: Cloudflare's built-in **One-Time PIN** identity provider SHALL be used initially — email-delivered single-use code, no external IdP dependency. This AC SHALL be revisited when (a) the team exceeds three people, (b) a real IdP (Google Workspace, Okta, GitHub SSO) becomes available, or (c) an incident demonstrates PIN delivery is slow/unreliable.
- AC-29.5: The Access policy SHALL additionally include a **Service Token** authentication method, named `voter-info-widget-ci`, to permit automated smoke/e2e tests from GitHub Actions to hit gated non-prod surfaces. The service token's client ID and secret SHALL be stored as GitHub Actions secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The service token SHALL be limited to the same Access Application (it does not authenticate to prod) and rotated annually or on any suspected compromise (AC-29.11).
- AC-29.6: The prod hostname `vote.cogs.it.com` SHALL NOT be listed under any Access Application. Any proposed Access policy that would cover prod MUST be rejected at review — prod is a public embed surface. This AC exists specifically to lock that intent in the spec and make accidental inclusion a spec-violation.
- AC-29.7: Non-prod Worker deploys via GitHub Actions (`.github/workflows/deploy.yml`) SHALL succeed unchanged — `wrangler deploy --env <nonprod>` authenticates via `CLOUDFLARE_API_TOKEN`, which targets the Workers control plane, not the Worker's HTTP surface. Access gates the HTTP surface only. The deploy step itself does not traverse Access.
- AC-29.8: Any post-deploy smoke/e2e job in CI that hits a non-prod HTTP surface (e.g., `curl https://dev.vote.cogs.it.com/voter-info-widget.iife.js` to confirm the bundle actually shipped) SHALL include the Access service-token headers: `CF-Access-Client-Id: ${{ secrets.CF_ACCESS_CLIENT_ID }}`, `CF-Access-Client-Secret: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}`. A request without these headers SHALL receive an Access login challenge (HTML 302) in CI's headless context, failing the smoke test for a non-security reason. CI steps MUST be shaped to carry the headers or target prod (where no auth is needed).
- AC-29.9: Integration tests and end-to-end tests SHALL support two modes:
  - **Local mode** (default, runs on every PR): Playwright or equivalent points at a `wrangler dev --env preview` instance on `http://localhost:8787`. No Access traversal; this is the inner loop. Fast and cheap; catches regression in Worker logic without round-tripping to CF.
  - **Remote mode** (opt-in via env var `E2E_REMOTE_URL=https://dev.vote.cogs.it.com`, runs post-deploy to non-prod): Playwright or equivalent points at the real gated CF edge. When `E2E_REMOTE_URL` starts with `https://dev.vote.cogs.it.com`, `https://uat.vote.cogs.it.com`, or `https://stg.vote.cogs.it.com`, the test runner SHALL set `extraHTTPHeaders` (Playwright) or equivalent so every request carries the service-token headers.
- AC-29.10: Developers working locally against a gated non-prod hostname SHALL authenticate via the `cloudflared access login <hostname>` CLI, which caches the Access JWT for 24h (matching AC-29.2). `docs/deployment.md §Developer Access login` SHALL document the one-time setup. Raw `curl` / browser dev tools work after this login.
- AC-29.11: Service-token client-secrets SHALL be treated as high-value secrets on par with `CLOUDFLARE_API_TOKEN`:
  - Stored only as GitHub Actions secrets (`gh secret set`) and in Cloudflare's Access Service Token vault.
  - Never committed to the repo, including in test fixtures or error messages.
  - Rotated annually (calendar-based, first of the new year) or within 24 hours of any suspected compromise.
  - The rotation procedure SHALL be documented in `docs/deployment.md §Rotating Access service tokens`.
- AC-29.12: When a non-prod request is rejected by Access (bad/no token, expired session, non-allowlisted email), the Worker SHALL never be invoked. This is Access's default behavior at the edge; this AC pins the intent so any future change that routes unauthenticated traffic past Access is a spec violation. Consequence: the Worker's FR-27 security-header baseline does NOT apply to Access's challenge/denial responses — those are Cloudflare's pages, not ours. This is acceptable because the challenge is served over HTTPS from Cloudflare with their own reasonable defaults.
- AC-29.13: The Access policy SHALL emit audit events to Cloudflare's Zero Trust logs (default behavior). `docs/deployment.md §Access audit review` SHALL specify a lightweight review cadence: weekly scan of Access Events for any unexpected login source, failed service-token auth attempts, or email addresses that shouldn't be on the allow list.
- AC-29.14: Prod remains publicly reachable for embedders. The `dev`/`uat`/`stg` custom domains remain resolvable publicly (DNS is public), but every HTTP request to them goes through Access first. An unauthenticated request to `https://dev.vote.cogs.it.com/voter-info-widget.iife.js` SHALL return Access's challenge page (HTML 302/401), not a 200 with the Worker's response. This is the primary security-behavior assertion for FR-29.

### FR-30: Staging as Regression Gate for Prod Deploys (NEW v2.5.0)

**Stg's sole purpose.** `stg` exists for exactly one reason: to catch regressions before they reach prod. It is NOT a general-purpose rehearsal environment, demo surface, feature-flag playground, reviewer sandbox, or long-lived QA target. It holds no stg-specific data, no stg-specific features, no stg-specific config beyond what differs from prod by infrastructure necessity (bucket name, Worker name). Every run of the stg rehearsal workflow is a prod simulation; any stg state between runs is transient and uninteresting.

**Problem.** Without a formal regression gate, any regression that depends on real prod-shaped data (a new bill format, a renumbered roll call, a member roster change, a Congress.gov response shape shift) can only surface after prod deploy.

**Solution.** Formalize `stg` as a single-purpose regression gate. Its Worker config mirrors prod exactly. On each rehearsal: copy prod's R2 data wholesale to stg, deploy the stg Worker, and run the entire test suite against the deployed stg Worker at its real edge (`https://stg.vote.cogs.it.com`). Any failure — at copy, deploy, or test — blocks prod and requires manual investigation. There is no automatic retry, no "rerun the workflow and hope," because a failure in the prod → stg pipeline is itself a signal that something about prod's known state has diverged from what stg can reproduce, and that divergence is the regression risk the gate exists to catch.

**Scope:** The stg Worker (`voter-info-widget-proxy-stg`), its custom domain (`stg.vote.cogs.it.com`), its R2 bucket (`voter-info-widget-assets-stg`), and a new sync + verify workflow.

**Acceptance criteria:**

- AC-30.1: stg Worker configuration (`[env.stg]` in `wrangler.toml`) SHALL be identical to prod's top-level block, except for the bucket name (`voter-info-widget-assets-stg`) and the Worker name (`voter-info-widget-proxy-stg`). Specifically: same `ALLOWED_ORIGINS`, same absence of `ALLOW_LOCALHOST`, same observability flag, same compatibility date. Any divergence from prod SHALL be called out in-line in `wrangler.toml` with a dated comment explaining why.
- AC-30.2: The stg Worker's Congress.gov API key (`CONGRESS_API_KEY` Worker secret) is set once per env via `wrangler secret put CONGRESS_API_KEY --env stg` and is NOT touched by the sync workflow. Out of scope for this FR — managed manually, same as prod. Stg MAY have a distinct Congress.gov key from prod; both consume from the same 5000-req/hour budget. Rationale: distinct keys can be revoked independently if one leaks.
- AC-30.3: A new npm script `npm run stg:sync-data` SHALL perform a **copy-then-swap** of prod's three R2 objects into stg's R2 bucket:
  1. Fetch each of `voter-info-widget.iife.js`, `ukraineBills.json`, `ukraineVotes.json` from `voter-info-widget-assets` (prod bucket).
  2. Write each to `voter-info-widget-assets-stg/<key>.pending` (a staging location inside stg's bucket).
  3. Verify all three `.pending` objects exist with expected content-type and non-zero size.
  4. For each file, `put` the verified pending bytes at the canonical key (`voter-info-widget.iife.js` etc.), overwriting the previous stg copy.
  5. Delete the `.pending` objects.
  6. **Any failure at any step is a hard stop.** The workflow exits non-zero with a summary identifying which file and which step failed. There is no automatic retry. The operator SHALL manually investigate: is prod R2 reachable? Did permissions change? Did content-types drift? Is the stg bucket full? The regression-gate premise depends on this investigation happening — a silently-retried sync could mask a drift that matters.
- AC-30.4: A new GitHub Actions workflow `.github/workflows/stg-rehearsal.yml` SHALL trigger on `workflow_dispatch` (manual button only — not on push) with these steps, in order:
  1. Checkout the code at the `stg` branch head.
  2. Run `npm run stg:sync-data` — copy prod data to stg per AC-30.3.
  3. Deploy the Worker to stg via `wrangler deploy --env stg`.
  4. Run **the entire test suite against the deployed stg Worker edge** (`E2E_TARGET=https://stg.vote.cogs.it.com`, carrying the service-token headers from `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` per FR-29).
  5. If any step fails, the workflow SHALL fail loud and the run's summary SHALL identify which AC was not satisfied.
- AC-30.5: The "full test suite" referenced in AC-30.4 is **interpretation (A)**: the suite runs against stg's deployed Worker at its real edge (`https://stg.vote.cogs.it.com`), not against a locally-booted `wrangler dev` copy. Today the suite is unit + existing mocked-service integration tests (`npm test`); neither currently traverses a remote edge. Therefore: AC-30.5 is **aspirational** until at least one test file is refactored to run in "remote mode" (per AC-29.9 patterns) against `E2E_TARGET`. Until then, the stg rehearsal workflow SHALL run `npm test` (local mode) after deploy as a placeholder, and the workflow SHALL emit a visible warning in its run summary: "`stg rehearsal ran unit tests only; no remote-mode coverage yet`". This warning SHALL be resolved by the first merged remote-mode test.
- AC-30.6: The stg rehearsal workflow SHALL block any prod deploy that is materially different from the last-green stg rehearsal. Enforcement: the `prod` branch's GitHub environment protection rule SHALL require a reviewer who has seen a green `stg-rehearsal.yml` run from the same commit SHA. This is an honor-system check initially (reviewer eyeballs the SHA match); automated enforcement is deferred until a small GitHub Actions script (or the GitHub API) cross-references the runs.
- AC-30.7: Stg's R2 data MAY lag prod by up to seven days between syncs. Teams or individuals running the rehearsal for a review that depends on fresh data SHALL re-run `stg:sync-data` before rehearsing. The sync is idempotent — running it twice is safe (the second run just re-copies).
- AC-30.8: Stg is gated by Cloudflare Access exactly like `dev` and `uat` per FR-29. The same service token (`voter-info-widget-ci`) authenticates the stg-rehearsal workflow. No separate token.
- AC-30.9: The stg rehearsal workflow SHALL NOT modify prod. Safety is structural — the workflow has no step that writes to prod R2, prod Worker, or prod secrets. Any future change that would introduce such a step MUST first amend this AC with explicit rationale.
- AC-30.10: Stg holds no persistent state worth preserving. Every object in stg KV is a transient copy of prod, replaceable at any time by re-running `stg:sync-data` (v2.5.0 — now KV-prefix-level copy, no R2). There is no stg-specific test data, no stg-specific feature flag state, no stg-specific user data. This is the direct consequence of stg's single-purpose framing: adding stg-only persistent state would turn stg into a thing that needs its own backup story, defeating the point. Any future proposal to add persistent stg-only state MUST first amend this AC and justify why a separate environment is not the right answer.

### FR-31: Name-Based Member Search (NEW v2.5.0 — see ADR-011)

**Problem.** The widget currently requires a voter to know their address to see their reps. A voter who just wants to look up "how did Durbin vote on Ukraine" has no entry point. Address lookup is heavyweight (Census geocode + Congress.gov member fetch) for a question that is fundamentally a name lookup.

**Solution.** Add a name-search entry point alongside address lookup. Voter types a fragment of a first or last name; a live, debounced **tile grid** (mirroring the post-address ResultsPanel layout) shows matching current-Congress members as clickable MemberChips in a single unified pane (no Senators/Representative split for search results). Selecting a chip opens the same RepDetail as the address flow.

**User story (US-7)**: *As a voter, I want to type a representative's name and see their voting record directly, without providing an address.*

**Acceptance criteria:**
- AC-31.1: The widget SHALL render a **NameSearchInput** component adjacent to or inset within the AddressInput. The two inputs SHALL be visually distinct (different labels, different placeholder text) and operate independently. Submitting one SHALL NOT clear or affect the other's state.
- AC-31.2: NameSearchInput SHALL debounce keystrokes by 150ms. After the debounce elapses, if the input value has ≥2 characters, the widget SHALL fetch `/api/name-search?q=<value>`.
- AC-31.3: The widget SHALL render search results as a **single-pane tile grid** in the same pane region where address-lookup results would appear — using the same MemberChip + RepDetail components as the address flow, but with one unified chip row labelled "Matches" (no Senators/Representative split). The widget SHALL NOT show address results and name-search results simultaneously. While the search input has ≥2 characters, search results take the pane. Clearing the input returns to whichever address-lookup result was previously rendered (if any).
- AC-31.4: Each result row SHALL display: member's display name (e.g., "Richard J. Durbin"), chamber ("Senate" or "House"), state (two-letter code), party (single letter). Row ordering SHALL match the Worker's ranking: exact-prefix matches first, then other substring matches, then by chamber (Senate before House), then by state ASC.
- AC-31.5: Clicking a result row SHALL fetch `/api/members/{bioguideId}` and render that member's rep card using the same `RepCard` / `RepDetail` components as the address flow.
- AC-31.6: The search SHALL match against **first names and last names**. Typing `"tammy"` SHALL match both Tammy Baldwin and Tammy Duckworth. Typing `"durb"` SHALL match Durbin.
- AC-31.7: Matching SHALL be case-insensitive and diacritics-insensitive. The Worker normalizes both the query and the indexed `searchKey` by: lowercasing, NFKD-decomposing then stripping combining marks, removing apostrophes and hyphens, collapsing internal whitespace to single spaces.
- AC-31.8: The search endpoint SHALL return at most 10 results per query. If the match set exceeds 10, the top 10 (per AC-31.4 ranking) SHALL be returned and the response SHALL include a boolean `truncated: true` field.
- AC-31.9: If the Worker returns 503 (name-index not ready), the widget SHALL disable the NameSearchInput and render a hint: "Name search temporarily unavailable — try address lookup." The hint SHALL be dismissible but SHALL re-appear on the next keystroke if still 503.
- AC-31.10: If the Worker returns 200 with an empty result list, the widget SHALL render "No members match" below the search input. The widget SHALL NOT render an empty result panel.
- AC-31.11: NameSearchInput SHALL be keyboard-accessible: Tab into input, Enter to submit (equivalent to clicking first result), Arrow Down/Up to navigate result list, Escape to clear the results dropdown without clearing the input.
- AC-31.12: The name-search results panel SHALL have `role="listbox"` and each result row `role="option"` with `aria-selected` reflecting keyboard-highlight state. The input SHALL be `role="combobox"` with `aria-expanded` reflecting results-open state and `aria-controls` pointing at the listbox ID.

### FR-32: KV Storage Model (NEW v2.5.0 — see ADR-011)

**Problem.** The v2.4.0 storage story placed curated data on R2 (blob JSON files) and cache responses in KV. ADR-011 supersedes this with a unified KV store where all curated content lives as atomic, per-member records alongside the existing response cache.

**Solution.** Single KV namespace (`KV_VOTER_INFO`) with four prefixes (`member:v1:*`, `bill:v1:*`, `roll-call:v1:*`, `name-index:v1:*`) plus the ADR-009 response cache (`cache:v1:*`). R2 and its `ASSETS` binding for curated data are removed. The widget bundle continues to be served via Worker Sites static assets (not R2, not KV — same binding, different mechanism).

**Acceptance criteria:**
- AC-32.1: The `member:v1:{bioguideId}` KV record SHALL be a JSON object with the following fields (all required unless marked optional):
  - `bioguideId: string` (e.g., "D000563")
  - `first: string`, `last: string`, `officialName: string`
  - `state: string` (two-letter)
  - `district: number | null` (null for senators)
  - `chamber: "Senate" | "House"`
  - `party: string` (single letter: D, R, I, L, etc.)
  - `photoUrl: string | null`, `website: string | null`
  - `searchKey: string` (normalized per AC-31.7; used by name-index)
  - `ukraineVotes: UkraineVoteEntry[]` — each entry: `{ rollCallId, cast, date, billId, question, result, weight, billTitle }`
  - `ukraineScore: { value, totalWeighted, supportWeighted, obstructionEvents, didNotServeCount }`
  - `sponsored: BillSummary[]`, `cosponsored: BillSummary[]` — each: `{ billId, title, introducedDate, latestAction, latestActionDate }`
  - `generatedAt: string` (ISO-8601)
  - `schemaVersion: number` (currently 1)
- AC-32.2: The `bill:v1:{billId}` KV record SHALL be the canonical bill metadata: `{ billId, type, number, congress, title, shortTitle?, introducedDate, latestAction, latestActionDate, summary?, direction, weight, curatedRollCalls[] }`. Member records MAY denormalize a subset of these fields into their `sponsored[]`, `cosponsored[]`, and `ukraineVotes[].billTitle` fields for read-path simplicity; the `bill:v1:*` record remains authoritative.
- AC-32.3: The `roll-call:v1:{chamber}:{congress}:{session}:{rollCall}` KV record SHALL be the canonical roll-call metadata: `{ rollCallId, chamber, congress, session, rollCall, date, question, result, billId?, totals: { yea, nay, present, notVoting } }`. Member records' `ukraineVotes[]` entries MAY denormalize `date`, `question`, `result` for read-path simplicity.
- AC-32.4: The `name-index:v1:{letter}` KV record SHALL be `{ letter, generatedAt, entries: NameIndexEntry[] }` where each entry is `{ bioguideId, displayName, first, last, state, chamber, party, searchKeys: string[] }`. A member with first name "Richard" and last name "Durbin" SHALL appear in both `name-index:v1:r` and `name-index:v1:d` shards (first-name-initial index + last-name-initial index).
- AC-32.5: The Worker SHALL NOT write to any key under the `member:`, `bill:`, `roll-call:`, or `name-index:` prefixes. Only the curator writes these. Any `env.KV_VOTER_INFO.put(k, ...)` call in Worker source SHALL be accompanied by a runtime assertion `assert(k.startsWith('cache:v1:'))`. Violation SHALL throw (fails loud per "Fail loudly" design principle). `tests/unit/kvPrefixes.test.ts` SHALL assert this invariant by grepping `proxy/*.ts` for `KV_VOTER_INFO.put` calls.
- AC-32.6: The curator SHALL NOT write to any key under the `cache:` prefix. Only the Worker writes the response cache.
- AC-32.7: The `scripts/kv-purge.mjs` tool (ADR-009) SHALL accept a `--prefix` argument and SHALL fail if the prefix argument is not one of: `cache:v1:`, `member:v1:`, `bill:v1:`, `roll-call:v1:`, `name-index:v1:`. This prevents typo-driven cross-prefix wipes. Purging `cache:v1:` SHALL NOT touch `member:v1:` keys and vice versa. A unit test SHALL assert this by running the tool against a fake KV with mixed-prefix keys.
- AC-32.8: All four environments (dev, uat, stg, prod) SHALL have their own `KV_VOTER_INFO` namespace binding (separate namespace IDs). The `wrangler.toml` per-env blocks SHALL carry the per-env namespace ID. Namespace IDs SHALL NOT be committed as secrets — they are identifiers, not credentials.
- AC-32.9: The KV binding in Worker code SHALL be named `KV_VOTER_INFO` (not the v2.4.0 `KV_RESPONSE_CACHE` name from ADR-009). The rename reflects the broader scope. Migration is one-line in `proxy/worker.ts` + one-line per env in `wrangler.toml`.
- AC-32.10: The `ASSETS` binding (Worker Sites static assets) SHALL continue to serve `index.html` and `voter-info-widget.iife.js`. These files SHALL NOT be moved to KV — Worker Sites is purpose-built for static-asset serving and is more efficient than KV for these.
- AC-32.11: R2 bindings (`[[r2_buckets]]`, `R2_ASSETS`) SHALL be removed from `wrangler.toml` across all env blocks. The physical R2 buckets MAY be deleted via the Cloudflare dashboard after 48 hours of stable prod operation on the KV-only architecture, but deletion is a manual, out-of-code operation.
- AC-32.12: The publish-to-kv script SHALL support `--dry-run` which prints the key list and byte counts without executing `KV.put`. `--env <dev|uat|stg|prod>` SHALL select the target namespace.
- AC-32.13: KV eventual consistency: a `put` is visible globally within ~60 seconds. The widget SHALL accept this bound — a user loading the widget within 60s of a curator run may receive a mix of old and new records. This is acceptable for nightly curator cadence. `docs/deployment.md` SHALL document this SLO.
- AC-32.14: The name-search endpoint `/api/name-search` and member endpoint `/api/members/{bioguideId}` SHALL return responses with `Cache-Control: public, max-age=60, s-maxage=300`. This lets a browser reuse a result within a user's session without re-hitting the Worker, and lets CF's edge cache amortize across visitors. On a curator update, the next cache eviction picks up the new record within ~5 minutes at the edge.

### FR-33: Dev Harness Env Picker + Search Status Indicator (NEW v2.5.0)

**Problem.** The non-prod Workers (`dev`, `uat`, `stg`) are gated by Cloudflare Access. Opening `https://dev.vote.cogs.it.com` in a browser triggers an OTP email challenge, which is friction for smoke testing. The dev harness needs a way to exercise each env's Worker without the embedder-facing OTP flow. Separately, the name-search input needs a visible status indicator so developers can distinguish "still loading" from "succeeded, no matches" from "server error" without opening DevTools.

**Solution.**
1. The dev harness (`src/main.tsx`, not the embeddable build) SHALL render an **EnvPicker** component that selects which env's Worker the widget talks to. Selection maps to one of five API bases: `local`, `dev`, `uat`, `stg`, `prod`. Non-prod selections route through Vite dev-server proxies (`/env-<name>/*`) that attach CF Access service-token headers server-side, so the browser never hits the Access challenge.
2. A URL parameter `?env=<name>` locks the picker to that env (useful for bookmarking "see my widget against stg data"). When locked, the picker control is disabled and a 🔒 glyph is shown.
3. NameSearchInput SHALL render a **status indicator** glyph inline with the input, reflecting: idle (no glyph), loading (animated circle), error/unavailable (!), no-matches (?). Each glyph has a `title` and `aria-label` tooltip. A compact text line under the input surfaces the status in prose for screen-reader users and for the zero-match case. Error details SHALL be shown in non-prod envs only; prod SHALL display a generic "Search error" without upstream detail.

**User story (US-8)**: *As a developer testing the widget, I want to switch between env Workers with one click and see search progress/errors without opening DevTools.*

**Acceptance criteria:**
- AC-33.1: EnvPicker SHALL render in a fixed position (top-right of the viewport) in the dev harness only. The embedded IIFE build (`src/embed.tsx`) SHALL NOT include the EnvPicker — production embedders get a single apiBase from the web component `api-base` attribute.
- AC-33.2: Selecting an env SHALL remount the widget (via a React `key` change on the selected env name) so that in-flight state from the previous env does not leak into the next.
- AC-33.3: The env→apiBase map SHALL be: `local → ''` (same-origin), `dev → '/env-dev'`, `uat → '/env-uat'`, `stg → '/env-stg'`, `prod → '/env-prod'`. The `/env-<name>` prefixes are handled by Vite dev-server proxies configured in `vite.config.ts`.
- AC-33.4: For `dev`, `uat`, and `stg`, the Vite proxy SHALL attach `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers to every forwarded request. Values come from `.env` (never committed). Prod SHALL NOT attach these headers.
- AC-33.5: The Vite proxy SHALL set `Origin: https://trackukraine.com` on forwarded requests so the Worker's origin allowlist check passes. (The browser's real Origin is `http://localhost:5173`, which is permitted only on dev but rejected on uat/stg/prod — the proxy normalizes so the same harness can exercise every env.)
- AC-33.6: On page load, the harness SHALL read the `env` URL parameter (if present and one of the valid names) and lock the picker to that env. If absent or invalid, the picker defaults to `dev` and remains interactive.
- AC-33.7: NameSearchInput SHALL render a status glyph at the right edge of the input, inline with it (not full-width). Glyph states:
  - **idle**: no glyph
  - **loading**: animated circular indicator (CSS-only, no images) with title="Searching…"
  - **error / unavailable**: red badge with `!` and title="Search failed" / "Search unavailable"
  - **no-matches (success but zero results)**: yellow badge with `?` and title="No matches found"
- AC-33.8: A compact text status line SHALL appear below the input (NOT in the results pane, NOT full-page-width) for the no-matches case — "No matches for \"<query>\"" — and, when `showErrorDetails=true`, for the error/unavailable case. Prod passes `showErrorDetails=false` so users see only the generic glyph.
- AC-33.9: The `showErrorDetails` prop on VoterInfoWidget defaults to `false`. The dev harness sets it `env !== 'prod'`. The IIFE embed build always gets `false`.
- AC-33.10: The status indicator SHALL be accessible: `role="status"`, glyph carries `aria-label` matching the tooltip, and the text line (when rendered) is also `role="status"` so screen readers announce it on state change.

### FR-26: Cloudflare Deployment Story (NEW v2.4.0)

**Problem.** The widget has no defined production deployment. Spec and code exist but "where does this actually live" is undefined. Since the widget must be embeddable on trackukraine.com (Fourthwall) and the stated goal is to host infrastructure on Cloudflare for security, the deployment architecture needs to be explicit.

**Solution (revised 2026-04-18 — ADR-011 migration).** Two Cloudflare services, both deployed from this repo via `wrangler` invoked from GitHub Actions:

1. **Cloudflare Worker (Worker Sites)** serving the widget bundle + curated JSON as static assets from the bundled `./dist` directory via the `[assets] binding = "ASSETS"` in `wrangler.toml`. No separate R2 bucket for static content. (Historical: v2.4.x used R2; see FR-32 / ADR-011 for the migration.)
2. **Cloudflare Worker KV (`KV_VOTER_INFO`)** holding curator records (member profiles, bill records, roll calls, name index) + an optional response cache per ADR-009. Populated by `scripts/publish-to-kv.ts`.

Both surfaces ship together with `wrangler deploy`. `CONGRESS_API_KEY` is a per-env Worker secret.

See `docs/deployment.md` for the concrete setup playbook.

**Acceptance criteria:**
- AC-26.1 (revised 2026-04-18): The repo SHALL contain a `wrangler.toml` at the project root defining the Worker, the `[assets]` static-file binding (`./dist`), the `KV_VOTER_INFO` KV namespace binding, and the `RATE_LIMITER` rate-limiting binding. Historical: prior R2 bindings removed in ADR-011 migration.
- AC-26.2: The Worker source SHALL be TypeScript (`proxy/worker.ts`) consistent with the rest of the codebase.
- AC-26.3: The repo SHALL contain `.github/workflows/pr.yml` running lint, typecheck, and tests on every PR to `main`. No deployment.
- AC-26.4 (revised 2026-04-18): The repo SHALL contain `.github/workflows/deploy.yml` running on rung-branch push: build widget bundle, compute SRI sidecar, stage curated JSON into `./dist`, publish curator records to KV via `scripts/publish-to-kv.ts`, deploy Worker via `wrangler deploy` (which ships `./dist` as static assets with the Worker). Historical: v2.4.x had an R2 upload step; removed in ADR-011.
- AC-26.5: The repo SHALL contain `.github/workflows/refresh-data.yml` running weekly: run the curator, check for diffs, open a PR with the updated JSON files and a summary of added/changed votes.
- AC-26.6: Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CONGRESS_API_KEY`) SHALL be documented in `docs/deployment.md` and set via `gh secret set` or the GitHub Actions UI.
- AC-26.7: The embed snippet documented in `README.md` SHALL reference the final Cloudflare URLs (placeholders acceptable until the actual domains are provisioned).
- AC-26.8: The Vite library build (`--mode lib`) SHALL define `process.env.NODE_ENV` as `"production"` at build time. Library mode in Vite defaults to *not* substituting this value (a library shouldn't assume the consumer's environment), but our IIFE is embedded directly in browsers — no consumer build step — so the Worker runtime has no `process` global and React crashes at module-load with `ReferenceError: process is not defined`. The `define` block in `vite.config.ts` prevents this regression. Side-benefit: the build shrinks ~40% because React's dev-only invariant/warning paths get dead-code-eliminated.
- AC-26.9 (NEW v2.5.1): The deploy workflow SHALL compute a Subresource Integrity (SRI) hash of the built `voter-info-widget.iife.js` (SHA-384, base64) and write it to `dist/voter-info-widget.iife.js.sri` alongside the bundle. The `.sri` sidecar SHALL ship to the same asset surface as the bundle itself (currently Worker Sites — `./dist` directory bound via `[assets] binding = "ASSETS"` in `wrangler.toml` — so integrators can fetch the current hash at `https://vote.cogs.it.com/voter-info-widget.iife.js.sri`). Rationale: publishing the hash out-of-band is the only way a third-party embedder (trackukraine.com) can pin a known-good build. Without SRI, a compromised Cloudflare account means the attacker's JavaScript runs on trackukraine.com with full origin privileges.
- AC-26.10 (NEW v2.5.1): The integrator-facing embed snippet documented in `README.md`, `proxy/example-embed.html`, and any future integration guide SHALL use the SRI-pinned form: `<script src="https://vote.cogs.it.com/voter-info-widget.iife.js" integrity="sha384-<base64>" crossorigin="anonymous" async></script>`. The `<base64>` placeholder SHALL be replaced with the release's actual hash at embed time. If the integrator cannot pin to a specific release, the docs SHALL clearly state the tradeoff — that an unpinned embed inherits the full attack surface of the widget's deploy pipeline. For SRI to work, the bundle response SHALL carry `Access-Control-Allow-Origin: *` per AC-27.1b.
- AC-26.11 (NEW v2.5.1, revised twice: 2026-04-18a for Worker Sites migration, 2026-04-18b for ADR-011 curated-data placement): The deployed Worker Sites static-asset surface (binding `ASSETS`, backed by `./dist`) SHALL contain, at minimum: `voter-info-widget.iife.js` and `voter-info-widget.iife.js.sri`. The deploy workflow SHALL ship both on every deploy; a post-deploy smoke test SHALL `curl` each path on the deployed hostname and assert a 200 response. Rationale: missing datasets were found in prod during the 2026-04-17 audit. Making asset presence + verification part of the deploy contract prevents silent loss of functionality. **Curated data placement after ADR-011:** `ukraineBills.json` is imported at build time into the IIFE bundle (not a separately-deployed asset — runtime reads it from the bundled constant via `src/services/ukraineFilter.ts`); `ukraineVotes.json` was removed entirely in favor of per-member data in KV (via `scripts/publish-to-kv.ts`). Neither is a separately-fetched static asset, so neither is part of this AC's smoke list. **Historical note:** the original v2.5.1 wording listed four R2 keys; both revisions above chase the code's actual state.
- AC-26.12 (NEW v2.5.1, revised 2026-04-18): The static-asset surface SHALL be served by the Worker deployment (Worker Sites' `ASSETS` binding), NOT by a separate Pages binding, Transform Rule, or direct R2 public URL. Verification: `curl -i https://vote.cogs.it.com/voter-info-widget.iife.js` SHALL return a `Content-Type` of `application/javascript`, and the response headers SHALL pass through `applySecurityHeaders` (STS, nosniff, CORP cross-origin, etc. all present). Rationale: the 2026-04-17 audit observed prod serving the bundle with headers that did not match Worker output, indicating a separate serving path. Spec-as-Truth: the Worker's deploy is the single authority for what `/voter-info-widget.iife.js` returns. Any Cloudflare-dashboard binding that would shadow this path is a spec violation.

### FR-21: Obstruction Events (NEW v2.1.3)
The system SHALL identify **obstruction events** — actions whose effect is to block, delay, or kill a pro-Ukraine bill *without* a direct Nay on passage — and surface them in the UI.

An action is an obstruction event when **any** of the following hold:

- It is a **procedural vote** (kind ∈ {`cloture`, `motion-to-proceed`, `motion-to-recommit`, `waive-budget`, `motion-to-table`, `motion-to-reconsider`, `other-procedural`}) AND the computed valence is `voted-anti`. In plain terms: the member used a procedural maneuver to oppose a Ukraine bill.
- It is a **non-procedural** vote on an **anti-Ukraine** bill, and the member voted **Aye** (actively supporting an anti-Ukraine amendment/measure).
- It is a **sponsorship** (sponsored *or* cosponsored) of an **anti-Ukraine** bill.

**Design rules:**
- AC-21.1: Obstruction detection is a pure function over already-classified data (bill.direction, vote.kind, memberVote, valence). No new curator-time classification.
- AC-21.2: A direct Nay on a pro-UA passage vote is **not** obstruction — that is an open, on-the-record opposition vote and is already captured by `voted-anti` valence at full weight. Obstruction is strictly about procedural or indirect opposition.
- AC-21.3: Each obstruction row in the UI SHALL carry a visible **"OBSTRUCTION"** tag so the voter can see the pattern when they expand the procedural cluster. Clusters remain collapsed by default; the score-badge callout count reflects all obstruction events (including those inside still-collapsed clusters) and voters can expand clusters manually to see the detail. Rationale: auto-expansion pushed long tables of procedural detail at the voter before they chose to engage with it; keeping the default collapsed respects the compact-overview intent of the clustering feature.
- AC-21.4: The score badge SHALL include a subtle context note when the member has **≥ 2** obstruction events: e.g., "*Score reflects N obstruction events (procedural anti-UA votes or anti-UA sponsorships).*" This adds transparency — the single score already incorporates these actions at their assigned weights; the note just explains why.
- AC-21.5: Obstruction does **not** change the score. The score already reflects these actions via their valence and weight. Obstruction detection is UI-only.

### FR-9: Web Component Embedding
The system SHALL be buildable as a self-contained Web Component using Shadow DOM for style isolation, distributable as a single IIFE JavaScript bundle.

### FR-10: CORS Proxy Integration
The system SHALL route all external API requests through a configurable proxy base URL to handle CORS restrictions. The proxy base URL SHALL be configurable via the `api-base` attribute on the custom element.

---

## 4. Non-Functional Requirements

### NFR-1: Performance
- Initial address lookup and representative display SHALL complete within 5 seconds on a broadband connection
- Vote history loading SHALL show a loading indicator and render progressively as data arrives

### NFR-2: Accessibility
- The widget SHALL meet WCAG 2.1 Level AA
- All interactive elements SHALL be keyboard navigable
- Vote tables SHALL use proper ARIA roles and labels

### NFR-3: Statelessness
- The widget SHALL not persist any user data (no cookies, localStorage, or server-side storage)
- All state is in-memory and resets on page reload

### NFR-4: Bundle Size
- The production IIFE bundle SHOULD be under **200KB gzipped**
- **Measured baseline (2026-04-16)**: 185.72 KB gzipped (React 19 + ReactDOM + widget code + inlined CSS). This is acceptable for an embeddable widget; React runtime dominates.
- If the bundle exceeds 200KB, first check: (1) if React is duplicated, (2) if DOMParser polyfills leaked in, (3) if dev assertions weren't dropped by minifier.

### NFR-5: Rate Limit Awareness
- The system SHALL limit concurrent API requests to avoid exceeding the Congress.gov rate limit of 5,000 requests/hour
- Concurrent requests to Congress.gov SHALL be limited to 5 in-flight at any time

### NFR-6: Error Resilience
- Individual API failures SHALL NOT crash the widget
- Partial data (e.g., member info loads but votes fail) SHALL be displayed with error indicators on the failed sections

---

## 5. External Interface Specifications

### 5.1 U.S. Census Bureau Geocoder
- **Endpoint**: `GET /geocoder/geographies/onelineaddress`
- **Auth**: None required (free government API)
- **Input**: `address` (string), `benchmark`, `vintage`, `format`
- **Output**: Address match with geographies including `119th Congressional Districts` (state FIPS + district number)
- **Reference**: docs/api-contracts.md §1

### 5.2 Congress.gov API (v3)
- **Base URL**: `https://api.congress.gov`
- **Auth**: API key via `?api_key=` query parameter or `X-Api-Key` header
- **Rate Limit**: 5,000 requests/hour
- **Pagination**: `limit` (max 250), `offset`
- **Reference**: docs/api-contracts.md §2

### 5.3 Senate.gov Vote XML
- **Base URL**: `https://www.senate.gov/legislative/LIS/`
- **Auth**: None required
- **Format**: XML, parsed client-side with DOMParser
- **Reference**: docs/api-contracts.md §3

---

## 6. Data Dictionary

### Representative
| Field | Type | Description |
|-------|------|-------------|
| bioguideId | string | Congress.gov biographical directory ID |
| name | string | Full display name |
| party | string | Party affiliation (e.g., "Democratic", "Republican") |
| state | string | Two-letter state code |
| district | number \| null | Congressional district number (null for senators) |
| chamber | "house" \| "senate" | Legislative chamber |
| photoUrl | string \| null | URL to official photograph |
| isNonVoting | boolean | True for non-voting delegates (DC, territories) |

### VoteRecord
| Field | Type | Description |
|-------|------|-------------|
| date | string | ISO date of the vote |
| billNumber | string \| null | Associated bill number (e.g., "H.R. 1234") |
| billTitle | string | Short title or description |
| question | string | The question being voted on |
| memberVote | "Aye" \| "Nay" \| "Present" \| "Not Voting" | This member's vote |
| result | string | Overall result (e.g., "Passed", "Failed") |
| partyMajorityVote | string | How this member's party majority voted |

### Bill
| Field | Type | Description |
|-------|------|-------------|
| number | string | Bill designation (e.g., "S. 456") |
| title | string | Official or short title |
| dateIntroduced | string | ISO date introduced |
| latestAction | string | Most recent legislative action |
| congressGovUrl | string | URL to full bill text on congress.gov |
| relationship | "sponsored" \| "cosponsored" | Member's relationship to the bill |

### PartyAlignment
| Field | Type | Description |
|-------|------|-------------|
| score | number | 0-100 percentage alignment with party |
| totalPartyLineVotes | number | Number of party-line votes in the sample |
| votesWithParty | number | Times member voted with party majority |

---

## 7. Constraints

- **C-1**: U.S. Census Bureau Geocoder has no CORS support and no authentication. It is free but has no SLA — responses can be slow (1-3s).
- **C-2**: Congress.gov API does not provide Senate vote data. Senate votes must be sourced from Senate.gov XML.
- **C-3**: Census geocoder, Congress.gov API, and Senate.gov do not support CORS for browser-origin requests. A server-side proxy is required.
- **C-4**: Congress.gov House roll call vote data covers 117th Congress (2021) onward.
- **C-5**: Congress.gov API key must not be embedded in the production client-side bundle. Census geocoder requires no API key.
