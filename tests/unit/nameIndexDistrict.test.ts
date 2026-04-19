/**
 * AC-32.4 (REVISED v2.5.2) — name-index shards carry `district: number | null`.
 *
 * Covers two flanks:
 *   1. The Worker's name-search handler preserves the `district` field when
 *      passing shard entries through to the client (the runtime shape, not
 *      just the TS type).
 *   2. The Worker's NameIndexEntry type admits `district` as an optional
 *      `number | null` without forcing a cast.
 *
 * Curator-side emission is covered by tests/unit/curator/publishToKv.test.ts
 * (that file is out of scope here — curator changes already landed in commit
 * 31552b8). This test pins the Worker-facing observable: hitting
 * /api/name-search surfaces the district from the shard.
 */
import { describe, expect, it } from 'vitest';
import {
  handleFetch,
  type CacheLike,
  type KVLike,
  type NameIndexEntry,
  type ProxyEnv,
} from '../../proxy/lib';

function makeFakeKV(store: Record<string, string> = {}): KVLike {
  return {
    async get(key) {
      return store[key] ?? null;
    },
    async put(key, value) {
      store[key] = value;
    },
    async list({ prefix }) {
      return {
        keys: Object.keys(store)
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(key) {
      delete store[key];
    },
  };
}

function makeFakeCache(): CacheLike {
  return {
    async match() {
      return undefined;
    },
    async put() {
      // no-op
    },
  };
}

function makeEnv(store: Record<string, string>): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    ALLOW_LOCALHOST: undefined,
    KV_VOTER_INFO: makeFakeKV(store),
  };
}

const ORIGIN = { Origin: 'https://trackukraine.com' };

describe('AC-32.4 — district in name-index shard round-trip', () => {
  const durbinSenate: NameIndexEntry = {
    bioguideId: 'D000563',
    displayName: 'Richard J. Durbin',
    first: 'Richard',
    last: 'Durbin',
    state: 'IL',
    chamber: 'Senate',
    district: null, // senator
    party: 'D',
    photoUrl: 'https://www.congress.gov/img/member/d000563_200.jpg',
    searchKeys: ['richard', 'durbin'],
  };

  const jordanHouse: NameIndexEntry = {
    bioguideId: 'J000289',
    displayName: 'Jim Jordan',
    first: 'Jim',
    last: 'Jordan',
    state: 'OH',
    chamber: 'House',
    district: 4,
    party: 'R',
    photoUrl: 'https://www.congress.gov/img/member/j000289_200.jpg',
    searchKeys: ['jim', 'jordan'],
  };

  function shardFor(letter: string, entries: NameIndexEntry[]): string {
    return JSON.stringify({ letter, generatedAt: '2026-04-18T00:00:00Z', entries });
  }

  it('preserves district on House member', async () => {
    const store = {
      'name-index:v1:meta': JSON.stringify({ shardLetters: ['j'], totalMembers: 1 }),
      'name-index:v1:j': shardFor('j', [jordanHouse]),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=jordan', { headers: ORIGIN }),
      makeEnv(store),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: NameIndexEntry[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.bioguideId).toBe('J000289');
    expect(body.results[0]!.district).toBe(4);
    expect(body.results[0]!.chamber).toBe('House');
  });

  it('preserves district=null on Senator', async () => {
    const store = {
      'name-index:v1:meta': JSON.stringify({ shardLetters: ['d'], totalMembers: 1 }),
      'name-index:v1:d': shardFor('d', [durbinSenate]),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=durbin', { headers: ORIGIN }),
      makeEnv(store),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: NameIndexEntry[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.district).toBeNull();
    expect(body.results[0]!.chamber).toBe('Senate');
  });

  // Backward-compat guard: a pre-v2.5.2 shard with no `district` field at all
  // SHALL NOT crash the route. The response SHALL omit or null the field
  // rather than throw.
  it('backward-compat: shard entry without district field does not crash', async () => {
    // Build an entry the old way (no `district` key at all).
    const pre252: Record<string, unknown> = {
      bioguideId: 'X000001',
      displayName: 'Legacy Member',
      first: 'Legacy',
      last: 'Member',
      state: 'OH',
      chamber: 'House',
      party: 'R',
      photoUrl: null,
      searchKeys: ['legacy', 'member'],
    };
    const store = {
      'name-index:v1:meta': JSON.stringify({ shardLetters: ['l'], totalMembers: 1 }),
      'name-index:v1:l': JSON.stringify({
        letter: 'l',
        generatedAt: '2025-01-01T00:00:00Z',
        entries: [pre252],
      }),
    };
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/name-search?q=legacy', { headers: ORIGIN }),
      makeEnv(store),
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(1);
    // `district` may be absent in the output (pass-through), or explicitly
    // null after normalization. Either shape is acceptable. The widget's
    // NameSearchResultsPanel uses `r.district ?? null` so both map to the
    // same Representative shape.
    const d = body.results[0]!.district;
    expect(d === undefined || d === null).toBe(true);
  });
});
