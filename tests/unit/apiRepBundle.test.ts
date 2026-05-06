/**
 * Unit tests for proxy/routes/api-rep-bundle.ts — the per-rep render-bundle
 * route.
 *
 * Target: maximize coverage of every branch documented in the source's JSDoc.
 *
 * Spec anchors covered (from the source file's JSDoc and the broader project):
 *   - FR-32 (KV-backed read-through fill / per-resource KV records)
 *   - FR-42 (route handler conventions / dispatch contract)
 *   - FR-51 (V4 denormalized read snapshots — bills/comments/social/quotes)
 *   - FR-55 / ADR-018 §6 (party-prior stamping comes through via the
 *     handleMemberProfile composition, not directly asserted here)
 *
 * All tests use named-import vitest, fake KV, fake ctx — no `vi.mock`,
 * no real `fetch`. The member profile is pre-seeded into KV so the
 * underlying `handleMemberProfile` cache-hit branch fires and no upstream
 * call is made.
 */
import { describe, it, expect } from 'vitest';
import { handleRepBundle } from '../../proxy/routes/api-rep-bundle';
import { KV_PREFIXES } from '../../proxy/kv/prefixes';
import type { ProxyEnv, KVLike } from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                              Fakes                                          */
/* -------------------------------------------------------------------------- */

class FakeKv implements KVLike {
  store = new Map<string, string>();
  putCalls: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = [];
  async get(key: string, type?: 'text' | 'json') {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') return JSON.parse(v);
    return v;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    this.putCalls.push({ key, value, opts });
    this.store.set(key, value);
  }
  async list(opts: { prefix: string }) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function makeEnv(kv: FakeKv): ProxyEnv {
  return {
    KV_VOTER_INFO: kv,
    // CONGRESS_API_KEY left absent — buildProfileFromUpstream returns null
    // immediately when missing, which exercises the "member non-200" branch
    // in composeBundle. For the happy-path tests we pre-seed the member KV
    // record so the upstream path never fires.
  } as unknown as ProxyEnv;
}

function makeRequest(method: 'GET' | 'HEAD' = 'GET'): Request {
  return new Request('https://worker.example/api/rep-bundle/A000001', { method });
}

/** Capture promises that the handler hands to ctx.waitUntil so tests can
 *  await the background KV write before asserting on it. */
function makeCtx(): { waitUntil: (p: Promise<unknown>) => void; promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    promises,
  };
}

const ORIGIN = 'https://embed.example';

/** Minimal MemberProfile JSON — enough to drive composeBundle's
 *  enumeration logic. The handler reads it out of KV verbatim. */
function makeMemberJson(opts: {
  bioguideId: string;
  sponsored?: unknown[];
  cosponsored?: unknown[];
}): string {
  return JSON.stringify({
    bioguideId: opts.bioguideId,
    first: 'Test',
    last: 'Rep',
    officialName: 'Test Rep',
    state: 'CA',
    district: 1,
    chamber: 'House',
    party: 'D',
    photoUrl: null,
    website: null,
    searchKey: 'test rep',
    sponsored: opts.sponsored ?? [],
    cosponsored: opts.cosponsored ?? [],
    generatedAt: '2026-05-01T00:00:00Z',
    schemaVersion: 1,
  });
}

/* -------------------------------------------------------------------------- */
/*                         Validation branch                                   */
/* -------------------------------------------------------------------------- */

describe('handleRepBundle — bioguideId validation (FR-42)', () => {
  it('returns 400 invalid_bioguide_id on a malformed id', async () => {
    const env = makeEnv(new FakeKv());
    const result = await handleRepBundle('not-an-id', makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(400);
    expect(result.shape).toBe('worker-emitted');
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe('invalid_bioguide_id');
  });

  it('returns 400 on an id that is too short', async () => {
    const env = makeEnv(new FakeKv());
    const result = await handleRepBundle('A123', makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(400);
  });

  it('accepts the canonical bioguide pattern (uppercase letter + 6 digits)', async () => {
    // Sanity check that the validation regex accepts the standard form.
    // (Note: although the route's own regex carries the `i` flag,
    // handleMemberProfile downstream uses a stricter case-sensitive
    // regex, so a lowercase id would fail to compose despite passing the
    // outer gate. We exercise the standard uppercase form here.)
    const kv = new FakeKv();
    await kv.put(KV_PREFIXES.member + 'A000010', makeMemberJson({ bioguideId: 'A000010' }));
    const env = makeEnv(kv);
    const result = await handleRepBundle('A000010', makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Cache HIT branch                                    */
/* -------------------------------------------------------------------------- */

describe('handleRepBundle — KV cache HIT', () => {
  it('returns the cached bundle verbatim with X-Bundle-Cache: hit', async () => {
    const kv = new FakeKv();
    const cached = JSON.stringify({ bioguideId: 'B000002', cached: true });
    await kv.put(KV_PREFIXES.repBundle + 'B000002', cached);
    const env = makeEnv(kv);
    const ctx = makeCtx();
    const result = await handleRepBundle('B000002', makeRequest(), env, ctx, ORIGIN);
    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('api-proxied');
    expect(result.response.headers.get('X-Bundle-Cache')).toBe('hit');
    expect(result.response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(result.response.headers.get('Cache-Control')).toMatch(/max-age=60/);
    expect(await result.response.text()).toBe(cached);
    // No background KV write on a cache hit.
    expect(ctx.promises).toHaveLength(0);
  });

  it('omits the body for HEAD on cache hit', async () => {
    const kv = new FakeKv();
    await kv.put(KV_PREFIXES.repBundle + 'C000003', '{"x":1}');
    const env = makeEnv(kv);
    const result = await handleRepBundle('C000003', makeRequest('HEAD'), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('X-Bundle-Cache')).toBe('hit');
    expect(await result.response.text()).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/*                       Cache MISS — happy paths                              */
/* -------------------------------------------------------------------------- */

describe('handleRepBundle — KV cache MISS / read-through compose', () => {
  it('composes a bundle with X-Bundle-Cache: miss and writes back to KV', async () => {
    const kv = new FakeKv();
    const id = 'D000004';
    // Member profile pre-seeded so handleMemberProfile cache-hits and never
    // calls upstream. Sponsored/cosponsored exercise all 3 ID forms.
    await kv.put(
      KV_PREFIXES.member + id,
      makeMemberJson({
        bioguideId: id,
        sponsored: [
          { billId: 'HR1' }, // canonical billId
          { bill_id: 'HR2' }, // legacy snake_case
          { type: 'HR', number: 3, congress: 118 }, // type+number form
          undefined, // hits the early-return guard in addBill()
        ],
        cosponsored: [
          { billId: 'S100' },
          { type: 'S', number: '200' }, // number as string still allowed
          {}, // no id, no type → skipped
        ],
      }),
    );
    // Bill records — only HR1 carries votes; HR2 has no votes; HR3 missing
    // entirely. This exercises:
    //   - happy bill JSON parse + roll-call enumeration
    //   - bill record present but no `votes` array
    //   - bill key absent → kv.get returns null → record stays null in map
    await kv.put(
      KV_PREFIXES.bill + 'HR1',
      JSON.stringify({
        billId: 'HR1',
        votes: [
          { chamber: 'House', congress: 118, session: 1, rollCall: 7 },
          { chamber: 'Senate', congress: 118, session: 1, rollCall: 12 },
        ],
      }),
    );
    await kv.put(KV_PREFIXES.bill + 'HR2', JSON.stringify({ billId: 'HR2' }));
    // Comments — only HR1 has them; absent for HR2/HR3 → skipped from map.
    await kv.put(
      KV_PREFIXES.comment + 'HR1',
      JSON.stringify({ billId: 'HR1', comments: [{ id: 'c1' }] }),
    );
    // Roll calls — both keys present.
    await kv.put(
      KV_PREFIXES.rollCall + 'house:118:1:7',
      JSON.stringify({ rollCallId: 'house:118:1:7' }),
    );
    await kv.put(
      KV_PREFIXES.rollCall + 'senate:118:1:12',
      JSON.stringify({ rollCallId: 'senate:118:1:12' }),
    );
    // Per-rep curated content.
    await kv.put(KV_PREFIXES.socialPost + id, JSON.stringify({ posts: [{ id: 'p1' }] }));
    await kv.put(KV_PREFIXES.quote + id, JSON.stringify({ quotes: [{ id: 'q1' }] }));

    const env = makeEnv(kv);
    const ctx = makeCtx();
    const result = await handleRepBundle(id, makeRequest(), env, ctx, ORIGIN);

    expect(result.response.status).toBe(200);
    expect(result.shape).toBe('api-proxied');
    expect(result.response.headers.get('X-Bundle-Cache')).toBe('miss');
    expect(result.response.headers.get('Cache-Control')).toMatch(/max-age=60/);

    const bundle = (await result.response.json()) as {
      bioguideId: string;
      member: { bioguideId: string };
      bills: Record<string, unknown>;
      rollCalls: Record<string, unknown>;
      comments: Record<string, unknown>;
      socialPosts: unknown;
      quotes: unknown;
      bundledAt: string;
    };

    expect(bundle.bioguideId).toBe(id);
    expect(bundle.member.bioguideId).toBe(id);
    // 4 distinct bill IDs enumerated: HR1, HR2, HR3, S100, S200
    expect(Object.keys(bundle.bills).sort()).toEqual(['HR1', 'HR2'].sort());
    expect(bundle.comments).toHaveProperty('HR1');
    expect(Object.keys(bundle.comments)).toHaveLength(1);
    expect(bundle.rollCalls).toHaveProperty('house:118:1:7');
    expect(bundle.rollCalls).toHaveProperty('senate:118:1:12');
    expect(bundle.socialPosts).toEqual({ posts: [{ id: 'p1' }] });
    expect(bundle.quotes).toEqual({ quotes: [{ id: 'q1' }] });
    expect(typeof bundle.bundledAt).toBe('string');

    // Background-write fires.
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);
    const backWrite = kv.putCalls.find((c) => c.key === KV_PREFIXES.repBundle + id);
    expect(backWrite).toBeTruthy();
    expect(backWrite!.opts?.expirationTtl).toBe(30 * 60);
    // The persisted body should round-trip identically.
    expect(JSON.parse(backWrite!.value)).toMatchObject({ bioguideId: id });
  });

it('handles a member with no sponsored/cosponsored arrays at all', async () => {
    // Hits the `?? []` fallbacks on both sponsored and cosponsored.
    const kv = new FakeKv();
    const id = 'F000006';
    await kv.put(
      KV_PREFIXES.member + id,
      JSON.stringify({
        bioguideId: id,
        first: 'X',
        last: 'Y',
        officialName: 'X Y',
        state: 'NY',
        district: null,
        chamber: 'Senate',
        party: 'R',
        photoUrl: null,
        website: null,
        searchKey: 'x y',
        // sponsored / cosponsored intentionally omitted
        generatedAt: '2026-05-01T00:00:00Z',
        schemaVersion: 1,
      }),
    );
    const env = makeEnv(kv);
    const ctx = makeCtx();
    const result = await handleRepBundle(id, makeRequest(), env, ctx, ORIGIN);
    expect(result.response.status).toBe(200);
    const bundle = (await result.response.json()) as {
      bills: Record<string, unknown>;
      rollCalls: Record<string, unknown>;
      comments: Record<string, unknown>;
      socialPosts: unknown;
      quotes: unknown;
    };
    expect(bundle.bills).toEqual({});
    expect(bundle.rollCalls).toEqual({});
    expect(bundle.comments).toEqual({});
    expect(bundle.socialPosts).toBeNull();
    expect(bundle.quotes).toBeNull();
  });

  it('safeParse returns null on malformed bill / social / quote JSON', async () => {
    // Exercises the catch-branch in safeParse for every consumer (bill,
    // comment, rollCall, socialPost, quote). Bills/comments that fail to
    // parse become null entries → filtered out of the maps, so we only
    // observe their absence. Social/quote parse failures land in the
    // bundle as `null`.
    const kv = new FakeKv();
    const id = 'G000007';
    await kv.put(
      KV_PREFIXES.member + id,
      makeMemberJson({
        bioguideId: id,
        sponsored: [{ billId: 'HRBAD' }],
      }),
    );
    await kv.put(KV_PREFIXES.bill + 'HRBAD', '{not-json'); // safeParse → null
    await kv.put(KV_PREFIXES.comment + 'HRBAD', 'also-not-json'); // safeParse → null
    await kv.put(KV_PREFIXES.socialPost + id, '{broken'); // → null
    await kv.put(KV_PREFIXES.quote + id, '}{'); // → null

    const env = makeEnv(kv);
    const result = await handleRepBundle(id, makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(200);
    const bundle = (await result.response.json()) as {
      bills: Record<string, unknown>;
      comments: Record<string, unknown>;
      socialPosts: unknown;
      quotes: unknown;
    };
    expect(bundle.bills).toEqual({});
    expect(bundle.comments).toEqual({});
    expect(bundle.socialPosts).toBeNull();
    expect(bundle.quotes).toBeNull();
  });

  it('handles a referenced roll-call key that is absent from KV', async () => {
    // Bill enumerates a roll-call coordinate, but no roll-call record exists
    // in KV → kv.get returns null → ternary at the roll-call read picks the
    // null branch → entry is filtered from the rollCalls map.
    const kv = new FakeKv();
    const id = 'J000010';
    await kv.put(
      KV_PREFIXES.member + id,
      makeMemberJson({ bioguideId: id, sponsored: [{ billId: 'HRX' }] }),
    );
    await kv.put(
      KV_PREFIXES.bill + 'HRX',
      JSON.stringify({
        billId: 'HRX',
        votes: [{ chamber: 'House', congress: 119, session: 1, rollCall: 1 }],
      }),
    );
    // Intentionally NO roll-call record.
    const env = makeEnv(kv);
    const result = await handleRepBundle(id, makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(200);
    const bundle = (await result.response.json()) as { rollCalls: Record<string, unknown> };
    expect(bundle.rollCalls).toEqual({});
  });

  it('also exercises malformed-JSON safeParse for a roll-call record', async () => {
    const kv = new FakeKv();
    const id = 'H000008';
    await kv.put(
      KV_PREFIXES.member + id,
      makeMemberJson({
        bioguideId: id,
        sponsored: [{ billId: 'HR9' }],
      }),
    );
    await kv.put(
      KV_PREFIXES.bill + 'HR9',
      JSON.stringify({
        billId: 'HR9',
        votes: [{ chamber: 'House', congress: 118, session: 2, rollCall: 99 }],
      }),
    );
    // Roll-call payload is not valid JSON — safeParse returns null and the
    // entry is filtered from the rollCalls map.
    await kv.put(KV_PREFIXES.rollCall + 'house:118:2:99', '{nope');

    const env = makeEnv(kv);
    const result = await handleRepBundle(id, makeRequest(), env, makeCtx(), ORIGIN);
    expect(result.response.status).toBe(200);
    const bundle = (await result.response.json()) as { rollCalls: Record<string, unknown> };
    expect(bundle.rollCalls).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/*                  Cache MISS — composeBundle error envelope                  */
/* -------------------------------------------------------------------------- */

describe('handleRepBundle — composeBundle propagates member non-200', () => {
  it('returns rep_bundle_unavailable with the upstream status when member missing', async () => {
    // No member KV record + no CONGRESS_API_KEY in env →
    // buildProfileFromUpstream returns null → handleMemberProfile returns
    // 404 member_not_found → composeBundle bubbles up as { bundle: null,
    // status: 404 } → handler returns the rep_bundle_unavailable envelope.
    const kv = new FakeKv();
    const env = makeEnv(kv);
    const id = 'I000009';
    const ctx = makeCtx();
    const result = await handleRepBundle(id, makeRequest(), env, ctx, ORIGIN);
    expect(result.response.status).toBe(404);
    expect(result.shape).toBe('worker-emitted');
    const body = (await result.response.json()) as { error: string; bioguideId: string };
    expect(body.error).toBe('rep_bundle_unavailable');
    expect(body.bioguideId).toBe(id);
    // No background-write on the failure path.
    expect(ctx.promises).toHaveLength(0);
    // No bundle written back to KV.
    expect(kv.putCalls.find((c) => c.key.startsWith(KV_PREFIXES.repBundle))).toBeUndefined();
  });
});
