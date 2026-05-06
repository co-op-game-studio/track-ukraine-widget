/**
 * Shared HTTP-status classification for adapter responses.
 *
 * Centralised so every adapter throws the same `RateLimitError` shape on
 * upstream throttling — the poll loop relies on `isRateLimit(e)` to short-
 * circuit the platform instead of marking N hopeless handles as "error."
 *
 * Recognised throttling signals:
 *   - HTTP 429 (Too Many Requests) — universal
 *   - HTTP 403 with a body that mentions quota/rate/limit — Google + Twitter
 *     return 403 when the daily quota is exhausted, with the explanation in
 *     the body rather than as a 429.
 */
import type { PlatformSlug } from './types';
import { RateLimitError } from './types';

/** Parse the upstream Retry-After header (seconds OR HTTP-date). */
function parseRetryAfter(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const sec = Number.parseInt(headerVal, 10);
  if (Number.isFinite(sec) && sec >= 0) return sec;
  // HTTP-date form
  const t = Date.parse(headerVal);
  if (!Number.isNaN(t)) {
    const delta = Math.round((t - Date.now()) / 1000);
    return delta > 0 ? delta : 0;
  }
  return null;
}

/** Read a soft rate-limit reset hint from common provider headers. */
function parseResetHeader(res: Response): number | null {
  // Twitter / Bluesky / many Mastodon instances expose epoch seconds here.
  const reset = res.headers.get('x-ratelimit-reset') ?? res.headers.get('ratelimit-reset');
  if (!reset) return null;
  const n = Number.parseInt(reset, 10);
  if (!Number.isFinite(n)) return null;
  // If it looks like an epoch (>1e9), convert to seconds-from-now.
  if (n > 1e9) {
    const delta = n - Math.floor(Date.now() / 1000);
    return delta > 0 ? delta : 0;
  }
  // Otherwise assume "seconds from now."
  return n;
}

/**
 * Inspect a non-OK Response from an upstream API. If it's a throttling signal,
 * throw RateLimitError so the poll loop can short-circuit the platform.
 * Otherwise returns the body text so the caller can wrap it in a normal
 * platform-specific error.
 *
 * The `kind` discriminator tells the caller *why* it failed:
 *   - 'transient' = wait `retryAfterSec` and resume (Bluesky 429, Mastodon 429,
 *     Twitter 429 with an explicit reset window)
 *   - 'quota' = daily/monthly cap exhausted; no point retrying inside this run
 *     (YouTube 403-quota = resets midnight Pacific, Twitter 403-quota =
 *     monthly tier cap)
 */
export async function checkResponse(
  platform: PlatformSlug,
  res: Response,
  contextHint: string,
): Promise<string> {
  const body = await res.text().catch(() => '');
  const lower = body.toLowerCase();

  // 429 — almost always transient (per-window rate limit). Default backoff is
  // 60s when the upstream doesn't tell us.
  if (res.status === 429) {
    const retry = parseRetryAfter(res.headers.get('retry-after')) ?? parseResetHeader(res) ?? 60;
    throw new RateLimitError(platform, 429, `${contextHint} — ${trimSnippet(body)}`, retry, 'transient');
  }

  // 403 with quota body — daily/monthly hard cap. Don't retry inside this run.
  // Operator path: extend YouTube quota in Google Cloud Console, or upgrade
  // Twitter tier. Surfaced in App Config view.
  if (res.status === 403 && (
    lower.includes('quota') ||
    lower.includes('exceeded') ||
    lower.includes('usage cap')
  )) {
    const retry = parseRetryAfter(res.headers.get('retry-after')) ?? parseResetHeader(res);
    throw new RateLimitError(platform, 403, `${contextHint} — ${trimSnippet(body)}`, retry, 'quota');
  }

  // 403 without quota wording (or with just "rate"/"over_capacity") — treat as
  // transient. Bluesky has been known to use 403 for very-short overload
  // windows.
  if (res.status === 403 && (
    lower.includes('rate') ||
    lower.includes('over_capacity')
  )) {
    const retry = parseRetryAfter(res.headers.get('retry-after')) ?? parseResetHeader(res) ?? 60;
    throw new RateLimitError(platform, 403, `${contextHint} — ${trimSnippet(body)}`, retry, 'transient');
  }

  return body;
}

function trimSnippet(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '…' : flat;
}
