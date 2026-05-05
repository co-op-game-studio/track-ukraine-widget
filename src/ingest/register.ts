/**
 * Adapter registration — called once at worker boot.
 *
 * Import this module to populate the adapter factory with all available
 * platform connectors. Adding a new platform = add one import + one
 * registerAdapter call.
 */
import { registerAdapter } from './factory';
import { BlueskyAdapter } from './adapters/bluesky';
import { YouTubeAdapter } from './adapters/youtube';
import { MastodonAdapter } from './adapters/mastodon';
import { TwitterAdapter } from './adapters/twitter';

// Free / no-auth adapters: always registered.
registerAdapter(new BlueskyAdapter());
registerAdapter(new MastodonAdapter());

// Auth-requiring adapters: registered conditionally at first request when
// the corresponding env var is present. Once registered, the platforms
// endpoint runs the adapter's healthCheck() to confirm the credentials
// actually work — only "available" platforms are exposed to the UI.
//
// Facebook + Instagram intentionally NOT here. Meta's policy landscape as of
// 2026-05 makes timeline polling for accounts you don't own essentially
// impossible without academic Content Library access (which sandboxes data).
// Direct-add by URL via oEmbed is the only feasible read path; we'll add
// that back through a different surface when there's demand.
export function registerYouTube(apiKey: string): void {
  registerAdapter(new YouTubeAdapter(apiKey));
}
export function registerTwitter(bearerToken: string): void {
  registerAdapter(new TwitterAdapter(bearerToken));
}
