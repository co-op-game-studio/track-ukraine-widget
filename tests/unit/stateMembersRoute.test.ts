/**
 * AC-32.16 — /api/state-members/{stateCode}
 *
 * Specified in spec.md FR-32 AC-32.16 and api-contracts.md §5.6;
 * serves `state-members:v1:{stateCode}` records from KV.
 *
 * These tests are expected to FAIL until T-039 (new Worker route handler)
 * lands.
 */
import { describe, expect, it } from 'vitest';
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

function makeEnv(store: Record<string, string>): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    ALLOW_LOCALHOST: undefined,
    KV_VOTER_INFO: makeKV(store),
  };
}

const ORIGIN = { Origin: 'https://trackukraine.com' };

const illinoisRecord = {
  stateCode: 'IL',
  senators: [
    {
      bioguideId: 'D000563', first: 'Richard', last: 'Durbin',
      officialName: 'Richard J. Durbin', state: 'IL', district: null,
      chamber: 'Senate', party: 'D',
      photoUrl: 'https://www.congress.gov/img/member/d000563_200.jpg',
      website: 'https://www.durbin.senate.gov',
    },
    {
      bioguideId: 'D000622', first: 'Tammy', last: 'Duckworth',
      officialName: 'Tammy Duckworth', state: 'IL', district: null,
      chamber: 'Senate', party: 'D',
      photoUrl: 'https://www.congress.gov/img/member/d000622_200.jpg',
      website: 'https://www.duckworth.senate.gov',
    },
  ],
  house: [
    {
      bioguideId: 'J000309', first: 'Jonathan', last: 'Jackson',
      officialName: 'Jonathan L. Jackson', state: 'IL', district: 1,
      chamber: 'House', party: 'D',
      photoUrl: null, website: null,
    },
    {
      bioguideId: 'D000096', first: 'Danny', last: 'Davis',
      officialName: 'Danny K. Davis', state: 'IL', district: 7,
      chamber: 'House', party: 'D',
      photoUrl: null, website: null,
    },
  ],
  generatedAt: '2026-04-19T02:00:00Z',
  schemaVersion: 1,
};

describe('AC-32.16 — /api/state-members/ route', () => {
  it('AC-32.16 — 200 with state record verbatim on hit', async () => {
    const store = {
      'state-members:v1:IL': JSON.stringify(illinoisRecord),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/IL', { headers: ORIGIN }),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as typeof illinoisRecord;
    expect(body).toEqual(illinoisRecord);
    expect(body.senators).toHaveLength(2);
    expect(body.house).toHaveLength(2);
  });

  it('AC-32.16 — accepts case-insensitive stateCode, normalized to uppercase lookup', async () => {
    const store = {
      'state-members:v1:IL': JSON.stringify(illinoisRecord),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/il', { headers: ORIGIN }),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stateCode: string };
    expect(body.stateCode).toBe('IL');
  });

  it('AC-32.16 — Cache-Control is 5 min with SWR=10 min (tightened 2026-04-19 UAT)', async () => {
    const store = {
      'state-members:v1:IL': JSON.stringify(illinoisRecord),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/IL', { headers: ORIGIN }),
      makeEnv(store),
      makeCache(),
    );
    const cc = r.headers.get('Cache-Control') ?? '';
    // Dropped from 24h/24h/1h SWR → 5min/5min/10min SWR so curator
    // republishes (state-members changes frequently during iteration)
    // propagate within minutes instead of a full day.
    expect(cc).toContain('max-age=300');
    expect(cc).toContain('s-maxage=300');
    expect(cc).toContain('stale-while-revalidate=600');
  });

  it('AC-32.16 — 404 `state_members_not_found` on missing key', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/WY', { headers: ORIGIN }),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('state_members_not_found');
  });

  it('AC-32.16 — 400 `invalid_state_code` on malformed stateCode', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/NOT_A_STATE', { headers: ORIGIN }),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_state_code');
  });

  it('AC-32.16 — 403 on disallowed origin', async () => {
    const store = {
      'state-members:v1:IL': JSON.stringify(illinoisRecord),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/state-members/IL', {
        headers: { Origin: 'https://evil.example.com' },
      }),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(403);
  });
});
