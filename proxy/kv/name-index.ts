/**
 * Name-search normalization + ranking helpers.
 *
 * Owns the real implementations as of Phase 12 T-073 (2026-04-19).
 * `proxy/lib.ts` re-exports from here for legacy import paths.
 *
 * Traces: FR-42 AC-42.1, AC-42.2. FR-31 AC-31.4, AC-31.7.
 */

/** Normalize a name-search query or indexed name: lowercase, strip diacritics,
 *  remove apostrophes/hyphens, collapse whitespace. See AC-31.7. */
export function normalizeSearchKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NameIndexEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  /** House district number; null for Senators and non-voting delegates
   *  (AC-32.4 REVISED v2.5.2). Optional for backward compat with pre-v2.5.2
   *  shards; the curator SHALL write it on all post-v2.5.2 records. */
  district?: number | null;
  party: string;
  photoUrl?: string | null;
  searchKeys: string[];
}

/** Rank matches per AC-31.4: exact-prefix first, then substring, then by chamber then state. */
export function rankMatches(query: string, entries: NameIndexEntry[]): NameIndexEntry[] {
  const q = normalizeSearchKey(query);
  if (!q) return [];
  const scored = entries
    .map((e) => {
      const anyPrefix = e.searchKeys.some((k) => k.startsWith(q));
      const anySubstring = e.searchKeys.some((k) => k.includes(q));
      if (!anySubstring) return null;
      return { e, prefix: anyPrefix };
    })
    .filter((x): x is { e: NameIndexEntry; prefix: boolean } => x !== null);
  scored.sort((a, b) => {
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
    if (a.e.chamber !== b.e.chamber) return a.e.chamber === 'Senate' ? -1 : 1;
    if (a.e.state !== b.e.state) return a.e.state.localeCompare(b.e.state);
    return a.e.last.localeCompare(b.e.last);
  });
  return scored.map((s) => s.e);
}
