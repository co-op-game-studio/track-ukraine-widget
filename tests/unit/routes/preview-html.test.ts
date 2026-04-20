/**
 * proxy/routes/preview.ts — HTML-builder smoke tests.
 *
 * The two functions return static HTML strings for /embed (any env) and /
 * (non-prod PREVIEW_MODE). Tests verify the shape of the output so future
 * edits can't silently break embedding or the preview page.
 */
import { describe, it, expect } from 'vitest';
import { buildEmbedHtml, buildPreviewHtml } from '../../../proxy/routes/preview';

describe('buildEmbedHtml', () => {
  it('returns valid HTML with a viw-mount element and the widget script', () => {
    const html = buildEmbedHtml('prod');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<div id="viw-mount"/);
    expect(html).toMatch(/voter-info-widget\.iife\.js/);
  });

  it('includes OpenGraph meta tags for link previews', () => {
    const html = buildEmbedHtml('uat');
    expect(html).toMatch(/<meta property="og:title"/);
    expect(html).toMatch(/<meta property="og:description"/);
  });

  it('handles every env label without crashing', () => {
    for (const env of ['prod', 'stg', 'uat', 'dev', 'preview', 'non-prod']) {
      const html = buildEmbedHtml(env);
      expect(html.length).toBeGreaterThan(200);
    }
  });
});

describe('buildPreviewHtml', () => {
  it('returns valid HTML with the widget custom element and the widget script', () => {
    const html = buildPreviewHtml('dev');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<voter-info-widget/);
    expect(html).toMatch(/voter-info-widget\.iife\.js/);
  });

  it('surfaces the env name somewhere in the markup so preview users know which env they hit', () => {
    const html = buildPreviewHtml('stg-rehearsal');
    expect(html.toLowerCase()).toContain('stg-rehearsal');
  });

  it('handles every non-prod env label', () => {
    for (const env of ['dev', 'uat', 'stg', 'preview', 'non-prod']) {
      const html = buildPreviewHtml(env);
      expect(html.length).toBeGreaterThan(200);
    }
  });
});
