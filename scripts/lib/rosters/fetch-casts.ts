/**
 * Roll-call cast fetchers — pull a single roll-call's member casts from
 * upstream. House: Congress.gov house-vote members (keyed by bioguideId).
 * Senate: Senate.gov roll-call XML (keyed by lastName+state, no bioguide).
 *
 * Extracted from scripts/publish-to-kv.ts so the `lw rosters seed` CLI and the
 * legacy KV publish share one implementation. Returns null on 404 (roll-call
 * not published upstream yet); throws on other non-OK so the caller can record
 * the failure and continue.
 *
 * Traces to: FR-32 AC-32.36, AC-32.15.
 */
import { DOMParser } from 'linkedom';

export interface HouseCast {
  bioguideId: string;
  cast: string;
}
export interface SenateCast {
  lastName: string;
  state: string;
  cast: string;
  firstName?: string;
  party?: string;
}

export interface CastFetchers {
  fetchHouse(congress: number, session: number, rollCall: number): Promise<HouseCast[] | null>;
  fetchSenate(congress: number, session: number, rollCall: number): Promise<SenateCast[] | null>;
}

/** Production fetchers bound to a Congress.gov API key. Tests inject fakes. */
export function makeCastFetchers(congressApiKey: string): CastFetchers {
  return {
    async fetchHouse(congress, session, rollCall) {
      const url = `https://api.congress.gov/v3/house-vote/${congress}/${session}/${rollCall}/members?format=json&limit=500&api_key=${congressApiKey}`;
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`House roster ${res.status} for ${congress}/${session}/${rollCall}`);
      const data = (await res.json()) as {
        houseRollCallVoteMemberVotes?: { results?: Array<{ bioguideID: string; voteCast: string }> };
      };
      const results = data.houseRollCallVoteMemberVotes?.results ?? [];
      const out: HouseCast[] = [];
      for (const r of results) {
        if (!r.bioguideID) continue;
        out.push({ bioguideId: r.bioguideID, cast: r.voteCast });
      }
      return out;
    },

    async fetchSenate(congress, session, rollCall) {
      const padded = String(rollCall).padStart(5, '0');
      const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Senate XML ${res.status} for ${congress}/${session}/${rollCall}`);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'text/xml') as unknown as Document;
      const members = Array.from(doc.getElementsByTagName('member'));
      const out: SenateCast[] = [];
      for (const m of members) {
        const lastName = m.getElementsByTagName('last_name')[0]?.textContent?.trim() ?? '';
        const firstName = m.getElementsByTagName('first_name')[0]?.textContent?.trim() ?? '';
        const state = m.getElementsByTagName('state')[0]?.textContent?.trim() ?? '';
        const party = m.getElementsByTagName('party')[0]?.textContent?.trim() ?? '';
        const cast = m.getElementsByTagName('vote_cast')[0]?.textContent?.trim() ?? '';
        if (!lastName || !state) continue;
        out.push({ lastName, state, cast, firstName, party });
      }
      return out;
    },
  };
}
