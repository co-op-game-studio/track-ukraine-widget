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

// Free / no-auth adapters: always registered.
registerAdapter(new BlueskyAdapter());
registerAdapter(new MastodonAdapter());

// Auth-requiring adapters: registered conditionally at first request when
// the corresponding env var is present. Once registered, the platforms
// endpoint runs the adapter's healthCheck() to confirm the credentials
// actually work — only "available" platforms are exposed to the UI.
//
// Twitter/X: API Basic tier is ~$100/month minimum — not warranted for this
// use case. Researchers add X posts manually by URL.
// Facebook + Instagram: Meta's policy makes timeline polling for accounts
// you don't own essentially impossible without academic Content Library access.
export function registerYouTube(apiKey: string): void {
  registerAdapter(new YouTubeAdapter(apiKey));
}
