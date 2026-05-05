# Researcher Workflow — Reporting Issues with Scores, Votes, and Bills


## 1. What you're reviewing

The widget shows each U.S. senator and House rep with:

- A **Ukraine Votes** tab — the individual floor votes that went into the score.
- A **Ukraine Legislation** tab — bills they sponsored or cosponsored.

Your job is to sanity-check these against reality. If something contradicts what a member has publicly said or done, it's a candidate issue.

---

## 2. How the score is built (the short version)

Three things go into the score:

1. **The bill list.** A hand-curated set of bills that are about Ukraine — military aid, sanctions on Russia, Lend-Lease, etc. Each bill has a **direction**: *pro-Ukraine*, *anti-Ukraine*, or is excluded. A bill that's on the list with the wrong direction will flip scores the wrong way.

2. **The votes on those bills.** Every roll-call vote on a listed bill is pulled from Congress. Each vote gets a **weight** based on how meaningful it is:

   | Vote type | Weight | What it means |
   |---|---|---|
   | Final passage | **1.00** | The bill passing or failing on the floor — the clearest signal |
   | Concur / conference report | 0.90 | Agreeing to the other chamber's version |
   | Substantive amendment | 0.70 | Changing the bill in a meaningful way |
   | Cloture | 0.45 | Ending debate so the bill can be voted on |
   | Motion to proceed | 0.30 | Letting the bill come to the floor |
   | Motion to recommit | 0.30 (often inverted) | A procedural move, sometimes hostile, sometimes friendly |
   | Budget waiver | 0.25 | Procedural budget override |
   | Motion to table / reconsider / ambiguous | **0.00** | Thrown out — too noisy to score |

   A **yes** vote on a pro-Ukraine bill helps the score. A **yes** vote on an anti-Ukraine bill hurts it. **No** votes flip both. Procedural votes can be tricky — sometimes voting *no* on a motion is actually the pro-Ukraine move (hawks blocking a weaker earlier version of a bill that later passes in stronger form). Those cases should be weighted zero; flag them if they aren't.

3. **Sponsorship.** Introducing or cosponsoring a pro-Ukraine bill is itself a signal, even if it never got a floor vote. It counts for less than a final-passage vote, but it counts.

That's the whole model. Anything that looks wrong in the score almost always traces back to one of these three: **wrong bill, wrong direction, or wrong vote weight.**

---

## 3. How to find issues

- Work from the app inside the "About this System" button. 
- Each bill needs it's votes checked we need to make sure the bill is the correct one listed in name. 
- Each roll call vote on the bills then needs checked for both relevance to Ukraine and content.
- With the way Congress works we often end up with large omnibus bills that have multiple interests represented.
- There are examples of votes that added aid for Israel as well - odd situations like this need noted and discuss more widely.


### Where to work

Open the widget and click **About this System**. That panel is the complete list of bills the scoring model is built on, along with the roll-call votes tied to each bill. This is your workbench. You are reviewing the **legislation**, not individual members — member scores are just the downstream effect of whatever is in this list.

Do *not* start from a member's detail panel. If you work member-by-member you'll chase the same bill over and over through different people's records. Work bill-by-bill in About this System and every member who touched that bill gets corrected in one pass.

### What to check, per bill

For each bill in About this System:

1. **Is the name / number right?** The bill as shown should match the bill on Congress.gov at `https://www.congress.gov/bill/<congress>th-congress/<chamber>-bill/<number>`. If the title in the widget doesn't match the title on Congress.gov, that's a wrong-number problem — report it.
2. **Is it actually about Ukraine, and in the right direction?** Read the Congress.gov summary. Pro-Ukraine, anti-Ukraine, or genuinely not about Ukraine? Compare to how the widget has it listed.
3. **Omnibus check.** Large bills (appropriations, NDAA, supplementals) often bundle unrelated things together — Israel aid, domestic spending, border provisions. If the bill carries Ukraine *and* significant non-Ukraine content, flag it. Those cases need a wider discussion before we decide how to count them — don't silently accept or reject. Note what else is in the bill in your report.
4. **Walk the roll-call votes on the bill, one by one.** For each vote:
   - Is it relevant to the Ukraine portion of the bill, or is it a vote about something else that happens to share the same bill number?
   - Is it a substantive vote (final passage, concur, real amendment) or procedural (cloture, motion to proceed, motion to table)? Procedural votes often need zero weight or an inverted direction — see §2.
   - Does the direction make sense? On an omnibus, a **no** vote isn't necessarily anti-Ukraine — the member may have been objecting to a different part of the bill entirely. When in doubt, flag it.

### Bills that should exist but don't

After walking the current list, the second pass is **what's missing**. Open Congress.gov search for terms like `Ukraine`, `Russia sanctions`, `Lend-Lease`, `supplemental appropriations Ukraine`. Any Ukraine-substantive bill from the current or prior Congress that isn't in About this System is a candidate Template C report.

### The one cross-check that matters

**Congress.gov is the source of truth.** If the widget disagrees with Congress.gov on a title, summary, sponsor, or roll-call result, Congress.gov wins and the widget needs to be fixed. Paste the Congress.gov URL in every report — it's the single most useful field for whoever actions the issue.

---

## 4. Reporting templates (Discord)

Post in the research channel. Pick the template that fits. **One issue per post** — don't bundle. Bundled reports are harder to act on and harder to close out.

Fill in every field. "I'm not sure" is a valid answer — say so, don't leave it blank.

### Template A — Bill looks wrong (wrong bill, wrong direction, or shouldn't be listed)

```
**Issue type:** Bill
**Member where I noticed it:** <Last name, state, chamber — e.g. "Lankford, OK, Senate">
**Bill:** <congress number + bill, e.g. "118th HR 815" or "119th S. 1234" — copy from the widget>
**Congress.gov link:** <paste URL if you checked it>
**What the widget shows:** <e.g. "listed as pro-Ukraine", "listed as anti-Ukraine", "appears in Ukraine Legislation tab">
**What I think is correct:** <e.g. "direction should be flipped — this bill cut aid", "not actually Ukraine-related, it's a broader approps bill", "should not be in the list at all">
**Why I think so:** <one or two sentences — what did you read, whose statement, which section of the bill text>
**Confidence:** <low / medium / high>
```

### Template B — Vote looks wrong (bill is fine, but this specific roll call is mis-scored)

```
**Issue type:** Vote
**Member:** <Last name, state, chamber>
**Bill:** <e.g. "118th HR 815">
**Vote:** <date + what it was, e.g. "Feb 13 2024 cloture" or "April 23 2024 final passage">
**What the widget shows:** <e.g. "counted as anti-Ukraine against this member", "looks like it's being weighted like a final passage">
**What I think is correct:** <e.g. "this was a procedural vote that shouldn't be scored", "the direction should be inverted — nay here was the pro-Ukraine move", "weight should be lower — it was motion to proceed, not final passage">
**Why I think so:** <link to the vote on senate.gov or clerk.house.gov, plus one sentence of context>
**Confidence:** <low / medium / high>
```

### Template C — Bill is missing (a Ukraine-relevant bill isn't listed)

```
**Issue type:** Missing bill
**Bill:** <congress + type + number, e.g. "119th S. 1234" — Congress.gov URL is fine if you don't have the citation>
**Title:** <copy from Congress.gov>
**Direction:** <pro-Ukraine / anti-Ukraine — your read>
**Key vote(s) or sponsorship worth capturing:** <e.g. "final passage in Senate, June 12 2025", or "introduced by Sen. X with 14 cosponsors, no floor vote yet">
**Why it belongs:** <one sentence — what does the bill actually do>
**Confidence:** <low / medium / high>
```

### Template D — Score looks wrong but I can't pin down why

```
**Issue type:** Score smell test
**Member:** <Last name, state, chamber>
**Score shown:** <copy the number or label from the badge>
**What I expected and why:** <one or two sentences — their public position, recent statements, committee role>
**Bills/votes I looked at in the detail panel:** <list what you clicked through>
**Closest guess at the root cause:** <optional — "maybe bill X is mis-directed", "maybe a procedural vote is over-weighted", or "genuinely don't know">
```

Use D sparingly — A, B, or C are much faster to action. But a D report on a canary member (a well-known hawk or skeptic whose score is visibly off) is still valuable even when you can't isolate the cause; it tells us where to look.

---

## 5. What happens after you post

Your call is the call. The engineering side is a pipeline, not a second opinion — reports get implemented as written. That means:

- **Be specific and be sure.** If you say "flip the direction on HR 815," the direction gets flipped. There's no one behind the scenes double-checking your read against Congress.gov — **you** are the source of truth on what the data should say.
- **Use the Confidence field honestly.** Low confidence is a valid, useful signal — it tells engineering to park the report until another researcher weighs in, rather than shipping a change on a hunch. High confidence means "ship it."
- **Cite Congress.gov in every report.** Not because engineering will re-verify against it, but because it's the durable record of *why* the change was made. Six months from now, when someone asks "why did we flip this bill's direction?", the Congress.gov link in the report is the answer.
- **If you change your mind, say so.** Post a follow-up in the same thread — "ignore the earlier report, I re-read the summary and it's actually pro-Ukraine." Retractions are cheap; silent wrong data is expensive.

Each report lands as a git commit that names the bill and the defect. The widget redeploys and you'll see the change in About this System; that's your confirmation the report was actioned.

---

## 6. What *not* to report

- **Score differences between members that are both in the "expected" range.** Small gaps between two hawks, or between two skeptics, are usually real — the model is crude on purpose. Only report when a member is on the *wrong side* of their expected range.
- **Missing members.** The roster is pulled from Congress directly; if someone's not there, that's a different pipeline issue, not curation.
- **Stylistic/UI issues.** This workflow is for data correctness. UI feedback goes elsewhere.
- **Bills that are tangentially Ukraine-related.** A defense authorization bill that mentions Ukraine in a findings section but doesn't *do* anything Ukraine-specific isn't in scope. When in doubt, report it as a **low-confidence** Template A — we'd rather see the call than miss it.

---

## 7. Quick reference — the "does this look wrong?" checklist

For any member whose score surprises you:

- [ ] Open their detail panel.
- [ ] Does every bill in **Ukraine Votes** actually look Ukraine-related? (Title check.)
- [ ] Does every bill in **Ukraine Legislation** actually look Ukraine-related?
- [ ] For the member's 2–3 most visible public Ukraine positions — are the corresponding votes present and pointed the right direction?
- [ ] Are any major Ukraine bills from the last year **missing** from both tabs?
- [ ] Do the procedural votes (cloture, motion to proceed) make sense, or are any of them carrying more weight than they should?

If any box is off, file the matching template above.
