/**
 * AC-32.15 — /api/roll-call-rosters/{chamber}/{congress}/{session}/{rollCall}
 *
 * This route is specified in spec.md FR-32 AC-32.15 and api-contracts.md §5.5;
 * it serves `roll-call-roster:v1:{chamber}:{c}:{s}:{rc}` records from KV.
 *
 * These tests are expected to FAIL until T-037 (new Worker route handler)
 * lands. Each test cites the AC it pins.
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

const houseRoster = {
  rollCallId: 'house:118:2:151',
  chamber: 'house',
  congress: 118,
  session: 2,
  rollCall: 151,
  casts: {
    J000289: 'Nay',
    D000096: 'Yea',
    A000371: 'Nay',
  },
  generatedAt: '2026-04-19T02:00:00Z',
  schemaVersion: 1,
};

const senateRoster = {
  rollCallId: 'senate:118:2:154',
  chamber: 'senate',
  congress: 118,
  session: 2,
  rollCall: 154,
  casts: [
    { lastName: 'Durbin', state: 'IL', cast: 'Yea', firstName: 'Richard', party: 'D' },
    { lastName: 'Duckworth', state: 'IL', cast: 'Yea', firstName: 'Tammy', party: 'D' },
    { lastName: 'Lankford', state: 'OK', cast: 'Nay', firstName: 'James', party: 'R' },
  ],
  generatedAt: '2026-04-19T02:00:00Z',
  schemaVersion: 1,
};

describe('AC-32.15 — /api/roll-call-rosters/ route', () => {
  it('AC-32.15 — 200 with House roster verbatim on KV hit', async () => {
    const store = {
      'roll-call-roster:v1:house:118:2:151': JSON.stringify(houseRoster),
    };
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/118/2/151',
        { headers: ORIGIN },
      ),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as typeof houseRoster;
    expect(body).toEqual(houseRoster);
    expect(body.casts.J000289).toBe('Nay');
  });

  it('AC-32.15 — 200 with Senate roster verbatim on KV hit', async () => {
    const store = {
      'roll-call-roster:v1:senate:118:2:154': JSON.stringify(senateRoster),
    };
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/senate/118/2/154',
        { headers: ORIGIN },
      ),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as typeof senateRoster;
    expect(body).toEqual(senateRoster);
    expect(Array.isArray(body.casts)).toBe(true);
    expect(body.casts.find((c) => c.lastName === 'Durbin')?.cast).toBe('Yea');
  });

  it('AC-32.15 — Cache-Control is immutable 1y', async () => {
    const store = {
      'roll-call-roster:v1:house:118:2:151': JSON.stringify(houseRoster),
    };
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/118/2/151',
        { headers: ORIGIN },
      ),
      makeEnv(store),
      makeCache(),
    );
    const cc = r.headers.get('Cache-Control') ?? '';
    // AC-32.15 mandates: public, max-age=86400, s-maxage=31536000, immutable
    expect(cc).toContain('max-age=86400');
    expect(cc).toContain('s-maxage=31536000');
    expect(cc).toContain('immutable');
  });

  it('AC-32.15 — 404 with `roll_call_roster_not_found` on missing key', async () => {
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/118/2/999',
        { headers: ORIGIN },
      ),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('roll_call_roster_not_found');
  });

  it('AC-32.15 — 400 on invalid chamber', async () => {
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/martian/118/2/151',
        { headers: ORIGIN },
      ),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(400);
  });

  it('AC-32.15 — 400 on non-numeric congress/session/rollCall', async () => {
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/abc/2/151',
        { headers: ORIGIN },
      ),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(400);
  });

  it('AC-32.15 — 403 on disallowed origin', async () => {
    const store = {
      'roll-call-roster:v1:house:118:2:151': JSON.stringify(houseRoster),
    };
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/118/2/151',
        { headers: { Origin: 'https://evil.example.com' } },
      ),
      makeEnv(store),
      makeCache(),
    );
    expect(r.status).toBe(403);
  });

  it('AC-32.15 — 405 on POST', async () => {
    const r = await handleFetch(
      new Request(
        'https://vote.cogs.it.com/api/roll-call-rosters/house/118/2/151',
        { method: 'POST', headers: ORIGIN },
      ),
      makeEnv({}),
      makeCache(),
    );
    expect(r.status).toBe(405);
  });
});
