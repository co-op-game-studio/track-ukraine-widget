/**
 * Canonical roll-call key for `src/data/ukraineVotes.json` `rosters`.
 *
 * Single source of truth shared by the producer (`scripts/build-vote-rosters.ts`)
 * and the party-priors consumer (`scripts/compute-party-priors.ts`) so the two
 * cannot drift silently. A drift makes every `rosters[key]` lookup miss and the
 * consumer computes empty priors while exiting 0 — a hollow
 * `scores:v1:party-priors` write that looks successful but degrades every rep to
 * no-shrink.
 *
 * Format: `${chamber}|${congress}|${session}|${rollCall}` with `chamber` the
 * literal `'House'` or `'Senate'` (e.g. `House|117|2|65`).
 *
 * Traces to: FR-32 AC-32.45 (key contract), AC-32.42 (deterministic regen).
 */
export function rosterKey(
  chamber: 'House' | 'Senate',
  congress: number,
  session: number,
  rollCall: number,
): string {
  return `${chamber}|${congress}|${session}|${rollCall}`;
}
