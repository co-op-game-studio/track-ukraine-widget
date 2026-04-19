/**
 * Tests for proxy/cache/r2-tier.ts — R2Tier wraps R2_STATIC.
 *
 * Traces to FR-41 AC-41.1, AC-41.2, AC-41.3, AC-41.5, AC-41.6.
 */
import { describe, expect, it } from 'vitest';
import { R2Tier, r2PathForKey } from '../../../proxy/cache/r2-tier';
import type { CacheKey } from '../../../proxy/cache/key';
import type { CacheEntry } from '../../../proxy/cache/tier';
import type { WritePolicy } from '../../../proxy/cache/policy';

class FakeR2 {
  readonly store = new Map<
    string,
    { body: string; httpMetadata: { contentType?: string }; customMetadata?: Record<string, string> }
  >();
  async get(key: string): Promise<{
    body: ReadableStream | null;
    text: () => Promise<string>;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  } | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    const text = hit.body;
    return {
      body: null,
      text: async () => text,
      httpMetadata: hit.httpMetadata,
      customMetadata: hit.customMetadata,
    };
  }
  async put(
    key: string,
    body: string,
    opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<void> {
    this.store.set(key, {
      body,
      httpMetadata: opts?.httpMetadata ?? {},
      customMetadata: opts?.customMetadata,
    });
  }
}

const SENATE_KEY: CacheKey = {
  kind: 'senate-xml',
  params: { congress: 117, session: 2, rollCall: 78 },
};
const HOUSE_ROSTER_KEY: CacheKey = {
  kind: 'house-roster',
  params: { congress: 118, session: 1, rollCall: 5 },
};
const BILL_ACTIONS_KEY: CacheKey = {
  kind: 'bill-actions',
  params: { congress: 118, type: 'hr', number: 1234 },
};
const FROZEN_XML_ENTRY: CacheEntry<string> = {
  value: '<?xml version="1.0"?><root />',
  contentType: 'application/xml',
  fetchedAt: 1_000,
  sourceUpstream: 'senate',
  sessionStatus: 'frozen',
};
const IMMUTABLE_POLICY: WritePolicy = {
  maxAge: 31_536_000,
  immutable: true,
  eligibleTiers: ['edge', 'kv', 'r2'],
};
const NON_IMMUTABLE_POLICY: WritePolicy = {
  maxAge: 3600,
  immutable: false,
  eligibleTiers: ['edge', 'kv', 'r2'],
};

describe('r2PathForKey — AC-41.2 path schema', () => {
  it('senate-xml → archive/senate/xml/vote_{c}_{s}_{rc}.xml (zero-padded)', () => {
    expect(r2PathForKey(SENATE_KEY)).toBe('archive/senate/xml/vote_117_2_00078.xml');
  });

  it('house-roster → archive/congress/house-vote/{c}/{s}/{rc}/members.json', () => {
    expect(r2PathForKey(HOUSE_ROSTER_KEY)).toBe(
      'archive/congress/house-vote/118/1/5/members.json',
    );
  });

  it('house-vote-detail → archive/congress/house-vote/{c}/{s}/{rc}.json', () => {
    const k: CacheKey = { kind: 'house-vote-detail', params: { congress: 118, session: 2, rollCall: 42 } };
    expect(r2PathForKey(k)).toBe('archive/congress/house-vote/118/2/42.json');
  });

  it('bill-actions → archive/congress/bill/{c}/{type}/{num}/actions.json', () => {
    expect(r2PathForKey(BILL_ACTIONS_KEY)).toBe('archive/congress/bill/118/hr/1234/actions.json');
  });

  it('bill-summaries → archive/congress/bill/{c}/{type}/{num}/summaries.json', () => {
    const k: CacheKey = { kind: 'bill-summaries', params: { congress: 118, type: 's', number: 17 } };
    expect(r2PathForKey(k)).toBe('archive/congress/bill/118/s/17/summaries.json');
  });

  it('throws on unsupported kinds (fail-loud)', () => {
    const k: CacheKey = { kind: 'member-detail', params: { bioguideId: 'D000563' } };
    expect(() => r2PathForKey(k)).toThrow(/unsupported|member-detail/i);
  });

  it('throws on census-geocoder key (fail-loud)', () => {
    const k: CacheKey = { kind: 'census-geocoder', params: { q: 'x' } };
    expect(() => r2PathForKey(k)).toThrow();
  });
});

describe('R2Tier.put — AC-41.3 gating', () => {
  it('writes when policy.immutable=true AND sessionStatus=frozen', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, FROZEN_XML_ENTRY, IMMUTABLE_POLICY);
    expect(r2.store.size).toBe(1);
  });

  it('silently skips when policy.immutable=false (even if frozen)', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, FROZEN_XML_ENTRY, NON_IMMUTABLE_POLICY);
    expect(r2.store.size).toBe(0);
  });

  it('silently skips when sessionStatus=live (even if immutable)', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, { ...FROZEN_XML_ENTRY, sessionStatus: 'live' }, IMMUTABLE_POLICY);
    expect(r2.store.size).toBe(0);
  });

  it('silently skips when sessionStatus is undefined', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    const entryNoStatus: CacheEntry<string> = {
      value: 'x',
      contentType: 'text/plain',
      fetchedAt: 1,
      sourceUpstream: 'synthetic',
    };
    await tier.put(SENATE_KEY, entryNoStatus, IMMUTABLE_POLICY);
    expect(r2.store.size).toBe(0);
  });
});

describe('R2Tier.put — AC-41.5 metadata persistence', () => {
  it('stores custom metadata with fetchedAt + sourceUpstream + sessionStatus', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, FROZEN_XML_ENTRY, IMMUTABLE_POLICY);
    const stored = r2.store.get(r2PathForKey(SENATE_KEY))!;
    expect(stored.customMetadata).toBeDefined();
    expect(stored.customMetadata?.fetchedAt).toBe('1000');
    expect(stored.customMetadata?.sourceUpstream).toBe('senate');
    expect(stored.customMetadata?.sessionStatus).toBe('frozen');
  });

  it('stores httpMetadata contentType for byte-verbatim serving', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, FROZEN_XML_ENTRY, IMMUTABLE_POLICY);
    const stored = r2.store.get(r2PathForKey(SENATE_KEY))!;
    expect(stored.httpMetadata.contentType).toBe('application/xml');
  });
});

describe('R2Tier.get — AC-41.6 byte-verbatim', () => {
  it('roundtrips body + contentType + session status', async () => {
    const r2 = new FakeR2();
    const tier = new R2Tier<string>(r2);
    await tier.put(SENATE_KEY, FROZEN_XML_ENTRY, IMMUTABLE_POLICY);
    const hit = await tier.get(SENATE_KEY);
    expect(hit?.value).toBe(FROZEN_XML_ENTRY.value);
    expect(hit?.contentType).toBe('application/xml');
    expect(hit?.sessionStatus).toBe('frozen');
    expect(hit?.fetchedAt).toBe(1000);
    expect(hit?.sourceUpstream).toBe('senate');
  });

  it('returns null on miss', async () => {
    const tier = new R2Tier<string>(new FakeR2());
    expect(await tier.get(SENATE_KEY)).toBeNull();
  });

  it('returns null on unsupported kinds (graceful, no throw from get)', async () => {
    const tier = new R2Tier<string>(new FakeR2());
    const unsupported: CacheKey = { kind: 'member-detail', params: { bioguideId: 'D000563' } };
    expect(await tier.get(unsupported)).toBeNull();
  });
});

describe('R2Tier identity', () => {
  it('has name="r2" and canWrite=true', () => {
    const tier = new R2Tier<string>(new FakeR2());
    expect(tier.name).toBe('r2');
    expect(tier.canWrite).toBe(true);
  });

  it('returns null on get when binding is absent (defensive)', async () => {
    const tier = new R2Tier<string>(undefined);
    expect(await tier.get(SENATE_KEY)).toBeNull();
  });

  it('silently skips put when binding is absent', async () => {
    const tier = new R2Tier<string>(undefined);
    await expect(tier.put(SENATE_KEY, FROZEN_XML_ENTRY, IMMUTABLE_POLICY)).resolves.toBeUndefined();
  });
});
