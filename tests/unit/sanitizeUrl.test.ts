/**
 * Tests for `sanitizeUrl` — the single chokepoint for URLs sourced from
 * external APIs before they become `href`/`src` attributes.
 *
 * Traces to: FR-31 AC-31.1, AC-31.2.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from '../../src/utils/sanitizeUrl';

describe('sanitizeUrl (AC-31.1, AC-31.2)', () => {
  describe('accepts safe http(s) URLs', () => {
    it('returns an https URL verbatim', () => {
      expect(sanitizeUrl('https://www.house.gov/rep/smith')).toBe(
        'https://www.house.gov/rep/smith',
      );
    });

    it('returns an http URL verbatim', () => {
      expect(sanitizeUrl('http://senator.state.gov/page')).toBe(
        'http://senator.state.gov/page',
      );
    });

    it('preserves a URL with a query string', () => {
      expect(sanitizeUrl('https://api.example.com/path?x=1&y=2')).toBe(
        'https://api.example.com/path?x=1&y=2',
      );
    });

    it('preserves a URL with a fragment', () => {
      expect(sanitizeUrl('https://example.com/page#section')).toBe(
        'https://example.com/page#section',
      );
    });
  });

  describe('rejects dangerous schemes', () => {
    it('rejects a javascript: URL', () => {
      expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    });

    it('rejects a JAVASCRIPT: URL (mixed case)', () => {
      expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBeNull();
    });

    it('rejects a data: URL', () => {
      expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('rejects a vbscript: URL', () => {
      expect(sanitizeUrl('vbscript:msgbox(1)')).toBeNull();
    });

    it('rejects a file: URL', () => {
      expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
    });

    it('rejects a chrome-extension: URL', () => {
      expect(sanitizeUrl('chrome-extension://abc/page.html')).toBeNull();
    });
  });

  describe('rejects malformed / empty inputs', () => {
    it('returns null for an empty string', () => {
      expect(sanitizeUrl('')).toBeNull();
    });

    it('returns null for whitespace', () => {
      expect(sanitizeUrl('   ')).toBeNull();
    });

    it('returns null for null', () => {
      expect(sanitizeUrl(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(sanitizeUrl(undefined)).toBeNull();
    });

    it('returns null for a relative URL (no scheme)', () => {
      // A relative URL is not safe as an absolute href — the origin
      // resolves against whatever document embeds the widget, which is
      // not what the caller intends when handing off an API-sourced URL.
      expect(sanitizeUrl('/page')).toBeNull();
    });

    it('returns null for a protocol-relative URL', () => {
      expect(sanitizeUrl('//evil.com/page')).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(sanitizeUrl('not a url at all')).toBeNull();
    });
  });

  describe('embedded control characters', () => {
    it('rejects a URL containing a tab', () => {
      expect(sanitizeUrl('https://example.com/a\tb')).toBeNull();
    });

    it('rejects a URL containing a newline', () => {
      expect(sanitizeUrl('https://example.com/a\nb')).toBeNull();
    });

    it('rejects a URL containing a carriage return', () => {
      expect(sanitizeUrl('https://example.com/a\rb')).toBeNull();
    });

    it('rejects a URL containing a null byte', () => {
      expect(sanitizeUrl('https://example.com/a\x00b')).toBeNull();
    });

    it('rejects a URL containing DEL (0x7f)', () => {
      expect(sanitizeUrl('https://example.com/a\x7fb')).toBeNull();
    });
  });

  describe('leading/trailing whitespace', () => {
    it('rejects URLs with leading whitespace that hides a dangerous scheme', () => {
      // Some historical browsers tolerated leading whitespace before the
      // scheme, turning `  javascript:alert(1)` into an executable href.
      // The sanitizer's job is to reject anything not cleanly http(s).
      expect(sanitizeUrl('  javascript:alert(1)')).toBeNull();
    });

    it('accepts a well-formed URL with no whitespace', () => {
      expect(sanitizeUrl('https://clean.example.com')).toBe('https://clean.example.com');
    });
  });
});
