/**
 * Congress calendar helpers — FR-41 AC-41.4 (spec.md v2.6.0).
 *
 * Pure functions over the U.S. Congress schedule:
 *   - Each Congress lasts 2 years, starting January 3 of the odd year.
 *     117th = 2021-01-03 .. 2023-01-03
 *     118th = 2023-01-03 .. 2025-01-03
 *     119th = 2025-01-03 .. 2027-01-03
 *   - Each Congress has two sessions:
 *     Session 1 = the odd year (e.g., 2025 for the 119th)
 *     Session 2 = the even year (e.g., 2026 for the 119th)
 *
 * Used by `R2Tier.put()` (via its policy-gate caller) and by upstream
 * fetchers that need to stamp `sessionStatus` on CacheEntry.
 *
 * No hidden state. `now` is always a parameter so tests pin time.
 */

/**
 * Congress number containing the given date. 117 for dates in 2021-2022,
 * 118 for 2023-2024, 119 for 2025-2026, etc. Transition happens on
 * January 3 of the odd year.
 */
export function currentCongress(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const day = now.getUTCDate();

  // Reference: 117th starts 2021-01-03.
  // A new Congress starts on 2021, 2023, 2025, ... (odd years), specifically
  // on January 3. Before Jan 3 of an odd year, the previous Congress still
  // sits.
  const startYearOfThisCongress = year % 2 === 1
    ? (month === 0 && day < 3 ? year - 2 : year)
    : year - 1;
  return 117 + Math.floor((startYearOfThisCongress - 2021) / 2);
}

/**
 * Session number (1 or 2) for the given date within its Congress.
 * Session 1 = odd years (2021, 2023, 2025, ...).
 * Session 2 = even years (2022, 2024, 2026, ...).
 */
export function currentSession(now: Date = new Date()): 1 | 2 {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  // Before Jan 3 of a given year, we're effectively still in the prior
  // calendar year's session for congressional-calendar purposes.
  const effectiveYear = (month === 0 && day < 3) ? year - 1 : year;
  return (effectiveYear % 2 === 1) ? 1 : 2;
}

/**
 * Is a roll-call from a *closed* session? AC-41.4 rule:
 *   frozen if congress < currentCongress OR
 *           (congress === currentCongress AND session < currentSession).
 *
 * Future (congress, session) tuples are NEVER frozen — defense against
 * misclassification.
 */
export function isRollCallFrozen(args: {
  congress: number;
  session: number;
  now?: Date;
}): boolean {
  const now = args.now ?? new Date();
  const cc = currentCongress(now);
  const cs = currentSession(now);
  if (args.congress < cc) return true;
  if (args.congress > cc) return false;
  return args.session < cs;
}

/**
 * Is a bill's actions/summaries record frozen by the 180-day rule?
 * AC-41.4: frozen if `latestActionDate` is strictly >180 days before `now`.
 * Missing/null date → not frozen.
 */
export function isBillFrozen(args: {
  latestActionDate: Date | null;
  now?: Date;
}): boolean {
  if (!args.latestActionDate) return false;
  const now = args.now ?? new Date();
  const ageDays = (now.getTime() - args.latestActionDate.getTime()) / (24 * 3600 * 1000);
  return ageDays > 180;
}
