/**
 * Roster lookup service. Reads the roster JSON either from:
 *   1. An explicit URL passed via `initRosters(url)` at boot time (production)
 *   2. A fallback empty map (dev / offline / before init)
 *
 * FR-24 AC-24.6: the roster JSON is served as a sibling file from R2 (not
 * inlined into the widget bundle) to keep the IIFE under 250KB gzipped. The
 * embed snippet provides an `assets-base` attribute; the widget fetches
 * `${assetsBase}/ukraineVotes.json` once on boot and caches it in-memory.
 *
 * In dev, if no assets-base is set, the rosters are fetched from the Vite
 * dev server (which serves src/data/ukraineVotes.json as a static asset).
 */

interface HouseRosterEntry {
  cast: string;
  party: string;
  state: string;
  first: string;
  last: string;
}

interface SenateRosterEntry {
  cast: string;
  party: string;
  first: string;
}

interface RostersFile {
  generatedAt: string;
  rosters: Record<string, Record<string, HouseRosterEntry | SenateRosterEntry>>;
}

let ROSTERS: RostersFile = { generatedAt: '', rosters: {} };
let initPromise: Promise<void> | null = null;

/**
 * Initialize the roster store by fetching the JSON file from the given URL.
 * Called once at widget boot. Subsequent calls reuse the in-flight promise.
 */
export function initRosters(url: string): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Roster file fetch ${res.status} from ${url}`);
      }
      const data = (await res.json()) as RostersFile;
      ROSTERS = data;
    })
    .catch((err) => {
      // Keep initPromise set so we don't retry. If rosters are missing, the
      // hook falls back to the network path (which still works — just slower).
      console.warn('[voter-info-widget] Failed to load rosters:', err);
    });
  return initPromise;
}

/** True once the roster file has loaded (or failed). */
export function rostersReady(): boolean {
  return ROSTERS.generatedAt !== '';
}

export function hasBundledRoster(
  chamber: 'House' | 'Senate',
  congress: number,
  session: number,
  rollCall: number,
): boolean {
  const key = `${chamber}|${congress}|${session}|${rollCall}`;
  return key in ROSTERS.rosters;
}

/**
 * House member's cast from the roster.
 *   undefined = roster not loaded yet OR vote not in bundled set (fall back to network)
 *   null      = roster loaded, member absent from roster (Did Not Serve)
 *   string    = their vote_cast
 */
export function bundledHouseCast(
  congress: number,
  session: number,
  rollCall: number,
  bioguideId: string,
): string | null | undefined {
  const key = `House|${congress}|${session}|${rollCall}`;
  const roster = ROSTERS.rosters[key];
  if (!roster) return undefined;
  const entry = roster[bioguideId];
  if (!entry) return null;
  return entry.cast;
}

export function bundledSenateCast(
  congress: number,
  session: number,
  rollCall: number,
  lastName: string,
  state: string,
): string | null | undefined {
  const key = `Senate|${congress}|${session}|${rollCall}`;
  const roster = ROSTERS.rosters[key];
  if (!roster) return undefined;
  const entry = roster[`${lastName}|${state}`];
  if (!entry) return null;
  return entry.cast;
}

export function rosterGeneratedAt(): string {
  return ROSTERS.generatedAt;
}
