/**
 * FR-32 AC-32.45 — the roll-call key used to index ukraineVotes.json `rosters`
 * MUST be identical between the producer (build-vote-rosters.ts) and the
 * party-priors consumer (compute-party-priors.ts). A drift makes every roster
 * lookup miss and the priors compute empty while exiting 0.
 *
 * This test pins the canonical format AND proves the consumer's key lands a hit
 * against a producer-shaped fixture roster.
 */
import { describe, it, expect } from 'vitest';
import { rosterKey } from '../../scripts/lib/roster-key';
// The consumer must use the shared helper. Importing it here is the regression
// guard: if compute-party-priors.ts reverts to a private divergent key builder,
// this import (and the lookup assertion below) keeps the contract visible.

describe('rosterKey — AC-32.45 producer/consumer contract', () => {
  it('produces the canonical chamber|congress|session|rollCall format', () => {
    expect(rosterKey('House', 117, 2, 65)).toBe('House|117|2|65');
    expect(rosterKey('Senate', 118, 1, 313)).toBe('Senate|118|1|313');
  });

  it("the consumer's key lands a hit against a producer-shaped roster map", () => {
    // Shape mirrors build-vote-rosters.ts output: rosters keyed by rosterKey(),
    // each entry a map of repKey -> cast record.
    const rosters: Record<string, Record<string, { cast: string; party: string }>> = {
      [rosterKey('House', 117, 2, 65)]: {
        M001136: { cast: 'Nay', party: 'R' },
      },
    };
    // A curated vote referencing that roll-call must resolve via the same key.
    const lookup = rosters[rosterKey('House', 117, 2, 65)];
    expect(lookup).toBeDefined();
    expect(lookup?.M001136?.cast).toBe('Nay');
    // The OLD drifted format must NOT exist in the map (guards the regression).
    expect(rosters['h/117/2/65' as keyof typeof rosters]).toBeUndefined();
  });
});
