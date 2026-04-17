# Software Requirements Specification (SRS)
# Voter Information Widget — Ukraine Focus

**Version**: 2.4.0
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

### FR-24: Baked Vote Rosters (NEW v2.4.0)

**Problem.** Opening a rep card currently fires **26–36 HTTP requests** — one for each curated roll-call vote (House members endpoint or Senate XML). Measured at concurrency 3 (our current setting), that's ~1.2 seconds per card. Even at concurrency 8 it's several hundred ms per card via the proxy. First-load performance is noticeably slow.

Roll-call vote rosters are *immutable* — a 2022 vote's list of Aye/Nay voters never changes. We're doing live fetches of static historical data.

**Solution.** The curator (`scripts/build-curated-bills.ts`) SHALL additionally fetch the roster of each curated vote at build time and write it to `src/data/ukraineVotes.json`. The widget's `useVotingRecord` hook SHALL read from this bundled JSON first. Runtime network fetches become a fallback only for cache misses (e.g., a brand-new vote referenced in the override YAML that the last curator run missed).

**Acceptance criteria:**
- AC-24.1: The curator SHALL output `src/data/ukraineVotes.json` containing, for each curated vote, the complete member-vote roster (bioguideId → cast, plus name/party/state). The file is keyed by `${chamber}|${congress}|${session}|${rollCall}`.
- AC-24.2: The widget SHALL import `ukraineVotes.json` as a bundled asset (or fetch it as a sibling R2 file on boot, depending on bundle-size tradeoff).
- AC-24.3: `useVotingRecord` SHALL consult the bundled roster map first. A cache hit produces zero runtime HTTP calls for that vote. A cache miss falls back to the existing Senate XML / House `/members` fetch path.
- AC-24.4: The bundled roster SHALL distinguish "member not in roster" (absent entry) from "member in roster, Not Voting" (present with that cast) so FR-23's Did-Not-Serve logic still works without additional context.
- AC-24.5: The curator SHALL report diff statistics on the rosters file each run (votes added, voters added/changed) so reviewers can see what changed in the weekly PR.
- AC-24.6: The widget bundle SHALL remain under **400KB gzipped**. The large `ukraineVotes.json` roster file (~800KB raw, ~200KB gzipped) SHALL be served as a sibling file from the CDN and fetched asynchronously on widget boot. The smaller `ukraineBills.json` metadata file MAY be inlined into the IIFE since the UI depends on it at initial render and delaying render on a separate fetch is a worse UX than the modest size increase. Current measured bundle: ~310KB gzipped.

### FR-25: Edge-Cached CORS Proxy (NEW v2.4.0)

**Problem.** The Cloudflare Worker proxy currently pass-through-fetches every request to the upstream (Census, Congress.gov, Senate.gov). No caching. Every user pays the upstream round-trip.

**Solution.** Wrap upstream fetches in Cloudflare's `caches.default` API. For immutable data (roll-call rosters, historical bill actions) return `Cache-Control: public, max-age=31536000, immutable`. For mutable data (sponsored legislation lists) use `max-age=300` to keep rosters fresh without overwhelming upstreams.

**Acceptance criteria:**
- AC-25.1: The Worker SHALL wrap each upstream fetch in `caches.default.match(req) ?? fetchAndStore(req)`.
- AC-25.2: Responses from immutable routes (`/api/senate/legislative/LIS/*`, `/api/congress/v3/house-vote/*`, `/api/congress/v3/bill/*/actions`, `/api/congress/v3/bill/*/summaries`) SHALL return `Cache-Control: public, s-maxage=31536000, max-age=31536000, immutable`.
- AC-25.3: Responses from semi-mutable routes (`/api/congress/v3/member/*/sponsored-legislation`, `/api/congress/v3/member/*/cosponsored-legislation`) SHALL return `Cache-Control: public, s-maxage=3600, max-age=300`.
- AC-25.4: Responses from the Census geocoder SHALL return `Cache-Control: public, s-maxage=86400, max-age=3600` (address-to-district mappings change slowly with redistricting).
- AC-25.5: The Worker SHALL restrict CORS to a whitelist of origins: `https://trackukraine.com`, `https://www.trackukraine.com`, and any localhost origin (`http://localhost:*`, `http://127.0.0.1:*`). Requests from other origins SHALL receive a 403 response.
- AC-25.6: The allowed-origin whitelist SHALL be configurable via `ALLOWED_ORIGINS` Worker environment variable (comma-separated). The default value in `wrangler.toml` SHALL be the production whitelist; the dev-only preview Worker MAY widen this.

### FR-26: Cloudflare Deployment Story (NEW v2.4.0)

**Problem.** The widget has no defined production deployment. Spec and code exist but "where does this actually live" is undefined. Since the widget must be embeddable on trackukraine.com (Fourthwall) and the stated goal is to host infrastructure on Cloudflare for security, the deployment architecture needs to be explicit.

**Solution.** Two Cloudflare services, both deployed from this repo via `wrangler` invoked from GitHub Actions:

1. **Cloudflare R2 bucket** serving static assets: `voter-info-widget.iife.js`, `ukraineBills.json`, `ukraineVotes.json`. Accessed via custom domain (e.g., `cdn.trackukraine.com`).
2. **Cloudflare Worker** serving the CORS proxy with edge caching (FR-25). Accessed via custom domain (e.g., `api.trackukraine.com`). Holds `CONGRESS_API_KEY` as a secret.

See `docs/deployment.md` for the concrete setup playbook.

**Acceptance criteria:**
- AC-26.1: The repo SHALL contain a `wrangler.toml` at the project root defining the Worker and the R2 bucket bindings.
- AC-26.2: The Worker source SHALL be TypeScript (`proxy/worker.ts`) consistent with the rest of the codebase.
- AC-26.3: The repo SHALL contain `.github/workflows/pr.yml` running lint, typecheck, and tests on every PR to `main`. No deployment.
- AC-26.4: The repo SHALL contain `.github/workflows/deploy.yml` running on push to `main`: build widget bundle, deploy to R2, deploy Worker via `wrangler deploy`.
- AC-26.5: The repo SHALL contain `.github/workflows/refresh-data.yml` running weekly: run the curator, check for diffs, open a PR with the updated JSON files and a summary of added/changed votes.
- AC-26.6: Secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CONGRESS_API_KEY`) SHALL be documented in `docs/deployment.md` and set via `gh secret set` or the GitHub Actions UI.
- AC-26.7: The embed snippet documented in `README.md` SHALL reference the final Cloudflare URLs (placeholders acceptable until the actual domains are provisioned).
- AC-26.8: The Vite library build (`--mode lib`) SHALL define `process.env.NODE_ENV` as `"production"` at build time. Library mode in Vite defaults to *not* substituting this value (a library shouldn't assume the consumer's environment), but our IIFE is embedded directly in browsers — no consumer build step — so the Worker runtime has no `process` global and React crashes at module-load with `ReferenceError: process is not defined`. The `define` block in `vite.config.ts` prevents this regression. Side-benefit: the build shrinks ~40% because React's dev-only invariant/warning paths get dead-code-eliminated.

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
