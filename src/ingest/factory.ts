/**
 * Adapter factory — registry + URL-routing for social ingest.
 *
 * Adapters self-register at worker boot via `registerAdapter`. Consumers call
 * `getAdapter(slug)` or `adapterForUrl(url)`.
 *
 * Traces: FR-59.
 */
import type { PlatformSlug, SocialAdapter } from './types';
import { UnknownPlatformError, UnsupportedUrlError } from './types';
import type { AdapterLogger } from './adapter-logger';

const registry = new Map<PlatformSlug, SocialAdapter>();

export function registerAdapter(adapter: SocialAdapter): void {
  registry.set(adapter.platform, adapter);
}

export function getAdapter(platform: PlatformSlug): SocialAdapter {
  const a = registry.get(platform);
  if (!a) throw new UnknownPlatformError(platform);
  return a;
}

/** URL-routing helper for the direct-add flow. */
export function adapterForUrl(url: string): SocialAdapter {
  for (const a of registry.values()) {
    if (a.matchesUrl(url)) return a;
  }
  throw new UnsupportedUrlError(url);
}

export function listPlatforms(): PlatformSlug[] {
  return [...registry.keys()];
}

/**
 * Attach a logger to all registered adapters that support it.
 * Called once per request in the admin-ingest handler so each
 * adapter operation emits structured log lines with trace context.
 */
export function setAdapterLoggers(logger: AdapterLogger): void {
  for (const adapter of registry.values()) {
    if ('setLogger' in adapter && typeof (adapter as { setLogger?: unknown }).setLogger === 'function') {
      (adapter as { setLogger: (l: AdapterLogger) => void }).setLogger(logger);
    }
  }
}

/** Reset for testing — clears all registrations. */
export function _resetRegistry(): void {
  registry.clear();
}
