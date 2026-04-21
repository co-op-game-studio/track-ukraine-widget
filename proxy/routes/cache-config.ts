/**
 * Per-route cache-config map — AC-40.8.
 *
 * Single source of truth for: which /api/* path maps to which CacheKind,
 * which WritePolicy applies, and how to extract a CacheKey from the Request.
 *
 * This module is DATA. No upstream fetcher instances live here — route
 * handlers pick the right fetcher at wire time by calling `fetcher.canHandle(key)`.
 *
 * Data-type eligibility matrix (FR-41): senate-xml, house-roster,
 * house-vote-detail, bill-actions, bill-summaries are R2-eligible;
 * member-detail + census-geocoder are edge+kv only.
 *
 * KV-backed domain routes (/api/members/*, /api/name-search, /api/bills/*,
 * /api/roll-calls/*, /api/roll-call-rosters/*, /api/state-members/*) are
 * NOT in this table — they read from their own KV prefixes (member:v1:*,
 * name-index:v1:*, etc.), not from the tiered response cache. Those
 * handlers stay in their existing code path.
 *
 * Traces: FR-40 AC-40.8, FR-41 data-type matrix.
 */

import type { CacheKey, CacheKind } from '../cache/key';
import type { WritePolicy } from '../cache/policy';
import {
  IMMUTABLE_ARCHIVE_POLICY,
  ROTATING_POLICY,
} from '../cache/policy';

export interface RouteMatch {
  readonly cacheKind: CacheKind;
  readonly key: CacheKey;
  readonly policy: WritePolicy;
}

/**
 * AC-27.20 — per-upstream query-param allowlist. Unknown params are dropped
 * before the key is built so cache entries aren't fragmented by attacker-
 * supplied junk query strings.
 */
const CENSUS_ALLOWED_QS: readonly string[] = [
  'address', 'street', 'city', 'state', 'zip',
  'benchmark', 'vintage', 'layers', 'format',
];

/** Canonical filtered query string, keys sorted for stability. */
function canonicalQs(url: URL, allowed: readonly string[]): string {
  const entries: Array<[string, string]> = [];
  for (const key of allowed) {
    const values = url.searchParams.getAll(key);
    for (const v of values) entries.push([key, v]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const out = new URLSearchParams();
  for (const [k, v] of entries) out.append(k, v);
  return out.toString();
}

/** Regex patterns, checked in order. First match wins. */
const PATTERNS: ReadonlyArray<
  (u: URL) => RouteMatch | null
> = [
  // Senate XML — /api/senate/legislative/LIS/roll_call_votes/voteCCS/vote_C_S_RRRRR.xml
  (u) => {
    const m = u.pathname.match(
      /^\/api\/senate\/legislative\/LIS\/roll_call_votes\/vote\d+\/vote_(\d+)_(\d+)_(\d{5})\.xml$/,
    );
    if (!m) return null;
    return {
      cacheKind: 'senate-xml',
      key: {
        kind: 'senate-xml',
        params: { congress: Number(m[1]), session: Number(m[2]), rollCall: Number(m[3]) },
      },
      policy: IMMUTABLE_ARCHIVE_POLICY,
    };
  },

  // House roster — /api/congress/v3/house-vote/{c}/{s}/{rc}/members
  (u) => {
    const m = u.pathname.match(/^\/api\/congress\/v3\/house-vote\/(\d+)\/(\d+)\/(\d+)\/members$/);
    if (!m) return null;
    return {
      cacheKind: 'house-roster',
      key: {
        kind: 'house-roster',
        params: { congress: Number(m[1]), session: Number(m[2]), rollCall: Number(m[3]) },
      },
      policy: IMMUTABLE_ARCHIVE_POLICY,
    };
  },

  // House vote detail — /api/congress/v3/house-vote/{c}/{s}/{rc}
  (u) => {
    const m = u.pathname.match(/^\/api\/congress\/v3\/house-vote\/(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return {
      cacheKind: 'house-vote-detail',
      key: {
        kind: 'house-vote-detail',
        params: { congress: Number(m[1]), session: Number(m[2]), rollCall: Number(m[3]) },
      },
      policy: IMMUTABLE_ARCHIVE_POLICY,
    };
  },

  // Bill actions — /api/congress/v3/bill/{c}/{type}/{num}/actions
  (u) => {
    const m = u.pathname.match(/^\/api\/congress\/v3\/bill\/(\d+)\/([a-z]+)\/(\d+)\/actions$/);
    if (!m) return null;
    return {
      cacheKind: 'bill-actions',
      key: {
        kind: 'bill-actions',
        params: { congress: Number(m[1]), type: m[2]!, number: Number(m[3]) },
      },
      policy: IMMUTABLE_ARCHIVE_POLICY,
    };
  },

  // Bill summaries — /api/congress/v3/bill/{c}/{type}/{num}/summaries
  (u) => {
    const m = u.pathname.match(/^\/api\/congress\/v3\/bill\/(\d+)\/([a-z]+)\/(\d+)\/summaries$/);
    if (!m) return null;
    return {
      cacheKind: 'bill-summaries',
      key: {
        kind: 'bill-summaries',
        params: { congress: Number(m[1]), type: m[2]!, number: Number(m[3]) },
      },
      policy: IMMUTABLE_ARCHIVE_POLICY,
    };
  },

  // Member detail — /api/congress/v3/member/{bioguideId}
  (u) => {
    const m = u.pathname.match(/^\/api\/congress\/v3\/member\/([A-Za-z]\d{6})$/);
    if (!m) return null;
    return {
      cacheKind: 'member-detail',
      key: { kind: 'member-detail', params: { bioguideId: m[1]! } },
      policy: ROTATING_POLICY,
    };
  },

  // Census geocoder — /api/census/*
  (u) => {
    const m = u.pathname.match(/^\/api\/census\/(.+)$/);
    if (!m) return null;
    return {
      cacheKind: 'census-geocoder',
      key: {
        kind: 'census-geocoder',
        params: {
          path: m[1]!,
          qs: canonicalQs(u, CENSUS_ALLOWED_QS),
        },
      },
      policy: ROTATING_POLICY,
    };
  },
];

/**
 * Match an inbound Request against the route patterns. Returns null on
 * non-match; callers that see null fall through to their existing route
 * path (KV-backed routes, preview HTML, 404, etc.).
 */
export function matchRoute(request: Request): RouteMatch | null {
  const url = new URL(request.url);
  for (const matcher of PATTERNS) {
    const m = matcher(url);
    if (m) return m;
  }
  return null;
}
