# Bill & Vote Curation Methodology

**Status:** v0.1 — working draft. Lives alongside [curated-bills-v0.1.0.md](curated-bills-v0.1.0.md) (the ledger) and [scripts/vote-overrides.yaml](../scripts/vote-overrides.yaml) (the override layer).

**Audience:** the human curator. The pipeline can identify *candidate* bills and *candidate* vote weights, but it cannot tell whether a Feb 2024 cloture nay was a hawk's tactical move or a dove's defection. That judgment is yours. This doc gives you a repeatable process so your judgment is auditable, reversible, and not stuck in your head.

**Spec anchors:** FR-22 (override layer), design §4.6–4.7 (classifier + weighting), [ADR-010-name-index](decisions/ADR-010-name-index.md).

---

## 1. The problem in one paragraph

The widget scores each member's Ukraine alignment by summing weighted votes on a curated bill set. Two failure modes destroy the score's credibility:

1. **Bad data in the seed** — wrong bill number, wrong direction, mis-weighted vote, or a procedural vote whose direction is context-dependent and gets scored as if it weren't.
2. **Missing data** — a Ukraine-substantive bill that exists in Congress but isn't in the seed, so members who sponsored or voted on it get no credit (or no penalty).

Curation is the loop that finds and fixes both. Everything below is in service of making that loop **methodical, traceable, and reversible**.

---

## 2. The artifacts you touch

| File | What it is | When you edit it |
|---|---|---|
| [scripts/build-curated-bills.ts](../scripts/build-curated-bills.ts) | Seed list of `{congress, type, number, direction, label, featured}` | Adding/removing a bill |
| [scripts/vote-overrides.yaml](../scripts/vote-overrides.yaml) | Per-roll-call corrections to weight / direction / kind | Fixing a single vote whose default classification is wrong |
| [docs/curated-bills-v0.1.0.md](curated-bills-v0.1.0.md) | The review ledger — every seeded bill and every candidate, with status (✅ / 🟡 / ❌ / 🆕) | Every curation pass — this is your audit trail |
| [src/data/ukraineBills.json](../src/data/ukraineBills.json) | **Generated.** Output of `npm run curate`. Never hand-edit. | Never |

**Rule:** if a change isn't reflected in the ledger, it didn't happen. The ledger is the source of truth for *why* a bill is in or out; the seed is just the executable form.

---

## 3. The four loops

There are four distinct curation tasks. Each has its own entry trigger, its own checks, and its own exit condition. Don't blend them.

### Loop A — Correcting a bad bill (already in seed, wrong)

**Triggers:** ledger marks a row ❌, or a member's score looks wrong and the trail leads to a specific bill, or a Congress.gov title comes back unrelated to Ukraine.

1. **Open the ledger row.** Read the existing notes. If there are none, you are about to lose context — write down what you find as you go.
2. **Verify on Congress.gov.** Pull the bill at `https://www.congress.gov/bill/<congress>th-congress/<chamber>-bill/<number>`. Compare the actual title and summary against what the ledger claims.
3. **Classify the defect.** One of:
   - *Wrong bill number* (typo / wrong-number pollution) → remove the seed entry.
   - *Wrong direction* (seeded as pro-UA, actually anti-UA or neutral) → flip `direction` in the seed.
   - *Wrong weight on a specific roll call* → don't touch the seed; add a `vote-overrides.yaml` entry.
   - *Bill is technically Ukraine-adjacent but adds noise* (e.g., a broad approps bill with a tiny UA line item) → remove from seed and document why in the ledger row notes.
4. **Update the seed and/or overrides.** One change at a time. Multi-bill batches make bisection painful.
5. **Re-run the build.** `npm run curate`. Inspect the diff in `src/data/ukraineBills.json`.
6. **Re-score the canary members.** See §5. If a hawk's score moves the wrong direction, stop and reconsider.
7. **Update the ledger row** — flip the status, add a dated note: `2026-04-20: removed; HR XXXX is actually a post office naming bill, not the appropriations rider claimed.`
8. **Commit** with a message that names the bill and the defect category.

### Loop B — Correcting a bad vote weight (bill is fine, one roll call is wrong)

**Triggers:** classifier assigned weight 1.0 to what's actually a motion to table; or a procedural vote is being scored with the wrong sign (hawks voting nay tactically — see HR 815 Feb 2024).

1. **Identify the exact tuple.** `(chamber, congress, session, rollCall)` uniquely keys a vote. Pull it from Senate.gov or `clerk.house.gov`.
2. **Read the vote record carefully.** What is the motion *actually* doing? A "motion to recommit with instructions" can be hostile or friendly. A cloture vote on a doomed earlier version of a bill that later passed is unscorable without context.
3. **Pick the right override.** In order of preference:
   - `weight: 0` — when direction is genuinely ambiguous. **This is the safe default.** Better to drop a vote than to mis-score it.
   - `directionMultiplier: -1` — when the vote is meaningful but inverse (motion to recommit on a pro-UA bill: aye = attempt to kill).
   - `weight: <other>` — when the regex picked the wrong kind (e.g., labeled "passage" for what was actually "motion to proceed").
4. **Write the override entry with a long `note`.** The note must explain *why* — what you read, where you read it, what would go wrong without the override. The HR 815 entries in `vote-overrides.yaml` are the model. Future-you will need this.
5. **Re-run, re-score canaries, ledger note, commit** (same as Loop A steps 5–8).

### Loop C — Adding a new bill (🆕 candidate becomes ✅ keep)

**Triggers:** ledger has a 🆕 row; or you found a new bill via web search; or a member's office published a Ukraine-related bill that isn't in the seed.

1. **Verify the bill is real and Ukraine-substantive.** Title alone is not enough — read the summary and at least the first section of the bill text. "Ukraine" appearing in a definitions section doesn't mean the bill *does* anything about Ukraine.
2. **Decide the direction.** Pro-UA, anti-UA, or neutral. If neutral, **do not seed it** — neutral bills add noise to the score without signal. Document the decision in the ledger.
3. **Find the highest-weight vote it carries.**
   - Final passage > concur > substantive amendment > cloture > motion to proceed.
   - If no floor votes, sponsorship-only signal applies (1.5× amplifier on a 1.0 weight, see ledger §weight policy).
4. **Add to seed.** Minimum fields: `congress`, `type`, `number`, `direction`, `label`. Add `featured: true` only if this is a top-5 bill of its Congress (the widget surfaces featured bills first).
5. **Run `npm run curate`.** Watch for warnings about missing roll calls or unknown vote kinds — these often mean the bill needs override entries before it's safe to score.
6. **Spot-check the resulting member scores.** A new high-weight bill will move scores. If a known dove suddenly looks pro-UA because of one roll call on this bill, you've probably mis-keyed direction or missed a procedural override.
7. **Ledger row** → flip 🆕 to ✅, dated note with what you verified.
8. **Commit.**

### Loop D — Finding new candidates (open-ended, periodic)

**Triggers:** new Congress convenes; major UA-policy news cycle; member's office announces legislation; quarterly review.

This is the only loop without a tight failure mode — its risk is *omission*, which is invisible. Run it on a calendar, not on a trigger.

1. **Bound the search.** Pick one congress + one chamber per session. Don't try to refresh both chambers across multiple Congresses in one pass — you'll miss things.
2. **Query Congress.gov** with a small set of high-precision terms: `Ukraine`, `Russia sanctions`, `Lend-Lease`, `Defending Ukraine Sovereignty`, `supplemental appropriations Ukraine`. Capture the URL of each search.
3. **Add every plausible hit to the ledger as 🆕** — even ones you'll later reject. The ledger should record what you considered, not just what you kept. A 🆕→❌ row with a one-line "out of scope: domestic energy bill mentioning Russia in findings" note is more valuable than no row at all.
4. **Run Loop C on each 🆕** to promote it, or flip it ❌ with a reason.
5. **Date-stamp the pass.** At the top of the ledger, note `Last full sweep: 119th Senate, 2026-04-20.` Future curators (and future-you) need to know what's been swept and what hasn't.

---

## 4. Override layer cheat sheet

The override layer ([scripts/vote-overrides.yaml](../scripts/vote-overrides.yaml)) is the **only** place to fix a single vote without touching the seed. Keep this discipline — overrides are diffable, the seed is the dataset.

**Weights** (copy-paste reference; full table in ledger):

| Vote kind | Weight |
|---|---|
| Final passage | 1.00 |
| Concur / conference report | 0.90 |
| Substantive amendment | 0.70 |
| Cloture | 0.45 |
| Motion to proceed | 0.30 |
| Motion to recommit (with `directionMultiplier: -1`) | 0.30 |
| Budget waiver | 0.25 |
| Motion to table / reconsider / ambiguous | 0.00 |

**`directionMultiplier`:**
- `+1` (default) — aye on pro-UA bill = pro-UA score.
- `-1` — inverse (motion to recommit, motion to table on a pro-UA bill).
- `0` — exclude even if `weight` is non-zero. Equivalent to `weight: 0` for most purposes; prefer `weight: 0` for clarity.

**When in doubt, `weight: 0`.** A dropped vote is recoverable; a mis-scored hawk is a credibility hit that takes weeks to surface.

---

## 5. Canary members — your regression suite

Before committing a curation change, re-score this small set and confirm their relative ordering still matches reality. They are picked because their public Ukraine positions are unambiguous and well-documented.

| Member | State | Expected position | Why they're a canary |
|---|---|---|---|
| Schumer (D) | NY | Strongly pro-UA | Floor leader on every UA supplemental |
| McConnell (R) | KY | Strongly pro-UA | Repeatedly broke with caucus to whip yes |
| Risch (R) | ID | Pro-UA | SFRC ranking member, hawkish |
| Lankford (R) | OK | Pro-UA but procedurally complex | The HR 815 Feb 2024 case study |
| (add a known anti-UA member here when one is firmly identified) | | | |

Run `npm run -w voter-info-widget score-many -- --members=schumer,mcconnell,risch,lankford` (or the equivalent helper in `scripts/score-many.mjs`) and compare against the previous run. Any sign-flip on a canary stops the commit.

> **TODO for the curator:** confirm the exact `score-many.mjs` invocation and pin it here. The script exists; the flag shape may not match what's written above. Replace this note with the verified command on first use.

---

## 6. Reversibility — the most important rule

Every curation change must be reversible **without forensic git archaeology**. That means:

- One logical change per commit. "Fixed HR 815 Feb cloture + added 3 new 119th bills" is two commits, not one.
- Commit messages name the bill and the defect: `curate: zero-weight HR 815 §39 cloture (Feb 2024 maneuver, not direction-aligned)`.
- Ledger notes are **dated and signed** with what was verified, not what was assumed: `2026-04-20: confirmed against congress.gov/bill/118/hr815/all-actions; April version is the law, Feb cloture is unscorable.`
- Never delete a ledger row. Flip its status to ❌ and leave the note. The record of *why something was rejected* is as valuable as the record of what was kept.

If you can't explain a curation change in one sentence six months from now by reading the ledger row + the commit message, the change wasn't documented well enough.

---

## 7. Common traps

- **Wrong-number pollution.** Bills get cited by short title in the press but the press gets the number wrong. Always verify the number against Congress.gov, not against a news article.
- **Companion bills.** A House and Senate bill with the same name are *different bills* and need separate seed entries. They will have separate sponsorship signals.
- **Re-introduced bills across Congresses.** A bill from the 117th that didn't pass and was re-introduced in the 118th has a different `(congress, type, number)` tuple. Seed both if both have signal; don't merge them.
- **Approps bills with Ukraine line items.** A 4,000-page CR that includes a UA supplemental is genuinely pro-UA, but its votes are about much more than Ukraine. Seed it, but consider whether `directionMultiplier` should be reduced or whether only specific roll calls (the actual UA amendment vote) should be scored. Document the call in the ledger.
- **Procedural votes on doomed earlier versions.** HR 815 Feb 2024 is the canonical case. When a bill goes through multiple iterations, only the votes on the version that became law are unambiguously scorable. Earlier procedural votes usually need `weight: 0`.

---

## 8. Pre-commit checklist

Before any curation commit:

- [ ] Ledger row updated, dated, with verification source cited
- [ ] One logical change in this commit (split if not)
- [ ] `npm run curate` ran cleanly with no new warnings
- [ ] `npm run -w voter-info-widget verify-curated-bills` passes
- [ ] Canary members re-scored; no unexpected sign flips
- [ ] Commit message names the bill and the defect category
- [ ] If an override was added, its `note:` explains *why* in enough detail that a stranger could audit the call

---

## 9. What this doc deliberately does not cover

- **The classifier regex itself** — that's design §4.7. If the regex needs to change, that's a code change with tests, not a curation pass.
- **Score formula tuning** — weights and amplifiers are policy decisions documented in the ledger preamble and `vote-overrides.yaml` header. Changing the *formula* is an ADR, not a curation task.
- **Member-side data quality** (bioguide mismatches, party-switch handling) — covered separately in design §4.3 and ADR-010.

If a question doesn't fit one of the four loops above, it probably belongs in one of those other documents — push back before treating it as curation work.
