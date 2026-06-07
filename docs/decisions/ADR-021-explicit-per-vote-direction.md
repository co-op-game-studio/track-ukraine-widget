# ADR-021: Explicit per-vote direction replaces the inversion multiplier

- Status: Accepted
- Date: 2026-06-07
- Related: FR-15 (valence), FR-22 (per-roll-call overrides), FR-63 (this change), ADR-017 (D1 editable source of truth)

## Context

A roll-call vote's Ukraine direction has been *derived* at scoring time from
`bills.direction × votes.direction_multiplier`, where `direction_multiplier ∈
{−1, 0, +1}`:

- `+1`: an Aye aligns with the bill's direction (Aye on a pro bill = pro).
- `−1`: **inverted** — an Aye opposes the bill's direction (Aye on a
  motion-to-recommit of a pro bill = anti). This was introduced in FR-22 to
  capture procedural maneuvers.
- `0`: ambiguous — contributes nothing.

This means a single vote's meaning depends on TWO fields plus a sign flip.
Researchers curating votes, and voters reading the breakdown, both have to do
the `bill.direction × multiplier` arithmetic in their heads. The product owner
flagged this directly: *"Separate the roll call votes from the bills in terms of
direction — no more inversion."*

## Decision

Each vote carries an **explicit `direction`** ∈ `{pro, anti, neutral}`, meaning
"an Aye on this vote is pro / anti / neutral toward Ukraine." Vote scoring reads
this field directly and never consults `bills.direction` or a multiplier.

- `bills.direction` still drives **sponsorship** valence (sponsoring a pro bill
  is pro) — that's a property of the bill, not a vote, and stays.
- The `direction_multiplier` column is retained for one release (deprecated,
  unread) for rollback safety, then dropped.

### Migration is two stages

1. **Score-preserving mechanical conversion.** Backfill `direction` from the
   existing `(bills.direction, direction_multiplier)` using the table in FR-63.
   An equivalence test (AC-63.4) proves that scoring over the converted explicit
   directions reproduces the legacy `computeValence` output for every
   combination — so no member's score moves on the migration itself.
2. **Multi-stage researcher review.** Every vote is then routed through a review
   surface that re-confirms its explicit direction, with previously-inverted
   (`−1`) votes flagged for extra scrutiny. Scores MAY change here — that human
   re-confirmation is the point. Until reviewed, a vote keeps its
   mechanically-converted direction (no scoring gap).

## Why not just hide the inversion in the UI

Considered: keep the multiplier internally and only present the "effective
direction" in the UI. Rejected — the spec/docs would then describe a model the
data doesn't have (a Spec-as-Truth violation), and curators would still edit a
multiplier. The directive is to change the model, not paper over it.

## Consequences

- Scoring simplifies: `vote.direction + cast → valence`, no bill lookup.
- The classifier (`build-curated-bills.ts`), seed, projector, embed JSON, and
  domain types all carry `direction` per vote instead of `directionMultiplier`.
- A new audited admin review surface (FR-63 AC-63.6) is required; it is the
  mechanism by which scores are allowed to change post-conversion.
- One-release retention of `direction_multiplier` keeps rollback cheap; a
  follow-up migration drops it.
- FR-22's override file switches from `directionMultiplier` to `direction`.
