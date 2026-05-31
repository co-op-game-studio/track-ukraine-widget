/**
 * Pure D1 → KV member projections (FR-32 AC-32.40 / AC-32.41).
 *
 * Lives in proxy/ so BOTH the publish CLI (scripts/lib/members/project.ts
 * re-exports these) and the Worker routes (api-members / api-state-members /
 * api-name-search D1 self-heal fallback) share one implementation and can't
 * drift. Turns durable `members` + `vote_casts` rows into the KV record shapes
 * the routes + widget already consume.
 */
import { normalizeSearchKey, type NameIndexEntry } from '../kv/name-index';
import type { MemberProfile } from '../kv/member-profile';

/** The D1 `members` row shape (snake_case columns from migration 0013). */
export interface MemberRow {
  bioguide_id: string;
  first: string;
  last: string;
  official_name: string;
  state: string;
  chamber: string; // 'House' | 'Senate'
  district: number | null;
  party: string;
  photo_url: string | null;
  website: string | null;
  search_key: string;
  year_entered: number | null;
  is_non_voting: number;
  socials_json: string | null;
  sponsored_json: string;
  cosponsored_json: string;
  congress_update_date: string | null;
  last_freshness_check_at: string | null;
}

function parseJsonArray(s: string): unknown[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}
function parseSocials(s: string | null): MemberProfile['socials'] | undefined {
  if (!s) return undefined;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
}

/** members row → member:v1: MemberProfile (partyPrior stamped later at read time). */
export function projectMemberProfile(r: MemberRow, generatedAt: string): MemberProfile {
  const chamber: 'House' | 'Senate' = r.chamber === 'Senate' ? 'Senate' : 'House';
  return {
    bioguideId: r.bioguide_id,
    first: r.first,
    last: r.last,
    officialName: r.official_name,
    state: r.state,
    district: r.district,
    chamber,
    party: r.party,
    photoUrl: r.photo_url,
    website: r.website,
    searchKey: r.search_key,
    sponsored: parseJsonArray(r.sponsored_json),
    cosponsored: parseJsonArray(r.cosponsored_json),
    yearEntered: r.year_entered ?? undefined,
    socials: parseSocials(r.socials_json),
    generatedAt,
    schemaVersion: 1,
  };
}

export interface MemberSummary {
  bioguideId: string;
  first: string;
  last: string;
  officialName: string;
  state: string;
  district: number | null;
  chamber: 'Senate' | 'House';
  party: string;
  photoUrl: string | null;
  website: string | null;
  isNonVoting?: boolean;
  yearEntered?: number;
  socials?: MemberProfile['socials'];
}

export interface StateMembersRecord {
  stateCode: string;
  senators: MemberSummary[];
  house: MemberSummary[];
  generatedAt: string;
  schemaVersion: number;
}

function toSummary(r: MemberRow): MemberSummary {
  const chamber: 'Senate' | 'House' = r.chamber === 'Senate' ? 'Senate' : 'House';
  return {
    bioguideId: r.bioguide_id, first: r.first, last: r.last, officialName: r.official_name,
    state: r.state, district: r.district, chamber, party: r.party,
    photoUrl: r.photo_url, website: r.website,
    isNonVoting: r.is_non_voting === 1 || undefined,
    yearEntered: r.year_entered ?? undefined,
    socials: parseSocials(r.socials_json),
  };
}

/** members[] → Map<stateCode, state-members:v1: record>. */
export function projectStateMembers(rows: MemberRow[], generatedAt: string): Map<string, StateMembersRecord> {
  const byState = new Map<string, StateMembersRecord>();
  for (const r of rows) {
    if (!/^[A-Z]{2}$/.test(r.state)) continue;
    let rec = byState.get(r.state);
    if (!rec) { rec = { stateCode: r.state, senators: [], house: [], generatedAt, schemaVersion: 1 }; byState.set(r.state, rec); }
    (r.chamber === 'Senate' ? rec.senators : rec.house).push(toSummary(r));
  }
  for (const rec of byState.values()) {
    rec.senators.sort((a, b) => a.last.localeCompare(b.last));
    rec.house.sort((a, b) => (a.district ?? 0) - (b.district ?? 0));
  }
  return byState;
}

export interface NameIndexShard { letter: string; generatedAt: string; entries: NameIndexEntry[]; schemaVersion: number }
export interface NameIndexMeta { generatedAt: string; shardLetters: string[]; totalMembers: number }

function toNameIndexEntry(r: MemberRow): NameIndexEntry {
  const chamber: 'Senate' | 'House' = r.chamber === 'Senate' ? 'Senate' : 'House';
  return {
    bioguideId: r.bioguide_id,
    displayName: `${r.first} ${r.last}`.trim(),
    first: r.first, last: r.last, state: r.state, chamber, district: r.district,
    party: r.party, photoUrl: r.photo_url,
    searchKeys: [normalizeSearchKey(r.first), normalizeSearchKey(r.last)].filter(Boolean),
  };
}

/** members[] → name-index shards (by first letter of each searchKey) + meta. */
export function projectNameIndex(rows: MemberRow[], generatedAt: string): { shards: Map<string, NameIndexShard>; meta: NameIndexMeta } {
  const shards = new Map<string, NameIndexShard>();
  for (const r of rows) {
    const entry = toNameIndexEntry(r);
    const letters = new Set(entry.searchKeys.map((k) => k[0]).filter(Boolean) as string[]);
    for (const letter of letters) {
      let shard = shards.get(letter);
      if (!shard) { shard = { letter, generatedAt, entries: [], schemaVersion: 1 }; shards.set(letter, shard); }
      shard.entries.push(entry);
    }
  }
  return {
    shards,
    meta: { generatedAt, shardLetters: [...shards.keys()].sort(), totalMembers: rows.length },
  };
}

/* ----------------------------- rosters from vote_casts ----------------------------- */

export interface VoteCastRow {
  chamber: string; congress: number; session: number; roll_call: number;
  bioguide_id: string | null; last_name: string | null; first_name: string | null;
  state: string | null; party: string | null; cast: string;
}

export interface RosterRecord {
  rollCallId: string;
  chamber: 'house' | 'senate';
  congress: number;
  session: number;
  rollCall: number;
  casts: Record<string, string> | Array<{ lastName: string; state: string; cast: string; firstName?: string; party?: string }>;
  generatedAt: string;
  schemaVersion: number;
}

/** vote_casts[] → Map<KV key, roster record> grouped per roll-call. */
export function projectRosters(casts: VoteCastRow[], generatedAt: string): Map<string, RosterRecord> {
  const byRoll = new Map<string, VoteCastRow[]>();
  for (const c of casts) {
    const key = `${c.chamber.toLowerCase()}:${c.congress}:${c.session}:${c.roll_call}`;
    if (!byRoll.has(key)) byRoll.set(key, []);
    byRoll.get(key)!.push(c);
  }
  const out = new Map<string, RosterRecord>();
  for (const [rollId, rows] of byRoll) {
    const first = rows[0]!;
    const chamber = first.chamber.toLowerCase() === 'senate' ? 'senate' : 'house';
    const base = { rollCallId: rollId, chamber, congress: first.congress, session: first.session, rollCall: first.roll_call, generatedAt, schemaVersion: 1 } as const;
    if (chamber === 'house') {
      const c: Record<string, string> = {};
      for (const r of rows) if (r.bioguide_id) c[r.bioguide_id] = r.cast;
      out.set(`roll-call-roster:v1:${rollId}`, { ...base, casts: c });
    } else {
      out.set(`roll-call-roster:v1:${rollId}`, {
        ...base,
        casts: rows.filter((r) => r.last_name && r.state).map((r) => ({
          lastName: r.last_name as string, state: r.state as string, cast: r.cast,
          ...(r.first_name ? { firstName: r.first_name } : {}),
          ...(r.party ? { party: r.party } : {}),
        })),
      });
    }
  }
  return out;
}
