/**
 * Parse a social-media URL into { platform, handle }.
 *
 * Used by the admin "Add handle" form so a researcher can paste a profile
 * URL (e.g. https://bsky.app/profile/rep.bsky.social) and the form picks
 * the right platform and pre-fills the handle.
 *
 * Returns null when:
 *   - the input isn't a valid http(s) URL
 *   - the host doesn't match any supported platform
 *   - the path doesn't include a handle (e.g. https://twitter.com/ alone)
 *
 * Platforms covered: bluesky, mastodon, youtube, twitter/x, facebook,
 * instagram, threads. Mastodon is special-cased because the handle includes
 * the server domain (e.g. user@server.tld).
 */
export interface ParsedHandle {
  platform: 'bluesky' | 'mastodon' | 'youtube' | 'twitter' | 'facebook' | 'instagram' | 'threads';
  handle: string;
}

export function parseHandleUrl(input: string): ParsedHandle | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? '';

  // Bluesky: bsky.app/profile/<handle>
  if (host === 'bsky.app' && first === 'profile' && segments[1]) {
    return { platform: 'bluesky', handle: decodeURIComponent(segments[1]) };
  }

  // YouTube channel handle: youtube.com/@handle  or  youtube.com/channel/UCxxx
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (first.startsWith('@')) {
      return { platform: 'youtube', handle: first.slice(1) };
    }
    if (first === 'channel' && segments[1]) {
      return { platform: 'youtube', handle: segments[1] };
    }
    if (first === 'c' && segments[1]) {
      return { platform: 'youtube', handle: segments[1] };
    }
  }

  // Twitter / X: twitter.com/<handle> or x.com/<handle>
  if (host === 'twitter.com' || host === 'x.com') {
    if (first && !['home', 'i', 'search', 'explore', 'notifications', 'messages'].includes(first)) {
      return { platform: 'twitter', handle: first };
    }
  }

  // Facebook: facebook.com/<handle>  (skip generic non-profile paths)
  if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.com') {
    if (first && !['groups', 'pages', 'events', 'marketplace', 'watch', 'home.php'].includes(first)) {
      return { platform: 'facebook', handle: first };
    }
  }

  // Instagram: instagram.com/<handle>
  if (host === 'instagram.com') {
    if (first && !['explore', 'reels', 'p', 'stories', 'direct'].includes(first)) {
      return { platform: 'instagram', handle: first };
    }
  }

  // Threads: threads.net/@handle
  if (host === 'threads.net' && first.startsWith('@')) {
    return { platform: 'threads', handle: first.slice(1) };
  }

  // Mastodon: any host with /@user path. Server is the host. Handle is
  // returned in the canonical user@server form so it round-trips through
  // the existing storage layer.
  if (first.startsWith('@')) {
    const user = first.slice(1);
    if (user) return { platform: 'mastodon', handle: `${user}@${host}` };
  }
  if (first === 'users' && segments[1]) {
    // Some Mastodon instances surface profiles at /users/<name>.
    return { platform: 'mastodon', handle: `${segments[1]}@${host}` };
  }

  return null;
}
