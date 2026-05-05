# ADR-018: Score Bayesian Shrink Toward Party Prior for Newer Reps

**Status**: Accepted
**Date**: 2026-05-02
**Deciders**: Kody
**Related**: FR-55, ADR-017, FR-43 (data-surety visual treatment)

---

## Context

The pre-V4 Ukraine Support Score (FR-16, `services/ukraineScore.ts`) computes a normalized score in `[-1, +1]` from weighted votes and sponsorships. Below `LOW_CONFIDENCE_THRESHOLD = 3` contributing actions, the badge renders "Limited record" copy but the underlying score is still computed on whatever signal exists. Above `MODERATE_CONFIDENCE_THRESHOLD = 8`, the FR-43 saturation gradient lands the badge at full saturation.

This is fine for the typical case — a long-serving rep with hundreds of votes — but produces misleading output for newer reps. Concrete example raised by the user during V4 planning:

> A first-term GOP rep with one pro-Ukraine vote reads as "Strong supporter" (score = +1.0).

The score is technically correct (`+1 × amp × weight / amp × weight = +1`) but the inference a reader draws from "Strong supporter" is wrong: we have one data point, the rep's party caucus is on net anti-Ukraine, and the prior probability that this rep is actually a strong supporter is much lower than the score implies.

The user's V4 ask is "better handling for newer reps." The choices considered map to three axes of editorial stance:

1. **Hide the score below a threshold.** Honest, but blank-for-a-term feels lazy.
2. **Pull the score toward a prior.** Bayesian shrinkage. Mathematically principled, gives a *number* the reader can act on, but requires picking a prior.
3. **Boost researcher-curated signals (comments / posts / quotes) for newer reps so the score reflects what's known about them outside the floor record.** Editorial — risks bias.

The user's selected combination was "1 + 3" (option 3 was the floor-clamping variant in the AskUserQuestion options, not the curated-signal-boost). Practically, what we ship is options 1 + 2 in tandem:

- A floor (option 1) below which we refuse to score: the badge reads "Insufficient record."
- A shrink toward party prior (option 2) above the floor and below saturation, so the displayed score is a Bayesian estimate of the rep's stance given the limited evidence.

### Why a party prior

The ideal prior would be "the population mean Ukraine score among reps similar to this one." We don't have a notion of "similar" beyond party affiliation in V4. Possible priors considered:

- **Uniform 0.** Says "we know nothing — assume neutral." Wrong for a newer GOP rep, where the population average is anti-Ukraine; pulling toward 0 over-weights the single pro vote.
- **Global mean across all reps.** Pulls every newer rep toward the population center. Better than uniform 0, but loses the strong information party gives us.
- **Party caucus mean (chosen).** Captures the strongest non-vote-record signal we have: the rep caucused with party X, so the prior on their Ukraine stance starts at the mean of that caucus.
- **Per-state average.** Adds geographic prior. Tempting, but state caucuses are small (especially for senators) and the same fundamental issue — we'd shrink toward a noisy state mean — recurs at smaller-N. Not in V4.

Using party caucus mean has known limitations:

- An independent rep has a population of one (themselves) — degenerate. Code handles this by treating `partyPrior === null` as "no shrink" (cold-start / degenerate-population fallback).
- A rep who breaks with their party on Ukraine looks like an outlier under the prior. **Researcher comments with score-adjustment provide the override path**: a researcher attaches "this rep voted for HR 815 against caucus pressure" with `+0.2` score adjustment, which is applied before shrink.

### Why `k = 4` and `NEW_REP_THRESHOLD = 2`

Shrink weight `w = 1 / (1 + contributing / k)` interpolates between "trust the prior fully" (w → 1 at small `contributing`) and "trust the raw score fully" (w → 0 at large `contributing`).

Picking `k`:

- `k = 1`: `w = 0.5` at one action, `w = 0.33` at two. Aggressive — even a rep with five-six votes is mostly prior. Wrong for a feature whose purpose is to show how reps actually voted.
- `k = 4` (chosen): `w = 0.5` at four actions, `w = 0.33` at eight, `w = 0.2` at sixteen. By the time a rep crosses `MODERATE_CONFIDENCE_THRESHOLD = 8`, the prior contributes a third of the score; at `MODERATE × 2 = 16`, the prior is a fifth. Above `MODERATE`, the algorithm short-circuits and uses raw score (we already have a saturation gradient there for FR-43; layering shrink on top would be wasted compute).
- `k = 8` (matches `MODERATE_CONFIDENCE_THRESHOLD`): `w = 0.5` at eight actions. Too gentle — newer reps' scores would barely move toward the prior at the count that drives the user's specific complaint.

`NEW_REP_THRESHOLD = 2` is the floor below which we don't shrink, we *refuse to score*. The choice is editorial:

- `0`: every rep gets a score. Original behavior; produces the "first-term GOP rep with one pro vote = +1.0" failure mode.
- `1`: a rep with one vote can be "scored" via the shrink. Slightly better but a rep with one anti vote in a slightly-pro-leaning party would still display a misleadingly mild score.
- `2` (chosen): a rep with fewer than two contributing actions reads "Insufficient record." A rep with two actions is shrunk toward the prior with `w = 0.67` (most of the score is prior). At three actions, `w = 0.57`. The rep starts to be visible on their own merits past three or four actions, which feels right for the tone of the surface.
- Higher: blanks too many reps. Newer reps get no useful information for too long.

### Why before-shrink, not after-shrink, score-adjustments

Researcher comments carry `score_adjustment` (FR-51 AC-51.4). Two natural integration points:

- **Before shrink:** add the adjustment to `rawScore`, then shrink the result toward `partyPrior`.
- **After shrink:** compute the shrunken score, then add the adjustment.

We chose **before**. Rationale: the score-adjustment is editorial *evidence* — "this rep did the brave thing on HR 815" — and the rep's prior should be updated by that evidence, not bypass it. In practice, applying before-shrink keeps the adjustment from dominating the score for low-action reps. After-shrink would let a single big adjustment pull a 2-action rep all the way to ±1.0 regardless of prior, which is exactly the failure mode we're trying to fix.

## Decision

1. Below `NEW_REP_THRESHOLD = 2` contributing actions, `score = null`. The badge renders "Insufficient record" with the neutral gray (`hsl(220, 10%, 55%)`).
2. Between `NEW_REP_THRESHOLD` and `MODERATE_CONFIDENCE_THRESHOLD`, the displayed score is `(1 - w) × rawScore + w × partyPrior` with `w = 1 / (1 + contributing / 4)`.
3. At or above `MODERATE_CONFIDENCE_THRESHOLD`, no shrink — the displayed score equals raw score.
4. When `partyPrior === null` (cold-start; no full-confidence reps in this party yet), no shrink — degenerates to current behavior.
5. Researcher comment `score_adjustment` values are applied **before shrink**, not after.
6. Party prior is computed at publish time (FR-51), not render time. It is carried in `member:v1:{bioguideId}` as `partyPrior: number | null`.

The numbers (`k = 4`, `NEW_REP_THRESHOLD = 2`) are documented as constants in `src/services/ukraineScore.ts` and are exported so test fixtures can reason about them. They are not feature-flagged for V4 — if they need to change, change them in code with a follow-up ADR.

## Consequences

**Good:**
- A first-term GOP rep with one pro vote no longer reads "Strong supporter." It reads "Insufficient record." A first-term GOP rep with three pro votes reads near `µ_GOP` (anti-leaning) shrunk by `w ≈ 0.57`, which more honestly reflects the evidence.
- The algorithm is a single function update with a single new parameter; no rendering-side changes beyond the new `'insufficient'` tier.
- Researchers retain full editorial control via `score_adjustment` on comments — they can override the prior with evidence.

**Risk:**
- Reps in small-N parties (independents, third-parties) have a degenerate prior (`partyPrior === null` or computed over a small population). The cold-start fallback keeps these reps from NaN-ing but means they get raw-score behavior. This is acceptable for V4; a future enhancement could shrink them toward a global mean.
- The party prior is sensitive to caucus drift. A caucus-wide vote on a high-weight bill changes the prior the next publish run, which moves every newer rep's displayed score by some fraction. This is desirable — the prior tracks reality — but means that a rep's score can move in the embed without the rep themselves changing. Documented in FR-55 AC-55.6.
- The `k = 4` constant is a calibration choice, not a measurement. Future telemetry (FR-56 stats) lets us replace it with a value derived from the actual rep distribution; for now it is judgment-based.

**Explicit non-goals for V4:**
- Per-state priors.
- Per-cohort priors (e.g., "newer reps from competitive districts").
- Confidence interval display on the badge. The continuous `confidence` field already exists (FR-43); the badge color saturates with it. Showing a numeric ± alongside the score is design.md §4.10 territory and is out of scope for V4.

## References

- [FR-55 Newer-Rep Bayesian Shrink + Insufficient-Record Badge](../spec.md#fr-55-newer-rep-bayesian-shrink--insufficient-record-badge-new-v270)
- [FR-43 Data-Surety Visual Treatment for the Score Badge](../spec.md#fr-43-data-surety-visual-treatment-for-the-score-badge-new-v260)
- [Design §4.19 Score Update](../design.md)
- [src/services/ukraineScore.ts](../../src/services/ukraineScore.ts) — implementation home
