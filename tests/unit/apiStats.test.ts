/**
 * Tests for /api/stats/v1/summary (FR-56).
 * Traces to FR-56 AC-56.1..AC-56.4.
 */
import { describe, it, expect } from 'vitest';
import { handleStatsSummary } from '../../proxy/routes/api-stats';
import type { ProxyEnv, KVLike } from '../../proxy/env';

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
    return {
      keys: [...this.store.keys()]
        .filter((k) => k.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function makeEnv(kv: FakeKv): ProxyEnv {
  return { KV_VOTER_INFO: kv } as unknown as ProxyEnv;
}

const ORIGIN = 'https://embed.example';

describe('handleStatsSummary (FR-56 AC-56.1..56.4)', () => {
  it('AC-56.1 / AC-56.3: returns the cached stats record verbatim', async () => {
    const kv = new FakeKv();
    const record = {
      generatedAt: '2026-05-02T19:00:00Z',
      schemaVersion: 1,
      perBill: [
        {
          billId: '117-HR-2471',
          voteCount: 5,
          weightTotal: 2.8,
          directionPro: 5,
          directionAnti: 0,
        },
      ],
      commentsTimeseries: [{ date: '2026-04-25', count: 3 }],
    };
    await kv.put('stats:v1:summary', JSON.stringify(record));
    const result = await handleStatsSummary(
      new Request('https://worker.example/api/stats/v1/summary'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(await result.response.json()).toEqual(record);
  });

  it('AC-56.3: emits public cache-control with s-maxage=900', async () => {
    const kv = new FakeKv();
    await kv.put('stats:v1:summary', JSON.stringify({ schemaVersion: 1 }));
    const result = await handleStatsSummary(
      new Request('https://worker.example/api/stats/v1/summary'),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.headers.get('Cache-Control')).toMatch(/s-maxage=900/);
    expect(result.response.headers.get('Cache-Control')).toMatch(/public/);
  });

  it('AC-56.4: returns 503 + Retry-After when the record has not been published yet', async () => {
    const result = await handleStatsSummary(
      new Request('https://worker.example/api/stats/v1/summary'),
      makeEnv(new FakeKv()),
      ORIGIN,
    );
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get('Retry-After')).toBe('60');
    const body = (await result.response.json()) as {
      error: string;
      retryAfterSeconds: number;
    };
    expect(body.error).toBe('stats_not_ready');
    expect(body.retryAfterSeconds).toBe(60);
  });

  it('HEAD request returns headers without body', async () => {
    const kv = new FakeKv();
    await kv.put('stats:v1:summary', JSON.stringify({ ok: true }));
    const result = await handleStatsSummary(
      new Request('https://worker.example/api/stats/v1/summary', { method: 'HEAD' }),
      makeEnv(kv),
      ORIGIN,
    );
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe('');
  });
});
