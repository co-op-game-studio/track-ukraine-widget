import { throwFromResponse } from './errorEnvelope';

/**
 * Shared rep-bundle fetcher with in-flight deduplication.
 *
 * The Worker exposes `/api/rep-bundle/{bioguideId}` which returns
 * everything the embed needs to render one rep:
 *   { member, bills, rollCalls, comments, socialPosts, quotes }
 *
 * Multiple hooks (useSponsoredBills, useRepStatements, useRepQuotes,
 * useRepComments, useVotingRecord) need slices of this. Without
 * coordination they'd each fire their own fetch — defeating the whole
 * point of bundling.
 *
 * This module deduplicates: the first hook to request a rep triggers ONE
 * fetch; subsequent requests for the same rep within the lifetime of the
 * inflight promise (or a short result cache) await the same response.
 *
 * Cache TTL: 5 min in the SPA (matches the Worker's edge cache).
 * Hard reset on apiBase change.
 */
export interface RepBundle {
  bioguideId: string;
  member: Record<string, unknown>;
  bills: Record<string, unknown>;
  rollCalls: Record<string, unknown>;
  comments: Record<string, unknown>;
  socialPosts: { posts?: unknown[] } | null;
  quotes: { quotes?: unknown[] } | null;
  bundledAt: string;
}

interface CacheEntry {
  fetchedAt: number;
  bundle: RepBundle | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RepBundle | null>>();

function cacheKey(apiBase: string, bioguideId: string): string {
  return `${apiBase}|${bioguideId}`;
}

export function fetchRepBundle(apiBase: string, bioguideId: string): Promise<RepBundle | null> {
  const key = cacheKey(apiBase, bioguideId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(hit.bundle);
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const base = apiBase.replace(/\/+$/, '');
  const p = (async (): Promise<RepBundle | null> => {
    const res = await fetch(`${base}/api/rep-bundle/${encodeURIComponent(bioguideId)}`);
    if (!res.ok) {
      // Throw EnvelopedError so downstream useSponsoredBills + ErrorBanner
      // surface the same FR-37 envelope they did when calling /api/members
      // directly. throwFromResponse handles non-JSON bodies and missing
      // envelope fields with sensible fallbacks.
      await throwFromResponse(res, `rep bundle ${bioguideId}`);
    }
    return (await res.json()) as RepBundle;
  })()
    .then((bundle) => {
      cache.set(key, { fetchedAt: Date.now(), bundle });
      inflight.delete(key);
      return bundle;
    })
    .catch((err) => {
      inflight.delete(key);
      // Don't cache errors — let the next call retry.
      throw err;
    });
  inflight.set(key, p);
  return p;
}

/** Test/storybook hook to clear all caches. */
export function _resetRepBundleCache(): void {
  cache.clear();
  inflight.clear();
}
