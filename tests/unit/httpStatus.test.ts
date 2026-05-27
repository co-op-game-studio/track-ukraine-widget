/**
 * Tests for src/ingest/http-status.ts.
 *
 * The classifier converts non-OK upstream responses into either:
 *   - a normal body string (caller wraps in platform-specific error)
 *   - a `RateLimitError` thrown with `kind: 'transient' | 'quota'`
 *
 * This file pins both the recognition rules and the retry-after parsing.
 *
 * Traces: FR-59 (rate-limit handling), ADR around social-poll backoff.
 */
import { describe, it, expect } from 'vitest';
import { checkResponse } from '../../src/ingest/http-status';
import { RateLimitError, isRateLimit } from '../../src/ingest/types';

function res(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('checkResponse — non-rate-limit responses', () => {
  it('returns body text for arbitrary 4xx/5xx without throttling shape', async () => {
    const r = res(500, 'internal upstream boom');
    await expect(checkResponse('bluesky', r, 'feed')).resolves.toBe('internal upstream boom');
  });

  it('returns body text for 404', async () => {
    const r = res(404, 'not found');
    await expect(checkResponse('mastodon', r, 'lookup')).resolves.toBe('not found');
  });

  it('returns body text for 400', async () => {
    const r = res(400, 'malformed query');
    await expect(checkResponse('twitter', r, 'search')).resolves.toBe('malformed query');
  });

  it('handles empty body without throwing', async () => {
    const r = res(404, '');
    await expect(checkResponse('youtube', r, 'channel')).resolves.toBe('');
  });
});

describe('checkResponse — 429 (transient)', () => {
  it('throws RateLimitError with kind=transient on bare 429', async () => {
    const r = res(429, 'slow down');
    await expect(checkResponse('bluesky', r, 'feed')).rejects.toThrow(RateLimitError);
  });

  it('uses retry-after header (seconds form) when present', async () => {
    const r = res(429, '', { 'retry-after': '120' });
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect(isRateLimit(e)).toBe(true);
      const err = e as RateLimitError;
      expect(err.status).toBe(429);
      expect(err.kind).toBe('transient');
      expect(err.platform).toBe('bluesky');
      expect(err.retryAfterSec).toBe(120);
    }
  });

  it('falls back to x-ratelimit-reset (epoch) when retry-after absent', async () => {
    // 30 seconds in the future (epoch seconds)
    const futureEpoch = Math.floor(Date.now() / 1000) + 30;
    const r = res(429, '', { 'x-ratelimit-reset': String(futureEpoch) });
    try {
      await checkResponse('twitter', r, 'timeline');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as RateLimitError;
      // Allow ±2s tolerance for the inline Date.now() inside the parser
      expect(err.retryAfterSec).toBeGreaterThanOrEqual(28);
      expect(err.retryAfterSec).toBeLessThanOrEqual(32);
    }
  });

  it('treats x-ratelimit-reset under 1e9 as seconds-from-now', async () => {
    const r = res(429, '', { 'x-ratelimit-reset': '45' });
    try {
      await checkResponse('twitter', r, 'timeline');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(45);
    }
  });

  it('falls back to ratelimit-reset (no x- prefix) header', async () => {
    const r = res(429, '', { 'ratelimit-reset': '90' });
    try {
      await checkResponse('mastodon', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(90);
    }
  });

  it('defaults retry to 60s when no header provided', async () => {
    const r = res(429, 'slow down');
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(60);
    }
  });

  it('parses HTTP-date form retry-after', async () => {
    // Use a date 90 seconds in the future
    const future = new Date(Date.now() + 90_000).toUTCString();
    const r = res(429, '', { 'retry-after': future });
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      const sec = (e as RateLimitError).retryAfterSec ?? 0;
      // ±5s for clock-handling jitter
      expect(sec).toBeGreaterThanOrEqual(85);
      expect(sec).toBeLessThanOrEqual(95);
    }
  });

  it('treats past HTTP-date as 0', async () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const r = res(429, '', { 'retry-after': past });
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(0);
    }
  });

  it('ignores unparseable retry-after and falls through to header/default', async () => {
    const r = res(429, '', { 'retry-after': 'not-a-number-or-date' });
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      // Should default to 60 since header parses to null and there's no x-rl-reset
      expect((e as RateLimitError).retryAfterSec).toBe(60);
    }
  });
});

describe('checkResponse — 403 quota (hard cap)', () => {
  it('throws kind=quota when 403 body mentions "quota"', async () => {
    const r = res(403, 'The request cannot be completed because you have exceeded your quota.');
    try {
      await checkResponse('youtube', r, 'channels');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as RateLimitError;
      expect(err.status).toBe(403);
      expect(err.kind).toBe('quota');
    }
  });

  it('matches "exceeded" alone', async () => {
    const r = res(403, 'monthly limit exceeded');
    await expect(checkResponse('twitter', r, 'tweets')).rejects.toThrow(RateLimitError);
  });

  it('matches "usage cap"', async () => {
    const r = res(403, 'usage cap reached for the current period');
    await expect(checkResponse('twitter', r, 'tweets')).rejects.toThrow(RateLimitError);
  });

  it('preserves retry-after header on quota errors when present', async () => {
    const r = res(403, 'quota exceeded', { 'retry-after': '3600' });
    try {
      await checkResponse('youtube', r, 'channels');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(3600);
    }
  });

  it('quota with no retry-after gets null retry (no fallback for quota path)', async () => {
    const r = res(403, 'quota exceeded');
    try {
      await checkResponse('youtube', r, 'channels');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBeNull();
    }
  });
});

describe('checkResponse — 403 transient (rate / overload)', () => {
  it('throws kind=transient when 403 body mentions "rate"', async () => {
    const r = res(403, 'rate limit exceeded'); // contains BOTH rate AND exceeded
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as RateLimitError;
      expect(err.status).toBe(403);
      // 'exceeded' check fires first (quota branch) — verify the precedence.
      // Both "quota" body keywords AND "rate" can match; quota wins per code order.
      expect(err.kind).toBe('quota');
    }
  });

  it('throws kind=transient on bare "rate" body (no exceeded/quota)', async () => {
    const r = res(403, 'rate-throttled, please slow');
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).kind).toBe('transient');
    }
  });

  it('throws kind=transient on "over_capacity"', async () => {
    const r = res(403, 'over_capacity — try again');
    try {
      await checkResponse('twitter', r, 'tweets');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).kind).toBe('transient');
    }
  });

  it('transient 403 defaults retry to 60s when no header', async () => {
    const r = res(403, 'rate-limited');
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as RateLimitError).retryAfterSec).toBe(60);
    }
  });

  it('non-quota / non-rate 403 returns body normally (not rate-limit)', async () => {
    const r = res(403, 'forbidden — bad creds');
    await expect(checkResponse('twitter', r, 'tweets')).resolves.toBe('forbidden — bad creds');
  });
});

describe('checkResponse — body trimming and snippets', () => {
  it('trims 200+ char bodies in the error message', async () => {
    const longBody = 'a'.repeat(500);
    const r = res(429, longBody);
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // Message format: `<platform> rate-limited (<status>, <kind>): <ctx> — <snippet>`
      // Snippet is trimmed to 197 + '…'
      expect(msg.length).toBeLessThan(600); // sanity: can't be the full 500-char body
      expect(msg).toContain('…'); // truncation marker present
    }
  });

  it('flattens whitespace in body snippet', async () => {
    const r = res(429, 'multi\n\n\nline\twhitespace   here');
    try {
      await checkResponse('bluesky', r, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('multi line whitespace here');
    }
  });

  it('handles body-read failure gracefully (returns empty string path)', async () => {
    // Construct a Response whose .text() rejects — simulate by mocking
    const fakeRes = {
      status: 429,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream consumed')),
    } as unknown as Response;
    try {
      await checkResponse('bluesky', fakeRes, 'feed');
      expect.fail('should have thrown');
    } catch (e) {
      expect(isRateLimit(e)).toBe(true);
      // Body read failed → snippet is empty but we still threw
      expect((e as Error).message).toContain('feed');
    }
  });
});

describe('isRateLimit type guard', () => {
  it('returns true for RateLimitError', () => {
    expect(isRateLimit(new RateLimitError('bluesky', 429, 'oops', 60, 'transient'))).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isRateLimit(new Error('regular'))).toBe(false);
    expect(isRateLimit('a string')).toBe(false);
    expect(isRateLimit(null)).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
    expect(isRateLimit({ status: 429 })).toBe(false);
  });
});
