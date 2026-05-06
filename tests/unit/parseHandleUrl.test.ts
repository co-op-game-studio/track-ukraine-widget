/**
 * parseHandleUrl — admin "Add handle" URL → {platform, handle} parser.
 * Lets researchers paste any social profile URL instead of typing handles.
 */
import { describe, it, expect } from 'vitest';
import { parseHandleUrl } from '../../src/admin/utils/parseHandleUrl';

describe('parseHandleUrl', () => {
  it('parses Bluesky profile URLs', () => {
    expect(parseHandleUrl('https://bsky.app/profile/rep.bsky.social'))
      .toEqual({ platform: 'bluesky', handle: 'rep.bsky.social' });
  });

  it('parses YouTube @handle URLs', () => {
    expect(parseHandleUrl('https://youtube.com/@SenSchumer'))
      .toEqual({ platform: 'youtube', handle: 'SenSchumer' });
  });

  it('parses YouTube channel ID URLs', () => {
    expect(parseHandleUrl('https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx'))
      .toEqual({ platform: 'youtube', handle: 'UCxxxxxxxxxxxxxxxxxxxxxx' });
  });

  it('parses Twitter/X URLs from both hosts', () => {
    expect(parseHandleUrl('https://twitter.com/SenWarren'))
      .toEqual({ platform: 'twitter', handle: 'SenWarren' });
    expect(parseHandleUrl('https://x.com/SenWarren'))
      .toEqual({ platform: 'twitter', handle: 'SenWarren' });
  });

  it('rejects Twitter non-profile paths', () => {
    expect(parseHandleUrl('https://twitter.com/home')).toBeNull();
    expect(parseHandleUrl('https://twitter.com/i/status/123')).toBeNull();
  });

  it('parses Facebook URLs (with and without www)', () => {
    expect(parseHandleUrl('https://www.facebook.com/SenatorBennet'))
      .toEqual({ platform: 'facebook', handle: 'SenatorBennet' });
    expect(parseHandleUrl('https://facebook.com/SenatorBennet'))
      .toEqual({ platform: 'facebook', handle: 'SenatorBennet' });
  });

  it('parses Instagram URLs', () => {
    expect(parseHandleUrl('https://www.instagram.com/repbarbaralee/'))
      .toEqual({ platform: 'instagram', handle: 'repbarbaralee' });
  });

  it('parses Threads @handle URLs', () => {
    expect(parseHandleUrl('https://www.threads.net/@senwarren'))
      .toEqual({ platform: 'threads', handle: 'senwarren' });
  });

  it('parses Mastodon /@user URLs into canonical user@server form', () => {
    expect(parseHandleUrl('https://mastodon.social/@senator'))
      .toEqual({ platform: 'mastodon', handle: 'senator@mastodon.social' });
  });

  it('parses Mastodon /users/<name> URLs', () => {
    expect(parseHandleUrl('https://mas.to/users/senator'))
      .toEqual({ platform: 'mastodon', handle: 'senator@mas.to' });
  });

  it('returns null for non-URLs and empty input', () => {
    expect(parseHandleUrl('')).toBeNull();
    expect(parseHandleUrl('   ')).toBeNull();
    expect(parseHandleUrl('not a url')).toBeNull();
    expect(parseHandleUrl('@SenWarren')).toBeNull();
  });

  it('returns null for unsupported hosts', () => {
    expect(parseHandleUrl('https://example.com/SenWarren')).toBeNull();
    expect(parseHandleUrl('https://linkedin.com/in/senator')).toBeNull();
  });

  it('returns null for missing handle segment', () => {
    expect(parseHandleUrl('https://bsky.app/profile/')).toBeNull();
    expect(parseHandleUrl('https://twitter.com/')).toBeNull();
  });

  it('rejects non-http(s) protocols', () => {
    expect(parseHandleUrl('javascript:alert(1)')).toBeNull();
    expect(parseHandleUrl('ftp://twitter.com/handle')).toBeNull();
  });

  it('strips www and trims input', () => {
    expect(parseHandleUrl('  https://www.twitter.com/SenWarren  '))
      .toEqual({ platform: 'twitter', handle: 'SenWarren' });
  });
});
