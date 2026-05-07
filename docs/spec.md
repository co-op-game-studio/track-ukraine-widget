# Software Requirements Specification (SRS)
# Voter Information Widget — Ukraine Focus

**Version**: 2.7.0
**Date**: 2026-05-02
**Status**: Active

**v2.7.0 changelog (2026-05-02).** **V4 — admin-driven backend.** Introduces a **Cloudflare D1 database** as the editable source of truth for curated content (FR-49), an **admin API gated entirely at the edge by Cloudflare Access** (FR-50) — the Worker does no auth itself; it just extracts the authenticated user's email from the `Cf-Access-Authenticated-User-Email` header for audit-log attribution and fails loudly if the header is missing on a gated path. Plus: a **D1→KV publish pipeline** that preserves the FR-32 read-path invariants (FR-51), an **admin front-end MVP** for editing bills/votes/comments/social posts/quotes at `/admin` (FR-52), **embed surface updates** for in-line researcher commentary and a Record/Statements/Quotes tab restructure (FR-53), **per-vote researcher-tunable weights** that replace the static `ukraineBills.json` weight column (FR-54), **newer-rep handling** via a Bayesian shrink toward the party prior plus an "Insufficient record" badge (FR-55), a **deep-statistics endpoint** (FR-56), a **deferred Discord SSO migration** (FR-57), and an **audit endpoint** (FR-58). `src/data/ukraineBills.json` is frozen as a one-time bootstrap seed. Admin surfaces live under `/admin/*` (SPA) and `/api/admin/*` (writes). ADR-017 records the D1-as-source / KV-as-snapshot split + the edge-auth model; ADR-018 records the score-shrink choice.

**v2.6.0 changelog (2026-04-19).** Introduces a unified **tiered cache architecture** (FR-40), an **R2 static archive tier** for session-frozen roll-call data (FR-41), **first-class observability** via request tracing + Workers Analytics Engine + structured logs (FR-36, FR-38, FR-39), a **canonical error envelope** (FR-37), and a **proxy module decomposition** that replaces the 1500-line `proxy/lib.ts` god module with composed OOP interfaces (FR-42). ADR-011's "no R2" stance is narrowed, not reversed: R2 is reintroduced **only** as a byte-level archive for static upstream responses (closed-session roll-call XML + rosters), never as a curator-record store. The scheduled "curator" script is retired — prewarming becomes an ordinary client of the cache, populating tiers via the same code path real request traffic uses (ADR-015).

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
- AC-7.8 (NEW 2026-04-19 UAT): Every chip SHALL render the member's full state name on its own line (class `.viw-chip-state`) between the chamber/subtitle line and the party tag. The full-name mapping comes from `stateCodeToName()`; if the code is not mapped (unknown two-letter value), the chip SHALL render the uppercase two-letter code verbatim rather than printing "undefined" or omitting the line. Rationale: search-result chips and overview chips were state-ambiguous for senators, who otherwise showed only "U.S. SENATOR" / party.

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
The system SHALL obtain lists of sponsored and co-sponsored legislation for each member. **Data source (v2.5.2):** the widget SHALL read these lists from the `member:v1:{bioguideId}` KV record (per FR-32 AC-32.1) via `GET /api/members/{bioguideId}`, which carries up to 250 `sponsored` and 250 `cosponsored` raw entries. The Worker populates KV via read-through from `api.congress.gov /v3/member/{id}/sponsored-legislation` and `/cosponsored-legislation` (250-per-call, no pagination; see AC-32.18). The widget SHALL NOT call the paginated `/api/congress/v3/member/{id}/sponsored-legislation` or `/cosponsored-legislation` routes directly — the cache contract for those routes (AC-25.3) is preserved for admin / debugging use only. Rationale: the v2.5.1 widget paged through five 100-entry pages (10 Congress round-trips per rep click); the v2.5.2 KV-profile path drops that to one KV read per rep and is the sole widget-facing code path for legislation.

### FR-8: Party Alignment Calculation
The system SHALL calculate a party alignment score for each member **over the curated Ukraine roll-call votes only**. The algorithm is defined in the Design Document (design.md §4.5).

### FR-11: Ukraine Bill Filter (NEW v2)
The system SHALL filter both sponsored/cosponsored legislation lists and the voting record to entries whose `{congress, type, number}` matches an entry in the curated Ukraine bill set (`src/data/ukraineBills.json`). Non-matching entries SHALL NOT be shown.

### FR-12: Curated Bill Set as Source of Truth for Votes (NEW v2, REVISED v2.5.2)
The system SHALL build the voting record by iterating the curated bill set's pre-resolved roll-call numbers (not by fetching the most recent N votes). For each curated vote, the system SHALL look up the member's individual cast and produce a `MemberVoteRow { bill, vote, memberVote }`.

**Data source (v2.5.2):** the widget SHALL resolve each curated roll-call's cast via the KV-backed roster route `GET /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall}` (FR-32 AC-32.15). For House rosters the record contains a `{ [bioguideId]: cast }` map keyed by bioguide; for Senate rosters it contains an array of `{ lastName, state, cast }` entries (Senate XML carries no bioguide ID — see design.md §4.3). If the member is missing from the roster's cast map, the row SHALL show "Did Not Vote" (or "Did Not Serve" — the two are distinguished by cross-checking the member's `state-members:v1:{state}` record AC-32.16 to see whether the member was in that Congress).

**Prior behavior (v2.5.1, retired):** the widget fetched each roll-call's roster live from `/api/congress/v3/house-vote/{c}/{s}/{rc}/members` or `/api/senate/legislative/LIS/.../xml` at render time. This produced 18-27 upstream calls per rep click against Congress.gov / Senate.gov at cold-edge-cache (observed 429 pressure on 2026-04-18 go-live). These live routes remain cached at the proxy per AC-25.2 (immutable) for admin / debugging use, but the widget SHALL NOT call them directly.

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
- AC-25.3 (REVISED v2.5.2): Responses from semi-mutable routes (`/api/congress/v3/member/*/sponsored-legislation`, `/api/congress/v3/member/*/cosponsored-legislation`) SHALL return `Cache-Control: public, s-maxage=604800, max-age=86400, stale-while-revalidate=3600`. Rationale (v2.5.2): co-sponsorship changes on the scale of weeks-to-years; the prior 5-minute browser TTL forced same-session revisits back to the Congress key and produced observable 429 pressure on 2026-04-18. 7-day edge + 24-hour browser matches the upstream mutation cadence. `stale-while-revalidate=3600` lets the edge serve a stored copy immediately while refetching upstream in the background within the hour, so freshness lag is bounded at ~1 hour without ever blocking a visitor on an upstream round-trip. Note: these routes are **not called by the current widget** — `useSponsoredBills` reads legislation from `/api/members/{bioguideId}` (FR-32 AC-32.1) instead — but the cache contract stays in force for any future direct call (e.g., debugging, an admin tool) and for the Worker's own read-through path when it (re)builds a member profile (FR-32 AC-32.13).
- AC-25.4 (REVISED v2.5.2): Responses from the Census geocoder SHALL return `Cache-Control: public, s-maxage=86400, max-age=3600` (address-to-district mappings change slowly with redistricting). Responses from other `/api/congress/*` routes not covered by AC-25.2 or AC-25.3 (e.g., `/api/congress/v3/member/{id}` detail, `/api/congress/v3/member/congress/*` list) SHALL return `Cache-Control: public, s-maxage=86400, max-age=86400, stale-while-revalidate=3600`. Rationale (v2.5.2 bump from `s-maxage=3600, max-age=3600`): the curator refresh cadence is weekly (`.github/workflows/refresh-data.yml`), so the upstream truth for member detail rotates at most once per week. A 24-hour edge + 24-hour browser TTL with 1-hour SWR keeps freshness ≤24 h in the worst case while cutting the per-visitor upstream request count to near-zero on warm cache. The prior 1-hour values were authored when the curator ran more frequently and are now over-aggressive.
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
- AC-27.21 (v2.5.1, REVISED v2.5.2, RE-TIGHTENED v2.5.3): The Worker SHALL enforce a **per-IP in-Worker rate limit** on `/api/*` requests via the Cloudflare Workers Rate Limiting API binding (`RATE_LIMITER`). The binding SHALL be declared in `wrangler.toml` with a key derived from `cf.connecting_ip` (falling back to the `CF-Connecting-IP` header) for every `/api/*` request, evaluated **after** origin validation (so rejected-origin requests do not consume the budget). On limit exceeded, the Worker SHALL return `429 Too Many Requests` with body `{"error":"rate_limited","retry_after":<seconds>}`, `Retry-After: <seconds>` header, and `Cache-Control: no-store`. Per-env limits:
  - **prod**: 60 requests / 60 s / IP.
  - **stg**: 60 requests / 60 s / IP (stg mirrors prod per FR-30).
  - **uat**: 120 requests / 60 s / IP. (UAT reviewers need a looser budget to exercise the widget repeatedly during review sessions.)
  - **dev**, **preview**: 600 requests / 60 s / IP. (Local and dev harnesses iterate fast.)

  Rationale: layered with the zone-level rate limit in AC-28.3 — defense-in-depth. The zone rule is a blunt volumetric filter running before the Worker; the in-Worker rule is fine-grained, environment-aware, and survives zone-config drift. See ADR-010 for the binding vs. token-bucket-via-KV tradeoff.

  **Per-visit fan-out worst case (v2.5.3, after ADR-012 cutover):**
  - Address flow (3 reps resolved): 1 census + 1 `/api/state-members/{state}` + 3 `/api/members/{id}` = **5 requests**.
  - Exploring one House rep (N curated House votes): 1 `/api/members/{id}` (warm from chip enrichment) + N `/api/roll-call-rosters/house/{c}/{s}/{rc}`. At the current 18 House Ukraine votes that is **~19 requests**, all KV reads.
  - Exploring one Senate rep (M curated Senate votes): same shape with M ≈ 26. **~27 requests.**
  - Exploring all three reps on a single cold-KV visit: **~49 requests in the first few seconds**, of which every request is a single edge-local KV read (typical p99 ~50 ms). Over the 60 s window, the limit accommodates one visitor opening all three reps plus re-navigation and still leaves headroom.

  The prior 300/60s was an interim ceiling set during the 2026-04-18 go-live when the widget still fan-out to live upstreams (~70 requests per cold visit). With ADR-012 landed — upstream roster/state fetches replaced with KV-backed routes — the legitimate budget drops by ~40%, so the rate limit can re-tighten without trading off visitor UX. Anything beyond 60 req/min/IP in prod is now either hostile traffic or a stuck client repeatedly re-mounting the widget.

  **Forward path:** AC-32.17 (curator-baked member profiles with pre-joined vote casts) would further collapse the per-visit fan-out to ~5 requests regardless of curated-vote count. Once that lands the prod limit can re-tighten again (target: ~20 req/min/IP). Not scheduled.
- AC-27.22 (v2.5.1): The Worker SHALL NOT consume the AC-27.21 rate-limit budget for requests rejected at a cheaper earlier stage (missing Origin, non-allowlisted Origin, unknown `/api/<foo>` route, disallowed method). Rationale: rate limiting gates expensive upstream fetches; spending the budget on responses the Worker can reject in a few microseconds would let an attacker exhaust legitimate users' budget by flooding with cheap-to-reject requests.

### FR-28: Zone-Level Security Posture (NEW v2.5.0)

**Problem.** The Worker's defensive posture is now solid at the code layer, but several classes of threat are best handled at the Cloudflare zone layer — ahead of the Worker — where they cost zero code, produce no false positives against our known-good traffic, and cannot be accidentally regressed by a Worker deploy. The full Worker hardening pass (FR-27) assumes these zone-level controls are also in place; without them, attacks that should never reach the Worker's Origin-allowlist code (volumetric abuse, stale TLS, bot scraping, known-bad-actor geos) still consume Worker invocations and Congress.gov quota.

**Solution.** Commit to a specified zone-level posture documented in `docs/deployment.md §Zone-level hardening` and captured as ACs here. These are **configuration, not code** — the ACs describe the intended setting; the verification is a manual dashboard check or a `gh`/`wrangler`/CF API assertion in CI if we ever add one. ADR-007 records the choice rationale.

**Scope:** All ACs apply to the `cogs.it.com` Cloudflare zone and to every subdomain that serves the Worker (`vote.cogs.it.com`, `dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`). Where an AC needs per-env differentiation, the AC calls it out explicitly.

**Acceptance criteria:**

- AC-28.1: The zone SHALL have the **Cloudflare Managed Ruleset** (OWASP Core Rule Set) enabled in **Block** mode on `vote.cogs.it.com` and all env subdomains. Sensitivity: "Medium". Exceptions: none initially — monitor WAF events for 7 days post-enable; add scoped exclusions only for confirmed false positives against `/api/*` with an inline comment citing the event ID.
- AC-28.2: The zone SHALL have **Bot Fight Mode** enabled (or Super Bot Fight Mode if the plan supports it). Challenges for verified-bot traffic: allowed (Googlebot, Bingbot, legitimate crawlers). Definitely-automated traffic: challenged. This is a blunt tool; revisit if legitimate automation (e.g., uptime monitors) triggers it — whitelist by IP or User-Agent rather than disabling.
- AC-28.3 (REVISED v2.5.2, RE-TIGHTENED v2.5.3): The zone SHALL have a **Rate Limiting Rule** on `/api/*` configured to **120 requests per 60 seconds per client IP in prod**, **120 rpm in stg**, **240 rpm in uat**, **2400 rpm in dev**. Match expression: `(starts_with(http.request.uri.path, "/api/") and http.host eq "<env-hostname>")` — one rule per env hostname to permit per-env thresholds. Action: `Block` with a 10-minute timeout. Response: `429 Too Many Requests` (CF default block page; our Worker's JSON envelope doesn't apply at this layer).

  Rationale (v2.5.3): the zone rule is the blunt volumetric outer gate; the Worker rule is the fine-grained, per-env, quota-aware inner gate. The zone limit MUST stay at least **2× AC-27.21** so that the Worker's limiter is the binding constraint and the zone rule catches only flagrant abuse (e.g., diverse-IP volumetric attacks where individual IPs stay under the Worker rule). With AC-27.21 prod at 60/60s post-ADR-012, the matching zone is 2× = 120/60s.

  **Layered with AC-27.21** (Worker per-IP limit of 60/60s in prod): an attacker from one IP hits the Worker limit first (which still counts rejected requests against CF's bot signals); an attacker coming from diverse IPs that each stay under the Worker limit hits the zone limit once aggregate volume from that /24 or ASN exceeds 120/min/IP.

  **Forward path:** AC-32.17 (curator-baked member profiles with pre-joined vote casts) would drop the per-visit worst case to ~5 requests. If that ever lands, AC-28.3 SHALL re-tighten to ~40/60s prod in lockstep with AC-27.21.
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
- AC-30.3 (SUPERSEDED 2026-04-19 by FR-44 AC-44.6 — kept as historical marker): A new npm script `npm run stg:sync-data` SHALL perform a **copy-then-swap** of prod's three R2 objects into stg's R2 bucket:
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
- AC-30.5 (SUPERSEDED 2026-04-19 by FR-44 AC-44.5 — kept as historical marker): The "full test suite" referenced in AC-30.4 is **interpretation (A)**: the suite runs against stg's deployed Worker at its real edge (`https://stg.vote.cogs.it.com`), not against a locally-booted `wrangler dev` copy. Today the suite is unit + existing mocked-service integration tests (`npm test`); neither currently traverses a remote edge. Therefore: AC-30.5 is **aspirational** until at least one test file is refactored to run in "remote mode" (per AC-29.9 patterns) against `E2E_TARGET`. Until then, the stg rehearsal workflow SHALL run `npm test` (local mode) after deploy as a placeholder, and the workflow SHALL emit a visible warning in its run summary: "`stg rehearsal ran unit tests only; no remote-mode coverage yet`". This warning SHALL be resolved by the first merged remote-mode test.
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
- AC-31.4 (REVISED v2.5.2): Each result row SHALL display: member's display name (e.g., "Richard J. Durbin"), chamber subtitle, state (two-letter code), party (single letter). Row ordering SHALL match the Worker's ranking: exact-prefix matches first, then other substring matches, then by chamber (Senate before House), then by state ASC. **Chamber subtitle rules (v2.5.2):**
  - Senators: `"U.S. Senator"`.
  - Non-voting delegates (AC-1.4 territories): `"Delegate (non-voting)"`.
  - House representatives with a known district: `"District {N}"` (e.g., "District 7").
  - House representatives with `district === null` in the source record: `"U.S. Representative"` (no trailing district number). Rationale: before AC-32.4 v2.5.2 carried `district` in the name-index shard, every name-search House result had null district and rendered as "District null". The null-guard fallback is retained post-AC-32.4-revision to cover any stale shard entry or any Representative constructed without a resolved district, and to provide a well-formed subtitle for edge cases.

  The same subtitle rules apply to `RepDetail`'s `chamberLabel` header (the subtitle just below the member's name in the detail pane). In `RepDetail` the House-with-district form SHALL be rendered as `"U.S. Representative · District {N}"` (note the spaced middle dot separator); the null form SHALL be `"U.S. Representative"` with no separator or trailing district.
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
- AC-32.1 (REVISED v2.5.2): The `member:v1:{bioguideId}` KV record SHALL be a JSON object with the following fields (all required unless marked optional):
  - `bioguideId: string` (e.g., "D000563")
  - `first: string`, `last: string`, `officialName: string`
  - `state: string` (two-letter when emitted by the widget-facing route; the stored record MAY carry the full Congress.gov state name and the `/api/members/{id}` route SHALL normalize it to two-letter on egress)
  - `district: number | null` (null for senators and non-voting delegates)
  - `chamber: "Senate" | "House"`
  - `party: string` (single letter: D, R, I, L, etc.)
  - `photoUrl: string | null`, `website: string | null`
  - `searchKey: string` (normalized per AC-31.7; used by name-index)
  - `sponsored: CongressLegislationRawEntry[]` — up to 250 entries, shape as returned by `api.congress.gov /v3/member/{id}/sponsored-legislation` (includes `congress`, `number`, `type`, `title`, `introducedDate`, `latestAction`, `policyArea`, etc.); the widget filters to the curated Ukraine set and computes valence at render time. See api-contracts.md §3 for the upstream shape.
  - `cosponsored: CongressLegislationRawEntry[]` — same shape and cap as `sponsored`.
  - `generatedAt: string` (ISO-8601 timestamp of when the Worker's read-through built the profile; NOT a curator run timestamp)
  - `schemaVersion: number` (currently 1)

  **Deferred (v2.5.0 aspiration, not yet implemented):** pre-joined `ukraineVotes: UkraineVoteEntry[]` and pre-computed `ukraineScore` fields were specified in the v2.5.0 draft of this AC but never landed. The v2.5.1/v2.5.2 implementation computes Ukraine votes and score **client-side** from `sponsored`/`cosponsored` (bills) and from separate roll-call roster lookups (votes, per FR-32 AC-32.15 in flight). Re-introducing pre-joined votes/score is tracked as AC-32.17 below; it requires the curator to become the sole writer of `member:v1:*` (currently the Worker writes on read-through — see AC-32.18).
- AC-32.2: The `bill:v1:{billId}` KV record SHALL be the canonical bill metadata: `{ billId, type, number, congress, title, shortTitle?, introducedDate, latestAction, latestActionDate, summary?, direction, weight, curatedRollCalls[] }`. Member records MAY denormalize a subset of these fields into their `sponsored[]`, `cosponsored[]`, and `ukraineVotes[].billTitle` fields for read-path simplicity; the `bill:v1:*` record remains authoritative.
- AC-32.3: The `roll-call:v1:{chamber}:{congress}:{session}:{rollCall}` KV record SHALL be the canonical roll-call metadata: `{ rollCallId, chamber, congress, session, rollCall, date, question, result, billId?, totals: { yea, nay, present, notVoting } }`. Member records' `ukraineVotes[]` entries MAY denormalize `date`, `question`, `result` for read-path simplicity.
- AC-32.4 (REVISED v2.5.2): The `name-index:v1:{letter}` KV record SHALL be `{ letter, generatedAt, entries: NameIndexEntry[] }` where each entry is `{ bioguideId, displayName, first, last, state, chamber, district: number | null, party, photoUrl: string | null, searchKeys: string[] }`. The `district` field SHALL be the House district number for House members and SHALL be `null` for Senators and non-voting delegates (Congress.gov omits `district` on senators and emits the territorial district for delegates — the curator SHALL map these to `null`). The `photoUrl` field SHALL be the curator-observed `depiction.imageUrl` or `null`. A member with first name "Richard" and last name "Durbin" SHALL appear in both `name-index:v1:r` and `name-index:v1:d` shards (first-name-initial index + last-name-initial index). Rationale for v2.5.2: before this revision the shard omitted `district`, and the widget's `NameSearchResultsPanel` rendered "District null" on every House search result. Carrying the field in the shard avoids a follow-up fetch to resolve district after a name-search click.
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
- AC-32.15 (NEW v2.5.2): The `roll-call-roster:v1:{chamber}:{congress}:{session}:{rollCall}` KV record SHALL be the canonical per-roll-call vote roster. Record shape:
  - For House (`chamber = "house"`): `{ rollCallId: string, chamber: "house", congress: number, session: number, rollCall: number, casts: { [bioguideId: string]: "Yea" | "Nay" | "Present" | "Not Voting" }, generatedAt: string, schemaVersion: 1 }`.
  - For Senate (`chamber = "senate"`): `{ rollCallId: string, chamber: "senate", congress: number, session: number, rollCall: number, casts: Array<{ lastName: string, state: string, cast: "Yea" | "Nay" | "Present" | "Not Voting", firstName?: string, party?: string }>, generatedAt: string, schemaVersion: 1 }`. Senate records are keyed by `lastName + state` because the Senate XML feed does not carry bioguide IDs (per design.md §4.3).
  - Only the curator writes these. The Worker exposes them via `GET /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall}` and SHALL return the record verbatim or 404. Cache-Control: `public, max-age=86400, s-maxage=31536000, immutable` — roll-call rosters are historical and immutable.
  - Rationale: the v2.5.1 widget fan-out resolved per-rep voting records by calling `/api/congress/v3/house-vote/{...}/members` or `/api/senate/.../xml` once per curated vote per rep click (observed 19-27 upstream calls per cold rep visit on 2026-04-18). Moving rosters into KV reduces the per-visit fan-out to N KV reads, eliminating the Congress.gov per-visitor load and the corresponding rate-limit pressure (see AC-27.21 forward-path note).
- AC-32.16 (NEW v2.5.2): The `state-members:v1:{stateCode}` KV record SHALL be the pre-computed per-state roster of current-Congress members. Record shape: `{ stateCode: string, senators: MemberSummary[], house: MemberSummary[], generatedAt: string, schemaVersion: 1 }` where each `MemberSummary` is `{ bioguideId, first, last, officialName, state, district: number | null, chamber, party, photoUrl, website }`. `house[]` SHALL be sorted by district ascending. Senators SHALL be sorted by seniority (class) ascending, then last name. The Worker exposes these via `GET /api/state-members/{stateCode}` and SHALL return the record verbatim or 404. Cache-Control: `public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600` — matches the weekly curator cadence. Rationale: replaces the v2.5.1 widget calls `fetchMembersByState` / `fetchMembersByStateDistrict` which hit `/api/congress/v3/member/congress/{congress}/{state}[/{district}]` directly against Congress.gov via the proxy.
- AC-32.17 (DEFERRED — not yet scheduled): The `member:v1:{bioguideId}` record SHALL be authored by the curator (not the Worker) and SHALL carry pre-joined `ukraineVotes[]` and pre-computed `ukraineScore` fields as drafted in the original v2.5.0 AC-32.1. Until this AC lands, Ukraine-vote and score computation remain client-side using AC-32.1 (v2.5.2) `sponsored`/`cosponsored` + AC-32.15 roll-call rosters.
- AC-32.18 (NEW v2.5.2 — documents existing behavior): The Worker SHALL write `member:v1:{bioguideId}` records on read-through miss, populated from `api.congress.gov /v3/member/{id}` + `/sponsored-legislation` + `/cosponsored-legislation`. This SHALL use `env.KV_VOTER_INFO.put(..., { expirationTtl: 2592000 })` (30-day TTL). This narrowly exempts the `member:v1:` prefix from AC-32.5's curator-only write rule. The Worker's read-through write is the **v2.5.1/v2.5.2 interim** until AC-32.17 lands; at that point the Worker's `put` on `member:v1:*` SHALL be removed and AC-32.5 tightened. The corresponding `kvPrefixes.test.ts` assertion SHALL be relaxed to permit either `cache:v1:` or `member:v1:` writes until AC-32.17 lands.
- AC-32.19 (NEW v2.5.2 — JSON parse resilience): The Worker's read-through that populates `member:v1:{bioguideId}` SHALL isolate JSON parse failures on the optional `sponsored-legislation` and `cosponsored-legislation` upstream responses. A malformed or truncated body from either optional upstream SHALL result in an empty array for that field and SHALL NOT cause the profile read-through to fail. A malformed body on the required `/v3/member/{id}` detail upstream SHALL cause the Worker to return `502` with body `{"error":"upstream_error","detail":"upstream_body_invalid"}` rather than propagating the raw `SyntaxError` position. Rationale: on 2026-04-18 a mid-response upstream truncation surfaced as `"Expected ':' after property name in JSON at position 15492"` and blocked the member profile from ever populating KV; isolating the optional leg turns a full 502 into a partial-success profile with empty `sponsored`/`cosponsored`.

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

### FR-34: Mobile Layout Adaptations (NEW v2.5.2)

**Problem.** The v2.2.0 chip grid (AC-7.5) is the only spec-level mobile treatment. The v2.5.x detail pane brought new dense surfaces — the address-lookup form, the Ukraine-votes table, the sponsored/cosponsored legislation table, and the member detail frame — whose desktop layouts overflow or wrap awkwardly on a 375px-wide viewport. On 2026-04-18 several observed mobile renders had visible overflow (right edge of tables clipped past the detail frame, "LOOK UP" button on its own orphan row, etc.). This FR captures the mobile layout contract for the high-density surfaces.

**Solution.** Add explicit ACs for each surface that must adapt below a 640px viewport threshold. The existing 720px chip-grid breakpoint (AC-7.5) is preserved; the 640px threshold here is for *within-detail* layouts that appear only after the user has drilled into a representative. Mobile iOS must not auto-zoom text inputs (the 16px font-size trick).

**Acceptance Criteria:**

- AC-34.1: **Address form.** On viewports ≤ 520px the AddressInput text field and the "Look Up" submit button SHALL stack vertically: the input takes the full row, the button takes the full row directly below the input with no top border (so the two controls visually share a single border outline). On viewports > 520px the input and button SHALL render side-by-side on a single row with the button's left border flush against the input's right edge (current desktop behavior). The text input SHALL have `font-size: 16px` at all viewport sizes to prevent iOS Safari's auto-zoom-on-focus behavior.
- AC-34.2: **Address form label hint.** The "(street + state or ZIP required)" hint text next to "ENTER YOUR HOME ADDRESS" SHALL render as a block element below the label on viewports ≤ 520px (so the two lines wrap predictably). On > 520px viewports the hint SHALL render inline with 0.5rem left margin.
- AC-34.3: **Vote list stacking.** On viewports ≤ 640px, the Ukraine-votes table (`.viw-votelist`) SHALL render each row as a vertically-stacked card instead of a table row. Specifically: `<thead>` SHALL be `display: none`; each `<tr>` SHALL be `display: block` with a top border separating it from the previous row; each `<td>` SHALL be `display: block` with a small muted label derived from a `data-label` attribute (e.g., "DATE", "POSITION", "OUTCOME") rendered above the cell content via a `::before` pseudo-element. The leading cell (bill number + title, class `.viw-votelist-bill`) SHALL NOT render its label — the bill number already reads as the row heading. On > 640px viewports the table SHALL render as a conventional table (current behavior).
- AC-34.4: **Bill list stacking.** On viewports ≤ 640px, the sponsored/cosponsored legislation table (`.viw-billlist`) SHALL apply the same stacked-card treatment as AC-34.3, using `data-label` attributes "BILL", "TITLE", "INTRODUCED", "LATEST ACTION". The leading cell (bill number) SHALL NOT render its label. The summary row (colspan=4 expanded CRS summary) SHALL render unchanged — its single wide cell already reads correctly stacked.
- AC-34.5: **No nested card borders in stacked mode.** When the vote-list or bill-list is rendered inside the `.viw-detail` card (always, in the current UX), the stacked rows SHALL NOT carry their own full `border: 2px solid` — only a top border separating rows — to avoid a card-in-card visual. The outer `.viw-detail` card supplies the frame; row cards would nest into it.
- AC-34.6: **Horizontal scroll fallback.** The wrapping `<div class="viw-votelist-scroll">` SHALL have `overflow-x: visible` on viewports ≤ 640px (so the stacked layout doesn't produce a scroll gutter). On > 640px it SHALL have `overflow-x: auto` (current behavior, a safety net if the table's natural width exceeds its container).

### FR-35: Cache Warming Procedure (NEW v2.5.2, REVISED v2.6.0)

**Problem.** The widget's per-visit cold-cache cost is dominated by (a) the Worker's read-through population of `member:v1:{bioguideId}` on first lookup of a given member (one Congress.gov detail call + two legislation calls) and (b) the widget's per-roll-call roster fetches (FR-12, FR-32 AC-32.15). The first visitor to open a given member or a given roll-call pays this cost; subsequent visitors hit cache and pay ~nothing. On a fresh deploy or fresh KV namespace every visitor is "first" until the cache fills organically, which produced visible latency and 429 pressure during the 2026-04-18 go-live. A deliberate pre-warming step after each deploy moves this cost off the visitor path.

**Solution (v2.6.0 — unified with FR-40 / FR-42).** Prewarming SHALL be an ordinary client of the tiered cache (FR-40), not a privileged side channel. `scripts/warm.ts` issues `GET` requests to the target Worker's public API for every prewarmable key. Each request flows through the standard `serveCached` pipeline: edge miss → KV miss → R2 miss (if eligible) → upstream → `storeFromUpstream` writes to all tiers the policy allows. No transformation logic lives in the warmer. No bulk `wrangler kv put` writes. No separate curator. The warmer is exactly the same code path a real visitor's browser exercises, at a controlled rate. This eliminates the curator/warmer drift risk that existed in v2.5.2 (where `publish-to-kv.ts` could encode records differently than the Worker's read-through path).

**Acceptance Criteria:**

- AC-35.1: `scripts/warm.ts` SHALL accept these flags:
  - `--host <https://env.vote.cogs.it.com>` — required, the target Worker origin.
  - `--concurrency <N>` — default 4; bounded pool size for each phase.
  - `--delay-ms <N>` — default 250; per-worker inter-request pause (so effective steady-state RPS stays ≤ `concurrency / (delay-ms/1000)` ≈ 16 rps at defaults, comfortably under AC-27.21's 300/60s prod ceiling).
  - `--access-id <id>` / `--access-secret <secret>` — or read from `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` env vars. Required for dev/uat/stg (AC-28.8 Access-gated); omitted for prod.
  - `--skip-members` / `--skip-votes` — run individual phases in isolation (useful if one phase already succeeded in a prior run).
  - `--dry-run` — enumerate target URLs without issuing warming fetches.
- AC-35.2: Warming phase 1 (members) SHALL iterate every current-Congress bioguide (collected via paginated `GET /api/congress/v3/member?currentMember=true&limit=250`) and issue one `GET /api/members/{bioguideId}` per member. A 502 response SHALL be logged as a failure but SHALL NOT abort the phase — the warmer continues to the next bioguide.
- AC-35.3: Warming phase 2 (votes) SHALL read `src/data/ukraineBills.json`, extract every `votes[].{chamber, congress, session, rollCall}` tuple, and issue one GET per curated vote against the roster route:
  - House votes → `GET /api/roll-call-rosters/house/{congress}/{session}/{rollCall}` (v2.5.2, AC-32.15).
  - Senate votes → `GET /api/roll-call-rosters/senate/{congress}/{session}/{rollCall}` (v2.5.2, AC-32.15).
  During the v2.5.2 transition window (until AC-32.15 is live everywhere) the warmer MAY target the legacy routes `GET /api/congress/v3/house-vote/{...}/members` and `GET /api/senate/legislative/LIS/.../xml` to warm the edge cache for those routes in parallel. Once AC-32.15 lands in every env, the legacy phase SHALL be removed from the warmer.
- AC-35.4: The warmer SHALL report a summary on completion: `{ phase, ok_count, failure_count, sample_failures[] }`. A non-zero failure count SHALL cause the script to exit 1 (so CI integrations surface it).
- AC-35.5: `docs/deployment.md` SHALL document the warming procedure: which env to run it against, expected runtime at default flags (~3-5 minutes for ~540 members + ~44 roll-calls), and the invocation one-liners for each env. The weekly `.github/workflows/refresh-data.yml` MAY invoke the warmer as a post-curator step in a future iteration; initial v2.5.2 rollout keeps it manual.
- AC-35.6: The warmer SHALL NOT be invoked from Worker code or from the widget runtime — it is an ops-side Node.js script. It SHALL NOT be bundled into `dist/`. Its acceptance tests (if any) SHALL live under `tests/ops/` — a new sub-tree if none exists — to keep it out of the widget's test budget.

### FR-36: Request Tracing (NEW v2.6.0)

**Problem.** When a user reports "the widget is slow" or "it errored out," we have no way to correlate their browser-side action with the Worker's logs or upstream latency. Workers Logs is on, but each line is an island — we cannot reconstruct "this user's click triggered these seven upstream fetches." Debugging production issues devolves into pattern-matching timestamps.

**Solution.** A **per-request trace ID** that originates at the Worker's edge (or is echoed from a client-supplied header), is propagated through every upstream fetch the Worker makes on that request's behalf, and is stamped into every structured log line and analytics data point emitted during the request's lifetime. Scope is per-request (one inbound HTTP request = one trace), not per-user-action — simpler, sufficient for debugging, no widget-side state to thread.

**Acceptance Criteria:**

- AC-36.1: On every inbound request, the Worker SHALL generate a trace ID of form `tr_` + 16 hex bytes derived from `crypto.randomUUID()` (stripped of dashes, truncated to 16 chars). If the inbound request carries an `X-Trace-Id` header matching `/^tr_[0-9a-f]{16}$/`, the Worker SHALL echo that value instead of generating a new one. Any header that fails the pattern SHALL be ignored and replaced (no client-controlled trace IDs with arbitrary shape).
- AC-36.2: Every response emitted by the Worker — success, error, redirect, 304 — SHALL carry `X-Trace-Id: <id>`. This header SHALL be listed in `Access-Control-Expose-Headers` on `/api/*` responses so browser JS can read it.
- AC-36.3: Every `fetch()` call the Worker makes to an upstream (Congress.gov, Senate.gov, Census geocoder) SHALL forward the trace ID as `X-Trace-Id`. Upstream may ignore the header; that is fine — having it in the outbound traffic capture is the purpose.
- AC-36.4: Every structured log line (FR-39) and every Workers Analytics Engine data point (FR-38) emitted during a request SHALL include the trace ID as a dedicated field (`traceId` in logs; `indexes: [traceId]` in analytics).
- AC-36.5: When the widget surfaces an error state (address lookup failed, rep fetch failed, name search failed, roster fetch failed), the error UI SHALL display the trace ID inline in the form `Reference: tr_abc123def4567890` so a user reporting a bug can quote it. This SHALL be readable but visually subordinate (muted color, monospace font, selectable).
- AC-36.6: Trace IDs SHALL NOT be generated by the widget. The widget reads the trace ID off the first `X-Trace-Id` response header it receives for a given user action and carries it forward to any error UI for that action. If no fetch has completed yet when the error surfaces (e.g., a network failure), the widget MAY display `Reference: (unavailable)`.
- AC-36.7: Trace IDs SHALL NOT be used as cache keys, user identifiers, session tokens, or any form of state. They are observability-only.

### FR-37: Canonical Error Envelope (NEW v2.6.0)

**Problem.** The Worker today emits several error shapes: `{ error: 'upstream_error', status, upstream }` for upstream failures, raw `Response` bodies with short text strings for rate-limit / origin-deny / 404, and free-form `new Response('...')` for edge cases. The widget cannot branch reliably on error cause — it reads `response.ok` and falls back to a generic "something went wrong." There is no retryability signal, no stable error-code enumeration, no trace-ID surface.

**Solution.** A single canonical error envelope for every non-2xx response emitted by the Worker (except 304). Closed enumeration of error codes. The widget parses the envelope and branches UI accordingly. No legacy dual-shape window — this is a fall-over deployment and there are no external consumers of the Worker's error bodies beyond our own widget.

**Acceptance Criteria:**

- AC-37.1: Every non-2xx, non-304 response from the Worker that carries a body SHALL use the envelope:
  ```json
  {
    "error": {
      "code": "<enum>",
      "message": "<human-readable operator message>",
      "userMessage": "<human-readable end-user message>",
      "upstream": "<'congress' | 'senate' | 'census' | null>",
      "retryable": <boolean>,
      "traceId": "tr_<16hex>"
    }
  }
  ```
  Content-Type `application/json; charset=utf-8`. The envelope SHALL be the top-level shape — no wrapping, no metadata siblings.
- AC-37.2: `error.code` SHALL be one of this closed enumeration: `bad_request`, `origin_not_allowed`, `rate_limited`, `not_found`, `upstream_4xx`, `upstream_5xx`, `upstream_timeout`, `upstream_parse_error`, `internal_error`. Adding a new code is a spec change.
- AC-37.3: `error.retryable` SHALL be:
  - `true` for `rate_limited`, `upstream_5xx`, `upstream_timeout`, `internal_error`
  - `false` for `bad_request`, `origin_not_allowed`, `not_found`, `upstream_4xx`, `upstream_parse_error`
- AC-37.4: `error.userMessage` SHALL be suitable for direct display to an end user. Operator-internal details (upstream hostname, stack traces, internal paths) SHALL NOT appear in `userMessage`; they belong in `error.message` and structured logs.
- AC-37.5: The widget SHALL parse the envelope when `response.ok === false`. On retryable errors the widget SHALL render a "Try again" button that re-issues the original request. On non-retryable errors the widget SHALL render the `userMessage` with no retry affordance.
- AC-37.6: The prior shape `{ error: 'upstream_error', status, upstream }` used by `normalizeUpstreamErrorBody` (ADR-006) SHALL be removed. No compatibility alias. Every existing caller in the Worker SHALL migrate to the new envelope in the same commit that lands FR-37's implementation.
- AC-37.7: 429 Too Many Requests responses SHALL use `code: 'rate_limited'` and SHALL additionally carry a `Retry-After` header in seconds, derived from the rate-limit binding's window if available or a conservative default of 60 otherwise.
- AC-37.8: The widget SHALL NOT log `error.message` to the user-facing UI — only `error.userMessage` + trace ID. `error.message` is operator context, carried through to error-reporting sinks (Analytics Engine, `console.error`) but never shown.

### FR-38: Workers Analytics Engine Instrumentation (NEW v2.6.0)

**Problem.** Workers Logs gives us line-by-line visibility but is not aggregable. We cannot answer "what is our 429 rate this week by upstream?" or "which bioguide profile builds are the slowest?" without pulling the entire log stream and computing outside CF. Workers Analytics Engine exposes write-time-series storage with per-dataset SQL queries directly in the CF dashboard, at no external infrastructure cost.

**Solution.** A per-env Workers Analytics Engine binding. Every `/api/*` request writes exactly one data point at response time via `ctx.waitUntil`, carrying the fields that answer our known operator questions. Curator-like prewarming flows (FR-35 revised) also emit data points under a `curator` route class so cold-warm costs are visible in the same dataset.

**Acceptance Criteria:**

- AC-38.1: `wrangler.toml` SHALL declare an `[[analytics_engine_datasets]]` binding named `ANALYTICS` per env, with dataset name `voter_info_widget_${ENV_NAME}` (e.g., `voter_info_widget_prod`, `voter_info_widget_uat`).
- AC-38.2: Every `/api/*` request — hit, miss, error, OPTIONS preflight — SHALL emit exactly one `env.ANALYTICS.writeDataPoint(...)` call at response time with these fields:
  - `blobs: [routeClass, upstreamName, errorCode, env, cacheTier]`
    - `routeClass` ∈ {`census`, `senate-xml`, `congress-v3`, `members`, `name-search`, `roll-call-roster`, `state-members`, `bills`, `other`}
    - `upstreamName` ∈ {`senate`, `congress`, `census`, `none`}
    - `errorCode` = one of FR-37 AC-37.2 values or `ok`
    - `env` = `prod | stg | uat | dev | preview`
    - `cacheTier` ∈ {`edge`, `kv`, `r2`, `upstream`, `n/a`} — which tier served the response (or `upstream` on miss-all, `n/a` for non-cacheable routes)
  - `doubles: [totalLatencyMs, upstreamLatencyMs, statusCode, rateLimitRemaining]`
    - `totalLatencyMs` — wall-clock from request arrival to response flush
    - `upstreamLatencyMs` — ms spent in upstream `fetch()` calls; `0` when served from any cache tier
    - `statusCode` — HTTP status emitted to the client
    - `rateLimitRemaining` — integer tokens remaining in the binding window if known, else `-1`
  - `indexes: [traceId]` — single index, enables point queries for a specific request
- AC-38.3: The `writeDataPoint` call SHALL be wrapped in `ctx.waitUntil(...)` so it never extends perceived client latency.
- AC-38.4: Widget-side surfaces (the browser embed) SHALL NOT write to Analytics Engine directly. All instrumentation originates in the Worker.
- AC-38.5: The prewarming script (FR-35 revised) SHALL emit one analytics data point per warming request via `ctx.waitUntil` in the Worker it calls — i.e., the warmer itself does nothing special, it hits the Worker like any other client, and the Worker's standard AE write fires for each call. `blobs.env` = the target env; `blobs.routeClass` = whatever route the warmer hit. This gives one unified time series for real and synthetic traffic.
- AC-38.6: On a Worker exception caught by the top-level error handler, the AE write SHALL still occur with `errorCode: 'internal_error'`, `statusCode: 500`, and the other fields filled with best-effort values. A telemetry write SHALL NEVER throw (wrap in try/catch; a failed telemetry write logs via FR-39 but does not crash the request).

### FR-39: Structured Worker Logs (NEW v2.6.0)

**Problem.** Existing log statements in the Worker are free-form strings. They are readable to a human tailing `wrangler tail` but not filterable, not aggregatable, and not correlated to trace IDs.

**Solution.** A single `logEvent(ctx, { event, level, ...fields })` helper that emits one JSON line per call via `console.log(JSON.stringify(...))`. Workers Logs auto-indexes top-level JSON fields, so `event:rate_limit_denied AND env:prod` is a one-line filter in the CF dashboard. Levels follow the standard enumeration; success paths emit nothing by default.

**Acceptance Criteria:**

- AC-39.1: A helper `logEvent(ctx: LogContext, payload: { event: string; level: 'debug' | 'info' | 'warn' | 'error'; [k: string]: unknown })` SHALL live in `proxy/observability/log.ts` and emit exactly one `console.log(JSON.stringify({ ts: <iso>, env: ctx.env, traceId: ctx.traceId, ...payload }))` call.
- AC-39.2: Every error path in the Worker (rate-limit denial, origin denial, upstream failure, parse failure, KV read failure, R2 read failure, exception caught at top level) SHALL call `logEvent` at `warn` or `error` with (a) the trace ID, (b) the FR-37 error `code`, (c) enough structured context to reproduce the failure (e.g., `upstream: 'senate'`, `kvKey: 'roll-call-roster:v1:...'`, `status: 429`).
- AC-39.3: Success paths SHALL emit no logs at `info`+. A feature-flag-style `DEBUG_LOG=true` env var MAY be introduced later to enable per-request success logs during incident investigation; it is out of scope for v2.6.0.
- AC-39.4: `logEvent` SHALL NOT throw. Serialization errors (circular references) SHALL be caught and replaced with a `{ event: 'log_serialization_error', original_event: <string> }` fallback line.
- AC-39.5: Log payloads SHALL NOT contain secrets. The `CONGRESS_API_KEY` redactor currently in `redactSecrets` (proxy/lib.ts) SHALL be applied to every stringified field in `logEvent` as defense-in-depth.

### FR-40: Tiered Cache Architecture (NEW v2.6.0)

**Problem.** Today's proxy has three overlapping caches: the Cloudflare edge cache (per-POP), a per-member KV write-through in `handleMemberProfile`, and a bag of `[[curator-written]]` KV prefixes populated by `scripts/publish-to-kv.ts`. Each lives in a different code path. The widget's fan-out depends on which cache happens to be warm. Cold-KV cold-edge requests fall all the way through to upstream and hit rate limits. There is no single answer to "where does this response come from?"

**Solution.** A unified **tiered cache layer** with a single `CacheTier<V>` interface implemented by three concrete tiers (`EdgeTier`, `KvTier`, `R2Tier`), composed by a `TieredCache<V>` class that reads tier-by-tier and **promotes on hit** (write-back) + **stores on miss** (write-through). Every route that wants caching goes through `serveCached(request, key, cache, fetcher, policy, ctx, env)`. The prewarming flow is an ordinary client of this layer — no second code path.

This supersedes ADR-009's standalone "KV response cache" plan: the KV cache still exists but is now the tier-2 implementation of a three-tier system, not a standalone module. R2 is introduced as tier 3, **only** for data that qualifies as byte-level-static (FR-41).

**Cache tiers, fastest to slowest:**

| Tier | Backing | Scope | Typical hit latency | Writable? |
|------|---------|-------|---------------------|-----------|
| 0 (edge) | `caches.default` | per-POP | ~5 ms | yes |
| 1 (kv) | `KV_VOTER_INFO` | global, eventually consistent | ~30 ms | yes |
| 2 (r2) | `R2_STATIC` (new) | global, durable | ~50 ms | yes, but gated by FR-41 eligibility |
| 3 (upstream) | Senate.gov / Congress.gov / Census | live | 400–1200 ms | N/A (read-through only) |

**Acceptance Criteria:**

- AC-40.1: A TypeScript interface `CacheTier<V>` SHALL be defined in `proxy/cache/tier.ts`:
  ```typescript
  export interface CacheTier<V> {
    readonly name: 'edge' | 'kv' | 'r2';
    readonly canWrite: boolean;
    get(key: CacheKey): Promise<CacheEntry<V> | null>;
    put(key: CacheKey, entry: CacheEntry<V>, policy: WritePolicy): Promise<void>;
  }
  ```
  Each concrete tier SHALL live in its own file: `proxy/cache/edge-tier.ts`, `proxy/cache/kv-tier.ts`, `proxy/cache/r2-tier.ts`. No tier may reach into another tier's internals.
- AC-40.2: `CacheKey` SHALL be a structured domain object (not a string):
  ```typescript
  export interface CacheKey {
    readonly kind: 'senate-xml' | 'house-roster' | 'house-vote-detail' | 'bill-actions' | 'member-detail' | 'member-sponsored' | 'member-cosponsored' | 'census-geocoder' | 'bill-record' | 'roll-call-roster' | 'state-members' | 'member-profile' | 'name-index-shard';
    readonly params: Record<string, string | number>;
  }
  ```
  Each tier SHALL define its own `serialize(key): string` for its native storage format (URL for edge, dotted-prefix string for KV, path-style for R2). Serializers SHALL be pure, total functions with unit tests.
- AC-40.3: `CacheEntry<V>` SHALL carry:
  ```typescript
  export interface CacheEntry<V> {
    readonly value: V;
    readonly contentType: string;
    readonly fetchedAt: number;           // ms epoch
    readonly sourceUpstream: 'senate' | 'congress' | 'census' | 'synthetic';
    readonly sessionStatus?: 'frozen' | 'live';
  }
  ```
- AC-40.4: `WritePolicy` SHALL carry:
  ```typescript
  export interface WritePolicy {
    readonly maxAge: number;       // seconds
    readonly immutable: boolean;
    readonly eligibleTiers: readonly ('edge' | 'kv' | 'r2')[];
  }
  ```
  `eligibleTiers` names which tiers a given route allows writes to. The pipeline SHALL NOT write to a tier whose name is absent from this list, regardless of that tier's own `put()` behavior. This is the policy-layer gate; each tier's own gating (e.g., R2 session-status check) is an additional defense.
- AC-40.5: A `TieredCache<V>` class SHALL compose an ordered array of tiers and expose:
  ```typescript
  get(key): Promise<{ entry, servedBy } | null>
  promote(key, entry, servedBy, ctx, policy): void    // writes to faster tiers via ctx.waitUntil
  storeFromUpstream(key, entry, ctx, policy): void    // writes to every eligible writable tier via ctx.waitUntil
  ```
  `promote` and `storeFromUpstream` SHALL NOT block the response. Both SHALL be idempotent (re-running with the same inputs is safe).
- AC-40.6: A `serveCached<V>(request, key, cache, fetcher, policy, ctx, env)` pipeline function SHALL be the single code path any cacheable route uses. On hit: promote + return with `X-Cache-Tier: <tier>` and `X-Cache: HIT`. On miss: fetch upstream, store, return with `X-Cache-Tier: upstream` and `X-Cache: MISS`. On fetcher error: emit FR-37 envelope + FR-39 log + FR-38 data point. No route SHALL call upstream directly — every upstream call is mediated by a registered `UpstreamFetcher`.
- AC-40.7: `UpstreamFetcher<V>` SHALL be an interface with `canHandle(key) → boolean` and `fetch(key, env) → Promise<CacheEntry<V>>`. Each upstream gets its own implementation (`SenateXmlFetcher`, `HouseRosterFetcher`, `HouseVoteDetailFetcher`, `BillActionsFetcher`, `MemberDetailFetcher`, `CensusGeocoderFetcher`). Each lives in its own file under `proxy/upstreams/`.
- AC-40.8: **Route-to-cache-config mapping.** Each existing route SHALL declare a static `CacheConfig` entry specifying its `WritePolicy` + its `UpstreamFetcher`. This mapping lives in `proxy/routes/cache-config.ts` and is the single source of truth for "which tiers does this route use and with what TTL." No cache decision lives in per-route code.
- AC-40.9: **Header contract.** Every response served via `serveCached` SHALL carry `X-Cache-Tier: <edge|kv|r2|upstream>` and `X-Cache: HIT|MISS`. On promote-from-slower-tier the header reflects the **tier that served the hit**, not the destination of the write-back. `Access-Control-Expose-Headers` SHALL list both.
- AC-40.10: **Testability.** Each tier SHALL have a `FakeTier<V>` in `tests/fakes/` that is a `Map<string, CacheEntry<V>>`. `TieredCache` unit tests SHALL run with three fake tiers and verify tier-order-reads, promote-on-hit, store-on-miss, policy filtering, and waitUntil dispatch. Integration tests SHALL run with the real runtime bindings.
- AC-40.11: **Edge-tier key uniqueness.** The `keyToUrl` mapping supplied to `EdgeTier` SHALL be injective over `CacheKey` — i.e., for any two `CacheKey`s that are not `cacheKeyEquals`, the URLs SHALL differ. In particular, when a route's `CacheKey` carries query-derived params (e.g. `census-geocoder` with `params.qs`), those params SHALL be reflected in the edge URL, not just the request pathname. Two `CacheKey`s with the same `kind` and the same upstream pathname but different `params` SHALL NOT collide on a single edge cache entry. *Rationale: a 2026-05-03 prod incident produced edge cache poisoning on `/api/census/geocoder/...` because the wired `keyToUrl` ignored `CacheKey.params` and used only the inbound pathname; one address's empty-match response was then served for every subsequent address at that POP.*

### FR-41: R2 Static Archive Tier (NEW v2.6.0)

**Problem.** Closed-session roll-call XML (Senate) and roll-call rosters (House) never change after the Congress adjourns. Historically we have re-fetched these from senate.gov / api.congress.gov every time the edge + KV caches cycled, contributing to 429 pressure observed on 2026-04-18. A durable, globally-replicated byte-level archive costs fractions of a cent per month and eliminates upstream contact for this data entirely.

**Solution.** A single Cloudflare R2 bucket per env (`voter-info-widget-archive-${env}`), wired as tier 3 of the tiered cache (FR-40). **Only byte-level-static upstream responses** are eligible. The R2 tier's `put()` internally gates on `policy.immutable === true` AND `entry.sessionStatus === 'frozen'` — any other entry is silently skipped at the R2 boundary. Served bytes are verbatim with original content-type (XML stays XML, JSON stays JSON); the cache is content-agnostic.

**ADR-014 reconciliation.** ADR-011 ("KV is the sole datastore") is narrowed, not reversed. KV remains the sole store for *curator-shaped domain records* (`member:v1:*`, `bill:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`, `name-index:v1:*`, etc.). R2 stores **raw upstream bytes** of static responses, which are a different abstraction layer. The two do not overlap in ownership: a `roll-call-roster:v1:*` KV record is the domain projection; the R2 archive of `vote_117_2_00078.xml` is the byte-level source those projections were built from.

**Data-type eligibility matrix (exhaustive):**

| Data type | Tier layout | Static? | Rationale |
|-----------|-------------|---------|-----------|
| Senate roll-call XML (`vote_{c}_{s}_{rc}.xml`) | edge → kv → **r2** → upstream | **Yes, after session close** | Historical XML is frozen; observed zero mutations post-session in project history. R2 is the right durable floor. |
| House roll-call members (`/v3/house-vote/{c}/{s}/{rc}/members`) | edge → kv → **r2** → upstream | **Yes, after session close** | Same as Senate. The Worker parses this into `roll-call-roster:v1:*` but the raw bytes are the authoritative record; parsing is a projection. |
| House roll-call detail (`/v3/house-vote/{c}/{s}/{rc}`) | edge → kv → **r2** → upstream | **Yes, after session close** | Same. |
| Bill actions (`/v3/bill/{c}/{type}/{num}/actions`) | edge → kv → **r2** (only if `latestActionDate > 180d ago`) → upstream | **Partial.** Most bills static after signing; recent bills still accrue actions. | Age-gated: once `latestActionDate` is >180 days old, mark frozen. Before then, edge+KV only. |
| Bill summaries (`/v3/bill/{c}/{type}/{num}/summaries`) | edge → kv → **r2** (same age gate) → upstream | **Partial.** CRS summaries are revised in the weeks after introduction, then freeze. | Same age-gate as bill actions. |
| Bill metadata (`/v3/bill/{c}/{type}/{num}`) | edge → kv → upstream | No R2 | Small payload. Latest-action field can change arbitrarily. KV sufficient. |
| Member detail (`/v3/member/{bioguideId}`) | edge → kv → upstream | **No R2** | Member status can change mid-Congress (death, resignation, party switch). Freshness > performance. |
| Member sponsored-legislation (`/v3/member/{id}/sponsored-legislation`) | edge → kv → upstream | **No R2** | Rotating. New sponsorships daily while in session. |
| Member cosponsored-legislation (`/v3/member/{id}/cosponsored-legislation`) | edge → kv → upstream | **No R2** | Same. |
| Census geocoder (`/geographies/addressbatch`) | edge → kv → upstream | **No R2** | Address-specific; hit rate per key ~1; R2 would explode storage for zero benefit. |
| Our own KV-projected records (`member:v1:*`, `bill:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`, `name-index:v1:*`) | kv (sole) | — | Not upstream responses. Owned by the prewarmer which also writes via the cache pipeline (FR-35 revised). No R2. |

**Acceptance Criteria:**

- AC-41.1: Per env, one R2 bucket named `voter-info-widget-archive-${env}` SHALL be provisioned and bound in `wrangler.toml` as `R2_STATIC`.
- AC-41.2: `R2Tier` SHALL serialize a `CacheKey` to a path of shape:
  - `senate-xml` → `archive/senate/xml/vote_{c}_{s}_{rc}.xml`
  - `house-roster` → `archive/congress/house-vote/{c}/{s}/{rc}/members.json`
  - `house-vote-detail` → `archive/congress/house-vote/{c}/{s}/{rc}.json`
  - `bill-actions` → `archive/congress/bill/{c}/{type}/{num}/actions.json`
  - `bill-summaries` → `archive/congress/bill/{c}/{type}/{num}/summaries.json`
  R2 SHALL NOT store any other key kinds. The serializer SHALL throw on unsupported kinds (fail-loud per CLAUDE.md conventions).
- AC-41.3: `R2Tier.put()` SHALL gate writes on `policy.immutable === true` **AND** `entry.sessionStatus === 'frozen'`. Non-frozen entries SHALL be silently skipped — not an error, not a log, the right behavior for open-session data flowing through the same pipeline.
- AC-41.4: **Session-status determination.** `sessionStatus` SHALL be computed at fetch time by the upstream fetcher:
  - For Senate XML + House roster/detail: `frozen` if `congress < currentCongress` OR (`congress === currentCongress` AND `session < currentSession`); otherwise `live`.
  - For bill actions/summaries: `frozen` if the parsed response's `latestAction.actionDate` is >180 days before now; otherwise `live`.
  `currentCongress` / `currentSession` SHALL be computed from the current date via a pure helper in `proxy/upstreams/congress-calendar.ts` (119th Congress = 2025-01-03 to 2027-01-03; session 1 odd years, session 2 even years). A unit test SHALL cover the boundary dates.
- AC-41.5: R2 object metadata SHALL include `{ fetchedAt, sourceUpstream, sessionStatus, sha256 }` as custom metadata. No encryption (data is public by source). No versioning (immutable by definition).
- AC-41.6: R2 bytes SHALL be served verbatim with the original `contentType` from the stored `CacheEntry`. The Worker SHALL NOT reparse XML to JSON on the serving path. If a caller wants the parsed form, they read the KV-projected record (`roll-call-roster:v1:*`).
- AC-41.7: **Parse-on-demand, defer-convert-save.** When a request hits R2 for Senate XML, the response is served as-is. If and only if the request was for the JSON-projected route (`/api/roll-call-rosters/senate/...`) **and** the KV projection is absent, the Worker SHALL parse the R2 XML into the `RollCallRosterRecord` shape, respond to the client, and write the parsed record to KV via `ctx.waitUntil` so the next request for the JSON route hits KV directly. The XML parser used on the Worker SHALL live in `proxy/upstreams/senate-xml-parser.ts` and be shared with any future curator-like prewarming flow.
- AC-41.8: **Population model.** R2 is populated **only** by the `storeFromUpstream` path of the tiered cache. There is no separate R2 uploader script. A prewarmer that hits the Worker's public API for every eligible key exercises the same path real traffic does — `serveCached` → upstream miss → `storeFromUpstream` → tiers (including R2 when gated policy allows). Over time this populates R2 naturally. A one-shot "prewarm everything" command is a documented operational procedure (FR-35 revised), not a special code path.
- AC-41.9: **Tier fallthrough rules for static routes.** On tier-3 miss AND tier-4 (upstream) success, the result SHALL be stored in all three writable tiers (edge, KV, R2 if gated). On tier-3 miss AND tier-4 rate-limit (429), the Worker SHALL emit an FR-37 `rate_limited` envelope; it SHALL NOT fabricate a response from another source.
- AC-41.10: **Never serve stale-frozen with suspicion.** Once a response is in R2 with `sessionStatus === 'frozen'`, no mechanism in the Worker invalidates or rewrites it. Corrections to historical Senate XML (rare, only observed during the post-cast correction window which is always `live`) would enter via the upstream path and be written to KV only, never to R2. If human-in-the-loop evidence shows a frozen record is wrong, the operator deletes the R2 object via `wrangler r2 object delete`; the next request rebuilds it from upstream.
- AC-41.11: **Deployment dependency.** Each env's R2 bucket SHALL be created before that env's Worker deploys. The deploy workflow SHALL fail fast if `R2_STATIC` binding is configured in `wrangler.toml` but the underlying bucket does not exist (fail-loud). No auto-creation.
- AC-41.12: **Cost and scale.** Estimated steady-state R2 footprint: ~200 Senate XML × 20 KB + ~200 House rosters × 30 KB + ~200 House vote-detail × 5 KB + ~27 bill-actions × 15 KB + ~27 bill-summaries × 8 KB ≈ **13 MB per env**. Four envs = ~52 MB total. R2 storage at $0.015/GB/month = **<$0.001/month total**. Egress within CF is free. This AC is informational — no gate — but any future design that inflates the footprint by >10× SHALL revisit the cost calculation.

### FR-42: Proxy Module Composition (NEW v2.6.0)

**Problem.** `proxy/lib.ts` is 1569 lines. It holds routing, CORS, security headers, rate limiting, origin allowlisting, KV helpers, R2-era dead comments, member-profile build-through, name-search ranking, and every route handler. It is untested as a composed whole — tests are 1678 lines of route-shaped integration-style assertions against the god module. Any change risks invisible regressions in unrelated code.

**Solution.** Decompose into named OOP modules each with a single responsibility, composed at the Worker entry point. TypeScript is the language — use interfaces, classes, and dependency injection the way the language was designed for. No global state; every module receives its dependencies.

**Target topology:**

```
proxy/
  worker.ts                              — thin shim: bind runtime, instantiate, dispatch
  router.ts                              — matches Request to a Route; no handler logic
  routes/
    api-congress.ts                      — handler class per route family
    api-senate.ts
    api-census.ts
    api-members.ts
    api-name-search.ts
    api-roll-call-rosters.ts
    api-state-members.ts
    api-bills.ts
    preview.ts
    not-found.ts
    cache-config.ts                      — static CacheConfig map (FR-40 AC-40.8)
  cache/
    tier.ts                              — CacheTier<V> interface, CacheKey, CacheEntry, WritePolicy
    tiered-cache.ts                      — TieredCache<V> class
    edge-tier.ts                         — EdgeTier
    kv-tier.ts                           — KvTier
    r2-tier.ts                           — R2Tier
    pipeline.ts                          — serveCached() function
  upstreams/
    fetcher.ts                           — UpstreamFetcher<V> interface
    senate-xml-fetcher.ts
    senate-xml-parser.ts
    house-roster-fetcher.ts
    house-vote-detail-fetcher.ts
    bill-actions-fetcher.ts
    bill-summaries-fetcher.ts
    member-detail-fetcher.ts
    census-geocoder-fetcher.ts
    congress-calendar.ts                 — currentCongress/session helpers (FR-41 AC-41.4)
  security/
    origin-allowlist.ts                  — isOriginAllowed, isPreviewEnv, isSameOriginBypass
    cors.ts                              — CORS reflection headers, preflight handler
    headers.ts                           — applySecurityHeaders, stripFingerprintingHeaders
    rate-limit.ts                        — RateLimitGate class wrapping RATE_LIMITER binding
    query-filter.ts                      — allowlist filtering, cache-key canonicalization
    url-validator.ts                     — isValidUpstreamPath, sanitizeHttpUrl
  observability/
    trace.ts                             — traceId generation/echo (FR-36)
    log.ts                               — logEvent helper (FR-39)
    analytics.ts                         — writeDataPoint helper (FR-38)
    error-envelope.ts                    — ErrorEnvelope type, normalizers, asResponse (FR-37)
  kv/
    prefixes.ts                          — KV_PREFIXES constant
    member-profile.ts                    — MemberProfile type, profile shape, parser
    name-index.ts                        — NameIndexEntry type, normalizeSearchKey, rankMatches
```

**Acceptance Criteria:**

- AC-42.1: After the refactor, `proxy/lib.ts` SHALL be deleted. `proxy/worker.ts` SHALL be the only entry point, and it SHALL be ≤ 100 lines (wiring only, no business logic).
- AC-42.2: **File size cap.** No file under `proxy/` SHALL exceed **300 lines**. Files approaching this cap SHALL be split by responsibility. Current offenders beyond the refactor's direct scope (e.g., `tests/unit/worker.test.ts` at 1678 lines) SHALL also be split, by route family, into `tests/unit/routes/*.test.ts`.
- AC-42.3: Every class in the refactored proxy SHALL accept its dependencies via constructor injection. No module-scope mutable state. No singleton access to `env`, `ctx`, or `caches.default` — these are parameters, not globals.
- AC-42.4: Each route handler SHALL implement:
  ```typescript
  export interface RouteHandler {
    readonly pattern: RegExp | string;
    readonly methods: readonly HttpMethod[];
    handle(ctx: RequestContext): Promise<Response>;
  }
  ```
  where `RequestContext` carries `{ request, env, ctx, traceId, url, logger, analytics }`. The router iterates registered handlers, matches on `pattern`, and dispatches. Handlers SHALL NOT cross-call each other; shared logic lives in lower layers (cache, security, observability).
- AC-42.5: `TieredCache`, each `CacheTier`, each `UpstreamFetcher`, and each `RouteHandler` SHALL have a dedicated test file named for it. Tests SHALL use the corresponding `FakeTier` / fake fetcher / mock `RequestContext` — no cross-module integration reach-throughs in unit tests.
- AC-42.6: **Public API stability.** The refactor SHALL NOT change any externally observable behavior: every existing `/api/*` route keeps its response shape, status codes (once migrated to FR-37 envelope), cache-control values, and CORS headers. The refactor is pure decomposition.
- AC-42.7: **Migration approach.** The refactor SHALL proceed by (a) introducing the new module layout empty, (b) moving code module-by-module with tests updated in the same commit, (c) deleting the old `proxy/lib.ts` only after every caller has been migrated. Each intermediate commit SHALL be green (full suite passes, typecheck clean).
- AC-42.8: **Prewarming is a client.** The script formerly known as `scripts/publish-to-kv.ts` + `scripts/warm-member-cache.mjs` SHALL be replaced by a single `scripts/warm.ts` that issues HTTP `GET` requests to the target Worker for each prewarmable key. It SHALL contain no transformation logic; all transformation lives in the Worker's `UpstreamFetcher` implementations. Per FR-41 AC-41.8, this populates every tier (including R2) via the standard `serveCached` pipeline. The old scripts SHALL be deleted once `warm.ts` covers their ACs.
- AC-42.9: **No cross-layer leakage.** `proxy/routes/*` SHALL NOT import from `proxy/cache/*-tier.ts` directly — only from `proxy/cache/pipeline.ts` and `proxy/cache/tiered-cache.ts`. `proxy/cache/*` SHALL NOT import from `proxy/routes/*`. `proxy/upstreams/*` SHALL NOT import from `proxy/routes/*` or `proxy/cache/*-tier.ts`. Circular imports SHALL NOT exist; `tsc --noEmit` + `madge` SHALL confirm.

### FR-43: Data-Surety Visual Treatment for the Score Badge (NEW v2.6.0)

**Problem.** The Ukraine Support Score number renders at full saturation regardless of how much data underlies it. A first-term member with 2 curated-vote actions gets the same visual weight as a 4-term member with 30. The existing `lowConfidence` flag (FR-16) is a binary clamp — a member at 2 counted actions and a member at 2,999,999 counted actions are the only two states. The "Based on N counted actions" context line is buried beneath the number where voters often miss it. Per the 2026-04-19 design call, the score's *visual confidence* (saturation) should reflect how much the member's record actually supports the number, without changing the score itself.

**Solution.** Three design changes:

1. **Continuous confidence index + derived tier.** Replace the binary `lowConfidence: boolean` on `UkraineScore` with two new fields: `confidence: number` in `[0, 1]` (continuous) and `confidenceTier: 'low' | 'moderate' | 'full'` (discretized). The continuous index is derived as `confidence = min(1, contributing / MODERATE_CONFIDENCE_THRESHOLD)` — so 0 contributing → 0.0, 4 → 0.5, 8+ → 1.0 (clamped). The tier is a cheap discretization of the same signal for readable tests and label-copy branches: `< LOW_CONFIDENCE_THRESHOLD` → `'low'`, `< MODERATE_CONFIDENCE_THRESHOLD` → `'moderate'`, else `'full'`. The existing `lowConfidence` boolean remains as a derived alias (`tier === 'low'`) for one release, then removes. Giving downstream code both forms lets the UI interpolate smoothly while tests + label logic branch on the named tier.
2. **Color-saturation modulation on the score number (continuous).** CSS filter `saturate(...)` scales the number's red/yellow/green color by `confidence`: `saturation = 0.2 + 0.8 * confidence`. A member at `confidence = 0.125` (1 action) sits at ~0.30 saturation; `confidence = 0.5` (4 actions) sits at 0.60; `confidence = 1.0` (8+) sits at 1.0. This covers the three discrete tiers as corner cases of a smooth gradient, so a member at 4 contributing actions and a member at 7 look different, not identical. Desaturation moves the hue toward neutral grey without changing brightness — preserves WCAG AA 4.5:1 contrast against the widget background at every level. `scoreLabel` continues to emit "Limited record — leans X" copy at `tier === 'low'`; at `'moderate'` and above it emits the normal label (the continuous visual signal carries the nuance).
3. **Layout: slug adjacent to number + enlarged title.** The `MIXED · Based on 15 counted actions (12 excluded…)` context slug moves **to the immediate left** of the score number on the same row (no longer a separate line below the bar). The `UKRAINE SUPPORT SCORE` title enlarges to ~1.4× its current size (`clamp(1rem, 2.2vw, 1.4rem)`, uppercase, weight 900 italic per AC-9.3) so it reads as the section header it is.

**Acceptance criteria:**

- AC-43.1 (REVISED for FR-55 / ADR-018): `UkraineScore.confidenceTier` SHALL be `'insufficient'` when `contributing < NEW_REP_THRESHOLD`, `'low'` when `contributing < LOW_CONFIDENCE_THRESHOLD`, `'moderate'` when `contributing < MODERATE_CONFIDENCE_THRESHOLD`, `'full'` otherwise. `UkraineScore.confidence` (continuous) SHALL be `Math.min(1, contributing / MODERATE_CONFIDENCE_THRESHOLD)`. `NEW_REP_THRESHOLD` = 2 (per FR-55), `LOW_CONFIDENCE_THRESHOLD` = 3, `MODERATE_CONFIDENCE_THRESHOLD` = 8. When `contributing < NEW_REP_THRESHOLD` (which includes the `contributing === 0` empty-state) the tier is `'insufficient'`, `confidence === 0`, and the score itself is `null` — the badge renders "Insufficient record" copy. The pre-FR-55 wording said `'low'` was the floor tier; that is superseded.
- AC-43.2: `UkraineScore.lowConfidence` SHALL remain exported as the boolean alias `(confidenceTier === 'low' && contributing > 0)` for v2.6.0 compatibility, flagged `@deprecated` in the TypeScript doc comment. The `contributing > 0` guard matches pre-v2.6.0 behavior so the empty-state UI path (N/A rendering) is unchanged. Direct consumers MAY migrate to `confidenceTier` at their pace; the alias SHALL be removed in v2.7.0.
- AC-43.3: The score number in `UkraineScoreBadge` SHALL render with `filter: saturate(X)` where `X = 0.2 + 0.8 * score.confidence`. At `confidence = 0` → `X = 0.2`; at `confidence = 0.5` → `X = 0.6`; at `confidence = 1.0` → `X = 1.0`. The filter SHALL apply ONLY to the `.viw-score-value` element; surrounding text + the gradient bar SHALL remain at full saturation (they convey categorical information, not confidence).
- AC-43.4 (REVISED 2026-04-19 UAT): The header of `UkraineScoreBadge` SHALL render as a single CSS-Grid row at viewports ≥ 640px with four tracks in document order: `[title] [context-stack] [value] [caret]`. The context-stack is a vertical flex container holding two children — `.viw-score-label` (e.g., "Strong supporter") above `.viw-score-justification` (e.g., "Based on 16 counted actions (11 excluded: unstated, procedural, or neutral)") — right-justified against the value. The title (`.viw-score-title`), value (`.viw-score-value`), and context-stack SHALL be sized so their painted heights are visually equal (title + value line-height 1 at `~2rem` font-size; stack is two stacked lines ≈ the same height). At viewports < 640px the row collapses to a 2-row grid: row 1 `[title] [value] [caret]`, row 2 holds the context-stack with label + justification rendered INLINE on one line separated by " · " and right-justified against the value above. At the < 640px width the title text SHALL render the short form "Score"; at ≥ 640px it SHALL render the full form "Ukraine Support Score". The justification text SHALL render the full form at viewports ≥ 900px and a compact form (e.g., "16 actions (11 exc)") at viewports < 900px. Both text variants SHALL be present in the DOM (hidden by CSS media queries) so there is no render reflow on viewport change and both are available for copy/screen-reader access.
- AC-43.5: The `Ukraine Support Score` title SHALL render at `font-size: clamp(1rem, 2.2vw, 1.4rem)`, uppercase, weight 900 italic, matching the host's heading treatment per AC-9.3. Color stays as-is (inherits `var(--viw-black)`).
- AC-43.6: No AA contrast regression. Every tier/color combination of the score number against the card background (`var(--viw-white)` = `#ffffff`) SHALL maintain ≥4.5:1 per WCAG AA. Verification: the tested fixture set covers the three tier values × three band colors (red/yellow/green) = 9 combinations, all ≥4.5:1.
- AC-43.7: The `lowConfidence` clamp on `scoreLabel` (FR-16) SHALL remain — at `'low'` tier the label reads "Limited record" variants as today. At `'moderate'` the label reads as the full-tier would; the moderate desaturation is the only visual signal of partial confidence. This is intentional: the binary-clamp label change was itself part of Kaziem's "degrades mid-rangers" feedback — moving the nuance from copy to color is the design intent.
- AC-43.8: Tests in `tests/unit/UkraineScoreBadge.test.tsx` SHALL cover: tier derivation boundaries (0, 1, 2, 3, 7, 8, 9 counted actions); saturation CSS applied per tier; slug rendering position relative to the number; title size class applied; the existing abstention/obstruction note paths continue to render.
- AC-43.9 (NEW UAT): The header row SHALL render as an HTML `<button>` (`.viw-score-header-toggle`) that toggles an expandable breakdown panel (`#viw-score-breakdown-panel`). The button SHALL set `aria-expanded` and `aria-controls` and SHALL be keyboard-activatable. The panel SHALL render ONLY when expanded (no display:none placeholder).
- AC-43.10 (NEW UAT): When expanded, the breakdown panel SHALL render a per-member contribution table with one `<tbody>` row per curated Ukraine action for the member: sponsored bills, cosponsored bills (each with weight 1.0), and every row in `VotingRecordData.flat`. Columns: `Bill / Vote`, `Action`, `Sign`, `Amp × Weight`, `Contribution`. Rows whose contribution is zero (valence `unstated` OR weight ≤ 0 per FR-16 `PROCEDURAL_THRESHOLD`) SHALL carry class `viw-score-row-skipped` and display `skip (reason)` — where reason is one of `Unstated`, `Present`, `Abstained`, `Procedural`, or `Neutral` — in place of a numeric contribution. The table SHALL have a `<tfoot>` with two rows: "Totals" (Σ amp×weight · Σ contribution) and "Score = … ÷ …" ending with the final score value. The final score in the footer SHALL equal the badge's displayed value for every member.
- AC-43.11 (NEW UAT): In addition to the header toggle, the score bar + obstruction-note region SHALL also act as a clickable toggle (`.viw-score-bar-toggle`) that expands/collapses the same breakdown panel, with the same `aria-expanded` / `aria-controls` wiring. The progressbar role SHALL remain on the inner `.viw-score-bar` element (not on the outer button) so screen readers still announce the score value.
- AC-43.12 (NEW UAT, REVISED 2026-04-19): Each row in the breakdown table SHALL carry a valence CSS class `viw-valence-{sponsor-pro|voted-pro|unstated|voted-anti|sponsor-anti}` matching the action's computed valence. Styling (full-row background tint via `--viw-valence-*-bg`, contribution-cell foreground color via `--viw-valence-*`) SHALL use the existing FR-15 palette tokens so the color scheme stays consistent with the Ukraine Votes table below. Unstated/skipped rows SHALL render with a transparent background and muted italic text. No left-edge accent stripe is applied — an earlier iteration used `box-shadow: inset 3px 0 0` to paint a colored vertical bar along the bill cell, but post-UAT feedback (2026-04-19) found it read as an "extra border" between the bill cell and the numeric cells on tinted rows. Removed.
- AC-43.13 (NEW UAT): The gradient-bar + obstruction-note region SHALL render ABOVE the breakdown panel in DOM and visual order when the panel is expanded, i.e., the expand/collapse SHALL NOT push the bar, obstruction note, or abstention note off-screen — the panel is the last child of `.viw-score`.
- AC-43.14 (NEW UAT, post-feedback 2026-04-19): The "Bill · Action" cell in the breakdown table SHALL render the per-action record as **three stacked pieces of structured data**, not a single long string:
  1. **Slug** (`.viw-score-row-bill-slug`): a short bill identifier. For House bills, `${TYPE} ${number}` (e.g., `HR 815`). For Senate bills, `S.`-prefixed variants (`S. 1241`, `S.JRES 117`). Bold italic uppercase, matches the host's heading treatment.
  2. **Description** (`.viw-score-row-bill-desc`): the curator-authored one-sentence bill label, truncated to `BILL_LABEL_TRUNCATE_CHARS` (72) characters with an ellipsis when longer.
  3. **Action caption** (`.viw-score-row-bill-action`): for vote rows, `"${VOTE_KIND_LABEL[kind]} — Voted ${memberVote}"` (e.g., `"Cloture — Voted Aye"`, `"Final passage — Voted Nay"`, `"Motion to proceed — Voted Aye"`). For sponsorship rows, simply `"Sponsored"` or `"Cosponsored"`.

  Rows with a truncated description OR with additional `vote.action` clerk text SHALL render the cell as a `<button>` (`.viw-score-row-bill-toggle`) with `aria-expanded` and a caret glyph (`▸` / `▾`). Clicking the button toggles a per-row expand that reveals the full description and, for vote rows, the `actionDetail` (full clerk-action text, e.g., `"Senate agreed to the House amendment to the Senate amendment to H.R. 815 by Yea-Nay Vote. 79 - 18. Record Vote Number: 154."`) as `.viw-score-row-bill-detail`. Rows where both description and action detail are short SHALL render the structured fields directly (no button wrapper).

  Row-expand state is isolated: each row's expand state is independent of other rows and of the outer panel's `aria-expanded` state.

  The "Action" column that appeared in the first UAT iteration SHALL be removed; the "Voted Aye / Voted Nay / Sponsored / Cosponsored" information now lives in the action caption inside the bill cell. Header columns: `Bill · Action` | `Sign` | `Amp × Weight` | `Contribution`.

  Footer `colSpan` adjusts accordingly: "Totals" row uses `colSpan={2}`, "Score = Σ ÷ Σ" row uses `colSpan={3}`.
- AC-43.15 (NEW UAT 2026-04-19): The entire `.viw-score` band — the grey wrapper AND any whitespace inside the white `.viw-score-breakdown` panel — SHALL act as a single click target that toggles the breakdown panel's `expanded` state. All interactive descendants (header toggle, bar toggle, per-row bill-expand toggles) SHALL call `e.stopPropagation()` on their own click so the container handler does not double-fire. The rule: clicking any non-interactive whitespace toggles; clicking a dedicated button fires only that button's own semantics. The score band SHALL carry `cursor: pointer` to signal the hit area. Rationale: UAT feedback found the dedicated header/bar buttons were too-small targets on mobile; the full grey band is a much easier tap zone and matches the "card opens on tap" pattern voters already expect from the chip grid.

### FR-44: Test Ladder, CI/CD Gating, and Stress Testing (NEW v2.6.0)

**Problem.** Today the test suite is overwhelmingly unit tests with a handful of hook-level "integration" tests that mock `fetch` at the service boundary. What ADR-011/ADR-012/ADR-014 actually ship — the Worker composing a router, CORS gate, rate limiter, tiered cache, R2 tier, KV tier, edge tier, upstream fetchers, and observability — has **no test that composes those real modules together with only bindings faked**. The existing `tests/e2e/widget.test.tsx` exercises the full React component tree but still mocks every `/api/*` response at the service boundary; it has never seen a real `serveCached` pipeline. FR-30's "run the suite against the stg edge" clause has been aspirational since it was written (AC-30.5 "until at least one remote-mode test lands" has never been resolved). The 2026-04-18 go-live produced 429s that no test could have caught because no test exercised the upstream fan-out.

**Solution.** Formalize a four-tier test ladder, make every tier a merge-blocking CI gate, and pair stg with two new ops: a full prod-KV mirror sync before the stg rehearsal, and a stress run that matches the upstream rate limits the widget actually pushes against.

**Four tiers:**

| Tier | Scope | Network | Where runs | Gates |
|------|-------|---------|------------|-------|
| 1. Unit | Single module under test, all collaborators faked | None | Every PR (pr.yml) + locally | Blocks merge to `main` |
| 2. Integration | Multiple modules composed (e.g. `serveCached` with real `TieredCache` + all three tier impls + real `UpstreamRegistry`), only **bindings** faked (fake KV, fake R2, fake `caches.default`, stubbed `fetch`) | Stubbed | Every PR + locally | Blocks merge to `main` |
| 3. E2E (local Worker) | Full Worker booted via `wrangler dev`, widget SPA pointed at `http://localhost:8787`, real HTTP roundtrip, **mocked upstreams** (Congress/Senate/Census) via a local test-fixtures server | Real local HTTP | On push to `develop`/`uat`/`stg`/`prod` | Blocks promotion ladder |
| 4. E2E (remote edge) | Full suite against the deployed stg Worker (`https://stg.vote.cogs.it.com`), **real upstream data** via prod-mirrored KV, real Access service token | Real WAN | Stg rehearsal workflow, manual trigger | Blocks prod promotion |

**Stress testing (stg only):**

- Runs AFTER the remote-edge suite in the stg rehearsal workflow.
- Simulates realistic visitor patterns (address lookup → 3-rep fan-out → click through detail panels) at configured concurrency for a configured duration, against stg's real edge.
- Targets both cold-cache (first visitor) and warm-cache steady-state profiles.
- Asserts three budgets: (a) p95 latency ≤ 5s per visitor flow, (b) zero 5xx from the Worker, (c) upstream 429 count stays within a declared tolerance (0 on warm, ≤5 on cold for a 50-concurrent 60s burst).
- Uses Cloudflare's ratelimit + the `RATE_LIMITER` binding as guardrails; service token bypasses the per-IP limit so stress can exceed 60/60s/IP.

**Stg KV mirror (v2.6.0 — tightened from FR-30 AC-30.3):**

- At rehearsal start, every curator-owned KV prefix (`member:v1:*`, `bill:v1:*`, `roll-call:v1:*`, `name-index:v1:*`, `roll-call-roster:v1:*`, `state-members:v1:*`) is copied verbatim from prod's KV namespace to stg's.
- `cache:v1:*` (tiered-cache response cache) is NOT copied — stg must exercise its own cold-cache path every rehearsal, otherwise the stress test is meaningless.
- R2 static archive objects (`archive/**`) are NOT copied for the same reason — stg must re-populate its R2 during the rehearsal so the cold-R2-miss → upstream → write-R2 path runs under real conditions.
- Sync is a pre-flight step: if it fails (prod KV unreachable, stg namespace full, token expired), the rehearsal aborts before deploy.

**Acceptance criteria:**

- AC-44.1 (integration tier): `tests/integration/` SHALL gain `serveCached.test.ts` composing a real `TieredCache<string>` with real `EdgeTier`, `KvTier`, `R2Tier` instances, a real `createUpstreamRegistry`, and a fake `fetch` that returns fixture responses. Test cases SHALL cover: cold-all-tiers → upstream → writes to all eligible tiers; edge hit; KV hit + promotes to edge; R2 hit + promotes to KV + edge; R2-ineligible route (member-detail) never writes to R2; upstream 429 → FR-37 envelope; upstream 5xx → FR-37 envelope with `retryable: true`. ~12 tests. This closes the "no test composes the real cache pipeline" gap.
- AC-44.2 (integration tier): `tests/integration/matchRoute.test.ts` SHALL pair `matchRoute` + `serveCached` + the registry against 20+ sample `/api/*` paths covering every CacheKind, asserting round-trip header shape (`X-Cache`, `X-Cache-Tier`, `X-Trace-Id`) and FR-37 envelope on upstream error.
- AC-44.3 (e2e local): The `tests/e2e/` directory SHALL gain `worker-local.test.ts` that: boots the Worker via `wrangler dev --env preview` on a random free port, stands up a fixture HTTP server on a second port returning canned Congress/Senate/Census responses, points the Worker's upstream URLs at the fixture server via a `STRESS_MODE=true` env var + override, and drives the widget SPA through its golden flows (address lookup, name search, rep detail) asserting end-to-end response bodies + headers. At least one test SHALL assert that a second request for the same roll-call serves from a cache tier (`X-Cache-Tier: edge` or `kv`).
- AC-44.4 (e2e local): `worker-local.test.ts` SHALL run in CI via `npm run test:e2e:local` gated on a `pr.yml` job that installs wrangler, starts the fixture server, runs the Worker, waits for health, executes the test file, and tears down. Duration budget: ≤90 seconds.
- AC-44.5 (e2e remote): The stg-rehearsal workflow SHALL run a `tests/e2e/remote.test.ts` file against `E2E_TARGET=https://stg.vote.cogs.it.com` with CF Access service-token headers. The same test file SHALL be runnable locally against any env via `E2E_TARGET=https://... npm run test:e2e:remote`. At least the golden-flow test from AC-44.3 SHALL have a remote-mode twin. This resolves AC-30.5.
- AC-44.6 (stg KV mirror): `scripts/sync-stg-data.ts` (extended from T-025e scaffold) SHALL copy every curator prefix listed in FR-30's revised scope to stg's KV namespace before the rehearsal deploys. SHALL skip `cache:v1:*` and any R2-backed archive. SHALL fail loud on any write error (no silent partial copy). Supports `--dry-run`.
- AC-44.7 (stg KV mirror): The stg rehearsal workflow SHALL invoke the sync as its first post-checkout step, BEFORE `wrangler deploy --env stg`. A failed sync aborts the rehearsal.
- AC-44.8 (stress): `tests/stress/visitor-flow.stress.ts` (new directory `tests/stress/`) SHALL exercise a parametrized concurrent-visitors workload against `E2E_TARGET`. Two scenarios: **cold** (fresh R2 + KV, 50 concurrent visitors, 60-second burst) and **warm** (after cold, another 50 concurrent for 60s). Assertions per AC-44 solution text: p95 ≤ 5s, 0 Worker 5xx, upstream 429 ≤ 0 (warm) / ≤ 5 (cold). Uses the same service token as remote e2e.
- AC-44.9 (stress): The stg-rehearsal workflow SHALL invoke the stress scenarios AFTER the remote-edge e2e suite passes. Stress failure fails the rehearsal exactly like e2e failure. Duration budget: ≤4 minutes for both scenarios combined.
- AC-44.10 (ci gating): `pr.yml` SHALL run tiers 1 and 2 (unit + integration) as required status checks. `deploy.yml` (on push to `develop` or `uat`) SHALL run tier 3 (e2e local) before invoking `wrangler deploy`. The `stg` branch's deploy workflow SHALL additionally invoke the stg-rehearsal workflow (tiers 3 + 4 + stress) as a required pre-deploy step. The `prod` branch's environment protection rule SHALL require a reviewer who has verified the latest stg-rehearsal run was green **at the same SHA being promoted** (AC-30.6 honor-system check, not yet automated).
- AC-44.11 (ci gating): A PR against `main` that touches ANY file under `proxy/**` or `src/services/**` or `scripts/publish-to-kv.ts` or `scripts/warm.ts` SHALL be marked failing if integration tier coverage drops below 80% branches on the affected module(s). Coverage threshold is enforced by `npx vitest run --coverage --coverage.thresholds.branches=80` scoped to the changed-paths glob.
- AC-44.12 (ci gating): The stress tier's output SHALL be captured in the workflow run summary (req/sec, p95, error rate, upstream 429 count, cache-hit ratio by tier). This gives operators a numeric history of rehearsal runs to spot regressions before they become incidents. A future dashboard MAY ingest these (out of scope for v2.6.0).
- AC-44.13 (remote-mode ergonomics): Remote-mode test files SHALL consult `process.env.E2E_TARGET` at module top. When unset, the suite SHALL skip the file with a console note ("remote-mode test skipped: E2E_TARGET not set") — NOT fail — so developers running `npm test` locally aren't blocked. Required-runs in CI set `E2E_TARGET` explicitly.
- AC-44.14 (harness): A single `tests/e2e/harness.ts` SHALL provide helpers used by both local and remote e2e tests: `fetchApi(path, { env })` with Access headers wired, `assertCacheTier(resp, tier)`, `assertErrorEnvelope(resp, code, retryable)`. Keeps golden-flow tests readable.

**Additional integration seams (AC-44.15..AC-44.20 — derived from the 2026-04-19 audit against the Phase 11 tree).** Each closes a specific composition-level wiring bug that tier-1 unit tests cannot catch because the seams involve real modules on both sides of the boundary.

- AC-44.15 (integration — registry completeness): `tests/integration/upstreamRegistry.test.ts` SHALL verify that every `CacheKind` returned by `matchRoute` has a registered fetcher in `createUpstreamRegistry`. The test enumerates matchRoute's full sample set (senate-xml, house-roster, house-vote-detail, bill-actions, bill-summaries, member-detail, census-geocoder), constructs a CacheKey for each, and asserts `registry.getFor(key)` returns a non-null fetcher whose `canHandle(key)` is true. This catches the class of bug where a new kind is added to cache-config but the corresponding fetcher wiring is forgotten — the pipeline would silently hit the `fetcher is null` path and fail with an obscure error. Target: 3 tests (enumeration + boundary + negative case for unhandled `member-profile` kind).
- AC-44.16 (integration — voting-record chain): `tests/integration/votingRecord.valence.test.ts` SHALL compose `useVotingRecord` hook + real `rollCallRosters` service + real `valence` + real `ukraineScore` against fake fetch returning realistic House and Senate roster shapes. Asserts: Senate `Yea` normalizes to `Aye` before valence lookup; House roster `bioguideID` → `Aye`/`Nay` map flows correctly to `voted-pro`/`voted-anti` valence; mixed roster (member votes on some rolls, not others) produces the expected `Did Not Vote` marker; `ukraineScore.contributing` count matches the non-excluded actions. Target: 5 tests. Closes the unit-test gap where `valence` and `ukraineScore` are tested in isolation but never with the roster-shape inputs they actually receive in production.
- AC-44.17 (integration — hook error propagation): `tests/integration/hookErrorBanner.test.tsx` SHALL compose each error-emitting hook (`useAddressLookup`, `useNameSearch`, `useMemberProfile`) against a fake fetch that returns a realistic FR-37 envelope for status 429, 500, 404, and 400. Renders the real component that owns the error state (`ResultsPanel`, `NameSearchResultsPanel`, `RepDetail`) and asserts: ErrorBanner renders with `userMessage` visible, `traceId` rendered, "Try again" button present iff `retryable: true`. Target: 4 tests (one per error code × one per component owner). Catches the class of bug where a hook sets error state but the component's error-rendering path is dead code.
- AC-44.18 (integration — sanitizeUrl at render boundaries): `tests/integration/sanitizeUrlBoundary.test.tsx` SHALL render `MemberChip`, `BillList`, and `RepDetail` with malicious URL values (`javascript:alert(1)`, `data:text/html,...`, `vbscript:...`, `file://...`) in every href/src field the component emits. Asserts: no `<a href>` or `<img src>` in the rendered DOM retains the dangerous scheme; `sanitizeUrl` is applied at the render boundary, not just at fetch time. Target: 4 tests (one per component + one negative case for a valid `https://` URL that MUST pass through). Catches the class of bug where upstream data is trusted at render but sanitized only at fetch.
- AC-44.19 (integration — observability thread): `tests/integration/observabilityThread.test.ts` SHALL compose a fake request flowing through `resolveTraceId` → `serveCached` → (forced upstream error) → `asErrorResponse` → `logEvent` → `writeAnalyticsPoint`. Asserts: the same trace ID appears in (a) the response `X-Trace-Id` header, (b) the FR-37 envelope `error.traceId` field, (c) the captured `console.log` JSON line, (d) the Analytics Engine data point's `indexes[0]`. Target: 3 tests (success path, upstream-error path, top-level-exception path). Catches the class of bug where trace ID is generated per-request but lost at one of the 4 integration points.
- AC-44.20 (integration — Senate XML parser error resilience): `tests/integration/senateXmlFetcherResilience.test.ts` SHALL exercise `SenateXmlFetcher` against fake fetch returning (a) a valid XML body, (b) an HTML error page with Content-Type text/html, (c) a truncated XML body (first 200 bytes of a valid body), (d) an empty 200 response. Asserts: (a) succeeds; (b)-(d) throw errors that the pipeline would translate to `upstream_parse_error` envelopes rather than uncaught exceptions. Target: 3 tests. Catches the class of bug where the bespoke XML parser works on happy-path input but crashes the Worker on upstream weirdness.
- AC-44.21 (integration — V4 D1→KV→embed round-trip, NEW v2.7.0): `tests/integration/v4PublishRoundTrip.test.ts` SHALL compose the V4 admin store + publish projector + embed read routes end-to-end against in-memory D1 + KV fakes. Test cases SHALL cover: (a) seed a bill via `createBill`, run `buildPublishPlan` against the in-memory D1, write the resulting `bill:v1:*` payload to fake KV, fetch via `handleBill`, and assert the embed sees the bill with the same direction + weight; (b) attach a `createComment` to that bill, re-run publish, and assert `handleComments` returns the comment with `attachedToRollCallId`, `scoreAdjustment`, and the redacted `authorEmail` shape the embed expects; (c) seed two cosponsorships → publish → assert `handleSocialPosts` (or quotes path) returns the projection in the canonical order; (d) delete a bill via `deleteBill` with a `reason`, re-publish, and assert (1) the bill record disappears from KV, (2) the audit_log entry is exposed by `handleAuditPublic` with email-domain stripped per AC-58.2 and `before/after/reason/trace_id` redacted. Target: 4 tests. Closes the gap where each layer is unit-tested with isolated fakes but no test verifies the contract that admin writes flow correctly through projection into the shape the embed read routes return.
- AC-44.22 (unit — `/admin` SPA bootstrap rewrite, NEW v2.7.0): `tests/unit/router.adminBootstrap.test.ts` SHALL exercise `proxy/router.ts#dispatch` for the FR-52 AC-52.2 `/admin` SPA-serving path. Test cases SHALL cover: (a) `GET /admin Accept: text/html` rewrites to `/admin/index.html` via `env.ASSETS.fetch` and returns 200 with the SPA shell; (b) `GET /admin/ Accept: text/html` (trailing slash) rewrites the same way; (c) `env.ASSETS` absent → 404 with body `admin SPA bundle missing`; (d) `env.ASSETS.fetch` throws → 404 (not 500) so a missing bundle never crashes the Worker. Target: 4 tests. Closes the gap where the SPA-rewrite path was never unit-tested and the only coverage was a manual browser session.
- AC-52.10 (NEW 2026-05-02 — preview-HTML shadow fix): The dev / non-prod `PREVIEW_MODE=true` HTML-fallback branch in `proxy/router.ts#dispatch` SHALL NOT intercept any path under `/admin/*`. The preview HTML is the embed dev harness; serving it for a `GET /admin/index.html Accept: text/html` request (or any nested `/admin/<asset>.html` request) was a real bug observed on the 2026-05-02 dev deploy: the SPA's HTML shell was replaced by the embed preview HTML, so the SPA bundle never bootstrapped and the user saw a 404-shaped or no-controls page. After the fix, requests under `/admin/*` SHALL fall through to `env.ASSETS.fetch` (which serves them from the bundled `dist/admin/` static files) regardless of `PREVIEW_MODE`. The same rule SHALL apply to the prod 301-redirect-to-trackukraine.com branch — `/admin/*` SHALL NOT be redirected to the embed host. Tests SHALL cover: (e) `GET /admin/index.html Accept: text/html` falls through to ASSETS even when PREVIEW_MODE=true; (f) `GET /admin/anything Accept: text/html` falls through to ASSETS even on prod (no PREVIEW_MODE).
- AC-52.11 (NEW 2026-05-02 — Vite admin base path): The admin SPA's Vite config (`vite.admin.config.ts`) SHALL set `base: '/admin/'` so the built `index.html` references its JS / CSS assets via `/admin/assets/...` paths. Without this, Vite emits root-relative `/assets/...` paths that 404 in production because the assets land at `/admin/assets/...` per the dist layout — discovered live on dev 2026-05-02 when the SPA HTML loaded but the JS bundle returned 404. The dev server (`npm run dev:admin`) inherits the same base, so admin links work in local development too.
- AC-52.12 (NEW 2026-05-02 — Bill ID derivation): The admin SPA's Bills editor (BillsTab) SHALL derive `bill_id` deterministically from `congress`, `type`, and `number` as `${congress}-${type.toUpperCase()}-${number}` (matching `billKey()` in `scripts/seed-d1-from-json.ts`). The `bill_id` field SHALL be rendered as **read-only**; researchers SHALL NOT be able to type it directly. Whenever any of the three components changes, the displayed `bill_id` SHALL update live. The Worker still validates `bill_id` shape and uniqueness on POST/PATCH, but the SPA enforcing derivation upstream prevents the entire class of "researcher typed `117-Hr-2471` instead of `117-HR-2471` and the comment record never matches" bug. Tests SHALL cover: (a) typing a Type value lowercases to uppercase in the bill_id; (b) editing congress / type / number live-updates the bill_id field; (c) the bill_id input has `readOnly` set; (d) on save, the body sent to POST/PATCH carries the derived `bill_id`, not whatever the row had before edit.
- AC-52.13 (NEW 2026-05-02 — Bills field labels reflect intent): The admin SPA's Bills editor SHALL label `title` as **"Official title (from Congress.gov)"** and `label` as **"Curator description / what this bill does"**. Background: pre-V4 curator JSON used `title` for the bill's official Congress.gov name (e.g. "PEACE Act of 2025") and `label` for a longer hand-written plain-English summary (e.g. "Peaceful resolution to Russia-Ukraine conflict / financial institution prohibitions"). The original "Title" / "Short label" labels misled researchers because `label` is typically *longer* than `title` — backwards from the conventional naming. The renamed labels make the editorial roles explicit. Data shape unchanged — only display-side labels change. Tests SHALL assert the rendered editor shows the new labels.
- AC-52.14 (NEW 2026-05-02 — list-item ellipsis): The admin SPA's `ResourceTab` list-item rendering SHALL apply CSS overflow handling (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`) to each list-item label so long row labels (e.g. a 200-char official Congress.gov title) truncate with "…" rather than wrapping into multi-line awkwardness. The selected row SHALL still show the full label on hover via the native `title` attribute. Tests SHALL assert the inline style includes the three CSS rules and that the `title` attribute carries the un-truncated text.
- AC-49.8 (NEW 2026-05-02 — drop placeholder direction_reason): The seed script (`scripts/seed-d1-from-json.ts`) SHALL filter the bill `direction_reason` field, mapping any value matching the placeholder string `"manual override"` (case-insensitive, trim-tolerant) to SQL NULL. Background: pre-V4 curator JSON used `"manual override"` as a default direction-reason on most bills. The string carries no editorial meaning — it just records that the curator override-flag was set on the original Python pipeline. Treating it as data clutters the admin UI. The `direction_reason` field itself remains — researchers SHALL be able to write substantive rationale; only this specific placeholder is filtered. Tests SHALL cover: (a) `direction_reason: "manual override"` lands as NULL; (b) `direction_reason: " Manual Override "` lands as NULL (case + whitespace insensitive); (c) `direction_reason: "Sanctions on Belarus + Russia"` lands verbatim; (d) `direction_reason: undefined` lands as NULL.
- AC-52.15 (NEW 2026-05-02 — grouped fieldset layout): The admin SPA's `ResourceTab` component SHALL accept extended schema entries with optional `group: string` and `width: 'short' | 'medium' | 'full'` properties. Fields with the same `group` SHALL render in a single `<fieldset>` with the group label rendered as the legend (or hidden when `group === undefined`). Within a group, fields SHALL flex-wrap with widths approximating: `short ≈ 120px min`, `medium ≈ 240px min`, `full = 100%` of the group container. Group boundaries are walked by reading the schema in order and splitting whenever the `group` value changes. Schema authors SHALL declare related fields adjacent in the schema array. On viewports < 720px, all fields collapse to single-column layout regardless of width. Tests SHALL cover: (a) two groups produce two fieldsets; (b) three `short` fields in one group occupy a single row at desktop width; (c) a `full` field forces a row break; (d) ungrouped fields (no `group` key) render in a default group with no legend.
- AC-52.16 (NEW 2026-05-02 — inline bill-attached sections): The admin SPA's Bills editor (BillsTab) SHALL render inline sections at the bottom of the editor (below the field groups, above the Save / Delete / Cancel actions) listing the resources attached to the currently-edited bill: (1) **Roll-call votes** — votes filtered by `bill_id`, with add / edit / delete affordances inline; (2) **Comments** — comments filtered by `bill_id`, with add / edit / delete inline. Each inline section SHALL be a collapsible panel headed with the section name + count badge (`Votes (5)`). The standalone top-level **Votes** tab in the SPA's tab strip SHALL be removed once the inline section is in place — researchers edit votes only in the context of a bill, never in isolation. The standalone **Comments** tab MAY remain for cross-bill workflows (e.g. "show me all comments by alice@…") but SHALL NOT be the primary entry point. Tests SHALL cover: (a) Bills editor with no votes shows an empty Votes section with `+ Add` affordance; (b) opening a bill that has 3 votes in D1 surfaces them in the inline section; (c) the SPA's tab strip no longer contains a standalone Votes tab.
- AC-52.17 (NEW 2026-05-02 — URL field with click-through): The admin SPA SHALL support a `kind: 'url'` schema entry that renders a text input PLUS an `↗ Open` link / button to the right of the input. The link / button SHALL `target="_blank" rel="noopener noreferrer"` and SHALL be rendered only when the field's current value is a syntactically-valid http(s) URL (passes `sanitizeUrl`). Clicking the link SHALL NOT mutate editor state (no field-change event, no draft-dirty flag). Tests SHALL cover: (a) valid `https://...` URL renders an `↗ Open` element with the same href; (b) empty / invalid value renders no link; (c) `javascript:` URL renders no link (sanitizeUrl rejection).
- AC-52.18 (NEW 2026-05-02 — client-side change-notes gate on update): On `update` flows in the admin SPA editor, the Save button SHALL be disabled when the change-notes textarea is empty or whitespace-only, and the textarea SHALL display a red `Required for updates` hint adjacent to its label. On `create` flows, change-notes remains optional and the Save button is unconditionally enabled. The Worker's `400 reason_required` (AC-50.8) remains in place as belt-and-suspenders. Tests SHALL cover: (a) clicking an existing bill (update flow) → empty change-notes → Save is disabled; (b) typing one non-whitespace char → Save enables; (c) clicking + New (create flow) → empty change-notes → Save is enabled; (d) the hint text appears only on update flows.
- AC-52.19 (NEW 2026-05-02 — short-field help is a tooltip, not wrapped text): For `width: 'short'` fields, the schema's `help` property SHALL render as the input's `title` attribute (browser-native tooltip on hover) rather than as inline text below the input. Long help strings under a 120 px column wrap into three lines and crowd the layout, as observed live on dev with the `Type` field's "HR / S / HJRES / SJRES / …" hint. For `width: 'medium' | 'full'`, help continues to render as inline text. Tests SHALL assert: (a) a `short` field with help has the help string in its `title` attribute and NO `.help` rendered text; (b) a `full` field with help still shows the inline help span.
- AC-52.20 (NEW 2026-05-02 — Latest action overflow): The `latest_action` field on the Bills editor SHALL render at `width: 'full'` (revised from `medium`), so long action text (e.g. "ASSUMING FIRST SPONSORSHIP …") doesn't get visually clipped on a 240 px column. Tests SHALL assert the rendered Bills editor has the latest_action input span the full width of its group container.
- AC-52.21 (NEW 2026-05-02 — caret rotation on collapsible sections): The inline-section disclosure caret in `BillInlineSections` SHALL show `▶` when collapsed and `▼` when expanded (replaces ASCII `▸` / `▾` which renders inconsistently across fonts). The caret SHALL be a sibling element with `transform: rotate(...)` rather than a swap of two characters, so screen-readers see one stable label.
- AC-52.28 (NEW 2026-05-03 — shared design tokens): A single `src/styles/tokens.css` defines the project's semantic design tokens (`--tk-*`) consumed by both the embed widget and the admin SPA. The embed's existing `--viw-*` names SHALL alias to `--tk-*` inside `:host, .viw-root` so the widget's existing 80+ selectors are byte-identical post-migration. The admin's legacy `--bg / --fg / --panel / --accent / --border / --muted / --danger / --success` names SHALL also alias to `--tk-*` so inline-style migration is incremental. Tokens cover palette (yellow `#fff100` brand CTA, party colors, valence pairs), typography (Hanken Grotesk + system fallback, type scale, weights, hero shadow), geometry (`--tk-radius: 0` flat, `--tk-border-w: 2px`, six-step spacing scale), and semantic surface tokens (`--tk-bg`, `--tk-surface`, `--tk-fg`, `--tk-muted`, `--tk-subtle`, `--tk-border`, `--tk-border-soft`, `--tk-accent`, `--tk-accent-fg`, `--tk-danger`, `--tk-danger-fg`, `--tk-success`, `--tk-focus`). Light theme is default; `[data-theme="dark"]` overrides surface tokens. The brand color (`--tk-accent: #fff100`) stays yellow in both themes — researchers shouldn't ship a different CTA color than the public widget.
- AC-52.29 (NEW 2026-05-03 — dark-mode toggle persistence): The admin SPA SHALL render a theme toggle in its header that cycles `system → light → dark`. The choice persists in `localStorage["tk-admin-theme"]`. On load — before React mounts — `<html data-theme>` SHALL be set from the stored preference (or `prefers-color-scheme` if `system`) via an inline `<script>` in `index.html` to prevent FOUC. When `system`, the SPA SHALL react to `matchMedia("(prefers-color-scheme: dark)")` change events live. Dark mode SHALL be admin-SPA-only — the embed widget assumes host-page contrast and does NOT carry a dark-theme block. Tests SHALL assert: (a) toggle cycles 3 states; (b) choice persists across mount/unmount; (c) `system` mode reacts to a stubbed `matchMedia` change; (d) initial render reflects stored preference.
- AC-52.30 (NEW 2026-05-03 — button-style unification): Every admin SPA button (`saveBtn`, `cancelBtn`, `deleteBtn`, `newBtn`, tab triggers, theme toggle, inline-section Save / Delete / Add) SHALL use the shared button style: `border-radius: 0` (flat), `2px solid var(--tk-border)` outline, font `var(--tk-font)` weight `var(--tk-fw-bold)`, `text-transform: uppercase`, `letter-spacing: 0.04em`. Primary CTA fills `var(--tk-accent)` with `var(--tk-accent-fg)` text. Destructive (Delete) uses `var(--tk-danger)` outline + text. Inputs SHALL also use `border-radius: 0` and `2px solid var(--tk-border-soft)`. The embed widget's existing button selectors (`.viw-about-trigger`, `.viw-about-tab`) keep their declarations unchanged but consume the same underlying tokens.
- AC-52.31 (NEW 2026-05-03 — `long` width tier): The admin SPA's `FieldWidth` SHALL gain a fourth tier `long` with `flex: 1 1 360px; max-width: 60ch`. The bill schema SHALL use it for `title`, `label`, `direction_reason`, `congress_gov_url`. `latest_action` retains `full` per AC-52.20. Existing schemas using `short` / `medium` / `full` are byte-identical; only opt-in callsites adopt `long`.
- AC-52.32 (NEW 2026-05-03 — Identity static post-create): Once the bill onboarding flow (AC-52.46+) populates `congress` / `type` / `number` from Congress.gov, those fields SHALL render as static read-only text in the bill editor (matching AC-52.27's vote-row treatment). On the create form they remain editable. The static treatment SHALL be a shared `StaticIdentifiers` component used by both the bill editor and the vote-row editor.
- AC-52.33 (NEW 2026-05-03 — inline summary disclosure): The bill editor SHALL expose a collapsible "Bill text & summary" panel that lazy-fetches `/api/congress/v3/bill/{c}/{t}/{n}/summaries`, renders the most recent summary's `actionDesc` + HTML-stripped `text`, surfaces upstream errors inline as "Could not load summary: {detail}", and links back to `congress_gov_url`. The fetch SHALL fire once per open (memoized) and not refetch on collapse-then-reopen.
- AC-52.34 (NEW 2026-05-03 — vote-row spacing condensed): The inline vote editor SHALL render a single static identifier strip (with left-accent border) directly above a 3-column editable grid (weight / direction multiplier / weight rationale). Padding, gaps, and line-heights SHALL be tightened so a populated row is approximately 33% shorter than the prior layout. Save / Delete SHALL right-align with `marginLeft: auto` on the action cluster.
- AC-52.35 (NEW 2026-05-03 — vote URL static): On existing vote rows, `votes.url` SHALL render as static text plus the `↗ Open` link (matching AC-52.27 treatment). The editable `url` input SHALL appear only on the create-vote form. The wire-level PATCH continues to accept `url` for backward compatibility.
- AC-52.36 (NEW 2026-05-03 — Classification inline row): The Classification group in the bill editor SHALL render Direction (select), Featured (checkbox), Became law (checkbox), and Direction rationale (single-line text, width `long`) on one flex-wrap row. `direction_reason` schema kind changes from `textarea` to `text`. At narrow viewports the rationale wraps to its own line first; checkboxes and select stay together.
- AC-52.37 (NEW 2026-05-03 — Direction display labels): The Direction `<select>` SHALL display `Pro` / `Neutral` / `Anti` while submitting wire values `pro-ukraine` / `ambiguous` / `anti-ukraine`. Display labels live in the schema's `options[].label`; underlying database enum and `BillRow.direction` type are unchanged.
- AC-52.38 (NEW 2026-05-03 — comments/posts/quotes schema delta): `migrations/d1/0002_comment_weight_direction.sql` SHALL replace `score_adjustment REAL` on `comments`, `social_posts`, and `quotes` with `weight REAL NOT NULL DEFAULT 0` (range `[0, 5]`) and `direction INTEGER NOT NULL DEFAULT 0` (∈ `{-1, 0, +1}`). Same constraints as `votes.weight` + `votes.direction_multiplier`.
- AC-52.39 (NEW 2026-05-03 — migration value mapping): For every existing row, `direction = sign(score_adjustment)` and `weight = MIN(5, ABS(score_adjustment) * 5)`. Rationale: existing slider was `[-1,+1]` representing "fraction-of-max"; map onto the 0..5 vote-weight scale by multiplying by 5 so a row at `score_adjustment = 1.0` becomes a maximally-weighted comment.
- AC-52.40 (NEW 2026-05-03 — validation): `POST` and `PATCH` on `/api/admin/{comments,social-posts,quotes}` SHALL validate `weight` (clamp negative → 0; reject `> 5` with 400 `invalid_weight`) and `direction` (reject anything ∉ `{-1, 0, +1}` with 400 `invalid_direction`). Same code path as votes' validators.
- AC-52.41 (NEW 2026-05-03 — UI controls): The CommentsTab, SocialPostsTab, QuotesTab, and the inline `BillCommentsSection` editor SHALL render a numeric weight input (0..5, step 0.05) and a direction `<select>` (`+1 pro-Ukraine` / `0 unstated` / `-1 anti-Ukraine`) in place of the existing `[-1,+1]` slider. A live "Contribution: ±N.NN" readout adjacent shows `weight × direction`.
- AC-52.42 (NEW 2026-05-03 — publish pipeline): `scripts/publish-d1-to-kv.ts` SHALL project `weight` and `direction` (camelCase) into KV under `comment:v1:*`, `social-post:v1:*`, `quote:v1:*`. The legacy `scoreAdjustment` field SHALL NOT appear in any new KV record.
- AC-52.43 (NEW 2026-05-03 — embed read shape): `useRepComments`, `useRepQuotes`, `useRepStatements`, and the rendered chips in `CommentExpand` / `StatementsList` SHALL consume `weight + direction` from KV. The displayed signed contribution chip uses `direction × weight` (range `[-5, +5]`).
- AC-52.44 (NEW 2026-05-03 — score formula contribution): `useUkraineScore` SHALL append one synthetic action per comment / post / quote with `direction !== 0`. Per-row mapping: `valence = 'voted-pro' if direction === +1 else 'voted-anti'`, `weight = comment.weight`. `computeUkraineScore`'s formula is unchanged byte-for-byte; only the input action list grows. The "contributing actions" `n` for FR-55 Bayesian shrink SHALL include comments/posts/quotes with `weight > 0 ∧ direction !== 0`.
- AC-52.45 (NEW 2026-05-03 — spec-as-truth correction): Pre-V4 the `comments.score_adjustment` field was stored, displayed as a chip, and editable, but **never entered `computeUkraineScore`** — it was dead weight. AC-52.44 wires comment/post/quote contributions into the score for the first time. ADR-019 records the additive (not substitutive) nature of this change. Existing reps with comments SHALL see their score recomputed on the next publish; a delta CSV (`scripts/check-score-deltas.ts`) SHALL be run before each environment migration to surface tier crossings.
- AC-52.46 (NEW 2026-05-03 — KV is read-through cache of D1, not a separate snapshot): The data flow becomes `Congress.gov API → D1 → KV (read-through cache) → edge`. The embed read routes (`/api/bills/*`, `/api/comments/*`, `/api/social-posts/*`, `/api/quotes/*`) SHALL serve from KV when present, fall through to D1 on miss, project the D1 rows into the existing KV record shape, write the projection back into KV, and return. Congress.gov is consulted ONLY by D1's freshness check (AC-52.49) — never on a hot read path. The legacy `scripts/publish-d1-to-kv.ts` is RETAINED as a manual warmer / debug tool, NOT part of the normal flow. The "curator" role is removed; researchers (admin SPA) are the sole writers of D1.
- AC-52.47 (NEW 2026-05-03 — KV invalidation on D1 mutation): Every D1 write inside `proxy/d1/admin-store.ts` (create / update / delete on `bills`, `votes`, `comments`, `social_posts`, `quotes`) SHALL invalidate the corresponding KV keys atomically with the audit-log batch. Mapping: `bills` → `bill:v1:{bill_id}`; `votes` → `bill:v1:{bill_id}` (votes are nested in the bill record); `comments` → `comment:v1:{bill_id}`; `social_posts` → `social-post:v1:{bioguide_id}`; `quotes` → `quote:v1:{bioguide_id}`. The next embed read repopulates the cache from D1 on demand. KV writes carry no TTL — invalidation is explicit (per user decision: "hours not days, we can invalidate directly"). The publish script's TTL behavior is unchanged but irrelevant on the hot path. Tests SHALL assert that a researcher edit deletes the affected KV key(s) before returning success.
- AC-52.48 (NEW 2026-05-03 — embed cold-D1 fallback): When the embed requests data for a `bill_id` (or `bioguide_id`) that has no KV record AND no D1 row, the read route SHALL return `404 not_found` with the FR-37 error envelope. The embed front-end SHALL handle 404 gracefully (no error banner — render an "Unknown bill" placeholder for bill routes, an empty-list state for collection routes). Every 404 SHALL be logged at `level: 'warn'` with the inbound `traceId`, the requested key, and `routeClass`, so ops can grep Logpush for "researcher hasn't imported yet" patterns.
- AC-52.49 (NEW 2026-05-03 — D1 freshness via scaling backoff): Each D1 row that originated from Congress.gov SHALL carry two timestamps: `congress_update_date` (the upstream `updateDate` at last fetch) and `last_freshness_check_at` (when our worker last asked Congress.gov "is this stale"). A scheduled cron walks the bills table once an hour, picks a working set per a scaling-backoff schedule, hits Congress.gov's bill-detail endpoint for each, compares `updateDate`, and if changed re-runs the import (refreshing static columns, preserving researcher curation per AC-52.50) and invalidates KV per AC-52.47. Backoff schedule:
  - bill seen / refreshed < 24h ago → recheck every 1h
  - < 7 days → recheck every 3h
  - < 30 days → recheck every 12h
  - ≥ 30 days → recheck once per day
  Implementation: `last_freshness_check_at + interval(seen_recency) ≤ now`. Researcher-edited columns are preserved; only Congress facts (title, latest_action, summary, etc) refresh. The admin SPA SHALL also expose a "Refresh from Congress now" button per bill that bypasses the schedule and forces an immediate check.
- AC-52.50 (NEW 2026-05-03 — refresh preserves researcher curation): When a bill row refreshes from Congress.gov (either scheduled or admin-triggered), the following columns are NEVER overwritten: `bills.direction`, `bills.direction_reason`, `bills.featured`, `bills.label`. On the votes table, `weight`, `direction_multiplier`, `weight_reason` are preserved. Comments / posts / quotes are 100% researcher-authored and are never touched by the freshness pipeline. Tests SHALL assert: a bill with `direction = 'pro-ukraine'` and `featured = 1` retains both after a forced refresh that returns a new title from upstream.
- AC-52.51 (NEW 2026-05-03 — read-through cache implementation): `proxy/routes/api-bills.ts` (and analogues for comments / social-posts / quotes) gain a fallthrough: on KV miss, query D1 directly via `D1_VOTER_INFO`, project to the canonical KV record shape via the existing `projectBill` / `projectComments` / `projectSocialPosts` / `projectQuotes` (in `scripts/publish-d1-to-kv.ts` — extracted into `proxy/services/kv-projector.ts` so both the cron warmer AND the read path consume one implementation), write to KV (no TTL), then return. The D1 query and KV write happen in parallel where possible. The route logs both `cache_hit` and `cache_miss` as a structured event with the inbound `traceId`. First-request latency may be 50–150ms higher (two D1 round-trips per the user's "slower-not-slow" decision); subsequent KV-warm requests serve in <10ms.
- AC-52.57 (NEW 2026-05-03 — display_title): Bills carry a researcher-editable `display_title TEXT` (nullable) used as the short blurb in the SPA list and embed surfaces. Falls back to `bills.title` when null. The schema's `Naming` group SHALL render `display_title` as a `width: 'long'` text input above the official `title`. The list-row label uses `display_title` when present, otherwise the first 60 chars of `title`.
- AC-52.58 (NEW 2026-05-03 — sponsor + cosponsors): On import, the orchestrator SHALL pull `/v3/bill/{c}/{type}/{n}/cosponsors` (paginated; collect all pages) and persist (a) the `bills.sponsor_bioguide_id / sponsor_full_name / sponsor_party / sponsor_state` columns from the bill detail's `sponsors[0]`, and (b) one `bill_cosponsors` row per cosponsor with `is_original_cosponsor`, `sponsorship_date`, `sponsorship_withdrawn_date`, party, state, district. The admin SPA SHALL render a collapsible "Sponsorship" section below the bill state pills showing: sponsor (party/state, original-cosponsor count), each cosponsor with date and original-cosponsor marker, and a count badge in the section heading. Re-imports refresh fully (cosponsor rows are upstream-owned, no curation to preserve).
- AC-52.59 (NEW 2026-05-03 — actions + Congressional Record): On import, the orchestrator SHALL persist every `actions[]` row from `/v3/bill/{c}/{type}/{n}/actions` into `bill_actions`, including the `sourceSystem.name`, the action text + date + code, and any `recordedVote` reference. When an action's `sourceSystem.name === "Library of Congress"` AND it carries a Congressional Record URL (via `actionCodes` or an attached `congressionalRecord` field), the URL + citation SHALL be persisted on the same row. The admin SPA SHALL render a collapsible "Action history" section below Sponsorship showing each action with its date, source, text, an `↗ Open` link to the Congressional Record (if present), and an inline tag when the action references a recorded vote (linking to that vote row in the Roll-call votes section).
- AC-52.60 (NEW 2026-05-03 — Senate vote URL fallback): When a vote row's `chamber === 'Senate'` and the inline-context disclosure renders a fallback link, the link SHALL prefer (in order): (1) the row's `votes.url` if it points at `senate.gov` AND ends in `.htm` or has no extension, (2) a derived human-readable URL `https://www.senate.gov/legislative/LIS/roll_call_lists/roll_call_vote_cfm.cfm?congress={c}&session={s}&vote={rc:0>5}`, (3) the row's raw `url` as last resort. The XML votes URL (`vote_{c}_{s}_{rc}.xml`) SHALL NOT be the primary fallback link since it renders as raw XML in a browser.
- AC-52.61 (NEW 2026-05-03 — vote-row single-line edits): On existing vote rows, the editable fields (Weight, Direction, Vote URL `↗ Open`, Weight rationale) SHALL render on a single horizontal flex row that wraps to a second line only at narrow viewports. Removes the previous two-row split (weight+direction on one line, URL static row + rationale on a separate line). Change-notes + Save/Delete remain on the action row beneath. Tests SHALL assert the four editable controls are siblings of one container.
- AC-52.62 (NEW 2026-05-03 — inline vote context pre-expanded, single line): The inline-context strip beneath each existing roll-call vote row SHALL be pre-expanded (no toggle button); the data fetch SHALL happen on row mount. Render shape is one horizontal line: `Q: <question> · Result: <result> · Totals: Y N · N N · P N · NV N`. On error, the strip SHALL collapse to one line `"Could not load vote context: <reason> — open source ↗"` with a link to the chamber-appropriate human-readable page. The collapse/expand toggle from earlier AC-52.26 is superseded. Tests SHALL cover: (a) on mount, exactly one fetch fires for House votes; (b) the rendered line contains all four totals; (c) error path renders the fallback link.
- AC-52.63 (NEW 2026-05-03 — vote row inline references): Each existing roll-call vote row SHALL render a `VoteRelatedReferences` strip below the inline context. The strip queries `/api/admin/actions?billId={bill_id}` once per row mount, finds the action whose `(recorded_chamber, recorded_roll_call)` matches the vote's `(chamber, roll_call)`, and surfaces: `Action: <action_text>` plus an `↗ Congressional Record (citation)` link when the matched action carries a `congressional_record_url` or citation. When no matching action is found (cold backfill state), the strip renders nothing (no clutter). Tests SHALL cover: (a) match found → action_text + CR link visible; (b) no match → strip absent; (c) match with no CR → no link rendered.
- AC-52.64 (NEW 2026-05-03 — Senate inline context via XML): When `chamber === 'Senate'`, the inline-context strip SHALL fetch the canonical Senate vote XML at `/api/senate/legislative/LIS/roll_call_votes/voteCSS/vote_C_S_RC.xml` (zero-padded 5-digit roll-call number) and parse it inline via `parseSenateVoteContextXml`. The parser extracts `<vote_question_text>`, `<vote_result_text>`, and the `<count>` totals (`<yeas>`, `<nays>`, `<present>`, `<absent>` — the last maps to `notVoting`). The same `Q · Result · Totals` render shape as House applies. The legacy "Senate vote context not yet inlined — open senate.gov ↗" placeholder is superseded. Tests SHALL cover: (a) parser extracts question + result; (b) parser extracts totals from `<count>`; (c) malformed XML / missing tags fall back to placeholder strings + zero totals; (d) component fetches from the senate proxy URL with zero-padded vote number.
- AC-52.65 (NEW 2026-05-03 — Comments tab removed): Comments are bill-level researcher content edited inline inside the Bills editor (BillCommentsSection per AC-52.16). The standalone top-level Comments tab in the admin SPA is removed; clicking the Bills tab and selecting a bill is the only path to view or edit comments. The `comments` D1 table and the `/api/admin/comments` endpoints are unchanged — only the SPA navigation drops the standalone tab. Tests SHALL assert the tab strip contains Bills, Statements, Quotes, Activity (no Comments) and that no `/comments` route in the admin SPA is reachable.
- AC-52.66 (NEW 2026-05-03 — Congressional Record citation extraction): Congress.gov's `/v3/bill/.../actions` endpoint embeds Congressional Record references inside the action's `text` field (e.g. `"… (text: CR H1405-1407)"` or `"… Page S1234"`). The structured `congressionalRecord.url` / `.citation` fields are NOT reliably populated. The orchestrator SHALL extract a citation by regex from `action.text` matching the patterns: `\(text:\s*CR\s+([HSE]\d+(?:-\d+)?)\)`, `\bCR\s+([HSE]\d+(?:-\d+)?)\b`, or `\bPage\s+([HSE]\d+(?:-\d+)?)\b`. The matched citation SHALL be persisted to `bill_actions.congressional_record_citation`. The URL field stays NULL when the API doesn't supply one (researchers can search the citation on congress.gov manually). Tests SHALL cover: (a) `(text: CR H1405-1407)` → citation `H1405-1407`; (b) `Page S1234` → `S1234`; (c) action with no CR ref → null citation; (d) the structured `congressionalRecord` field still wins when present. Pure helper `extractCongressionalRecord(text)` SHALL be exported for unit testing.
- AC-52.68 (NEW 2026-05-03 — Save flashes change-notes when empty on update): The inline Roll-call vote editor and the inline Comment editor SHALL keep the `Save` button **enabled** at all times (only disabled while a request is in flight). When a researcher clicks `Save` on an existing row whose change-notes input is empty (whitespace-only counts as empty), the editor SHALL: (a) NOT issue the PATCH; (b) flash the change-notes input by applying a transient red-border + light-red-background style + `tk-flash` keyframe animation for ~800ms, then revert; (c) set `aria-invalid="true"` on the input for the flash duration so screen readers announce the validation miss. This SUPERSEDES the earlier AC-52.23(d) wording that said Save was disabled until change-notes is non-empty — silent-disable produced "Save does literally nothing" UX. Add (create) flows are unaffected — change-notes is optional on add. Tests SHALL cover: (i) Save button on an existing-row editor is NOT disabled when change-notes is empty; (ii) clicking Save with empty change-notes does NOT fire a PATCH; (iii) clicking Save with empty change-notes sets `aria-invalid="true"` on the change-notes input; (iv) clicking Save with non-empty change-notes fires the PATCH normally and clears the reason input on success.
- AC-52.27 (NEW 2026-05-03 — vote editor: static identifiers + labeled editable fields): The inline Roll-call vote editor SHALL split row fields into two zones: (1) **Static identifiers** (chamber, congress, session, roll-call#, date, kind) sourced from the upstream Congress.gov API — rendered as plain read-only text with field labels (e.g. `Chamber: House  ·  Roll-call: 149  ·  2024-04-20  ·  passage`), NOT as inputs. Researchers SHALL NOT be able to mutate them via the SPA, since per AC-54.1 only `weight`, `direction_multiplier`, `weight_reason`, and `url` are researcher-editable. (2) **Editable fields** (`weight`, `direction_multiplier`, `weight_reason`, `url`) rendered as labeled inputs — every input SHALL have a visible label adjacent (left or above), no naked numbers, no placeholder-only fields. The `weight_reason` and per-row `change-notes` inputs SHALL be capped to a comfortable single-line width (≈ 60–80ch via `max-width: 60ch` or equivalent) — they SHALL NOT span the full editor width since longer rationales belong in audit history, not in the inline row. The vote `url` SHALL render an `↗ Open` external link to the right of the input when the value passes `sanitizeUrl` (preserves AC-52.25). For `Add` rows (creating a new vote), the static identifiers WILL still need to be entered — that's the only path to attach a vote to a bill — so the Add row SHALL show those as inputs (with labels), then once persisted they become read-only on subsequent renders. Tests SHALL cover: (a) an existing-row editor renders chamber/congress/session/roll-call/date/kind as text, NOT as form inputs; (b) every editable input has an associated `<label>` (or `aria-labelledby`) with visible text; (c) `weight_reason` and `change-notes` inputs have a max-width ≤ 60ch; (d) the `↗ Open` link still renders for valid URLs.
- AC-52.24 (NEW 2026-05-03 — bill-direction context above votes section): Above the inline Roll-call votes editor in the Bills tab, the SPA SHALL render a one-line context strip showing the bill's `direction` and what `direction_multiplier = +1` and `−1` mean for *this* bill. Example for `direction = pro-ukraine`: "Bill direction: **pro-ukraine** — `+1` means voting **for** Ukraine, `−1` means voting **against**." Renders the same shape for `anti-ukraine` (signs swapped) and `ambiguous` (no positional gloss, just the bill direction). The strip SHALL re-derive when the bill editor's `direction` field changes — researchers flipping the bill's direction immediately see what their per-vote multipliers now mean. Tests SHALL assert the rendered strip text for each of the three direction values.
- AC-52.25 (NEW 2026-05-03 — vote URL field + click-through): The inline vote editor SHALL render the existing `votes.url` column as an editable text input PLUS an `↗ Open` external link to the right when the value is a syntactically-valid http(s) URL (passes `sanitizeUrl`, same posture as the bill's Congress.gov URL field, AC-52.17). Empty / invalid → no link. The link opens `target="_blank" rel="noopener noreferrer"` and SHALL NOT mutate editor state. Tests SHALL assert: (a) valid URL → `↗ Open` element with matching href; (b) empty / invalid → no link; (c) click-through does not flip the row's draft-dirty / save state.
- AC-52.26 (NEW 2026-05-03 — inline Congress.gov vote-context excerpt): Each vote row in the inline editor SHALL provide an "Inline context" disclosure that, when opened, lazy-loads the structured vote data from Congress.gov (House votes only in V4 — Senate XML excerpt is out of scope) and renders: the legislative `voteQuestion`, the `result`, and aggregate per-position vote totals (Yea / Nay / Present / Not voting) computed by summing across the response's `votePartyTotal[]`. The disclosure SHALL fetch from the existing public route `GET /api/congress/v3/house-vote/{congress}/{session}/{rollCall}` — same-origin from the admin SPA, gated by Cf-Access at the edge for `/admin*` so the cookie auth carries; PREVIEW_MODE bypasses origin-allowlist on every env so no new admin proxy is needed. The disclosure SHALL fetch at most once per row per session (cache the parsed result in component state); collapsing and re-expanding SHALL NOT re-fetch. For Senate rows, the disclosure SHALL render a "Senate vote context not yet inlined — open Congress.gov" link to the row's `url` (or to `senate.gov` if the row has no URL) instead of attempting a fetch. Errors from the upstream SHALL render inline as "Could not load vote context: {detail}" without breaking the editor. Tests SHALL cover: (i) opening a House row's disclosure issues exactly one fetch and renders the question / result / totals; (ii) collapsing + re-expanding does NOT re-fetch (same memoized result); (iii) a Senate row renders the fallback link, no fetch; (iv) an upstream 5xx renders the error message and leaves the editor usable.
- AC-52.23 (NEW 2026-05-02 — inline editors replace "+ Add (T-133)" stub): The inline Roll-call votes and Comments sections under the Bills editor SHALL render full create/update/delete editors directly in the section, NOT a read-only list with a disabled "+ Add (T-133)" placeholder. The placeholder language and the T-133 deferral introduced by an earlier draft of AC-52.16 are SUPERSEDED. Specifically: (a) each existing vote row SHALL render its editable columns (`chamber`, `roll_call`, `kind`, `weight`, `direction_multiplier`, `weight_reason`) as inputs on a single line, with a per-row change-notes input and `Save` / `Delete` buttons; (b) each existing comment row SHALL render its editable columns (`attached_to_roll_call_id`, `body_markdown`, `score_adjustment`) as inputs, with a per-row change-notes input and `Save` / `Delete` buttons; (c) at the bottom of each section, a single "new" row SHALL render the same inputs (no change-notes — creates don't require one) and an `Add` button; (d) Save SHALL be disabled on existing-row updates until the change-notes input is non-empty (AC-50.8 client-side mirror — same posture as the bill editor itself, AC-52.18); (e) on save / delete success the section SHALL refetch its rows so the editor reflects the newly-canonical state. Tests SHALL cover: (i) editing a vote's weight + change-notes + Save fires PATCH `/api/admin/votes/{id}` with `_reason` populated; (ii) Save is disabled with empty change-notes on update; (iii) Add row create fires POST `/api/admin/votes` with the form values; (iv) Delete fires DELETE with `?reason=` populated; (v) same shape for comments. The tab-strip-side change in AC-52.16 (no standalone Votes tab) is unaffected.
- AC-52.22 (NEW 2026-05-02 — billId-filtered list endpoints for inline sections): `GET /api/admin/votes?billId={bill_id}` and `GET /api/admin/comments?billId={bill_id}` SHALL return `{ items: [...] }` containing every row in the corresponding D1 table whose `bill_id` matches exactly. Without the `billId` query param, both endpoints SHALL return `{ items: [] }` (a deliberately-empty unfiltered list — bulk listing is out of V4 scope; researchers reach votes / comments only via the bill they're attached to, per AC-52.16). The filter parameter name is `billId` (camelCase) on the wire to match the SPA's existing `BillVotesSection` / `BillCommentsSection` fetch URLs; the underlying column is `bill_id` (snake_case). The endpoint SHALL NOT 404 when no rows match — an empty `items` array is the success shape. Order: votes by `(congress DESC, session DESC, roll_call ASC)`; comments by `created_at DESC`. Tests SHALL cover: (a) `?billId=X` with 2 matching votes returns both rows; (b) `?billId=X` with no matches returns `{ items: [] }` and 200 (not 404); (c) no query param returns `{ items: [] }`; (d) the same shape for `/api/admin/comments`. This AC closes a regression where `BillVotesSection` saw a stub `[]` response from the Worker even though D1 contained rows for the bill.

**Reconciliation with existing specs:**

- **FR-30 AC-30.3** references copying three R2 objects (`.iife.js`, `ukraineBills.json`, `ukraineVotes.json`). Post-ADR-011, those objects don't exist on the R2-as-datastore surface (widget bundle is served from Worker Sites; ukraineVotes.json was removed; ukraineBills.json is bundle-embedded). FR-44 AC-44.6 SUPERSEDES AC-30.3 with the KV-prefix-mirror semantics. AC-30.3 is retained as a historical marker with a ("superseded by FR-44 AC-44.6") note — see the task-list reconciliation.
- **FR-30 AC-30.5** explicitly defers remote-mode coverage until "the first merged remote-mode test lands." FR-44 AC-44.5 is that first merged remote-mode test. AC-30.5's warning emission requirement sunsets when AC-44.5 is implemented.
- **FR-30 AC-30.10** ("stg holds no persistent state worth preserving") is preserved exactly — FR-44's sync is always transient.

### FR-45: Test Coverage Reporting & Thresholds (NEW v2.6.x UAT)

**Problem.** The project has 896 passing tests across unit / integration / e2e tiers (FR-44), but there is no mechanism to:

1. Measure what fraction of the library code those tests actually cover.
2. Compare coverage between tiers, so a regression where (e.g.) a hook-level integration test is silently replaced by a purely-mocked unit test produces a visible signal.
3. Gate merges on coverage floors, so new code can't silently ship uncovered.

Before this FR the `coverage/` directory existed only because `test:coverage` had been run manually once; its scope was whatever the most recent hand-run covered and had no freshness guarantee. The release-worthiness audit (2026-04-19) flagged this explicitly: "Coverage report scope is narrow — `src/components`, `hooks`, `utils`, `proxy/security`, `proxy/router.ts`, `proxy/worker.ts` all absent. The reported 99.8% overall lines is misleading."

**Solution.** Formalize coverage as a first-class part of the test ladder (FR-44). Every tier runs with its own coverage report; a combined roll-up is generated; thresholds are checked in CI.

**Design:**

- Coverage provider: `@vitest/coverage-v8` (already a devDependency).
- Coverage config lives in `vitest.config.ts` under `test.coverage` so it applies to every run (including `npm test`, not just `npm run test:coverage`).
- Scripts:
  - `npm run test:coverage` — full suite (all tiers) → `coverage/combined/`
  - `npm run test:coverage:unit` — unit only → `coverage/unit/`
  - `npm run test:coverage:integration` — integration only → `coverage/integration/`
  - `npm run test:coverage:e2e` — e2e only → `coverage/e2e/`
- Reporters: `['text', 'json', 'json-summary', 'html', 'lcov']` per tier.
- Roll-up script: `scripts/coverage-report.mjs` reads the four `coverage-summary.json` files and prints a unified table to stdout; exits non-zero if any tier falls below its floor. Used by CI.

**Acceptance criteria:**

- AC-45.1: `vitest.config.ts` SHALL declare a `test.coverage` block with provider `'v8'`, reporters including `'json-summary'` and `'html'`, and an explicit `include` list covering `src/**/*.{ts,tsx}` and `proxy/**/*.{ts,tsx}` AND an explicit `exclude` list covering the following categories of files that have no runtime semantics to cover:
  1. **Build-tool scripts** under `scripts/**` (`build-curated-bills.ts`, `build-vote-rosters.ts`, `publish-to-kv.ts`, `build-sri.mjs`, `extract-openapi.mjs`, `score-many.mjs`, `check-hawks.mjs`, `perf-check.mjs`, `sync-stg-data.ts`, `purge-members.ts`, `warm-member-cache.mjs`, `publish-curated-bills.mjs`, `core-bottom.mjs`, `check-lankford.mjs`). These are one-shot build/ops utilities and are not under test because exercising them requires Cloudflare bindings or real network.
  2. **Entry points** that bind only (`src/main.tsx`, `src/embed.tsx`) — they instantiate the widget into a host DOM element; the widget itself has its own tests.
  3. **Dev-harness-only components** not shipped in the production bundle (`src/EnvPicker.tsx`).
  4. **Type-only files** (`src/types/**`). These compile to nothing.
  5. **Test support** (`tests/fakes/**`, `tests/setup.ts`, `tests/**/fixtures/**`, `tests/**/*.test.{ts,tsx}`).
  6. **Generated artifacts** (`dist/**`, `node_modules/**`, `coverage/**`).
- AC-45.2: Coverage thresholds SHALL be declared in `vitest.config.ts` under `test.coverage.thresholds` with floor values:
  - `lines: 85`, `statements: 85`, `functions: 85`, `branches: 80`.
  When `npm run test:coverage` is invoked and any metric drops below its floor, the process SHALL exit non-zero. Rationale: the current library-code coverage is 95–100% across `src/components`, `src/hooks`, `src/services`, `src/utils`, and most of `proxy/`. 85/80 sets a floor that catches regressions without being so tight that a single new un-tested helper blocks merges — the actual target is "whatever we have today, minus a small slack."
- AC-45.3: Three per-tier scripts SHALL be available:
  - `test:coverage:unit` → runs only `tests/unit/**/*.test.{ts,tsx}` with output at `coverage/unit/`.
  - `test:coverage:integration` → runs only `tests/integration/**/*.test.{ts,tsx}` with output at `coverage/integration/`.
  - `test:coverage:e2e` → runs only `tests/e2e/**/*.test.{ts,tsx}` with output at `coverage/e2e/`.
  Per-tier runs SHALL use the same `include` / `exclude` lists as the full run but MAY relax thresholds — integration + e2e coverage is cumulative over unit, not a replacement, so a per-tier floor would be misleading.
- AC-45.4: A roll-up script `scripts/coverage-report.mjs` SHALL read each tier's `coverage-summary.json` after all four runs complete and print a four-row Markdown-compatible table with columns `tier | statements | branches | functions | lines | delta vs combined`. The script SHALL exit 0 if all four summaries exist and the combined run met its thresholds, non-zero otherwise.
- AC-45.5: A meta-test `tests/unit/coverageThresholds.test.ts` SHALL verify that `vitest.config.ts` declares `thresholds` matching AC-45.2. This is a self-documenting guardrail — if the thresholds are accidentally relaxed in config, the test fails.
- AC-45.6: Coverage output directories (`coverage/`, including `coverage/unit`, `coverage/integration`, `coverage/e2e`, `coverage/combined`) SHALL be listed in `.gitignore`. Only the config and the roll-up script are committed.
- AC-45.7: Documentation of the coverage surface is out of scope for this FR — the existing `docs/ci-cd.md` is the eventual home, but FR-44's CI gating is already stubbed there and that doc is itself deferred. The roll-up script's stdout is the definitive "current coverage" report.

**Rationale for file-level exclusions:** including `scripts/**`, entry points, and type-only files in the denominator makes the combined number unhelpful (today it reports 68.44% when the library is actually 95%+). The exclusion list is the honest denominator — what we ship + test, not what happens to live in the repo.

### FR-46: About-the-System Info Panel (NEW v2.6.x UAT, REVISED 2026-04-19)

**Problem.** UAT voters get a numeric score and a per-action breakdown, but the domain reasoning — *why* is a cloture-vote weight 0.45? *Why* does a sponsorship amplify 1.5×? What bills are actually being tracked? — has no surface in the UI. The score-breakdown panel (FR-43 AC-43.10) shows *how* a specific member's score was computed; this About panel shows *why* the system computes scores the way it does, plus the full live roster of bills it tracks.

**Solution.** A lightweight info panel opened from a `ⓘ About this system` button in the widget footer. Scope is **the scoring system and the tracked bill roster only** — no discussion of security, proxy routing, CORS, upstream APIs, or other technical/deployment design. Two content areas:

**Part A — How scoring works (static, driven by scoring constants):**

1. **Purpose** — one paragraph on what the score measures.
2. **The formula** — `score = Σ(sign × amp × weight) ÷ Σ(amp × weight)`, with a worked example.
3. **The valence table** — 5 rows driven from `VALENCE_SIGN` / `VALENCE_AMPLIFIER` / `VALENCE_LABEL` in `services/valence.ts`.
4. **The weight table** — vote-kind → weight mapping (passage = 1.0, cloture = 0.45, motion-to-proceed / recommit / waive-budget = 0.30, motion-to-table / motion-to-reconsider = 0 → excluded).
5. **Confidence tiers** — the `'low' | 'moderate' | 'full'` ladder and the saturation signal (FR-43).

**Part B — Tracked bills browser (live data, tabbed):**

6. **Tabbed browser** over the full contents of the bundled `src/data/ukraineBills.json`. One tab per direction category: `Pro-Ukraine`, `Anti-Ukraine`, `Neutral`. A tab is hidden when its bucket is empty. Each tab contains:
   - A **bills table** (slug · label · featured-flag · direction-reason · latest-action) rendered with the same formatting conventions as FR-43 AC-43.14's breakdown table (slug bold uppercase, description regular, action caption uppercase-small-caps).
   - Under each bill, a nested **votes table** (chamber · roll-call · kind · weight · action), collapsed by default with click-to-expand — same affordance as FR-43 AC-43.14's per-row expand. Kind rows whose weight is 0 SHALL render as "excluded" in muted italic (same treatment as the breakdown table's skip rows).
7. *(Removed 2026-04-19 UAT — closing note stripped; panel content ends with the tracked-bills browser.)*

**Scoping rules (what this panel SHALL NOT say):**

- No mention of CORS, proxies, rate limits, Cloudflare, KV, R2, tiered caching, observability, deployment environments, or any other infrastructure or security detail.
- No mention of upstream API endpoints (Congress.gov, Senate.gov, Census) beyond "the system reads directly from public legislative data." The voter's question is "what does the score measure and which bills?" — everything else is out of scope.

**Keep-in-sync rule:**

- AC-46.KIS: Any change to scoring constants (`VALENCE_SIGN`, `VALENCE_AMPLIFIER`, `VALENCE_LABEL`), to the set of vote kinds + their weights, or to the curated bill set schema SHALL be accompanied by a same-PR update to the About panel's content or table structure if the change would leave the panel stale. The valence table is auto-synced via imports (AC-46.1); the weight table + copy are hand-written and MUST be kept current. Per AIDD Phase 4 ("Refactor fourth — clean up while the suite stays green"), this includes updating/adding tests. The About panel's spec residency (this FR) is the single place developers check when they touch scoring.

**Acceptance criteria:**

- AC-46.1: A new component `src/components/AboutSystemPanel.tsx` SHALL render Part A (formula, valence table, weight table, confidence) and Part B (tabbed bills browser) as described. The valence table SHALL be driven by the constants from `services/valence.ts` so it stays sync automatically.
- AC-46.2: A trigger button SHALL be placed in `.viw-root-footer` with accessible name "About this system" and label glyph `ⓘ About this system`. Clicking it opens the inline panel beneath the footer (not a modal).
- AC-46.3: The bills browser SHALL be sourced by importing `src/data/ukraineBills.json` at module-init time. No runtime network. The import presents every curated bill grouped by `direction` (`pro-ukraine` / `anti-ukraine` / `neutral`). Tab order is: Pro-Ukraine → Anti-Ukraine → Neutral. Tabs with zero bills SHALL NOT render.
- AC-46.4: The panel SHALL close when the voter clicks the trigger button a second time OR presses `Escape` while focus is inside the panel. (Unlike FR-43 AC-43.15, the About panel does NOT close on click-whitespace — click-whitespace would collide with the bills-browser expand affordance and the tab-switching click targets.)
- AC-46.5: The bill rows SHALL reuse the FR-43 AC-43.14 formatting: slug (`HR 815`, `S. 1241`) in bold italic uppercase, bill label as a normal-weight description, a small-caps "featured" / "became law" / direction-reason caption underneath. Each bill row SHALL carry its valence CSS class (`viw-valence-sponsor-pro` / `voted-pro` / `unstated` / `voted-anti` / `sponsor-anti`) so the color scheme matches the score-breakdown table.
- AC-46.6: Click-to-expand on a bill row reveals a nested votes table. Table columns: `Chamber`, `Roll-call`, `Kind`, `Weight`, `Action`. Vote-kind rows where `weight === 0` SHALL render as "excluded (ambiguous procedural)" in muted italic.
- AC-46.7: The About panel SHALL NOT mention CORS, proxies, rate limits, Cloudflare, KV, R2, caching, observability, deployment environments, or specific upstream API endpoints. A test SHALL assert the rendered panel's text content does NOT contain these terms.
- AC-46.8: The About panel and the score-breakdown panel (FR-43) SHALL be independently operable — opening one does not close the other. Their `aria-controls` SHALL reference different ids.
- AC-46.9: Tests SHALL cover: trigger open/close; valence table renders all 5 valences in canonical order; weight table calls out passage/cloture/0.30 rows and excluded rows; bills tab-bar renders exactly the direction tabs that have bills; clicking a tab switches the visible bill list; clicking a bill row reveals its votes table with the correct kind+weight for the first vote in the curated data; Escape closes the panel; the forbidden terms from AC-46.7 are absent from the panel's rendered text.
- AC-46.10 (NEW UAT 2026-04-19): On viewports < 640px the three About-panel tables (valence, vote weights, bills, votes) SHALL collapse to stacked row-cards. The `<thead>` row SHALL be hidden; each `<tbody>` row SHALL render as `display: block` with its leading `<th>` as the card headline and each `<td>` stacked beneath. Every `<td>` that would carry a column-header meaning SHALL also carry a `data-col` attribute whose value is the column's label; CSS renders that attribute as a small-caps inline prefix (`WEIGHT: 0.90`). The value and the label SHALL appear on the SAME LINE (inline label + value, not stacked) so each cell reads as a compact name/value pair.
- AC-46.11 (NEW UAT 2026-04-19): On viewports < 640px the bills-browser direction tabs SHALL render the shortened form `Pro (55)` / `Anti (2)` / `Neutral (5)` instead of `Pro-Ukraine (55)` etc. so all three tabs fit on one row without wrapping. The short/full labels live as sibling `<span>` children (`.viw-about-tab-label-full` + `.viw-about-tab-label-short`) toggled via CSS media-query `display` — both are present in the DOM for copy/screen-reader accessibility.
- AC-46.12 (NEW UAT 2026-04-19): Direction tabs SHALL carry a valence-derived background color matching the FR-15 palette (`--viw-valence-voted-pro-bg` for the Pro-Ukraine tab, `--viw-valence-voted-anti-bg` for Anti-Ukraine, `--viw-off` for Neutral) so voters can tell at a glance which bucket they're browsing. The active tab SHALL still use `--viw-yellow` to signal "this tab is open"; an underline accent in the direction's valence color preserves the direction hint on the active tab.
- AC-46.13 (NEW UAT 2026-04-19): Every bill row in the browser SHALL carry a link `Read on congress.gov ↗` pointing at the bill's `congressGovUrl` field. Every roll-call vote row in the nested votes table SHALL carry a link `View vote ↗` pointing at the vote's `url` field. Both links open in a new tab with `rel="noopener noreferrer"` and pass through `sanitizeUrl` at the render boundary (AC-31.1). The link is a distinct interactive target from the bill-expand button — clicking the link does NOT toggle the expand state (`e.stopPropagation()` on the anchor).
- AC-46.14 (NEW UAT 2026-04-19): Clicking anywhere on a bill row's non-interactive areas SHALL toggle the expanded state — the main row (`<tr>` containing the bill-toggle button + votes-tracked + became-law cells) and the expanded row (`<tr>` containing the votes-cell + "No roll-call votes tracked" empty-state) both carry an onClick that calls `setOpenBill(isOpen ? null : key)`, guarded against interactive descendants (buttons, anchors) via `t.closest('button, a, input, [role="button"]')`. The expand toggle + link clicks stay authoritative for their own semantics; the broader click zones make the expanded area dismissible without hunting for the caret.



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

### FR-47: Isolated Per-Branch Preview Environments (NEW v2.6.x UAT)

**Problem.** Reviewers want to click a link in a PR and see that branch running live, without it affecting the shared dev/uat/stg/prod ladder. An earlier attempt (T-105 initial) proposed a shared `env.preview` wrangler block where every `preview/*` branch deployed under the same Cloudflare env and KV namespace. That approach has two failure modes:

1. **KV cross-contamination.** A preview branch that mutates schema (new field, renamed shard prefix, recomputed index) overwrites the shared KV, breaking every other preview on the same namespace. The release-worthiness audit's Spec-as-Truth principle applies: previews should be isolated or they aren't previews — they're shared-mutable staging.
2. **Secret + rate-limit co-mingling.** Shared env means shared `CONGRESS_API_KEY` secret exposure, shared rate-limit bucket (one preview hammering Congress.gov burns the whole preview env's quota), shared analytics dataset (no way to slice observability by branch).

**Solution — fully-isolated per-branch preview envs.** For every branch matching `preview/{slug}`, CI generates a freshly-scoped set of Cloudflare resources, deploys a Worker that uses them, posts the URL, and tears everything down on branch delete.

**Per-preview resource set (isolated):**

- **Worker**: `voter-info-widget-proxy-preview-{slug}` — deployed via `wrangler deploy --env preview-template --name <name>`.
- **KV namespace**: `voter-info-widget-preview-{slug}` — created on first deploy via `wrangler kv namespace create`, ID captured and passed to the Worker via `--kv-namespace KV_VOTER_INFO=<id>`. Deleted on teardown.
- **R2 bucket**: `voter-info-widget-archive-preview-{slug}` — created on first deploy, deleted on teardown. Empty by default; populated on-demand by warm-on-miss.
- **Analytics dataset**: `voter_info_widget_preview_{slug}` — namespaced analytics so a preview's Logpush + Analytics Engine data doesn't mix with others.
- **Rate-limit namespace**: `{1005 base} + hash(slug) mod 100` — a deterministic offset so concurrent previews each get their own token bucket.
- **Secret**: `CONGRESS_API_KEY` — copied from the `dev` env's secret at deploy time (one-time `wrangler secret put` during the CI deploy job).

**Shared seed data:** every preview env starts empty. CI's deploy job runs `scripts/publish-to-kv.ts --env preview-{slug}` which copies the dev namespace's curator output (`bill:*`, `roll-call:*`, `name-index:*`, `state-members:*`) into the preview KV. Member profile records (`member:v1:*`) are populated on-demand via the Worker's read-through from Congress.gov, just like prod — so previews don't need to pre-copy them.

**Slug rules:** `preview/{slug}` → slug is lowercased, non-`[a-z0-9-]` replaced with `-`, max length 40 chars (Cloudflare name limits). Slugs `dev`, `uat`, `stg`, `prod`, `preview` are reserved and SHALL be rejected.

**Acceptance criteria:**

- AC-47.1: Pushing to a branch matching `preview/**` SHALL trigger `.github/workflows/preview.yml` which computes a slug from the branch name via the rules above.
- AC-47.2: On first push to a `preview/{slug}` branch: CI SHALL create a KV namespace named `voter-info-widget-preview-{slug}`, an R2 bucket named `voter-info-widget-archive-preview-{slug}`, and deploy a Worker named `voter-info-widget-proxy-preview-{slug}` with those resources bound. The Worker SHALL NOT be routed to `*.preview.vote.cogs.it.com` automatically; the CI workflow SHALL emit the raw `*.workers.dev` URL as the preview URL. (DNS wildcard provisioning is a separate one-time human step tracked in `docs/deployment.md`, not part of this FR.)
- AC-47.3: On subsequent pushes to the same `preview/{slug}` branch: CI SHALL reuse the existing KV + R2 resources (detected via `wrangler kv namespace list`) and only re-deploy the Worker. No resource re-creation.
- AC-47.4: On branch delete (GitHub `delete` event with `ref_type=branch` and ref matching `preview/**`), CI SHALL delete the Worker, the KV namespace, and the R2 bucket for that slug. Analytics datasets are append-only in Cloudflare's product surface and SHALL be left in place (they're cheap; CF expires their data after 90d automatically).
- AC-47.5: Reserved slugs (`dev`, `uat`, `stg`, `prod`, `preview`, or empty) SHALL cause the deploy job to exit with a failure message identifying the conflict. Reserved prefixes (`vote-`, `trackukraine-`) SHALL also be rejected to prevent impersonation-style naming.
- AC-47.6: A new `env.preview-template` block in `wrangler.toml` SHALL act as the template that CI's `--name`, `--kv-namespace`, `--r2-bucket`, and `--var` overrides populate per-deploy. The template SHALL NOT reference fixed KV/R2 IDs — the resource bindings are provided entirely via CLI flags. The block's only purpose is to set `vars` defaults (ENV_NAME, PREVIEW_MODE, ALLOWED_ORIGINS) and the `compatibility_date`.
- AC-47.7: Per-preview `ENV_NAME` SHALL be `preview-{slug}` so that FR-36 trace logs + FR-38 analytics points correctly attribute every preview's traffic back to its branch.
- AC-47.8: The preview Worker SHALL carry `PREVIEW_MODE=true` and `ALLOW_LOCALHOST=true` so origin enforcement matches dev semantics. Preview URLs SHALL be gated behind Cloudflare Access per FR-29 AC-29.2 (non-prod envs require Access). The Access policy SHALL include a wildcard-matched `*.preview.vote.cogs.it.com` application once DNS is provisioned; until then, the raw `*.workers.dev` URL inherits the account's default Access policy (which may be public — documented as a limitation).
- AC-47.9: The workflow SHALL post a sticky PR comment with the preview URL, the slug, the Worker name, and the deployment timestamp. If a previous sticky comment exists, it is updated in place rather than appended. Comment body format: `🔎 **Preview**: <url> · branch: <ref> · worker: <name> · deployed: <iso8601>`.
- AC-47.10: Teardown failures (resource already deleted, permission error, transient CF API 5xx) SHALL NOT fail the whole workflow run; the workflow SHALL log the failure, continue to attempt other resources, and report a summary at the end. Rationale: when multiple resources need to be cleaned up, a partial failure shouldn't leave orphaned resources that block re-creation.
- AC-47.11: A deploy-gate check SHALL reject the deploy if `CLOUDFLARE_API_TOKEN` lacks the scope to create KV namespaces (detected by trial `wrangler kv namespace create <name> --dry-run` returning an auth error). This prevents half-deploys where the Worker lands but its backing KV doesn't exist.
- AC-47.12: Tests SHALL cover the slug-derivation pure function in isolation (reserved slugs, punctuation normalization, length clamp, empty-input guard) plus a snapshot test for the `wrangler.toml` `env.preview-template` block shape. The actual CF resource lifecycle is NOT unit-tested (it's CI-only); it's validated manually on first use by pushing a `preview/smoke-test` branch.

**Out of scope:** per-branch DNS automation (`*.preview.vote.cogs.it.com`), Access policy automation (human task), cross-branch data sharing (each preview is a cold start), custom domain per preview.

### FR-48: Member Social Media Links (NEW 2026-04-19 UAT)

**Problem.** The detail panel currently shows a single "Official website" link. Voters habitually check a member's social accounts (Twitter/X, YouTube, Facebook, Instagram) to get a feel for the member's public stance on Ukraine and to follow ongoing statements. Congress.gov's API does not expose social handles, so we have to source them from elsewhere.

**Solution.** Pull from the community-maintained `unitedstates/congress-legislators` dataset — specifically `https://unitedstates.github.io/congress-legislators/legislators-social-media.json`. This is the de-facto source used by GovTrack, ProPublica, and most civic-tech projects. Fetch once per curator run, join against bioguide IDs, ship into the KV shards that feed the widget.

**Data model:**

```ts
interface MemberSocials {
  twitter?: string;   // screen name, no @ prefix
  facebook?: string;  // page slug
  youtube?: string;   // channel slug
  instagram?: string; // handle
}
```

`youtube_id`, `twitter_id`, `instagram_id` from the upstream feed are ignored — we only need human-readable handles to construct URLs at render time. Bluesky is not in the upstream dataset as of 2026-04; we can add it when it appears.

**URL construction (render-time, in the widget):**

- Twitter/X → `https://x.com/{handle}`
- Facebook → `https://facebook.com/{slug}`
- YouTube → `https://youtube.com/@{slug}` (legacy `/user/{slug}` redirects)
- Instagram → `https://instagram.com/{handle}`

All passed through `sanitizeUrl` (AC-31.1). All links render with `target="_blank" rel="noopener noreferrer"`.

**Acceptance criteria:**

- AC-48.1: `scripts/publish-to-kv.ts` SHALL fetch `https://unitedstates.github.io/congress-legislators/legislators-social-media.json` once per run, parse to a `Map<bioguideId, MemberSocials>`, and log the count. Transient failures (non-2xx, parse error, network timeout) SHALL NOT fail the curator run — log a warning and continue with an empty map.
- AC-48.2: The `socials` field (optional) SHALL land on the `MemberProfile` KV record (`member:v1:*`), the `StateMemberSummary` (`state-members:v1:*`), and the `NameIndexEntry` (`name-index:v1:*`) shards. Same-trip fetch — no separate KV prefix, no separate route.
- AC-48.3: `src/types/domain.ts#Representative` SHALL carry an optional `socials?: MemberSocials` field. Every transform in `useAddressLookup`, `useNameSearch`, and `RepDetail`'s enrichment path SHALL thread it through.
- AC-48.4: `src/components/RepDetail.tsx` SHALL render a `.viw-detail-socials` row of icon-links below the Official Website button when any social handle is present. Each icon SHALL be a recognizable glyph (unicode or inline SVG — pick whichever keeps the bundle lean), with `aria-label="{Member name} on {Platform}"` for screen readers. Missing handles SHALL NOT render an empty slot; only the present platforms show.
- AC-48.5: The social-links row SHALL NOT render on the overview MemberChip grid — it's a detail-only affordance. Chips stay visually compact.
- AC-48.6: A cache-bust parameter SHALL NOT be added to the upstream social-media-data URL; the unitedstates.github.io source has its own CDN + git-backed versioning.
- AC-48.7: Tests SHALL cover:
  - `RepDetail` renders one link per present handle, zero links when `socials` is undefined or empty
  - `RepDetail` does NOT render a broken `href` when a handle is present but malformed (sanitizeUrl returns null)
  - The publish-to-kv integration: a fixture social-media JSON feeds into a mocked curator run and the resulting `MemberProfile.socials` shape matches AC-48.3

### NFR-7: Documentation Secret-Leakage (NEW 2026-04-19 UAT)

- NFR-7.1: `docs/**`, `.github/**`, and any tracked workflow SHALL NOT contain:
  - API keys (Congress.gov, Cloudflare, any other)
  - Service tokens (CF Access client ID or secret)
  - Private encryption / signing keys
  - GitHub personal access tokens
- NFR-7.2: Cloudflare resource identifiers that are **not secrets** (KV namespace IDs, R2 bucket names, account ID, zone ID) MAY appear in tracked config. They are routing identifiers authenticated via the API token; per CF's own guidance they are safe to commit. The canonical copy lives in `wrangler.toml`; duplicates in `scripts/*.ts` exist for runtime use and SHALL reference the same values.
- NFR-7.3: Personal identifiers (emails) that appear in `docs/deployment.md` or `docs/spec.md` for the purpose of documenting an Access allowlist SHALL be treated as git-author metadata — they are already public via git commit history and scrubbing them from docs would be cosmetic, not security-effective.
- NFR-7.4: A pre-push or CI grep SHALL reject any commit that introduces a string matching one of the patterns in NFR-7.1 into tracked files. The pattern set lives in `scripts/secret-scan.mjs` (deferred — see T-106).
- NFR-7.5: Audit run on 2026-04-19 found **zero** actual leaks. Findings documented in T-106.

### FR-49: D1 as Editable Source of Truth (NEW v2.7.0)

**Problem.** Every piece of curated content — bills, vote weights, direction tags, the entire `ukraineBills.json` — lives in a hand-edited git-tracked JSON file. There is no audit trail of who changed what, no place to attach researcher commentary or social-post citations or quotes, and no way for anyone other than a developer with repo write to make a change. The score-quality work in V4 (per-vote tunable weight, newer-rep handling, negative-signal amplification) requires a writable, queryable, audited backing store.

**Solution.** A new **Cloudflare D1** database (`viw_researcher`) becomes the source of truth for editable content. The widget continues to read from KV for edge-fast lookups; a curator publish step (FR-51) projects D1 rows into the existing KV record shapes plus three new prefixes (`comment:v1:*`, `social-post:v1:*`, `quote:v1:*`). The **FR-32 AC-32.5 invariant — only the curator writes to `*:v1:*` KV prefixes — is preserved.** Researchers write to D1; the curator script writes to KV. `src/data/ukraineBills.json` is imported into D1 once via `scripts/seed-d1-from-json.ts`, then frozen as a one-time bootstrap seed.

**Acceptance criteria:**

- AC-49.1: A new D1 database SHALL be provisioned per environment (`viw_researcher_dev`, `viw_researcher_uat`, `viw_researcher_stg`, `viw_researcher_prod`) with a `D1_VOTER_INFO` binding in `wrangler.toml`. Per-env database IDs SHALL live in `wrangler.toml`; they are routing identifiers, not secrets (per NFR-7.2).
- AC-49.2: The D1 schema SHALL be defined in versioned SQL files under `migrations/d1/000N_*.sql`. Migration `0001_init.sql` SHALL create tables `researchers`, `bills`, `votes`, `comments`, `social_posts`, `quotes`, `score_adjustments`, `audit_log` per design.md §5.1. Foreign keys SHALL cascade on bill/vote delete; `audit_log` rows SHALL NOT cascade (audit must outlive the row it audits).
- AC-49.3: `scripts/seed-d1-from-json.ts` SHALL read `src/data/ukraineBills.json` and INSERT one row per bill into `bills`, one row per nested `votes[]` entry into `votes`. The seed SHALL be idempotent: re-running with no JSON changes SHALL produce zero new rows. The seed SHALL set `audit_log.actor = 'seed'` and `audit_log.reason = 'bootstrap from ukraineBills.json'` for every inserted row.
- AC-49.4: After the bootstrap seed lands in an environment, edits to `src/data/ukraineBills.json` SHALL NOT propagate to that environment. Enforcement uses a sibling marker file `src/data/ukraineBills.json.FROZEN` (a plain-text README, not JSON) whose body documents the freeze: "FROZEN — see FR-49. Edits go through the admin front-end (FR-52). The seed script reads this file once at bootstrap and refuses to re-seed after." The seed script (`scripts/seed-d1-from-json.ts`) SHALL check for the marker; if present it SHALL refuse to seed unless invoked with `--force-reseed`. Rationale (and supersession of an earlier draft): a previous version of this AC asked for a top-of-file `// FROZEN` comment inside the JSON itself, which is not legal JSON. The sibling file is the correct mechanism.
- AC-49.5: D1 row IDs SHALL be ULIDs (text), not autoincrement integers. ULIDs are sortable, globally unique, and safe to expose in URLs. A small `src/utils/ulid.ts` helper module SHALL emit them; tests SHALL assert ULID format `^[0-9A-HJKMNP-TV-Z]{26}$`.
- AC-49.7 (NEW 2026-05-02): The seed script (`scripts/seed-d1-from-json.ts`) SHALL truncate the `summary_json` payload to a maximum of **8 KB** of serialized JSON before INSERT. D1's per-statement size cap (~100 KB) is exceeded by the largest curated bill (the FY22/FY23 Consolidated Appropriations summaries are ~290 KB). Truncation SHALL preserve the `actionDate` / `actionDesc` / `updateDate` fields verbatim and SHALL truncate `text` to fit the 8 KB budget, with the truncation indicated by a trailing `… [truncated; full summary at congress_gov_url]` marker. Researchers needing the full summary read it from `bills.congress_gov_url` (Congress.gov is the canonical source). Tests SHALL cover: a bill with a < 8 KB summary lands verbatim; a bill with a 100 KB summary lands truncated with the marker; an empty / null summary lands as NULL.
- AC-49.6: D1 schema migrations SHALL be applied via `wrangler d1 migrations apply --env <env>`. `docs/deployment.md` SHALL document the apply order: dev → uat → stg → prod, each gated on a green smoke test against the prior env.

### FR-50: Admin API at the Edge — Cloudflare Access Gates Everything (NEW v2.7.0, REVISED 2026-05-02)

**Problem.** The admin front-end needs to write to D1, but the Worker is a public embed. The Sunday-clock-friendly choice is to put auth at the edge and not own session state in the Worker.

**Solution.** Cloudflare Access gates every admin path (`/admin/*` for the SPA, `/api/admin/*` for the write API). Cloudflare's edge handles login, MFA, allowlist, and session.

The Worker still independently **verifies the Cloudflare Access JWT** on every admin request — belt-and-suspenders defense against direct-origin bypass (e.g. an attacker who finds a `*.workers.dev` URL or DNS path that skips the Access app and forges the email header). The verification is a standard JWS signature check against Cloudflare's published JWKS, plus an `aud` claim match against the configured Access application audience tag. Spoofing the email header without a valid signed JWT → 401.

In addition: `workers_dev = false` SHALL be set in `wrangler.toml` so the Worker is not reachable via `*.workers.dev` outside of the gated zone (defense layer 1; the JWT verify is layer 2).

The Worker's responsibilities at this layer are:

1. **JWT verification.** Verify the `Cf-Access-Jwt-Assertion` header against the Access app's JWKS, with `aud` and `iss` claim checks.
2. **Actor extraction for audit.** Read the `email` claim from the verified JWT (NOT from the `Cf-Access-Authenticated-User-Email` header) and stamp it onto every `audit_log` row. The plain header remains informational; the JWT claim is the source of truth.
3. **Fail loud on any verification failure.** Missing `Cf-Access-Jwt-Assertion` header → 401. Bad signature / expired / wrong `aud` / wrong `iss` → 401. Successful verify but `email` claim missing → 500 `admin_actor_missing` (CF Access shape changed; we want to see it). Per the user's 2026-05-02 directive: "Keep the email for logging from CF Access and fail if it's not present."

**No allowlist in the Worker. The `aud` claim check is the closest thing — only JWTs minted by the configured Access application pass.** All allowlisting (which emails / IdPs / MFA / etc.) is policy on the CF Access app, not in code.

Every successful write produces exactly one row in `audit_log`: `(id, actor_email, action, target_table, row_id, before_json, after_json, reason, trace_id, created_at)`. Reads do not audit-log.

Discord SSO (FR-57) is captured as a deferred future migration — when scheduled, the migration changes the CF Access IdP from email-PIN to Discord OIDC; the Worker code does not change.

**Acceptance criteria:**

- AC-50.1: Cloudflare Access SHALL gate the `/admin` and `/api/admin/*` path prefixes in dev, uat, stg, and prod. CF Access policies handle login / MFA / IdP / allowlist. Operator-side configuration is documented in `docs/deployment.md`. Additionally, `workers_dev = false` SHALL be set in `wrangler.toml` so the Worker is not reachable via `*.workers.dev` URLs that bypass the zone-level Access gate.
- AC-50.2: A `proxy/security/cf-access-jwt.ts` module SHALL verify the `Cf-Access-Jwt-Assertion` header on every admin request. Verification SHALL include: (a) signature check against Cloudflare's JWKS at `https://<CF_ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, (b) `aud` claim equals `CF_ACCESS_AUD` env var, (c) `iss` claim equals `https://<CF_ACCESS_TEAM>.cloudflareaccess.com`, (d) `exp` claim is in the future, (e) `iat` claim is not in the future. JWKS responses SHALL be cached for 1 hour in KV under the key `cache:v1:cf-access-jwks` (read-through; the JWT verifier is the only writer to this specific cache key). Any verification failure → 401 with body `{"error":"admin_jwt_invalid","detail":"<short reason>"}` per the FR-37 envelope shape. A `proxy/security/admin-actor.ts` module SHALL wrap the verifier and expose `extractAdminActor(request, env): { email: string } | Response`, returning the email from the verified JWT's claims (NOT from the loose header). If the verified JWT lacks an `email` claim, the function SHALL return a `500` with body `{"error":"admin_actor_missing","detail":"…"}` so the misconfiguration is visible. The plain `Cf-Access-Authenticated-User-Email` header remains informational only — the Worker SHALL NOT use it for actor identity. The Worker SHALL NOT consult any env-var email allowlist.
- AC-50.3: Every successful POST/PATCH/DELETE on `/api/admin/*` SHALL produce exactly one `audit_log` row written atomically with the underlying mutation. Atomicity is enforced via D1's `batch()` (implicit transaction across statements). If any statement in the batch fails, all are rolled back. Test: a forced audit insert failure leaves the target row unchanged.
- AC-50.4: `/api/admin/*` SHALL accept methods `GET, POST, PATCH, DELETE, OPTIONS`. `OPTIONS` SHALL return `204`. Other methods SHALL return `405` with `Allow: GET, POST, PATCH, DELETE, OPTIONS`.
- AC-50.5: Admin routes SHALL be subject to the existing per-IP rate limiter (FR-27 AC-27.21) under the same budget as other routes. CF Access already throttles authenticated traffic; a separate per-email budget is not introduced (revised from the original v2.7.0 draft, which included a `researcher:{email}` budget).
- AC-50.6: Admin routes SHALL emit **structured backend traces** beyond the FR-36/38/39 inbound-request envelope. Each admin write handler SHALL call `logEvent` once per write with the trace ID, action verb, target table, target row id, actor email, and outcome (`ok` / specific error code). Successful writes log at `level: 'info'`; client errors at `level: 'warn'`; server errors at `level: 'error'`. The trace ID is the same one the router middleware resolved for the inbound request.
- AC-50.7: The `audit_log` D1 table SHALL carry a `trace_id` column. Every audit row SHALL be inserted with the trace ID of the inbound request that produced it. This lets ops correlate "what changed in D1" with "what was logged" via a single trace-ID query against Logpush.
- AC-50.8 (NEW 2026-05-02): Every successful `update` or `delete` on `/api/admin/*` SHALL require a non-empty `reason` (change-notes) value. The reason flows into `audit_log.reason`. Posture:
  - For `POST` (create): `reason` is **optional**. The create itself is the justification; researchers MAY add a reason for context but the Worker SHALL NOT reject a create whose reason is missing.
  - For `PATCH` (update) and `DELETE`: `reason` is **REQUIRED**. A request without a non-empty reason SHALL return `400 reason_required` with FR-37 envelope and SHALL NOT mutate D1.
  - The reason is supplied via the request body's `_reason` field (a leading-underscore namespace so it cannot collide with any resource column). For `DELETE` (which conventionally has no body), the reason MAY also be supplied as `?reason=…` query parameter.
  - Whitespace-only reasons (`"  "`, `"\t\n"`) SHALL be treated as missing.
  - The Worker SHALL strip `_reason` from the body before passing it to the D1 store so it cannot accidentally land on a resource row.
- AC-50.9 (NEW 2026-05-02): The admin SPA's editor (FR-52) SHALL render a "Change notes" `<textarea>` immediately above the action buttons on every editor view. On `update` / `delete` flows the textarea SHALL be required (the Save / Delete button SHALL surface a validation hint when empty); on `create` flows it SHALL be optional. The textarea is populated from / saved to local component state and is reset on save / cancel — it is NOT persisted across drawer-open events.

### FR-51: D1→KV Publish Pipeline (NEW v2.7.0)

**Problem.** D1 reads are millisecond-cheap inside the Worker but are NOT replicated to every edge POP — they hit a single regional database. The widget's read path must stay edge-cache-fast (KV is the right tool for that). We need a deterministic, idempotent way to project D1 state into the existing KV records.

**Solution.** A new curator script `scripts/publish-d1-to-kv.ts` reads every relevant D1 table, builds the join (per-bill, per-member), and writes to KV under the existing FR-32 prefixes plus three new prefixes:

- `comment:v1:{billId}` — array of researcher comments attached to a bill (and optionally a specific roll call within that bill).
- `social-post:v1:{bioguideId}` — array of social posts curated for a representative.
- `quote:v1:{bioguideId}` — array of quotes (with source media metadata) attributed to a representative.

Existing prefixes `bill:v1:*`, `member:v1:*`, `state-members:v1:*`, `name-index:v1:*` continue to be the curator-only contracts FR-32 AC-32.5 mandates. The script SHALL diff against current KV and skip no-ops, so a re-publish after a single comment change writes exactly one key.

**Acceptance criteria:**

- AC-51.1: `scripts/publish-d1-to-kv.ts` SHALL accept `--env <dev|uat|stg|prod>` and SHALL operate against that environment's D1 + KV bindings. A `--dry-run` flag SHALL print the diff (keys that would be written, keys that would be unchanged, keys that would be deleted) without touching KV.
- AC-51.2: The script SHALL read every row of `bills`, `votes`, `comments`, `social_posts`, `quotes` and produce one KV write per affected key. The transformation SHALL be deterministic: identical D1 state produces byte-identical KV values across runs.
- AC-51.3: The `bill:v1:{billId}` record produced by the publish script SHALL match the FR-32 AC-32.2 shape exactly. Per-vote `weight` and `directionMultiplier` SHALL come from the D1 `votes` row, not from any static curated table. The `direction` field SHALL come from the D1 `bills.direction` column.
- AC-51.4 (REVISED 2026-05-03 — weight + direction, see AC-52.38): The `comment:v1:{billId}` record SHALL be `{ billId, comments: ResearcherComment[], generatedAt, schemaVersion: 1 }` where each comment is `{ id, bodyMarkdown, weight: number, direction: -1 | 0 | 1, attachedToRollCallId?: string, authorEmail, createdAt, updatedAt }`. `weight ∈ [0, 5]` and `direction ∈ {-1, 0, +1}`; the signed contribution is `direction × weight` (range `[-5, +5]`). Replaces the legacy `scoreAdjustment ∈ [-1, +1]` field per AC-52.38.
- AC-51.5 (REVISED 2026-05-03 — weight + direction, see AC-52.38): The `social-post:v1:{bioguideId}` record SHALL be `{ bioguideId, posts: SocialPost[], generatedAt, schemaVersion: 1 }` where each post is `{ id, platform: "x" | "facebook" | "youtube" | "instagram" | "other", url, postedAt, bodyText, weight: number, direction: -1 | 0 | 1, comment?, authorEmail, createdAt }`. `weight ∈ [0, 5]`, `direction ∈ {-1, 0, +1}`; signed contribution is `direction × weight`. Replaces the legacy `scoreAdjustment` field per AC-52.38.
- AC-51.6 (REVISED 2026-05-03 — full mediaKind enum + weight + direction, see AC-52.38): The `quote:v1:{bioguideId}` record SHALL be `{ bioguideId, quotes: Quote[], generatedAt, schemaVersion: 1 }` where each quote is `{ id, mediaKind: "text" | "news" | "social" | "video" | "audio" | "speech" | "press" | "interview" | "image" | "letter", sourceUrl, sourceLabel, quotedAt?, bodyText, weight: number, direction: -1 | 0 | 1, comment?, authorEmail, createdAt }`. `weight ∈ [0, 5]`, `direction ∈ {-1, 0, +1}`; signed contribution is `direction × weight`. Replaces the legacy `scoreAdjustment` field per AC-52.38. The `mediaKind` enum SHALL match `proxy/d1/admin-store.ts:VALID_MEDIA_KINDS`, which is the source of truth for validation.
- AC-51.7: AC-32.5 SHALL be amended (in spirit, codified in this AC) to permit only the curator-owned `scripts/publish-d1-to-kv.ts` and `scripts/publish-to-kv.ts` (FR-35) to write to `*:v1:*` KV prefixes. The Worker SHALL still NOT write to those prefixes from any researcher route. `tests/unit/kvPrefixes.test.ts` SHALL be updated to reflect the new prefix list and the unchanged Worker-side restriction.
- AC-51.8: `.github/workflows/publish-d1.yml` SHALL invoke the publish script on a 15-minute cron against dev and uat, on a manual trigger against stg and prod. The cron run SHALL log the diff summary `{ ok_count, unchanged_count, error_count }` and exit non-zero on any error so the workflow run shows red.
- AC-51.9: The script SHALL handle empty D1 tables gracefully: a member with zero comments produces a `comment:v1:{billId}` record with `comments: []` if any other bill data referencing them changed, otherwise the record is skipped (and the embed read of a missing key is treated as `comments: []` per AC-53.5).

### FR-52: Admin Front-End (MVP) (NEW v2.7.0)

**Problem.** Without a dedicated UI, every D1 edit goes through `wrangler d1 execute` — fine for a developer, useless for a researcher. We need a minimal SPA that lists each editable surface and lets a researcher save a change with optimistic update and audit-log feedback.

**Solution (REVISED 2026-05-04 — megamenu nav).** A Vite entry under `src/admin/` produces a small React SPA served by the Worker at `/admin`. The SPA's top-level navigation is a **single megamenu** (one trigger button in the header) that opens a panel with three columns:

- **Workspace** — People, Bills, Activity
- **Curation** — Inbox, Add quote, All quotes, Research, Add by URL
- **Admin** — Keywords, Tags, Poll status, App config

Each destination is addressable via a stable URL hash (e.g. `#/people/B001234`, `#/curation/inbox`, `#/settings/tags`) so deep-links and browser back/forward work. The earlier draft of this FR described a horizontal tab strip across the top (Bills / Votes / Comments / Social Posts / Quotes / Recent Activity); that strip was removed during V4 in favor of the megamenu (and Votes / Comments were absorbed into the Bills editor — see AC-52.16, AC-52.65). The megamenu invariant is enforced by AC-52.69; hash-routing by AC-52.70.

Each top-level destination is itself a list-detail layout where applicable: list on the left, drawer-style editor on the right. Save → PATCH to `/api/admin/*` → optimistic update → revalidate from server. No global state library (component-local `useState` + a small `fetcher` hook is enough at MVP).

**Acceptance criteria:**

- AC-52.1: The admin SPA SHALL be built from a separate Vite config (`vite.admin.config.ts`) and emit one IIFE bundle plus an HTML shell into `dist/admin/`. The widget's main bundle SHALL NOT depend on admin SPA code.
- AC-52.2: The Worker's existing `ASSETS` binding SHALL serve `/admin` and `/admin/assets/*` from `dist/admin/`. The route SHALL be gated by Cloudflare Access (FR-50). A request without a valid CF Access JWT SHALL be challenged by Access at the edge (the Worker additionally verifies the JWT per FR-50 AC-50.2 as a belt-and-suspenders measure).
- AC-52.3: Each tab SHALL fetch via `GET /api/admin/{tab}?limit=…&offset=…` and render a list. Selecting a row SHALL open a drawer editor populated from the row data. Saving SHALL `PATCH /api/admin/{tab}/{id}` with the changed fields only; the server returns the updated row plus the new audit row.
- AC-52.4: Optimistic updates SHALL revert visibly on a non-2xx response, with a toast showing the FR-37 error envelope's `error` field and `traceId`. Researchers can click the trace ID to copy it to the clipboard for sharing.
- AC-52.5: The Recent Activity tab SHALL render the latest 50 audit rows (from `GET /api/admin/audit?limit=50` per FR-58), most-recent-first, with: actor email, action, table, row title or ID, optional reason. The row SHALL be clickable; clicking SHALL deep-link the affected row in its primary tab via in-SPA state, not URL routing.
- AC-52.6: The SPA SHALL render a small "Logged in as `<email>`" badge in the header so the researcher can confirm they are scoped to the right account. The badge SHALL come from a synthetic `GET /api/admin/whoami` route that returns `{ email }` from the validated Access header.
- AC-52.7: The SPA SHALL not store any credential client-side. All auth SHALL be the Access cookie set by Cloudflare; the SPA reads `whoami` to discover its own identity.
- AC-52.8: Visual design is **utilitarian, not branded.** No design system, no logo, no theming. Plain HTML controls + minimal CSS. The admin SPA is internal tooling; bundle size and time-to-paint matter more than polish.
- AC-52.69 (NEW 2026-05-04 — single megamenu nav surface): The admin SPA SHALL render exactly one navigation surface: a single megamenu trigger in the header that opens a panel grouped into the three columns **Workspace** (People, Bills, Activity), **Curation** (Inbox, Add quote, All quotes, Research, Add by URL), and **Admin** (Keywords, Tags, Poll status, App config). The SPA SHALL NOT render a parallel tab strip, pill row, or breadcrumb-style horizontal nav at the top level. Sub-navigation inside a destination (e.g. tab strips inside an editor pane) is unaffected — this AC governs the top-level nav surface only. SUPERSEDES the early-draft tab-strip wording in the FR-52 §Solution prose. Tests SHALL assert: (a) the SPA's header contains exactly one element with `aria-haspopup="menu"`; (b) the panel, when open, exposes the three column headings `Workspace`, `Curation`, `Admin`; (c) no top-level `role="tablist"` element is rendered as a sibling of the megamenu trigger.
- AC-52.70 (NEW 2026-05-04 — stable hash routing for deep links): Each top-level destination SHALL be addressable via a stable URL hash so deep-links and browser back / forward work without losing state. The hash grammar SHALL be `#/<section>[/<sub>]` where `<section> ∈ { people, bills, curation, activity, settings }`. Sub-paths: `#/people/{bioguideId}` selects a person profile; `#/curation/{view}` with `view ∈ { inbox, add, quotes, research, direct }`; `#/settings/{view}` with `view ∈ { keywords, tags, poll-status, config }`. Unknown sections SHALL fall back to `#/people` (the default landing surface); unknown sub-views SHALL fall back to the section's first sub-view. The SPA SHALL update `window.location.hash` on every navigation and SHALL re-parse on `hashchange` so browser back / forward and external deep-links land on the same screen. Tests SHALL cover: (a) loading `#/curation/inbox` cold renders the Inbox view; (b) clicking Settings ▸ Tags updates the hash to `#/settings/tags`; (c) `hashchange` fired with `#/people/B001234` selects that bioguide; (d) `#/garbage` falls back to `#/people`.

### FR-53: Embed Surface Updates for Researcher Content (NEW v2.7.0)

**Problem.** The embed today renders the curated vote list, the sponsored/cosponsored bill list, the score badge, and the rep card. None of those surfaces show researcher comments, social posts, or quotes. We need to add them without changing the chip grid (AC-7.*) and without bloating the cold-load.

**Solution.** Four sub-surfaces:
1. Inline comment expand on each VoteList row.
2. RepDetail tab restructure: a single Record tab (votes on top of legislation, replacing the current twin-table layout) | Statements tab (social posts) | Quotes tab.
3. Score-adjustment chips render inline with comments / posts / quotes — the embed shows researchers' editorial influence on the score, not just the score.
4. About panel gains a "Recent researcher updates" feed (Tier B — may slip; if it slips the data is still available via FR-58).

The chip grid (AC-7.*) is untouched.

**Acceptance criteria:**

- AC-53.1: `src/components/VoteList.tsx` SHALL render an expand affordance (chevron + `aria-expanded`) on every row that has at least one researcher comment attached (via `comment:v1:{billId}` filtered to the matching `attachedToRollCallId`). Rows with no comments SHALL NOT render the affordance.
- AC-53.2 (REVISED 2026-05-02 — two tabs, legislation-top order): `src/components/RepDetail.tsx` SHALL render a tab strip with **two tabs** in this order: **Record**, **Statements**. The Record tab SHALL contain the existing `BillList` (Ukraine legislation) followed by the existing `VoteList` (Ukraine voting record), separated by a section heading — legislation renders ABOVE votes (revised from the previous votes-above-legislation order). The Statements tab SHALL render a single merged list combining curated social posts AND quotes. Default tab SHALL be Record. Tab state SHALL persist across rep-detail open/close within the same widget mount but SHALL NOT be encoded in the URL (chip-grid bookmarking semantics, AC-7.*, are unaffected). Rationale (per user 2026-05-02): the team-entered "Statements" workflow + the auto-ingested-then-reviewed "Quotes" workflow ultimately surface the same kind of data (a representative's public utterances on Ukraine), so the embed renders them as one feed even though the underlying D1 tables remain split for the future ingestion pipeline (see project_v4_statements_quotes_plan memory).
- AC-53.3 (REVISED 2026-05-03 — weight + direction, see AC-52.38): Each comment / post / quote SHALL render a signed-contribution chip when `direction !== 0 && weight > 0`: `+2.50`, `-1.00`, etc. (i.e. `direction × weight`, range `[-5, +5]`), color-coded with the same green/red gradient used for valence (`scoreToCssColor`-style hue). Items with `direction === 0` or `weight === 0` render no chip — the editorial neutrality is the signal.
- AC-53.4 (Tier B): `src/components/AboutSystemPanel.tsx` SHALL render a "Recent researcher updates" section listing the latest 20 audit rows from `GET /api/admin/audit?limit=20`. Each row SHALL show actor email (truncated to local-part), action verb, target row title, and relative time. If `/api/admin/audit` returns 401/403 (the embed is unauthenticated), the section SHALL render nothing — no error banner — since the feed is a "nice to have" surface.
- AC-53.5: All embed read fetches against the new prefixes SHALL tolerate 404 / empty as `{ comments: [] }` / `{ posts: [] }` / `{ quotes: [] }`. A missing record SHALL NOT trigger an error banner — the surface SHALL render its empty state ("No researcher comments yet" / etc.). This keeps the embed working during the brief window after a fresh deploy and before the first publish run.
- AC-53.6 (REVISED 2026-05-02): Embed components `CommentExpand`, `StatementsList` SHALL live in `src/components/`. `StatementsList` is a single merged list (revised from the original split `SocialPostsList` + `QuotesList`) that consumes both curated social posts and quotes and renders them in a single chronological feed under the Statements tab. The original `SocialPostsList` and `QuotesList` components SHALL be removed once `StatementsList` is in place. Each component SHALL be presentational (props in, JSX out) per the existing layering rule. The hooks `useRepStatements`, `useRepQuotes`, `useRepComments` SHALL live in `src/hooks/` and SHALL fetch via the embed's existing `apiBase` pattern; `RepDetail` orchestrates both `useRepStatements` + `useRepQuotes` and merges their results in-component before passing to `StatementsList`.
- AC-53.7: Mobile (≤ 640px) layout: the tab strip SHALL be horizontally scrollable if it overflows; tabs SHALL NOT wrap onto two rows (preserves a clean horizontal scan). Each list inside a tab inherits the FR-34 stacked-card treatment for ≤ 640px.

### FR-54: Per-Vote Researcher Weight Override (NEW v2.7.0)

**Problem.** Today, vote weight is a static number in `ukraineBills.json` set per `kind` (final passage 1.0, concur 0.9, …). There is no way to flag a specific roll call as more egregious or more performative than its kind suggests. The user's V4 ask is "negative signals much more pronounced" — this is the per-vote knob that delivers it without inventing a separate global amplifier.

**Solution.** Each `votes` row in D1 carries `weight: REAL NOT NULL` and `direction_multiplier: REAL NOT NULL DEFAULT 1`. The publish script writes these into `bill:v1:*` records exactly as the current schema expects (AC-32.2). Researchers raise weight on votes they consider especially important; combined with the direction tag, raising weight on an anti-Ukraine vote pulls the score lower more strongly. The `[-1, +1]` score range is preserved because the formula remains `Σ(sign × amp × weight) / Σ(amp × weight)`.

**Acceptance criteria:**

- AC-54.1: `votes.weight` and `votes.direction_multiplier` SHALL be researcher-editable via `PATCH /api/admin/votes/{voteId}`. The endpoint SHALL validate `weight ∈ [0, 5]` (clamp negative; reject above 5 with 400) and `direction_multiplier ∈ {-1, 0, 1}` (reject other values with 400). The 0..5 ceiling prevents a runaway researcher from making one vote dominate the score.
- AC-54.2: `src/services/ukraineScore.ts` SHALL continue to use `weight` as-is — no code change in the score formula. The change is purely in the data path: weights flow from D1 → KV → embed → `computeUkraineScore`.
- AC-54.3: The seed script (FR-49 AC-49.3) SHALL preserve every existing `weight` and `directionMultiplier` value from `ukraineBills.json`. Post-seed, scores SHALL be byte-identical to pre-V4 scores. A regression test SHALL compute the score for ten known-public bioguides against the seeded D1 + freshly-published KV and assert the score matches the pre-V4 baseline (snapshot fixture).
- AC-54.4: The admin SPA Vote editor SHALL render a weight slider (0.0 to 5.0, step 0.05) and a direction-multiplier dropdown (-1 / 0 / +1) with inline help text: "Raise weight on votes that deserve outsized influence. Set direction multiplier to -1 to invert (e.g. motion-to-recommit). 0 zeroes the vote out of the score."
- AC-54.5: `audit_log` rows for vote-weight edits SHALL include `before_json` and `after_json` capturing the full weight/direction snapshot, so a researcher can review their own history and another researcher can revert via the SPA's "revert" button (AC-52.3 PATCH).
- AC-54.6 (NEW 2026-05-02): The `votes` D1 table SHALL carry a nullable `weight_reason TEXT` column capturing the **standing rationale** for the current `weight` and `direction_multiplier` values — analogous to `bills.direction_reason`. The audit log captures *changes* to this rationale over time; `weight_reason` captures the *current* justification on the row itself, so a reader asking "why is HR 815 cloture weighted 2.5?" finds the answer in one read instead of querying audit history. The admin SPA's vote editor (per AC-54.4) SHALL render `weight_reason` as a textarea field, optional but encouraged. Empty / whitespace-only stores as NULL.

### FR-55: Newer-Rep Bayesian Shrink + Insufficient-Record Badge (NEW v2.7.0)

**Problem.** Today `LOW_CONFIDENCE_THRESHOLD = 3` produces a "Limited record" copy on the badge but the underlying score is still computed on whatever signal exists. A first-term GOP rep with one pro-Ukraine vote reads as "Strong supporter" — that is misleading and the user explicitly flagged it.

**Solution.** Two changes, applied in this order:

1. **Insufficient-record floor.** Below `NEW_REP_THRESHOLD = 2` contributing actions, the badge renders "Insufficient record" instead of any colored score. The badge color SHALL be the existing neutral gray (`hsl(220, 10%, 55%)`). The numeric score SHALL be `null` in the API response so consuming code can branch on it.

2. **Bayesian shrink toward party prior.** Between `NEW_REP_THRESHOLD` and `MODERATE_CONFIDENCE_THRESHOLD = 8`, the raw score SHALL be shrunk toward the member's **party prior** `µ_party` (the contemporaneous mean score of all members of the same party with `confidenceTier = 'full'`) by weight `w = 1 / (1 + contributing / k)` where `k = 4`. Final score = `(1 - w) × raw + w × µ_party`. At `contributing = 4`, w ≈ 0.5 (equal weight prior + raw); at `contributing = 8`, w ≈ 0.33 (raw dominates); above `MODERATE_CONFIDENCE_THRESHOLD`, w drops out (raw score used as-is, current behavior).

Researcher comments with non-zero `direction × weight` (FR-51 AC-51.4, per AC-52.38) SHALL be applied **before** shrink, so a researcher can override the prior by attaching evidence-bearing commentary.

**Acceptance criteria:**

- AC-55.1: A new constant `NEW_REP_THRESHOLD = 2` SHALL be exported from `src/services/ukraineScore.ts`. A new tier value `'insufficient'` SHALL extend `ConfidenceTier`. `deriveConfidenceTier(0)` and `deriveConfidenceTier(1)` SHALL return `'insufficient'`. Above the threshold, the existing `'low' | 'moderate' | 'full'` tiers apply unchanged.
- AC-55.2: `computeUkraineScore` SHALL accept an optional `priors?: { partyPrior: number | null }` parameter. When `confidenceTier === 'insufficient'` and the rep has no contributing actions, `score` SHALL be `null`. When `confidenceTier === 'insufficient'` and the rep has 1 contributing action, `score` SHALL also be `null` (badge reads "Insufficient record"). The raw computation IS still performed and exposed as a separate field `rawScore` for debugging/analytics.
- AC-55.3: When `confidenceTier ∈ {'low', 'moderate'}` and `priors.partyPrior !== null`, the returned `score` SHALL be `(1 - w) × rawScore + w × priors.partyPrior` with `w = 1 / (1 + contributing / 4)`. When `confidenceTier === 'full'`, `score === rawScore` (no shrink).
- AC-55.4: When `priors.partyPrior === null` (e.g., bootstrap, no full-confidence reps in this party yet), shrink SHALL be skipped — `score === rawScore` regardless of tier (degenerates to current behavior). Tests SHALL cover this path explicitly so we don't NaN under cold-start.
- AC-55.5: `src/components/UkraineScoreBadge.tsx` SHALL render "Insufficient record" copy and the neutral gray color when `confidenceTier === 'insufficient'`. The `confidence` numeric field SHALL be 0 in this case (no saturation).
- AC-55.6: The party prior SHALL be computed at publish time, not at render time, and SHALL be carried in `member:v1:{bioguideId}` as `partyPrior: number | null`. Rationale: the prior is derived from the population of full-confidence reps in the same party; computing it at render time would require the embed to fetch every member, which violates AC-32.1's atomic-record contract. The publish script (FR-51) computes one prior per party and writes it into every member's record.
- AC-55.7: Test fixtures SHALL include: (a) a rep with 0 votes → score = null, badge = "Insufficient record"; (b) a rep with 1 anti vote → score = null, badge = "Insufficient record"; (c) a GOP rep with 1 pro vote and `partyPrior = -0.4` → final score ≈ -0.16 (shrink dominates), badge = limited; (d) a GOP rep with 20 pro votes → final score = +1.0 (shrink absent at full tier).
- AC-55.8: ADR-018 SHALL document the prior choice (party caucus full-confidence mean), the shrink constant `k = 4`, the threshold `NEW_REP_THRESHOLD = 2`, and the alternatives considered (raw score with "limited record" copy only; floor-clamping; uniform Beta(1,1) prior).

### FR-56: Deep Statistics Endpoint (NEW v2.7.0)

**Problem.** Researcher decisions (which bills to add, which weights to raise, which comments to write) are made today against a small, mostly-curator-internal mental model of the data. To make those decisions evidence-based — and to feed the future "data analysis" surface — we need a queryable aggregate endpoint.

**Solution.** A new read route `GET /api/stats/v1/summary` returning a JSON envelope of pre-computed aggregates. **Backend only for V4** — the embed does not consume it Sunday. A future iteration adds a researcher-side dashboard.

**Acceptance criteria:**

- AC-56.1: `GET /api/stats/v1/summary` SHALL return:
  ```ts
  {
    generatedAt: string,           // ISO-8601
    schemaVersion: 1,
    perBill: Array<{ billId, voteCount, weightTotal, directionPro, directionAnti }>,
    perRepHistogram: { buckets: number[], counts: number[] },  // 21 buckets from -1.0 to +1.0 step 0.1
    topAntiUkraine: Array<{ bioguideId, displayName, score, weightedAntiActions }>,  // top 25
    commentsTimeseries: Array<{ date: string, count: number }>,  // last 90 days
    partyPriors: { D: number | null, R: number | null, I: number | null }
  }
  ```
- AC-56.2: The endpoint SHALL be public-readable (no auth) but rate-limited at 30 requests / 60s per IP — it's queryable by any embedder and there's nothing sensitive in aggregates, but it's expensive enough that abusing it is worth limiting.
- AC-56.3: The endpoint SHALL be served from a dedicated KV record `stats:v1:summary` written by the publish script (FR-51) at the end of every run. The Worker SHALL NOT compute aggregates per request — it returns the cached record. `Cache-Control: public, max-age=300, s-maxage=900`.
- AC-56.4: A FR-37 envelope `{ error, traceId }` SHALL be returned when the stats record is missing (cold cache after a fresh deploy). Status `503`, `Retry-After: 60`. The embed (or any consumer) SHALL be expected to retry rather than hard-fail.
- AC-56.5: Tests SHALL cover the publish script's stats-emission path with a small fixture D1 (3 bills, 2 reps) and SHALL assert exact byte-identical output across two runs (determinism).

### FR-57: Discord SSO Migration (DEFERRED — v2.7.x or later)

**Problem.** The user originally asked for a "researcher front-end with Discord SSO." For V4 we shipped a Cloudflare-Access stand-in (FR-50) — CF Access policies handle email allowlist + MFA today; the Worker JWT-verifies the same Access app on every admin request. Discord remains the right long-term choice because the researcher community organizes there.

**Status.** **Deferred.** Not in v2.7.0 scope. Captured here so the FR number is reserved and the migration story is documented before it starts.

**Migration outline (non-binding):**

1. Add a Discord OAuth app; configure the Worker to mint a session JWT (HttpOnly cookie) on successful Discord callback.
2. Configure CF Access to use Discord OIDC as the IdP. The Worker's JWT verifier in `proxy/security/cf-access-jwt.ts` is unchanged — it still verifies the same RS256 token from the same JWKS endpoint. The `email` claim may be replaced or augmented by a `sub` claim carrying a Discord ID; `extractAdminActor` is the only Worker-side touchpoint that needs an update.
3. The allowlist becomes a Discord guild + role check (e.g. members of the "researchers" role on the project's guild), not an env-var email list.
4. Existing `audit_log` rows are migrated from `actor_email` to `actor` (a generic identifier column populated with `discord:{id}` going forward, `email:{address}` historically).
5. ADR-017 is superseded by a new ADR documenting Discord-as-IdP.

**Acceptance criteria:** None for v2.7.0. To be filled in when the migration is scheduled.

### FR-58: Researcher Audit Visibility (NEW v2.7.0)

**Problem.** Audit-log rows are useless if no one can see them. The admin SPA's Recent Activity tab and the embed's About-panel feed both need a queryable endpoint.

**Solution.** `GET /api/admin/audit?limit=N&since=ISO` returns recent audit rows. Two callers:
- Admin SPA (authenticated, sees full row data including before/after JSON).
- Embed About panel (unauthenticated, sees a redacted projection: actor local-part of email, action verb, target title, relative time — no before/after).

**Acceptance criteria:**

- AC-58.1 (REVISED): `GET /api/admin/audit?limit=N` (with valid Access header) SHALL return up to N audit rows (max 100, default 50), most-recent first, full row data: `{ id, actor_email, action, target_table, row_id, row_title, before, after, reason, trace_id, created_at }`. Field names use `target_table` (matching the D1 column name and `AuditRow.target_table` in `proxy/d1/admin-store.ts`) so there is one canonical shape end-to-end. The `trace_id` field is included per AC-58.6.
- AC-58.2: `GET /api/audit/public?limit=N` (no auth required) SHALL return up to N audit rows (max 50, default 20) in the redacted projection: `{ id, actorLocalPart, action, table, rowTitle, createdAt }`. Email domain SHALL be stripped (`alice@example.com` → `alice`). `before`/`after`/`reason`/`trace_id` SHALL NOT be exposed. Note the public projection deliberately renames `target_table → table` to keep the public schema short and self-documenting; the authenticated feed (AC-58.1) keeps the longer `target_table` so it matches the D1 column 1:1 for ops use.
- AC-58.3: Both endpoints SHALL be served from a denormalized `audit-feed:v1:full` and `audit-feed:v1:public` KV record updated by the publish pipeline (FR-51) on every run plus a 5-minute cron. The Worker SHALL NOT query D1 per request — D1 is regional and `/api/audit/public` is meant to be embed-cheap.
- AC-58.4: `Cache-Control: public, max-age=60, s-maxage=120` on the public endpoint; `Cache-Control: no-store` on the authenticated endpoint (researcher-current view).
- AC-58.5: Tests SHALL cover: redaction (no `before`/`after` leaks on public), pagination (limit clamping), missing-record fallback (returns empty list, not 404 — same tolerance as AC-53.5).
- AC-58.6 (NEW 2026-05-02): The authenticated audit feed (`/api/admin/audit`) SHALL expose the `reason` field per row alongside `before` / `after` / `trace_id`. Researchers reading their own (or each other's) edit history rely on the `reason` to understand **why** an edit happened, not just **what** changed. This complements AC-50.8 (which requires `reason` on update / delete) — together they guarantee the authenticated audit feed always carries human-readable change notes for every mutating action past V4 cutover.

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
