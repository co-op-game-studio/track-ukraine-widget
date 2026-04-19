import { describe, it, expect } from 'vitest';
import {
  isOriginAllowed,
  isValidUpstreamPath,
  normalizeUpstreamErrorBody,
  applySecurityHeaders,
  stripFingerprintingHeaders,
} from '../../../proxy/lib';

// ─── Test harness ──────────────────────────────────────────────────────────

describe('isOriginAllowed (AC-25.5, AC-25.7, AC-25.9)', () => {
  const allowlist = ['https://trackukraine.com', 'https://www.trackukraine.com'];

  it('returns true for exact whitelist match', () => {
    expect(isOriginAllowed('https://trackukraine.com', allowlist, false)).toBe(true);
  });

  it('returns false for missing origin (AC-25.5)', () => {
    expect(isOriginAllowed(null, allowlist, false)).toBe(false);
  });

  it('returns false for origin not on whitelist', () => {
    expect(isOriginAllowed('https://evil.example.com', allowlist, false)).toBe(false);
  });

  it('returns false for suffix-attack origin (AC-25.7)', () => {
    expect(isOriginAllowed('https://trackukraine.com.evil.example', allowlist, false)).toBe(false);
  });

  it('returns false for prefix-attack origin', () => {
    expect(isOriginAllowed('https://evil.trackukraine.com', allowlist, false)).toBe(false);
  });

  it('is case-sensitive (AC-25.7)', () => {
    expect(isOriginAllowed('https://TRACKUKRAINE.com', allowlist, false)).toBe(false);
  });

  it('denies localhost when ALLOW_LOCALHOST is false (AC-25.9 — PROD BEHAVIOR)', () => {
    expect(isOriginAllowed('http://localhost:9999', allowlist, false)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:3000', allowlist, false)).toBe(false);
  });

  it('permits localhost only when ALLOW_LOCALHOST is true (AC-25.9)', () => {
    expect(isOriginAllowed('http://localhost', allowlist, true)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', allowlist, true)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8080', allowlist, true)).toBe(true);
  });

  it('does NOT permit https://localhost even with ALLOW_LOCALHOST=true', () => {
    // Prevents `Origin: https://localhost.attacker.com` style confusion — we
    // intentionally only match http://, the local-dev scheme.
    expect(isOriginAllowed('https://localhost:3000', allowlist, true)).toBe(false);
  });

  it('does NOT permit localhost-lookalike origins with ALLOW_LOCALHOST=true', () => {
    expect(isOriginAllowed('http://localhost.evil.com', allowlist, true)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1.evil.com', allowlist, true)).toBe(false);
    expect(isOriginAllowed('http://1localhost', allowlist, true)).toBe(false);
  });
});

describe('isValidUpstreamPath (AC-27.7)', () => {
  it('accepts simple paths', () => {
    expect(isValidUpstreamPath('v3/member/A000360')).toBe(true);
    expect(isValidUpstreamPath('geocoder/geographies/onelineaddress')).toBe(true);
  });

  it('rejects paths containing ..', () => {
    expect(isValidUpstreamPath('v3/../admin')).toBe(false);
    expect(isValidUpstreamPath('..')).toBe(false);
    expect(isValidUpstreamPath('foo/..bar')).toBe(false);
  });

  it('rejects paths containing //', () => {
    expect(isValidUpstreamPath('v3//member')).toBe(false);
    expect(isValidUpstreamPath('//evil.com/x')).toBe(false);
  });

  it('rejects paths containing @', () => {
    expect(isValidUpstreamPath('v3/member@evil.com')).toBe(false);
  });

  it('rejects paths with raw control characters', () => {
    expect(isValidUpstreamPath('v3/member\x00/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\n/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\r/x')).toBe(false);
    expect(isValidUpstreamPath('v3/member\x7f/x')).toBe(false);
  });

  it('rejects paths with percent-encoded control bytes (AC-27.7)', () => {
    // URL.pathname preserves percent-encoded bytes — attacker uses them to
    // smuggle CR/LF past naive string checks. isValidUpstreamPath must reject.
    expect(isValidUpstreamPath('v3/member/foo%0d%0aX-Injected')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%00admin')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%7f')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%1F')).toBe(false);
    expect(isValidUpstreamPath('v3/member/%0A')).toBe(false); // uppercase hex
  });

  it('accepts percent-encoded non-control bytes', () => {
    // %20 = space, %2f = /, %3a = : — still valid in paths.
    // (Note: %2f would be collapsed by URL.pathname normalization anyway in
    // most implementations, but structurally it's not a control byte.)
    expect(isValidUpstreamPath('v3/member/foo%20bar')).toBe(true);
    expect(isValidUpstreamPath('v3/member/A%3AB')).toBe(true);
  });

  it('accepts empty path', () => {
    // Empty is handled by upstream-path-starts-with-v3 check (AC-27.6), not here.
    expect(isValidUpstreamPath('')).toBe(true);
  });
});

describe('normalizeUpstreamErrorBody (AC-27.5)', () => {
  it('returns a JSON envelope for upstream errors', () => {
    const body = normalizeUpstreamErrorBody(500, 'congress');
    expect(JSON.parse(body)).toEqual({
      error: 'upstream_error',
      status: 500,
      upstream: 'congress',
    });
  });

  it('does not include the upstream response body', () => {
    // The helper signature deliberately does not accept the upstream body,
    // so it is impossible to pass it through by accident.
    const body = normalizeUpstreamErrorBody(502, 'census');
    expect(body).not.toMatch(/html|<|CONGRESS|api_key/);
  });
});

describe('applySecurityHeaders (AC-27.1)', () => {
  it('sets the universal baseline on any response', () => {
    const r = applySecurityHeaders(new Response('ok', { status: 200 }));
    expect(r.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('X-DNS-Prefetch-Control')).toBe('off');
    expect(r.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
    expect(r.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(r.headers.get('Origin-Agent-Cluster')).toBe('?1');
  });

  it('sets the baseline on error responses too', () => {
    const r = applySecurityHeaders(new Response('nope', { status: 403 }));
    expect(r.headers.get('Strict-Transport-Security')).toBeTruthy();
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('preserves the original status and body', async () => {
    const r = applySecurityHeaders(new Response('hello', { status: 418 }));
    expect(r.status).toBe(418);
    expect(await r.text()).toBe('hello');
  });
});

describe('stripFingerprintingHeaders (AC-27.3)', () => {
  it('removes Set-Cookie', () => {
    const h = new Headers({ 'Set-Cookie': 'sid=abc' });
    stripFingerprintingHeaders(h);
    expect(h.get('Set-Cookie')).toBeNull();
  });

  it('removes Access-Control-Allow-Credentials', () => {
    const h = new Headers({ 'Access-Control-Allow-Credentials': 'true' });
    stripFingerprintingHeaders(h);
    expect(h.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('removes Server, Via, Link', () => {
    const h = new Headers({ Server: 'apache', Via: '1.1 foo', Link: '<x>; rel=bar' });
    stripFingerprintingHeaders(h);
    expect(h.get('Server')).toBeNull();
    expect(h.get('Via')).toBeNull();
    expect(h.get('Link')).toBeNull();
  });

  it('removes Report-To, NEL, Reporting-Endpoints (opt-out of upstream beacons)', () => {
    const h = new Headers({
      'Report-To': '{"group":"x"}',
      NEL: '{"report_to":"x"}',
      'Reporting-Endpoints': 'default="https://x"',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('Report-To')).toBeNull();
    expect(h.get('NEL')).toBeNull();
    expect(h.get('Reporting-Endpoints')).toBeNull();
  });

  it('removes X-Powered-By, X-AspNet-Version, X-AspNetMvc-Version, P3P', () => {
    const h = new Headers({
      'X-Powered-By': 'Express',
      'X-AspNet-Version': '4.0',
      'X-AspNetMvc-Version': '5.2',
      P3P: 'CP="foo"',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('X-Powered-By')).toBeNull();
    expect(h.get('X-AspNet-Version')).toBeNull();
    expect(h.get('X-AspNetMvc-Version')).toBeNull();
    expect(h.get('P3P')).toBeNull();
  });

  it('removes x-vcap-*, x-api-umbrella-*, x-amz-*, x-azure-*, x-appengine-*, x-request-id, x-correlation-id, x-trace-id, x-b3-*', () => {
    const h = new Headers({
      'x-vcap-request-id': '1',
      'X-API-Umbrella-Request-Id': '2',
      'x-amz-request-id': '3',
      'x-azure-ref': '4',
      'x-appengine-region': '5',
      'x-request-id': '6',
      'x-correlation-id': '7',
      'x-trace-id': '8',
      'x-b3-traceid': '9',
    });
    stripFingerprintingHeaders(h);
    for (const k of [
      'x-vcap-request-id',
      'X-API-Umbrella-Request-Id',
      'x-amz-request-id',
      'x-azure-ref',
      'x-appengine-region',
      'x-request-id',
      'x-correlation-id',
      'x-trace-id',
      'x-b3-traceid',
    ]) {
      expect(h.get(k)).toBeNull();
    }
  });

  it('does not remove headers we explicitly keep', () => {
    const h = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'public',
      ETag: 'abc',
    });
    stripFingerprintingHeaders(h);
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get('Cache-Control')).toBe('public');
    expect(h.get('ETag')).toBe('abc');
  });
});
