# ADR-003: Senate Vote Data Source

**Date**: 2026-04-16
**Status**: Accepted
**Deciders**: Project team

## Context

The Congress.gov API (v3) provides House roll call vote data but does **not** provide Senate roll call vote data. We need Senate voting records to fulfill the voting record requirements for senators (spec FR-6).

## Decision

Fetch Senate vote data from the publicly available XML files published by the U.S. Senate at `senate.gov/legislative/LIS/`.

Parse the XML client-side using the browser's built-in `DOMParser` API.

## Rationale

Senate.gov publishes complete roll call vote data as XML files:
- **Vote index**: `vote_menu_{congress}_{session}.xml` — lists all votes in a session
- **Individual votes**: `vote_{congress}_{session}_{number}.xml` — full member-level breakdown

This is the same data source used by GovTrack, VoteView, and other civic data platforms. It is authoritative (published by the Senate itself), free, and requires no API key.

**Client-side XML parsing**: Modern browsers include `DOMParser` natively. The XML files are small (<200KB per vote file, <50KB for the index). No additional dependencies are needed.

**Member matching challenge**: Senate XML uses `last_name` + `state` for member identification (no bioguide ID). This is handled by matching against the known senators for the user's state. Ambiguity is rare (two senators from the same state with identical last names) and handled by falling back to `first_name`.

## Alternatives Considered

| Alternative | Why Not |
|------------|---------|
| ProPublica Congress API | Shut down / archived as of Feb 2025 |
| Congress.gov API Senate endpoints | Do not exist as of April 2026 |
| GovTrack API | Third-party; adds external dependency and potential availability risk |
| VoteView / Votecast data | Bulk CSV format, not suitable for real-time lookups |
| Scraping senate.gov HTML | Fragile; XML is the structured, intended-for-consumption format |

## Consequences

- XML parsing adds complexity vs JSON API calls
- Senate XML lacks bioguide IDs — member matching is less robust than House data
- XML files are published with a slight delay (hours to a day) after votes occur
- CORS proxy is required (same as other APIs)
- No authentication needed — one fewer API key to manage
