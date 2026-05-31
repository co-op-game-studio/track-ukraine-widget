/**
 * Admin profile widget-preview src — FR-60 AC-60.6.
 *
 * The PersonProfileView preview iframe deep-links the same-origin `/embed`
 * onto the member it is showing. Asserts the src carries `?bioguide=<id>`
 * against the served origin (not a hard-coded foreign domain).
 */
import { describe, it, expect } from 'vitest';
import { embedPreviewSrc } from '../../src/admin/components/PeopleTab';

describe('embedPreviewSrc (FR-60 AC-60.6)', () => {
  it('deep-links /embed on the given origin with the bioguide query param', () => {
    expect(embedPreviewSrc('https://dev.vote.cogs.it.com', 'D000563')).toBe(
      'https://dev.vote.cogs.it.com/embed?bioguide=D000563',
    );
  });

  it('uses the served origin (not a hard-coded trackukraine.com)', () => {
    const src = embedPreviewSrc('https://uat.vote.cogs.it.com', 'A000360');
    expect(src.startsWith('https://uat.vote.cogs.it.com/embed')).toBe(true);
    expect(src).not.toContain('trackukraine.com');
  });

  it('url-encodes the bioguide so a stray value cannot break out of the query', () => {
    // Bioguides are validated downstream; this guards the src construction.
    expect(embedPreviewSrc('https://x', 'A0 0')).toBe('https://x/embed?bioguide=A0%200');
  });
});
