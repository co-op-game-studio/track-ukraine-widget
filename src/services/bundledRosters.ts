/**
 * Bundled-roster facade (ADR-011 revised v2.5.1).
 *
 * In the KV-sole-datastore architecture we no longer pre-bundle vote rosters.
 * useVotingRecord goes directly to /api/congress/v3/house-vote/* and the
 * Senate XML routes; those requests are cached by the proxy's ADR-009
 * response cache (1-year TTL on historical roll calls).
 *
 * This module preserves the public API that useVotingRecord imports but
 * always reports "no bundled data" — forcing the hook's network fallback
 * path, which Just Works. The Worker handles per-roll-call caching so the
 * "cold" cost is amortized across all visitors globally.
 */

export function initRosters(_apiBase: string): Promise<void> {
  return Promise.resolve();
}

export function rostersReady(): boolean {
  return true;
}

export function hasBundledRoster(
  _chamber: 'House' | 'Senate',
  _congress: number,
  _session: number,
  _rollCall: number,
): boolean {
  return false;
}

export function preloadHouseMember(_bioguideId: string): Promise<null> {
  return Promise.resolve(null);
}

export function preloadSenateMember(_last: string, _state: string): Promise<null> {
  return Promise.resolve(null);
}

export function bundledHouseCast(
  _congress: number,
  _session: number,
  _rollCall: number,
  _bioguideId: string,
): string | null | undefined {
  return undefined;
}

export function bundledSenateCast(
  _congress: number,
  _session: number,
  _rollCall: number,
  _lastName: string,
  _state: string,
): string | null | undefined {
  return undefined;
}

export function rosterGeneratedAt(): string {
  return '';
}

export function __resetBundledRostersForTest(): void {
  /* no-op */
}
