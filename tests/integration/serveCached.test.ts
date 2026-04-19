/** Traces: FR-44 AC-44.1, AC-40.6, AC-41.3. */
/**
 * Integration test: composes real TieredCache + EdgeTier + KvTier + R2Tier
 * + createUpstreamRegistry + serveCached. The ONLY fakes are the bindings
 * (EdgeCacheLike, KvLike, R2BucketLike) and a stubbed fetch (see
 * fixtures/fake-bindings.ts).
 */
import { describe, expect, it } from 'vitest';
import { serveCached } from '../../proxy/cache/pipeline';
import { IMMUTABLE_ARCHIVE_POLICY, ROTATING_POLICY } from '../../proxy/cache/policy';
import { KV_CACHE_PREFIX } from '../../proxy/cache/kv-tier';
import { r2PathForKey } from '../../proxy/cache/r2-tier';
import type { CacheKey } from '../../proxy/cache/key';
import type { CacheEntry } from '../../proxy/cache/tier';
import { harness, makeCtx, seedEdge, seedKv, seedR2 } from './fixtures/fake-bindings';

const SENATE_KEY: CacheKey = { kind: 'senate-xml', params: { congress: 117, session: 2, rollCall: 78 } };
const MEMBER_KEY: CacheKey = { kind: 'member-detail', params: { bioguideId: 'D000563' } };
const TRACE = 'tr_0123456789abcdef';
const XML_BODY = '<?xml version="1.0"?><roll_call_vote><congress>117</congress></roll_call_vote>';
const JSON_BODY = '{"member":{"bioguideId":"D000563"}}';

function xmlResponse(status = 200, body = XML_BODY): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}
function jsonResponse(status = 200, body = JSON_BODY): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function frozenXmlEntry(overrides: Partial<CacheEntry<string>> = {}): CacheEntry<string> {
  return {
    value: XML_BODY,
    contentType: 'application/xml',
    fetchedAt: 1_000,
    sourceUpstream: 'senate',
    sessionStatus: 'frozen',
    ...overrides,
  };
}

describe('serveCached integration', () => {
  describe('cold miss → upstream → write-through', () => {
    it('writes to all three tiers for R2-eligible senate-xml', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(xmlResponse());
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);

      expect(resp.status).toBe(200);
      expect(resp.headers.get('X-Cache')).toBe('MISS');
      expect(resp.headers.get('X-Cache-Tier')).toBe('upstream');
      expect(resp.headers.get('X-Trace-Id')).toBe(TRACE);
      expect(h.edge.store.size).toBe(1);
      expect(h.kv.store.size).toBe(1);
      expect(h.r2.store.size).toBe(1);
      expect(h.r2.store.has(r2PathForKey(SENATE_KEY))).toBe(true);
    });
  });

  describe('cache hits', () => {
    it('HIT:edge — no other tier consulted, no fetch', async () => {
      const h = harness();
      await seedEdge(h, SENATE_KEY, frozenXmlEntry());
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      expect(resp.headers.get('X-Cache')).toBe('HIT');
      expect(resp.headers.get('X-Cache-Tier')).toBe('edge');
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.kv.getCalls).toHaveLength(0);
      expect(h.r2.getCalls).toHaveLength(0);
    });

    it('HIT:kv — promotes to edge, no fetch', async () => {
      const h = harness();
      await seedKv(h, SENATE_KEY, frozenXmlEntry());
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);
      expect(resp.headers.get('X-Cache-Tier')).toBe('kv');
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.edge.store.size).toBe(1);
    });

    it('HIT:r2 — promotes to edge + kv, no fetch', async () => {
      const h = harness();
      await seedR2(h, SENATE_KEY, frozenXmlEntry());
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);
      expect(resp.headers.get('X-Cache-Tier')).toBe('r2');
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.edge.store.size).toBe(1);
      expect(h.kv.store.size).toBe(1);
    });
  });

  describe('R2 write gate', () => {
    it('R2-ineligible route (member-detail, rotating) never writes to R2', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(jsonResponse());
      await serveCached({
        key: MEMBER_KEY, cache: h.cache, fetcher: h.fetcherFor(MEMBER_KEY),
        policy: ROTATING_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);
      expect(h.edge.store.size).toBe(1);
      expect(h.kv.store.size).toBe(1);
      expect(h.r2.store.size).toBe(0);
    });

    it('session-status live on senate-xml does NOT write to R2', async () => {
      // Future (congress, session) relative to `now` → SenateXmlFetcher stamps 'live'.
      const liveKey: CacheKey = { kind: 'senate-xml', params: { congress: 120, session: 1, rollCall: 1 } };
      const h = harness(new Date('2027-06-01T12:00:00Z'));
      h.fetch.mockResolvedValueOnce(xmlResponse());
      await serveCached({
        key: liveKey, cache: h.cache, fetcher: h.fetcherFor(liveKey),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);
      expect(h.edge.store.size).toBe(1);
      expect(h.kv.store.size).toBe(1);
      expect(h.r2.store.size).toBe(0);
    });
  });

  describe('FR-37 error envelope', () => {
    async function expectRetryableEnvelope(status: number): Promise<void> {
      const h = harness();
      h.fetch.mockResolvedValueOnce(new Response('oops', { status }));
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
        upstreamAttribution: 'senate',
      });
      expect(resp.headers.get('X-Trace-Id')).toBe(TRACE);
      const body = (await resp.json()) as { error: { code: string; retryable: boolean; traceId: string; upstream: string | null; message: string; userMessage: string } };
      expect(body.error.code).toBe('upstream_5xx');
      expect(body.error.retryable).toBe(true);
      expect(body.error.traceId).toBe(TRACE);
      expect(body.error.upstream).toBe('senate');
      expect(body.error.userMessage).toBeTruthy();
    }
    it('upstream 429 → upstream_5xx retryable envelope', async () => { await expectRetryableEnvelope(429); });
    it('upstream 503 → upstream_5xx retryable envelope', async () => { await expectRetryableEnvelope(503); });
  });

  describe('content-type roundtrip', () => {
    it('XML content-type survives fresh miss → later hit via tiers', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(xmlResponse());
      const miss = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      expect(miss.headers.get('Content-Type')).toBe('application/xml');
      await Promise.all(h.ctx.awaited);

      const hit = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: makeCtx(), traceId: TRACE,
      });
      expect(hit.headers.get('X-Cache')).toBe('HIT');
      expect(hit.headers.get('X-Cache-Tier')).toBe('edge');
      expect(hit.headers.get('Content-Type')).toBe('application/xml');
    });

    it('R2 hit preserves original XML content-type (not synthesized)', async () => {
      const h = harness();
      await seedR2(h, SENATE_KEY, frozenXmlEntry({ contentType: 'application/xml' }));
      const resp = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      expect(resp.headers.get('X-Cache-Tier')).toBe('r2');
      expect(resp.headers.get('Content-Type')).toBe('application/xml');
    });
  });

  describe('trace id propagation', () => {
    it('echoes X-Trace-Id on both MISS and HIT paths', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(xmlResponse());
      const miss = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: 'tr_deadbeefcafebabe',
      });
      expect(miss.headers.get('X-Trace-Id')).toBe('tr_deadbeefcafebabe');
      await Promise.all(h.ctx.awaited);

      const hit = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: makeCtx(), traceId: 'tr_feedfacef00dbaad',
      });
      expect(hit.headers.get('X-Cache')).toBe('HIT');
      expect(hit.headers.get('X-Trace-Id')).toBe('tr_feedfacef00dbaad');
    });
  });

  describe('promote-on-hit sequence', () => {
    it('first request is MISS, second is HIT:edge (promote-on-hit works)', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(xmlResponse());
      const r1 = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      expect(r1.headers.get('X-Cache')).toBe('MISS');
      await Promise.all(h.ctx.awaited);

      const r2 = await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: makeCtx(), traceId: TRACE,
      });
      expect(r2.headers.get('X-Cache')).toBe('HIT');
      expect(r2.headers.get('X-Cache-Tier')).toBe('edge');
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('KV namespacing', () => {
    it('stores miss under cache:v1: prefix', async () => {
      const h = harness();
      h.fetch.mockResolvedValueOnce(xmlResponse());
      await serveCached({
        key: SENATE_KEY, cache: h.cache, fetcher: h.fetcherFor(SENATE_KEY),
        policy: IMMUTABLE_ARCHIVE_POLICY, ctx: h.ctx, traceId: TRACE,
      });
      await Promise.all(h.ctx.awaited);
      const keys = [...h.kv.store.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]!.startsWith(KV_CACHE_PREFIX)).toBe(true);
    });
  });
});
