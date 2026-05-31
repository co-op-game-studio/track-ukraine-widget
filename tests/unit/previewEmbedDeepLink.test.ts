/**
 * Embed deep-link (?bioguide) — FR-60 AC-60.1, AC-60.7.
 *
 * buildEmbedHtml accepts an optional bioguide. When it is shape-valid
 * (`^[A-Z][0-9]{6}$`) the emitted `<voter-info-widget>` carries a
 * `bioguide` attribute; otherwise the element is mounted unchanged
 * (api-base only). The value is validated before it ever reaches the
 * markup, so injection payloads can never appear in the HTML.
 */
import { describe, it, expect } from 'vitest';
import { buildEmbedHtml } from '../../proxy/routes/preview';

describe('buildEmbedHtml deep-link (FR-60 AC-60.1)', () => {
  it('sets a bioguide attribute on the widget when the id is shape-valid', () => {
    const html = buildEmbedHtml('dev', 'D000563');
    // The mount script sets the attribute on the created element.
    expect(html).toMatch(/setAttribute\(\s*['"]bioguide['"]\s*,\s*['"]D000563['"]\s*\)/);
  });

  it('omits the bioguide attribute entirely when no id is supplied', () => {
    const html = buildEmbedHtml('dev');
    expect(html).not.toContain('bioguide');
  });

  it('omits the bioguide attribute when the id fails the shape check', () => {
    for (const bad of ['d000563', 'D00056', 'D0005633', 'ABCDEFG', '12345678', '']) {
      const html = buildEmbedHtml('dev', bad);
      // The api-base setAttribute is always present; only the bioguide one
      // must be absent. No reference to the rejected value may leak through.
      expect(html).not.toContain('bioguide');
      if (bad !== '') expect(html).not.toContain(bad);
    }
  });

  it('never interpolates an injection payload into the markup (AC-60.1 CSP posture)', () => {
    const payload = '"><script>alert(1)</script>';
    const html = buildEmbedHtml('dev', payload);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('bioguide');
  });

  it('stamps the CSP nonce on the inline script when provided (AC-60.9)', () => {
    const html = buildEmbedHtml('dev', 'D000563', 'abc-123');
    expect(html).toContain('<script nonce="abc-123">');
    // The external bundle loader stays nonce-free (it is allowed by 'self').
    expect(html).toContain('<script src="/voter-info-widget.iife.js" defer>');
  });

  it('omits the nonce attribute when no nonce is supplied', () => {
    const html = buildEmbedHtml('dev', 'D000563');
    expect(html).not.toContain('nonce=');
  });

  it('the no-bioguide HTML is unchanged from the bare-embed baseline (AC-60.7)', () => {
    const withUndefined = buildEmbedHtml('dev');
    const withEmpty = buildEmbedHtml('dev', '');
    // Both no-target forms produce identical, bioguide-free output.
    expect(withUndefined).toBe(withEmpty);
    expect(withUndefined).toContain('<div id="viw-mount">');
    expect(withUndefined).toContain('/voter-info-widget.iife.js');
  });
});
