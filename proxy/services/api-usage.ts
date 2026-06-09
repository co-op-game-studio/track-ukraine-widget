/**
 * Upstream API quota estimation (FR-62).
 *
 * The Worker does NOT keep a precise per-call quota counter. This module
 * produces an HONEST *estimate* of 24h usage from data we already persist
 * (`mocs_social_handles.last_poll_attempted_at`, `audit_log` import_bill rows)
 * plus the published daily limits, so operators can see headroom at a glance
 * without us pretending to a precision we don't have. Every estimate carries
 * `estimate: true` and the SPA labels it "est." (AC-62.1..62.7).
 *
 * Pure-ish: takes the D1 binding + a `nowMs` clock so it's deterministic in
 * tests (no inline Date.now in the query math).
 */

/** Minimal D1 surface this module needs. */
export interface D1UsageLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

export type UpstreamName = 'youtube' | 'congress';

export interface UpstreamUsage {
  upstream: UpstreamName;
  configured: boolean;
  /** Published daily limit, or null when the key isn't configured. */
  dailyLimit: number | null;
  limitUnit: 'units' | 'requests';
  /** Estimated consumption in the last 24h. Always an estimate. */
  estimatedUsed24h: number;
  estimate: true;
  lastRateLimitAt: string | null;
  lastRateLimitKind: 'quota' | 'transient' | null;
}

export interface ApiUsageReport {
  asOf: string;
  upstreams: UpstreamUsage[];
}

/** Published daily limits (AC-62.1). */
const YOUTUBE_DAILY_UNITS = 10_000;
/**
 * Congress.gov documents an hourly request cap; we report a conservative daily
 * figure for the gauge. This is the published budget, not a measured value.
 */
const CONGRESS_DAILY_REQUESTS = 5_000 * 24;

/**
 * YouTube unit-cost model (AC-62.2). A normal sync of one channel lists recent
 * uploads (1 unit). A fraction of syncs fall back to the search endpoint
 * (100 units) when the channel can't be resolved cheaply. We model an average
 * cost per sync attempt that bakes in a small search-fallback factor.
 */
const YOUTUBE_UNITS_PER_SYNC = 1 + 0.1 * 100; // ≈ 11 units avg (10% search fallback)

/** Congress requests per bill import (AC-62.3): detail + actions + cosponsors
 *  + per-roll-call vote details. Bounded; we use a fixed representative factor. */
const CONGRESS_REQUESTS_PER_IMPORT = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Matches the rate-limit error string shape produced by the ingest adapters
 *  (`rate-limited (429|403, transient|quota)`). */
const RATE_LIMIT_RE = /rate-limited \((?:429|403), (transient|quota)\)/i;

/**
 * Build the API-usage report. `keys` reports which upstream API keys are
 * configured (so an unconfigured upstream shows "not configured", AC-62.6).
 */
export async function buildApiUsageReport(
  d1: D1UsageLike,
  keys: { youtube: boolean; congress: boolean },
  nowMs: number,
): Promise<ApiUsageReport> {
  const sinceIso = new Date(nowMs - DAY_MS).toISOString();
  const asOf = new Date(nowMs).toISOString();

  const [youtube, congress] = await Promise.all([
    buildYouTube(d1, keys.youtube, sinceIso),
    buildCongress(d1, keys.congress, sinceIso),
  ]);

  return { asOf, upstreams: [youtube, congress] };
}

async function buildYouTube(
  d1: D1UsageLike,
  configured: boolean,
  sinceIso: string,
): Promise<UpstreamUsage> {
  // Count YouTube sync attempts in the window.
  const attempts = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM mocs_social_handles
       WHERE platform = 'youtube' AND last_poll_attempted_at >= ?`,
    )
    .bind(sinceIso)
    .first<{ n: number }>();

  const rate = await lastRateLimit(d1, 'youtube', sinceIso);

  const n = attempts?.n ?? 0;
  return {
    upstream: 'youtube',
    configured,
    dailyLimit: configured ? YOUTUBE_DAILY_UNITS : null,
    limitUnit: 'units',
    estimatedUsed24h: Math.round(n * YOUTUBE_UNITS_PER_SYNC),
    estimate: true,
    lastRateLimitAt: rate.at,
    lastRateLimitKind: rate.kind,
  };
}

async function buildCongress(
  d1: D1UsageLike,
  configured: boolean,
  sinceIso: string,
): Promise<UpstreamUsage> {
  const imports = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_log
       WHERE action = 'import_bill' AND created_at >= ?`,
    )
    .bind(sinceIso)
    .first<{ n: number }>();

  const n = imports?.n ?? 0;
  return {
    upstream: 'congress',
    configured,
    dailyLimit: configured ? CONGRESS_DAILY_REQUESTS : null,
    limitUnit: 'requests',
    estimatedUsed24h: n * CONGRESS_REQUESTS_PER_IMPORT,
    estimate: true,
    // Congress rate-limit signals aren't persisted per-handle; none surfaced here.
    lastRateLimitAt: null,
    lastRateLimitKind: null,
  };
}

/**
 * Most recent persisted rate-limit signal for a platform (AC-62.4): scan the
 * handle rows whose last error matches the rate-limit pattern and take the
 * newest attempt.
 */
async function lastRateLimit(
  d1: D1UsageLike,
  platform: UpstreamName,
  sinceIso: string,
): Promise<{ at: string | null; kind: 'quota' | 'transient' | null }> {
  const row = await d1
    .prepare(
      `SELECT last_poll_attempted_at AS at, last_poll_error AS err
       FROM mocs_social_handles
       WHERE platform = ? AND last_poll_status = 'error'
         AND last_poll_attempted_at >= ?
         AND last_poll_error LIKE '%rate-limited%'
       ORDER BY last_poll_attempted_at DESC
       LIMIT 1`,
    )
    .bind(platform, sinceIso)
    .first<{ at: string | null; err: string | null }>();

  if (!row?.at) return { at: null, kind: null };
  const m = row.err ? RATE_LIMIT_RE.exec(row.err) : null;
  const kind = m?.[1] ? (m[1].toLowerCase() as 'quota' | 'transient') : null;
  return { at: row.at, kind };
}
