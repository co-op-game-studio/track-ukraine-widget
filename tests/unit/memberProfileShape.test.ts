/**
 * AC-32.1 (REVISED v2.5.2) — MemberProfile shape.
 *
 * Pins the v2.5.2 profile shape returned by `/api/members/{bioguideId}`:
 *   - Identity fields: bioguideId, first, last, officialName, state,
 *     district (number | null), chamber, party.
 *   - URL fields: photoUrl, website (both nullable).
 *   - searchKey: normalized name per AC-31.7.
 *   - sponsored, cosponsored: arrays of raw CongressLegislationRawEntry
 *     objects (NOT pre-curated, NOT pre-joined to ukraineVotes/ukraineScore).
 *   - generatedAt, schemaVersion.
 *
 * AC-32.17 (DEFERRED) would add pre-joined `ukraineVotes` + `ukraineScore`.
 * Those fields SHALL NOT be present in the v2.5.2 shape; this test guards
 * against accidentally re-introducing them prematurely.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  handleFetch,
  type CacheLike,
  type KVLike,
  type ProxyEnv,
} from '../../proxy/lib';

function makeKV(store: Record<string, string> = {}): KVLike {
  return {
    async get(key) { return store[key] ?? null; },
    async put(key, value) { store[key] = value; },
    async list({ prefix }) {
      return {
        keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(key) { delete store[key]; },
  };
}

function makeCache(): CacheLike {
  return { async match() { return undefined; }, async put() {} };
}

function makeEnv(store: Record<string, string> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    ALLOW_LOCALHOST: undefined,
    KV_VOTER_INFO: makeKV(store),
  };
}

const ORIGIN = { Origin: 'https://trackukraine.com' };

describe('AC-32.1 (REVISED v2.5.2) — MemberProfile shape on read-through', () => {
  it('includes required identity + legislation fields and omits deferred AC-32.17 fields', async () => {
    const detail = {
      member: {
        bioguideId: 'D000563',
        firstName: 'Richard',
        lastName: 'Durbin',
        directOrderName: 'Richard J. Durbin',
        state: 'Illinois',
        partyHistory: [{ partyName: 'Democratic' }],
        terms: { item: [{ chamber: 'Senate', endYear: 2026 }] },
        depiction: { imageUrl: 'https://www.congress.gov/img/member/d000563_200.jpg' },
        officialWebsiteUrl: 'https://www.durbin.senate.gov',
      },
    };
    const sponsored = { sponsoredLegislation: [
      { congress: 118, type: 'S', number: '123', title: 'Some bill',
        introducedDate: '2023-01-09', latestAction: { text: 'Introduced' } },
    ] };
    const cosponsored = { cosponsoredLegislation: [
      { congress: 118, type: 'HR', number: '815', title: 'Ukraine supplemental',
        introducedDate: '2024-02-01', latestAction: { text: 'Became law' } },
    ] };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/sponsored-legislation')) return new Response(JSON.stringify(sponsored));
      if (u.includes('/cosponsored-legislation')) return new Response(JSON.stringify(cosponsored));
      return new Response(JSON.stringify(detail));
    });

    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/D000563', { headers: ORIGIN }),
      makeEnv(),
      makeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;

    // Required identity fields present.
    expect(body.bioguideId).toBe('D000563');
    expect(body.first).toBe('Richard');
    expect(body.last).toBe('Durbin');
    expect(body.officialName).toBe('Richard J. Durbin');
    expect(body.chamber).toBe('Senate');
    expect(body.party).toBe('D');
    expect(body.state).toBeTruthy();

    // district is number|null — for a Senator it SHALL be null (or absent;
    // AC-32.1 REVISED says null for senators).
    expect(body.district === null || body.district === undefined || typeof body.district === 'number').toBe(true);

    // URL fields may be null or a string.
    expect(body.photoUrl === null || typeof body.photoUrl === 'string').toBe(true);
    expect(body.website === null || typeof body.website === 'string').toBe(true);

    // searchKey present (AC-31.7 normalized).
    expect(typeof body.searchKey).toBe('string');

    // Legislation arrays present and raw.
    expect(Array.isArray(body.sponsored)).toBe(true);
    expect(Array.isArray(body.cosponsored)).toBe(true);
    expect((body.sponsored as unknown[]).length).toBe(1);
    expect((body.cosponsored as unknown[]).length).toBe(1);

    // Housekeeping fields.
    expect(typeof body.generatedAt).toBe('string');
    expect(body.schemaVersion).toBe(1);

    // Deferred AC-32.17 fields MUST NOT be present in v2.5.2. If they appear,
    // the implementation has regressed or pre-empted that AC without spec
    // alignment.
    expect(body.ukraineVotes).toBeUndefined();
    expect(body.ukraineScore).toBeUndefined();

    spy.mockRestore();
  });

  it('normalizes "Senate" chamber regardless of the Congress.gov "House of Representatives" vs "Senate" label', async () => {
    const houseDetail = {
      member: {
        bioguideId: 'J000289',
        firstName: 'Jim',
        lastName: 'Jordan',
        directOrderName: 'Jim Jordan',
        state: 'Ohio',
        district: 4,
        partyHistory: [{ partyName: 'Republican' }],
        terms: { item: [{ chamber: 'House of Representatives', endYear: 2026 }] },
      },
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('-legislation')) return new Response(JSON.stringify({}));
      return new Response(JSON.stringify(houseDetail));
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/J000289', { headers: ORIGIN }),
      makeEnv(),
      makeCache(),
      { waitUntil: (p) => { void p; } },
    );
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.chamber).toBe('House');
    expect(body.district).toBe(4);
    spy.mockRestore();
  });
});
