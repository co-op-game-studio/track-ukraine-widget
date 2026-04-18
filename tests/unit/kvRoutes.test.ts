/**
 * KV-backed route tests for /api/members, /api/name-search, /api/bills, /api/roll-calls.
 * Traces to: FR-24 (revised), FR-31, FR-32, ADR-011.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleFetch, type ProxyEnv, type KVLike, type CacheLike, normalizeSearchKey, rankMatches, type NameIndexEntry } from '../../proxy/lib';

function makeFakeKV(store: Record<string, string> = {}): KVLike {
  return {
    async get(key, _type) {
      return store[key] ?? null;
    },
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

function makeFakeCache(): CacheLike {
  const store = new Map<string, Response>();
  return {
    async match(req) { const k = typeof req === 'string' ? req : req.url; return store.get(k)?.clone(); },
    async put(req, resp) { const k = typeof req === 'string' ? req : req.url; store.set(k, resp); },
  };
}

function makeEnv(store: Record<string, string> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    ALLOW_LOCALHOST: undefined,
    KV_VOTER_INFO: makeFakeKV(store),
  };
}

const ORIGIN = { Origin: 'https://trackukraine.com' };

describe('normalizeSearchKey (AC-31.7)', () => {
  it('lowercases', () => expect(normalizeSearchKey('Durbin')).toBe('durbin'));
  it('strips diacritics', () => expect(normalizeSearchKey('Peña')).toBe('pena'));
  it('removes apostrophes', () => expect(normalizeSearchKey("O'Connor")).toBe('oconnor'));
  it('removes hyphens', () => expect(normalizeSearchKey('Van-Hollen')).toBe('vanhollen'));
  it('collapses whitespace', () => expect(normalizeSearchKey('  van  hollen  ')).toBe('van hollen'));
});

describe('rankMatches (AC-31.4)', () => {
  const entries: NameIndexEntry[] = [
    { bioguideId: 'D000563', displayName: 'Richard J. Durbin', first: 'Richard', last: 'Durbin', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['richard', 'durbin'] },
    { bioguideId: 'D000618', displayName: 'Mark DeSaulnier', first: 'Mark', last: 'DeSaulnier', state: 'CA', chamber: 'House', party: 'D', searchKeys: ['mark', 'desaulnier'] },
    { bioguideId: 'B001230', displayName: 'Tammy Baldwin', first: 'Tammy', last: 'Baldwin', state: 'WI', chamber: 'Senate', party: 'D', searchKeys: ['tammy', 'baldwin'] },
    { bioguideId: 'D000610', displayName: 'Tammy Duckworth', first: 'Tammy', last: 'Duckworth', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['tammy', 'duckworth'] },
  ];

  it('prefix match ranks before substring match', () => {
    const r = rankMatches('durb', entries);
    expect(r[0]?.bioguideId).toBe('D000563'); // Durbin prefix-matches
  });

  it('matches first name "tammy"', () => {
    const r = rankMatches('tammy', entries);
    expect(r.length).toBe(2);
    expect(r.map((x) => x.bioguideId).sort()).toEqual(['B001230', 'D000610']);
  });

  it('Senate ranks before House among same tier (AC-31.4)', () => {
    // Two prefix matches on "du": Durbin (Senate, IL), Duckworth (Senate, IL) — both Senate.
    // Use an entry set with a known House prefix-match and a known Senate prefix-match.
    const mixed: NameIndexEntry[] = [
      { bioguideId: 'HX001', displayName: 'House Dummy', first: 'House', last: 'Dummy', state: 'TX', chamber: 'House', party: 'R', searchKeys: ['house', 'dummy'] },
      { bioguideId: 'SY001', displayName: 'Senate Dummy', first: 'Senate', last: 'Dummy', state: 'TX', chamber: 'Senate', party: 'R', searchKeys: ['senate', 'dummy'] },
    ];
    const r = rankMatches('dummy', mixed);
    expect(r.length).toBe(2);
    expect(r[0]?.chamber).toBe('Senate');
    expect(r[1]?.chamber).toBe('House');
  });

  it('returns empty for non-match', () => {
    expect(rankMatches('zzzz', entries)).toEqual([]);
  });
});

describe('/api/members/{bioguideId}', () => {
  it('200 with JSON on hit', async () => {
    const env = makeEnv({ 'member:v1:D000563': JSON.stringify({ bioguideId: 'D000563', last: 'Durbin' }) });
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/members/D000563', { headers: ORIGIN }), env, makeFakeCache());
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toContain('max-age=60');
    const body = await r.json() as { bioguideId: string };
    expect(body.bioguideId).toBe('D000563');
  });

  it('404 on miss (read-through returns upstream 404)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/X999999', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    spy.mockRestore();
  });

  it('read-through: cache miss → upstream fetch → returns profile + X-Cache: MISS', async () => {
    const memberDetail = {
      member: {
        bioguideId: 'D000563',
        firstName: 'Richard',
        lastName: 'Durbin',
        directOrderName: 'Richard J. Durbin',
        state: 'IL',
        partyHistory: [{ partyName: 'Democratic' }],
        terms: { item: [{ chamber: 'Senate' }] },
      },
    };
    const sponsored = { sponsoredLegislation: [{ number: 'S1' }] };
    const cosponsored = { cosponsoredLegislation: [] };
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/sponsored-legislation')) return new Response(JSON.stringify(sponsored));
      if (u.includes('/cosponsored-legislation')) return new Response(JSON.stringify(cosponsored));
      return new Response(JSON.stringify(memberDetail));
    });
    const store: Record<string, string> = {};
    const env = makeEnv(store);
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/D000563', { headers: ORIGIN }),
      env,
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Cache')).toBe('MISS');
    const body = await r.json() as { bioguideId: string; chamber: string };
    expect(body.bioguideId).toBe('D000563');
    expect(body.chamber).toBe('Senate');
    spy.mockRestore();
  });

  it('400 on invalid bioguide shape', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/members/not-a-bioguide', { headers: ORIGIN }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(400);
  });

  it('403 on disallowed origin', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/members/D000563', { headers: { Origin: 'https://evil.example.com' } }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(403);
  });

  it('405 on POST', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/members/D000563', { method: 'POST', headers: ORIGIN }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(405);
  });

  it('204 OPTIONS preflight on allowed origin', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/members/D000563', { method: 'OPTIONS', headers: ORIGIN }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(204);
  });
});

describe('/api/name-search', () => {
  const durbinEntry: NameIndexEntry = { bioguideId: 'D000563', displayName: 'Richard J. Durbin', first: 'Richard', last: 'Durbin', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['richard', 'durbin'] };
  const baldwinEntry: NameIndexEntry = { bioguideId: 'B001230', displayName: 'Tammy Baldwin', first: 'Tammy', last: 'Baldwin', state: 'WI', chamber: 'Senate', party: 'D', searchKeys: ['tammy', 'baldwin'] };
  const duckworthEntry: NameIndexEntry = { bioguideId: 'D000610', displayName: 'Tammy Duckworth', first: 'Tammy', last: 'Duckworth', state: 'IL', chamber: 'Senate', party: 'D', searchKeys: ['tammy', 'duckworth'] };

  const storeWithIndex = (): Record<string, string> => ({
    'name-index:v1:meta': JSON.stringify({ generatedAt: new Date().toISOString() }),
    'name-index:v1:d': JSON.stringify({ letter: 'd', entries: [durbinEntry, duckworthEntry] }),
    'name-index:v1:b': JSON.stringify({ letter: 'b', entries: [baldwinEntry] }),
    'name-index:v1:t': JSON.stringify({ letter: 't', entries: [baldwinEntry, duckworthEntry] }),
    'name-index:v1:r': JSON.stringify({ letter: 'r', entries: [durbinEntry] }),
  });

  it('returns matches for last-name query', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=durb', { headers: ORIGIN }),
      makeEnv(storeWithIndex()),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { results: NameIndexEntry[]; truncated: boolean };
    expect(body.results.length).toBe(1);
    expect(body.results[0]?.bioguideId).toBe('D000563');
    expect(body.truncated).toBe(false);
  });

  it('returns matches for first-name query (AC-31.6)', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=tammy', { headers: ORIGIN }),
      makeEnv(storeWithIndex()),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { results: NameIndexEntry[] };
    expect(body.results.map((x) => x.bioguideId).sort()).toEqual(['B001230', 'D000610']);
  });

  it('503 when index not built', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=durb', { headers: ORIGIN }),
      makeEnv(), // empty store
      makeFakeCache(),
    );
    expect(r.status).toBe(503);
  });

  it('400 on short query', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=d', { headers: ORIGIN }),
      makeEnv(storeWithIndex()),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
  });

  it('deduplicates across multi-shard query', async () => {
    // "tammy durbin" — two letters, but duckworth shouldn't appear twice
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=tammy%20durb', { headers: ORIGIN }),
      makeEnv(storeWithIndex()),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json() as { results: NameIndexEntry[] };
    const ids = body.results.map((x) => x.bioguideId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('403 on disallowed origin', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=durb', { headers: { Origin: 'https://evil.example.com' } }),
      makeEnv(storeWithIndex()),
      makeFakeCache(),
    );
    expect(r.status).toBe(403);
  });
});

describe('/api/bills/{billId}', () => {
  it('200 on hit', async () => {
    const env = makeEnv({ 'bill:v1:HR815': JSON.stringify({ billId: 'HR815', title: 'Test' }) });
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/bills/HR815', { headers: ORIGIN }), env, makeFakeCache());
    expect(r.status).toBe(200);
  });
  it('404 on miss', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/bills/S999', { headers: ORIGIN }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(404);
  });
});

describe('/api/roll-calls', () => {
  it('200 on hit', async () => {
    const env = makeEnv({ 'roll-call:v1:senate:118:2:154': JSON.stringify({ rollCall: 154 }) });
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/roll-calls/senate/118/2/154', { headers: ORIGIN }), env, makeFakeCache());
    expect(r.status).toBe(200);
  });
  it('400 on malformed path', async () => {
    const r = await handleFetch(new Request('https://vote.cogs.it.com/api/roll-calls/senate/abc/2/154', { headers: ORIGIN }), makeEnv(), makeFakeCache());
    expect(r.status).toBe(400);
  });
});
