/**
 * Admin SPA hook — fetches the live platform-availability map from the
 * backend. Source of truth for "which platform toggles to render" across
 * the Inbox poll panel, the people-tab handle editor, the research view,
 * and any future surface that needs a platform list.
 *
 * Backend `/api/admin/ingest/platforms` runs each adapter's healthCheck()
 * and caches for 5 min, so this hook is cheap to call from many places.
 *
 * Returns an empty array while loading so callers can render gated UIs
 * (disabled toggles, "(checking…)" badges) without flickering.
 */
import { useEffect, useState } from 'react';
import { get } from '../fetcher';

export interface PlatformLiveness {
  slug: string;
  available: boolean;
  bulkEligible: boolean;
  error?: string;
  checkedAt: string;
}

let cache: PlatformLiveness[] | null = null;
let inflight: Promise<PlatformLiveness[]> | null = null;

async function fetchOnce(): Promise<PlatformLiveness[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = get<{ platforms: PlatformLiveness[] }>('/api/admin/ingest/platforms')
    .then((r) => {
      cache = r.platforms;
      return r.platforms;
    })
    .catch(() => {
      // Surface as empty so the UI degrades to "no platforms available"
      // (which is honest) rather than guessing.
      cache = [];
      return [];
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Force a refetch (e.g. operator just rotated a token). */
export function invalidatePlatformsCache(): void {
  cache = null;
}

export function useAvailablePlatforms(): PlatformLiveness[] {
  const [platforms, setPlatforms] = useState<PlatformLiveness[]>(cache ?? []);
  useEffect(() => {
    let cancelled = false;
    fetchOnce().then((p) => { if (!cancelled) setPlatforms(p); });
    return () => { cancelled = true; };
  }, []);
  return platforms;
}
