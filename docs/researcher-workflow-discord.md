# Researcher workflow (short version)

**Goal:** find wrong/missing bills and votes in the widget's Ukraine scoring. You are the source of truth — what you report gets shipped.

## How the score works

- **Bill list** — hand-curated Ukraine bills, each tagged pro- or anti-Ukraine.
- **Votes** — roll calls on those bills, weighted: final passage 1.0, concur 0.9, amendment 0.7, cloture 0.45, motion to proceed 0.3, motion to table/ambiguous 0.0.
- **Sponsorship** — introducing/cosponsoring a pro-UA bill counts too.

Errors almost always = **wrong bill, wrong direction, or wrong vote weight.**

## How to review

1. Open the widget → **About this System**. That's the full bill + vote list.
2. Work **bill-by-bill**, not member-by-member.
3. For each bill:
   - Name/number match Congress.gov?
   - Actually about Ukraine? Direction right?
   - Omnibus with Israel aid / unrelated content? Flag for discussion.
   - Walk each roll call — substantive or procedural? Direction make sense?
4. Second pass: search Congress.gov for `Ukraine`, `Russia sanctions`, `Lend-Lease` — anything missing from the list is a report.

**Congress.gov is truth. Paste the URL in every report.**

## Report templates (one issue per post)

**A — Bill wrong**
```
Bill: <e.g. 118th HR 815>
Congress.gov: <URL>
Widget shows: <current direction / listing>
Should be: <correction>
Why: <one sentence>
Confidence: low / med / high
```

**B — Vote wrong**
```
Bill: <e.g. 118th HR 815>
Vote: <date + type, e.g. "Feb 13 2024 cloture">
Widget shows: <current scoring>
Should be: <zero-weight / inverted / different weight>
Why: <one sentence + senate.gov or clerk.house.gov link>
Confidence: low / med / high
```

**C — Bill missing**
```
Bill: <congress + type + number or Congress.gov URL>
Title: <from Congress.gov>
Direction: pro-UA / anti-UA
Key vote or sponsorship: <e.g. "final passage June 12 2025">
Why it belongs: <one sentence>
Confidence: low / med / high
```

## Rules

- One issue per post. No bundling.
- **Confidence matters:** high = ship it, low = park until someone else weighs in.
- Change your mind? Reply in-thread — retractions are cheap.
- Don't report: small in-range score gaps, missing members (roster issue, not curation), UI/styling.
