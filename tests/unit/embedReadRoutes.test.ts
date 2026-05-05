/**
 * Tests for the V4 embed-facing read routes:
 *   - GET /api/comments/{billId}
 *   - GET /api/social-posts/{bioguideId}
 *   - GET /api/quotes/{bioguideId}
 *   - GET /api/audit/public
 *
 * Each route is a KV passthrough — reads `comment:v1:*` / `social-post:v1:*` /
 * `quote:v1:*` / `audit-feed:v1:public` and returns the value verbatim with
 * appropriate Cache-Control headers, or a 400 / 404 envelope.
 *
 * Traces to FR-51 AC-51.4 / AC-51.5 / AC-51.6, FR-53 AC-53.5, FR-58 AC-58.2 /
 * AC-58.4.
 */
import { describe, it, expect } from 'vitest';
import { handleComments } from '../../proxy/routes/api-comments';
import { handleSocialPosts } from '../../proxy/routes/api-social-posts';
import { handleQuotes } from '../../proxy/routes/api-quotes';
import { handleAuditPublic } from '../../proxy/routes/api-audit-public';
import type { ProxyEnv, KVLike } from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                                Fake KV                                     */
/* -------------------------------------------------------------------------- */

class FakeKv implements KVLike {
  store = new Map<string, string>();
  async get(key: string, type?: 'text' | 'json') {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') return JSON.parse(v);
    return v;
  }
  async put(key: string, value: string) {
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
  return { KV_VOTER_INFO: kv } as unknown as ProxyEnv;
}

function makeRequest(method = 'GET'): Request {
  return new Request('https://worker.example/api/test', { method });
}

const ORIGIN = 'https://embed.example';

/* -------------------------------------------------------------------------- */
/*                              comments                                      */
/* -------------------------------------------------------------------------- */

describe('handleComments (FR-51 AC-51.4, FR-53 AC-53.5)', () => {
  it('returns the canonical record verbatim with the right cache-control', async () => {
    const kv = new FakeKv();
    const record = {
      billId: '117-HR-2471',
      comments: [
        {
          id: 'c1',
          bodyMarkdown: 'Floor speech ignored the procedural maneuver.',
          weight: 0.25,
          direction: -1,
          attachedToRollCallId: 'house:117:2:65',
          authorEmail: 'alice@example.com',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      ],
      generatedAt: '2026-05-02T00:00:00Z',
      schemaVersion: 1,
    };
    await kv.put('comment:v1:117-HR-2471', JSON.stringify(record));
    const result = await handleComments('117-HR-2471', makeRequest(), makeEnv(kv), ORIGIN);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toMatch(/max-age=60/);
    expect(result.response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(await result.response.json()).toEqual(record);
  });

  it('returns 404 with FR-37 envelope when no record', async () => {
    const result = await handleComments(
      '999-X-1',
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(404);
    const body = (await result.response.json()) as { error: string; billId: string };
    expect(body.error).toBe('comments_not_found');
    expect(body.billId).toBe('999-X-1');
  });

  it('rejects bill IDs with disallowed chars (400 invalid_bill_id)', async () => {
    const result = await handleComments(
      'bad/id with spaces',
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe('invalid_bill_id');
  });

  it('HEAD request returns headers without body (passthrough convention)', async () => {
    const kv = new FakeKv();
    await kv.put('comment:v1:117-HR-2471', JSON.stringify({ comments: [] }));
    const result = await handleComments(
      '117-HR-2471',
      makeRequest('HEAD'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/*                              social posts                                  */
/* -------------------------------------------------------------------------- */

describe('handleSocialPosts (FR-51 AC-51.5, FR-53 AC-53.5)', () => {
  it('returns the canonical record verbatim', async () => {
    const kv = new FakeKv();
    const record = {
      bioguideId: 'D000563',
      posts: [
        {
          id: 'p1',
          platform: 'x',
          url: 'https://x.com/SenatorDurbin/status/123',
          postedAt: '2026-04-28T12:00:00Z',
          bodyText: 'Stand with Ukraine.',
          weight: 0.1,
          direction: 1,
          comment: null,
          authorEmail: 'alice@example.com',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
      generatedAt: '2026-05-02T00:00:00Z',
      schemaVersion: 1,
    };
    await kv.put('social-post:v1:D000563', JSON.stringify(record));
    const result = await handleSocialPosts(
      'D000563',
      makeRequest(),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual(record);
  });

  it('returns 404 for an unknown bioguide id', async () => {
    const result = await handleSocialPosts(
      'X999999',
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(404);
    const body = (await result.response.json()) as { error: string; bioguideId: string };
    expect(body.error).toBe('social_posts_not_found');
    expect(body.bioguideId).toBe('X999999');
  });

  it('rejects malformed bioguide ids (400 invalid_bioguide_id)', async () => {
    const result = await handleSocialPosts(
      'not-a-bioguide',
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe('invalid_bioguide_id');
  });
});

/* -------------------------------------------------------------------------- */
/*                              quotes                                        */
/* -------------------------------------------------------------------------- */

describe('handleQuotes (FR-51 AC-51.6, FR-53 AC-53.5)', () => {
  it('returns the canonical record verbatim', async () => {
    const kv = new FakeKv();
    const record = {
      bioguideId: 'D000563',
      quotes: [
        {
          id: 'q1',
          mediaKind: 'video',
          sourceUrl: 'https://www.c-span.org/video/?123',
          sourceLabel: 'C-SPAN floor speech',
          quotedAt: '2024-02-13',
          bodyText: 'I support Ukraine.',
          weight: 0.25,
          direction: 1,
          comment: null,
          authorEmail: 'alice@example.com',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
      generatedAt: '2026-05-02T00:00:00Z',
      schemaVersion: 1,
    };
    await kv.put('quote:v1:D000563', JSON.stringify(record));
    const result = await handleQuotes('D000563', makeRequest(), makeEnv(kv), ORIGIN);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual(record);
  });

  it('returns 404 envelope for missing record', async () => {
    const result = await handleQuotes(
      'X000000',
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(404);
    expect(((await result.response.json()) as { error: string }).error).toBe(
      'quotes_not_found',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                              audit public                                  */
/* -------------------------------------------------------------------------- */

describe('handleAuditPublic (FR-58 AC-58.2 / AC-58.4)', () => {
  it('returns the redacted record verbatim with public cache headers', async () => {
    const kv = new FakeKv();
    const record = {
      generatedAt: '2026-05-02T00:00:00Z',
      schemaVersion: 1,
      items: [
        {
          id: 'a1',
          actorLocalPart: 'alice', // NOTE: domain stripped by publish pipeline
          action: 'update',
          table: 'votes',
          rowTitle: '117-HR-2471 / House roll 65',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
    };
    await kv.put('audit-feed:v1:public', JSON.stringify(record));
    const result = await handleAuditPublic(makeRequest(), makeEnv(kv), ORIGIN);
    expect(result.response.status).toBe(200);
    // Public-feed cache: short max-age, slightly longer s-maxage.
    expect(result.response.headers.get('Cache-Control')).toMatch(/max-age=60/);
    const body = await result.response.json();
    expect(body).toEqual(record);
    // No before/after/reason/traceId/email fields leak through.
    const item = (body as typeof record).items[0]!;
    expect(item).not.toHaveProperty('before');
    expect(item).not.toHaveProperty('after');
    expect(item).not.toHaveProperty('reason');
    expect(item).not.toHaveProperty('traceId');
    expect(item).not.toHaveProperty('actor_email');
  });

  it('returns 404 envelope when the feed has not been published yet', async () => {
    const result = await handleAuditPublic(
      makeRequest(),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(404);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe('audit_feed_not_found');
  });
});
