/**
 * Member-profile-backed roster lookup (FR-24 revised, FR-32, ADR-011).
 *
 * This module preserves the public API that the useVotingRecord hook depends on:
 *   - initRosters(apiBase)           — set the base URL for /api/members
 *   - rostersReady()                 — becomes true once at least one member is cached
 *   - hasBundledRoster(chamber,c,s,rc) — true if *any* cached member has a cast for this roll call
 *   - bundledHouseCast(c,s,rc,bioguide) — cast for the given House member on the roll call, or undefined if we haven't fetched them yet, or null if they did not serve
 *   - bundledSenateCast(c,s,rc,last,state) — same for Senate, matched by last|state
 *
 * Behind the scenes the data is fetched lazily from /api/members/{bioguideId}
 * (or an analogous key for senators — see Senate lookup section below).
 * A simple in-memory Map caches each member's profile after first fetch.
 *
 * Senate lookup: the curator keys senate entries by a pseudo-bioguide
 * `S|{last}|{state}` because senate XML lacks bioguides. This module
 * encapsulates that detail.
 */

interface UkraineVoteEntry {
  rollCallId: string; // "chamber:congress:session:rollCall", lowercase
  cast: string;
  date: string;
  billId: string;
  question: string;
  weight: number;
  billTitle: string;
}

interface MemberProfile {
  bioguideId: string;
  first: string;
  last: string;
  state: string;
  chamber: 'House' | 'Senate';
  party: string;
  ukraineVotes: UkraineVoteEntry[];
}

let apiBase = '';
const profileCache = new Map<string, MemberProfile | null>(); // null = fetched, not found
const inflight = new Map<string, Promise<MemberProfile | null>>();

export function initRosters(base: string): Promise<void> {
  apiBase = base.replace(/\/+$/, '');
  return Promise.resolve();
}

export function rostersReady(): boolean {
  return apiBase !== '';
}

function memberKey(chamber: 'House' | 'Senate', bioguide: string): string {
  return `${chamber}|${bioguide}`;
}

function rollCallId(chamber: 'House' | 'Senate', congress: number, session: number, rollCall: number): string {
  return `${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`;
}

async function fetchMemberProfile(chamber: 'House' | 'Senate', bioguide: string): Promise<MemberProfile | null> {
  if (!apiBase) return null;
  const key = memberKey(chamber, bioguide);
  if (profileCache.has(key)) return profileCache.get(key) ?? null;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<MemberProfile | null> => {
    try {
      const res = await fetch(`${apiBase}/api/members/${encodeURIComponent(bioguide)}`);
      if (res.status === 404) {
        profileCache.set(key, null);
        return null;
      }
      if (!res.ok) {
        // Transient failure — cache nothing so a retry is possible
        return null;
      }
      const data = (await res.json()) as MemberProfile;
      profileCache.set(key, data);
      return data;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Synchronously check whether we have any cached cast for this roll call. */
export function hasBundledRoster(
  chamber: 'House' | 'Senate',
  congress: number,
  session: number,
  rollCall: number,
): boolean {
  const targetId = rollCallId(chamber, congress, session, rollCall);
  for (const profile of profileCache.values()) {
    if (!profile) continue;
    if (profile.chamber !== chamber) continue;
    if (profile.ukraineVotes.some((v) => v.rollCallId === targetId)) return true;
  }
  return false;
}

/**
 * Preload a House member's profile. Returns a promise that resolves when the
 * fetch completes (or fails); callers may await to ensure `bundledHouseCast`
 * is hot.
 */
export function preloadHouseMember(bioguideId: string): Promise<MemberProfile | null> {
  return fetchMemberProfile('House', bioguideId);
}

export function preloadSenateMember(last: string, state: string): Promise<MemberProfile | null> {
  return fetchMemberProfile('Senate', `S|${last}|${state}`);
}

/**
 * Synchronous lookup (from cache only). Returns:
 *   undefined = member not fetched yet — caller should await preloadHouseMember first
 *   null      = member fetched, but absent from roster for this roll call (Did Not Serve)
 *   string    = their vote cast
 */
export function bundledHouseCast(
  congress: number,
  session: number,
  rollCall: number,
  bioguideId: string,
): string | null | undefined {
  const key = memberKey('House', bioguideId);
  if (!profileCache.has(key)) return undefined;
  const profile = profileCache.get(key);
  if (!profile) return null;
  const targetId = rollCallId('House', congress, session, rollCall);
  const v = profile.ukraineVotes.find((x) => x.rollCallId === targetId);
  return v ? v.cast : null;
}

export function bundledSenateCast(
  congress: number,
  session: number,
  rollCall: number,
  lastName: string,
  state: string,
): string | null | undefined {
  const key = memberKey('Senate', `S|${lastName}|${state}`);
  if (!profileCache.has(key)) return undefined;
  const profile = profileCache.get(key);
  if (!profile) return null;
  const targetId = rollCallId('Senate', congress, session, rollCall);
  const v = profile.ukraineVotes.find((x) => x.rollCallId === targetId);
  return v ? v.cast : null;
}

export function rosterGeneratedAt(): string {
  return '';
}

/** Test-only reset. */
export function __resetBundledRostersForTest(): void {
  profileCache.clear();
  inflight.clear();
  apiBase = '';
}
