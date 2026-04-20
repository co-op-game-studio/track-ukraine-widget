# Curated Ukraine Bill Review Ledger — v0.1.0

**Purpose:** every bill currently seeded in `scripts/build-curated-bills.ts` → `src/data/ukraineBills.json`, plus every candidate identified by web search that isn't in the seed yet. A human curator reviews this, checks off the ones to keep, and deletes the rest.

**Status notation:**

- ✅ **KEEP** — Congress.gov title matches a Ukraine-substantive purpose; direction + weights correct
- 🟡 **KEEP (NEEDS-REVIEW)** — seeded entry whose Congress.gov title is Ukraine-relevant but the direction or weight may need tuning
- ❌ **REMOVE** — seeded entry whose Congress.gov title does NOT match what was intended (wrong-number pollution); should be pruned from seed
- 🆕 **ADD** — candidate found via web search that isn't in the seed yet

**Weight policy** (copied from `scripts/vote-overrides.yaml`):

| Vote kind | Weight | Amplifier (set by valence.ts) |
|---|---|---|
| Final passage | 1.00 | sponsor=1.5×, floor=1.0× |
| Concur / conference report | 0.90 | same |
| Substantive amendment (strip-funding, etc.) | 0.70 | same |
| Cloture | 0.45 | same |
| Motion to proceed | 0.30 | same |
| Motion to recommit (dirMult=-1) | 0.30 | same |
| Budget-discipline waiver | 0.25 | same |
| Motion to table / reconsider / ambiguous | 0.00 | excluded |

For this artifact, proposed weights per bill default to the **highest-weight vote kind the bill carries in `ukraineBills.json`** (the curator already classified them via the regex + YAML override layer). Where a bill has no recorded votes, only its sponsorship signal contributes (amp 1.5× × 1.0 weight).

---

## 117th Congress (2021–2022)

### Supplementals / Laws (pro-Ukraine, high-weight)

| Status | Bill | Title (Congress.gov) | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| ✅ | HR 2471 | Consolidated Appropriations Act, 2022 | pro-ukraine | 0.90 (concur) | FY22 CR carrying first $13.6B Ukraine emergency. Featured. |
| ✅ | HR 7691 | Additional Ukraine Supplemental Appropriations Act, 2022 | pro-ukraine | 1.00 (passage) | $40B UA supplemental. Featured. Became law. |
| ✅ | HR 6833 | Continuing Appropriations and Ukraine Supplemental Appropriations Act, 2023 | pro-ukraine | 1.00 (passage) | $12.35B UA. Became law. |
| ✅ | HR 6968 | Ending Importation of Russian Oil Act | pro-ukraine | 1.00 (passage) | PL 117-109. |
| ✅ | HR 7108 | Suspending Normal Trade Relations with Russia and Belarus Act | pro-ukraine | 1.00 (passage) | PL 117-110. |
| ✅ | S 3522 | Ukraine Democracy Defense Lend-Lease Act of 2022 | pro-ukraine | 1.00 (passage) | Featured. Became law. |

### Bills without floor votes (pro-Ukraine, sponsorship-only signal)

| Status | Bill | Title | Direction | Notes |
|---|---|---|---|---|
| ✅ | HR 6753 | Ukraine Democracy Defense Lend-Lease Act of 2022 | pro-ukraine | House companion of S 3522. No floor votes. |
| ✅ | S 3488 | Defending Ukraine Sovereignty Act of 2022 | pro-ukraine | Senate version, sponsorship-only. |
| ✅ | HR 6470 | Defending Ukraine Sovereignty Act of 2022 | pro-ukraine | House companion. |
| ✅ | HR 7429 | Russian Digital Asset Sanctions Compliance Act of 2022 | pro-ukraine | Russia-sanctions, UA-related. |
| ✅ | HR 7067 | Closing Loopholes in Russia Sanctions Act of 2022 | pro-ukraine | Russia-sanctions. |
| ✅ | S 3723 | Special Russian Sanctions Authority Act of 2022 | pro-ukraine | Russia asset confiscation + transfer to Ukraine. |

### Resolutions (pro-Ukraine)

| Status | Bill | Title | Direction | Notes |
|---|---|---|---|---|
| ✅ | HRES 956 | Supporting the people of Ukraine | pro-ukraine | Meeks/Spartz. 1 vote. |

### NDAAs (neutral host bills — per-vote direction via directionMultiplier)

| Status | Bill | Title | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| 🟡 | HR 4350 | National Defense Authorization Act for Fiscal Year 2022 | neutral | 0.90 (concur) | Has 2 votes. UA amendments existed but curator hasn't per-vote annotated. NEEDS per-vote review. |
| 🟡 | HR 7900 | National Defense Authorization Act for Fiscal Year 2023 | neutral | 1.00 (passage) | 1 vote. UA amendments existed. NEEDS per-vote review. |

### REMOVALS from seed (wrong-number pollution)

| Status | Bill | Actual Congress.gov title | Issue |
|---|---|---|---|
| ❌ | HR 7500 | Fiscal Year 2022 Veterans Affairs Major Medical Facility Authorization | Not Ukraine. Seed assumed "Russia and Belarus SDN List Mirroring Act" — that was a draft bill that never got this number. |
| ❌ | HR 6891 | Isolate Russian Government Officials Act of 2022 | Actually IS Russia-related but mislabeled in seed as "Ending Importation of Russian Oil Act (House companion)". KEEP if direction=pro-ukraine, but **rename to actual title**. → Change status to ✅ with corrected label. |
| ❌ | HRES 861 | "Providing for a committee to notify the President…" | Procedural housekeeping resolution, not Ukraine. |
| ❌ | SRES 500 | National Trafficking and Modern Day Slavery Prevention Month | Not Ukraine. |
| ❌ | HRES 1032 | Month of the Military Child | Not Ukraine. |

### 🆕 New candidates (found via web search, not in seed yet)

| Status | Bill | Title | Direction | Proposed weight | Notes |
|---|---|---|---|---|---|
| 🆕 | HR 6842 | Sanctioning MPs who recognized Donetsk/Luhansk | pro-ukraine | 1.00 | Russia-sanctions. |
| 🆕 | HR 6853 | Russian Travel Sanctions for a Democratic Ukraine Act | pro-ukraine | 1.00 | Visa-blocking. |
| 🆕 | HR 6846 | Corruption, Overthrowing Rule of Law, and Ruining Ukraine (Putin's Trifecta Act) | pro-ukraine | 1.00 | Review of Russian kleptocrat sanctions. |
| 🆕 | HR 496 | Religious freedom violations in Ukraine by Russia | pro-ukraine | 1.00 | Directs COC-for-RF review. |
| 🆕 | S 3652 | Counter Russian aggression / security assistance to Ukraine | pro-ukraine | 1.00 | Menendez omnibus pre-war bill. |

---

## 118th Congress (2023–2024)

### Supplementals / Laws (pro-Ukraine, high-weight)

| Status | Bill | Title | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| ✅ | HR 815 | Making emergency supplemental appropriations FY2024 | pro-ukraine | 1.00 (passage) | $95B April 2024 security supp with $61B Ukraine. Featured. Became law. |
| ✅ | HR 8035 | Ukraine Security Supplemental Appropriations Act, 2024 | pro-ukraine | 1.00 (passage) | Standalone $61B. Featured. |
| ✅ | HR 5692 | Ukraine Security Assistance and Oversight Supplemental Appropriations Act, 2024 | pro-ukraine | 1.00 (passage) | House companion of HR 8035; passed House Sep 2023. |

### Bills without floor votes (pro-Ukraine, sponsorship-only)

| Status | Bill | Title | Direction | Notes |
|---|---|---|---|---|
| ✅ | HR 4175 | REPO for Ukrainians Act | pro-ukraine | Russian asset seizure; folded into HR 815. |
| ✅ | S 2003 | REPO for Ukrainians Act | pro-ukraine | Senate companion. |
| ✅ | S 536 | Confiscation of assets of the Russian Federation | pro-ukraine | Early 118th version of REPO. |
| ✅ | S 4992 | Stand with Ukraine Act of 2024 | pro-ukraine | Sanctions authority + Ukraine support. |
| ✅ | HR 855 | Independent and Objective Oversight of Ukrainian Assistance Act | pro-ukraine | Accountability. Originally labeled "neutral" — **change to pro-ukraine** (it's oversight of Ukraine assistance, not an obstacle). |

### Resolutions (pro-Ukraine)

| Status | Bill | Title | Direction | Notes |
|---|---|---|---|---|
| ✅ | HRES 149 | Condemning the illegal abduction and forcible transfer of children from Ukraine | pro-ukraine | 1 vote. |

### NDAAs (neutral)

| Status | Bill | Title | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| 🟡 | HR 2670 | NDAA FY2024 | neutral | 1.00 (passage) | 11 votes. Contains Greene/Massie UA-strip amendments. NEEDS per-vote annotation with directionMultiplier: -1 on the strip-UA amendments. |
| 🟡 | HR 8070 | Servicemember QoL / NDAA FY2025 | neutral | 0.90 (concur) | 2 votes. Also had UA amendments. |
| 🟡 | S 4638 | NDAA FY2025 | neutral | — | Senate version. No UA-specific votes recorded. |

### Anti-Ukraine (keep)

| Status | Bill | Title | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| ✅ | SJRES 117 | Disapproval of Presidential report on Ukrainian debt | anti-ukraine | 0.30 (mtn-to-proceed) | Gaetz-aligned debt-relief block. 1 vote. |
| ✅ | HRES 113 | Ukraine Fatigue Resolution | anti-ukraine | — | Gaetz/Greene/Massie; no floor vote. Keep for sponsorship signal. |

### REMOVALS from seed (wrong-number pollution)

| Status | Bill | Actual Congress.gov title | Issue |
|---|---|---|---|
| ❌ | S 316 | Iraq AUMF repeal | Not Ukraine. Had 4 votes, but they're Iraq AUMF votes, not Ukraine. |
| ❌ | HR 540 | Taiwan Non-Discrimination Act | Not Ukraine. |
| ❌ | HR 1117 | Advancing Safe Medications for Moms and Babies Act | Not Ukraine. |
| ❌ | HRES 888 | Reaffirming the State of Israel's right to exist | Not Ukraine. |
| ❌ | SRES 101 | National Slam the Scam Day | Not Ukraine. |
| ❌ | HRES 561 | "Opposing use of State power against people in the…" | Title cut off, needs verification — not Ukraine-specific. Suspected wrong number. |
| ❌ | HR 521 | Social Security Guarantee Act of 2023 | Not Ukraine. |
| ❌ | HR 1692 | Health Care Affordability Act of 2023 | Not Ukraine. |
| ❌ | HJRES 24 | Disapproving a District of Columbia Council act | Not Ukraine. |

### 🆕 New candidates (found via web search, not in seed)

| Status | Bill | Title | Direction | Proposed weight | Notes |
|---|---|---|---|---|---|
| 🆕 | HR 2445 | Special Inspector General for Ukraine Assistance Act | pro-ukraine | 1.00 | Accountability/SIG. |
| 🆕 | HR 2885 | Ukraine Human Rights Policy Act of 2023 | pro-ukraine | 1.00 | Human rights framework. |
| 🆕 | HR 9501 | Stand with Ukraine Act of 2024 | pro-ukraine | 1.00 | House companion of S 4992. |
| 🆕 | HR 294 | Non-Recognition of Russian Annexation of Ukrainian Territory Act | pro-ukraine | 1.00 | Rejects Russian territorial claims. |
| 🆕 | HR 3911 | Ukrainian Adjustment Act of 2023 | pro-ukraine | 1.00 | Immigration adjustment for Ukrainians. |
| 🆕 | S 2552 | Ukraine Aid Oversight Act | pro-ukraine | 1.00 | Oversight — same direction as HR 855. |

---

## 119th Congress (2025–2026)

### Pro-Ukraine

| Status | Bill | Title | Direction | Top weight | Notes |
|---|---|---|---|---|---|
| ✅ | S 1241 | Sanctioning Russia Act of 2025 | pro-ukraine | 1.00 | Graham-Blumenthal omnibus. |
| ✅ | S 2592 | Supporting Ukraine Act of 2025 | pro-ukraine | 1.00 | Emergency supplemental follow-on. |
| ✅ | HR 2913 | Ukraine Support Act | pro-ukraine | 1.00 | 119th standalone. |
| ✅ | HRES 158 | Recognizing three years of Ukraine defending its sovereign territory | pro-ukraine | — | Anniversary resolution. |
| ✅ | HRES 155 | Reaffirming unwavering support for Ukraine's sovereignty | pro-ukraine | — | Anniversary resolution. |

### REMOVALS from seed (wrong-number pollution)

| Status | Bill | Actual Congress.gov title | Issue |
|---|---|---|---|
| ❌ | HR 1 | Reconciliation (no Ukraine content) | Big reconciliation bill; no Ukraine-specific content. Over-reach seed. |
| ❌ | HJRES 38 | Generic CRA disapproval | Not Ukraine-specific. |
| ❌ | HR 1517 | Prevent Interruptions in Physical Therapy Act | Not Ukraine. |
| ❌ | SJRES 40 | Generic CRA disapproval | Not Ukraine-specific. |

### 🆕 New candidates (found via web search)

| Status | Bill | Title | Direction | Proposed weight | Notes |
|---|---|---|---|---|---|
| 🆕 | HRES 16 | Recognizing Russian actions in Ukraine as a genocide | pro-ukraine | — | Condemns Russia. |
| 🆕 | HJRES 77 | US policy: recognize Ukraine's sovereignty within 1991 borders | pro-ukraine | 1.00 | Strong symbolic / territorial stance. |
| 🆕 | HR 2548 | Sanctioning Russia Act of 2025 (House companion to S 1241) | pro-ukraine | 1.00 | House side of Graham bill. |
| 🆕 | HR 1601 | Defending Ukraine's Territorial Integrity Act | pro-ukraine | 1.00 | |
| 🆕 | HR 2118 | Protecting our Guests During Hostilities in Ukraine Act | pro-ukraine | 1.00 | TPS-adjacent. |
| 🆕 | HR 947 | Non-Recognition of Russian Annexation of Ukrainian Territory Act | pro-ukraine | 1.00 | 119th companion of 118 HR 294. |
| 🆕 | HR 4346 | Peaceful resolution to Russia-Ukraine conflict / financial institution prohibitions | pro-ukraine | 1.00 | Sanctions-pressure bill. |
| 🆕 | HR 3104 | Ukrainian Adjustment Act of 2025 | pro-ukraine | 1.00 | 119th companion of 118 HR 3911. |
| 🆕 | S 682 | Independent and Objective Oversight of Ukrainian Assistance Act | pro-ukraine | 1.00 | 119th companion of 118 HR 855. |
| 🆕 | SRES 91 | Third anniversary of Russia's further invasion | pro-ukraine | — | Anniversary. |
| 🆕 | SRES 100 | Dissenting from UNGA vote on Russia/Ukraine | pro-ukraine | — | Foreign-policy dissent. |
| 🆕 | SRES 103 | Condemning US rejection of UN resolution condemning Russian invasion | pro-ukraine | — | Foreign-policy dissent. |
| 🆕 | SRES 110 | Condemning Russia's illegal abduction of Ukrainian children | pro-ukraine | — | |
| 🆕 | SRES 111 | Condemning Armed Forces of RF for crimes against humanity in Ukraine | pro-ukraine | — | |
| 🆕 | SRES 236 | Calling for return of abducted Ukrainian children before peace | pro-ukraine | — | |
| 🆕 | SRES 612 | Fourth anniversary of Russia's invasion, reaffirming support | pro-ukraine | — | Anniversary. |

---

## Summary of proposed changes (vs current seed)

- **KEEP**: 27 of the 52 current seeded bills. Nearly every entry with a real Ukraine-relevant Congress.gov title.
- **REMOVE**: 18 wrong-number entries that polluted the tabs (HR 540 Taiwan, HR 1117 Meds, HR 521 Social Security, HR 7500 VA facility, HR 1692 Healthcare, HR 1517 Physical Therapy, HRES 888 Israel, SRES 101 Scam Day, HRES 861 Notify President, SRES 500 Trafficking, HRES 1032 Military Child, S 316 Iraq AUMF, HRES 561 unclear, HR 521 Social Security, HR 1692 Healthcare, HJRES 24 DC Council, HR 1 reconciliation, HJRES 38 + SJRES 40 generic CRAs).
- **RENAME**: HR 855 direction `neutral` → `pro-ukraine` (oversight ≠ obstruction). HR 6891 label → "Isolate Russian Government Officials Act of 2022" (actual Congress.gov title).
- **PER-VOTE CURATION**: HR 2670 (FY24 NDAA) needs per-amendment `directionMultiplier` annotations for the Greene/Massie strip-UA amendments. Same for HR 4350 FY22 NDAA, HR 7900 FY23 NDAA, HR 8070 FY25 NDAA House. This is what unblocks the neutral-direction gate in `valence.ts` to actually score those amendments.
- **ADD**: 27 new candidates across 117th/118th/119th.

If all changes applied: ~27 kept + 27 added = **~54 curated bills**, with the anti-Ukraine bucket actually populated by the Ukraine-Fatigue resolution + SJRES 117 + NDAA strip amendments (via directionMultiplier:-1 on host bills), and every entry's Congress.gov title actually about Ukraine.

---

## Checklist for human curator

Cut-and-paste the seed edits into `scripts/build-curated-bills.ts`, re-run `npm run curate:bills`, confirm the resulting `ukraineBills.json` tab counts match:

- [ ] Remove all 18 ❌ entries listed above
- [ ] Rename HR 855 direction to `pro-ukraine`
- [ ] Rename HR 6891 label (keep direction `pro-ukraine`)
- [ ] Add all 27 🆕 entries from the tables above
- [ ] Author per-vote `directionMultiplier` entries in `scripts/vote-overrides.yaml` for the NDAA strip-UA amendments (separate task; needs roll-call research)
- [ ] Re-run `npm run curate:bills` and diff the output
- [ ] Commit with trailer `Co-Authored-By: <you>` once verified

---

**Artifact metadata:**

- **Version**: 0.1.0 → 0.1.1 (applied 2026-04-19)
- **Produced**: 2026-04-19
- **Source**: web searches against congress.gov + the existing `ukraineBills.json` (52 entries post-T-104 curator run)
- **Applied**: 2026-04-19. Seed updated in `scripts/build-curated-bills.ts`; curator re-run against Congress.gov produced **62 bills total (55 pro / 2 anti / 5 neutral), 59 roll-call votes**. All 62 resolve to real Congress.gov titles — a title-grep audit flagged 5 (HR 2471, HR 815, S 3652 "NYET Act", HR 4346 "PEACE Act", SRES 100 "UNGA dissent") whose titles don't literally contain "Ukraine"/"Russia" but which are confirmed Ukraine-substantive on review.

**Caveat — title-grep is a weak heuristic.** A bill's title does not have to contain "Ukraine" for the bill to be Ukraine-scoring. The FY22 CR, the April 2024 emergency supplemental, and every sanctions bill with an acronymic short title (PEACE, NYET) are legitimate Ukraine bills with generic or creative titles. The audit serves as a spot-check for outright pollution, not as an auto-reject.

**Next version bumps:**

- v0.2.0 — per-vote `directionMultiplier` annotations for NDAA strip-UA amendments (HR 2670, HR 4350, HR 7900, HR 8070) so the neutral-direction gate in `services/valence.ts` actually flows through.
- v0.2.1+ — periodic review pass on new 119th-Congress bills as they come in.
