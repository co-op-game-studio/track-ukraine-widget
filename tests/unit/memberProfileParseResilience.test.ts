/**
 * AC-32.19 — JSON parse resilience in the /api/members/{id} read-through.
 *
 * Optional legs (sponsored, cosponsored) with malformed/truncated JSON must
 * degrade to empty arrays rather than failing the whole profile fetch.
 * A malformed body on the required detail leg must surface as a clean 502
 * with `detail: "upstream_body_invalid"` — not a raw SyntaxError position.
 *
 * Observed in prod 2026-04-18 on bioguide A000371: a mid-response upstream
 * truncation leaked as "Expected ':' after property name in JSON at
 * position 15492" and blocked the member profile from ever populating KV.
 * See spec.md AC-32.19.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  handleFetch,
  type CacheLike,
  type KVLike,
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
  const store = new Map<string, Response>();
  return {
    async match(req) {
      const k = typeof req === 'string' ? req : req.url;
      return store.get(k)?.clone();
    },
    async put(req, resp) {
      const k = typeof req === 'string' ? req : req.url;
      store.set(k, resp);
    },
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

const validDetail = {
  member: {
    bioguideId: 'A000371',
    firstName: 'Pete',
    lastName: 'Aguilar',
    directOrderName: 'Pete Aguilar',
    state: 'California',
    district: 33,
    partyHistory: [{ partyName: 'Democratic' }],
    terms: { item: [{ chamber: 'House of Representatives', endYear: 2026 }] },
    depiction: { imageUrl: 'https://www.congress.gov/img/member/a000371_200.jpg' },
    officialWebsiteUrl: 'https://aguilar.house.gov',
  },
};

describe('AC-32.19 — malformed sponsored-legislation body', () => {
  it('degrades sponsored to [] and still returns the profile', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/sponsored-legislation')) {
        // Truncated mid-object — the real prod symptom on A000371.
        return new Response('{"sponsoredLegisla', { status: 200 });
      }
      if (u.includes('/cosponsored-legislation')) {
        return new Response(JSON.stringify({ cosponsoredLegislation: [{ number: 'HR1' }] }));
      }
      return new Response(JSON.stringify(validDetail));
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000371', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sponsored: unknown[]; cosponsored: unknown[] };
    expect(body.sponsored).toEqual([]);
    // Cosponsored was fine — must pass through.
    expect(body.cosponsored).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('AC-32.19 — malformed cosponsored-legislation body', () => {
  it('degrades cosponsored to [] and still returns the profile', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/cosponsored-legislation')) {
        return new Response('not json at all', { status: 200 });
      }
      if (u.includes('/sponsored-legislation')) {
        return new Response(JSON.stringify({ sponsoredLegislation: [{ number: 'S1' }] }));
      }
      return new Response(JSON.stringify(validDetail));
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000371', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sponsored: unknown[]; cosponsored: unknown[] };
    expect(body.cosponsored).toEqual([]);
    expect(body.sponsored).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('AC-32.19 — both optional legs malformed', () => {
  it('returns profile with both lists empty', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('-legislation')) {
        return new Response('{"sponsor', { status: 200 });
      }
      return new Response(JSON.stringify(validDetail));
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000371', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sponsored: unknown[]; cosponsored: unknown[] };
    expect(body.sponsored).toEqual([]);
    expect(body.cosponsored).toEqual([]);
    spy.mockRestore();
  });
});

describe('AC-32.19 — malformed required detail body', () => {
  it('returns 502 upstream_error with detail=upstream_body_invalid', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('-legislation')) {
        return new Response(JSON.stringify({ sponsoredLegislation: [], cosponsoredLegislation: [] }));
      }
      // Required leg returns truncated/malformed JSON.
      return new Response('{"member": {"bioguideId":', { status: 200 });
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000371', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: string; detail: string };
    expect(body.error).toBe('upstream_error');
    expect(body.detail).toContain('upstream_body_invalid');
    // Critically, the raw SyntaxError position MUST NOT leak.
    expect(body.detail).not.toMatch(/position \d+/);
    expect(body.detail).not.toMatch(/Unexpected token/);
    spy.mockRestore();
  });

  it('does not cache the failed profile (Cache-Control no-store)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{"member": {', { status: 200 });
    });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/members/A000371', { headers: ORIGIN }),
      makeEnv(),
      makeFakeCache(),
      { waitUntil: (p) => { void p; } },
    );
    expect(r.status).toBe(502);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    spy.mockRestore();
  });
});
