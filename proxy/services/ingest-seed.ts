/**
 * Auto-seed for the social ingest roster — runs on cron, not by button click.
 *
 * Three data sources, all idempotent (upsert with ON CONFLICT):
 *   1. congress-legislators  — YouTube, Facebook, Instagram, Mastodon handles
 *   2. Bluesky starter pack  — ~120 MoC Bluesky handles
 *   3. Ukraine keywords      — 12 default keyword watches
 *
 * The cron calls `ensureIngestSeeded` every tick. It's cheap when data
 * already exists — a single COUNT(*) query short-circuits if the roster
 * is already populated. A full re-sync can be forced via the admin API
 * or by the `force` flag.
 *
 * Traces: FR-59 (social ingest infrastructure).
 */
import type { ProxyEnv } from '../env';
import type { D1Like } from '../env';
import { KV_PREFIXES } from '../kv/prefixes';
import type { NameIndexEntry } from '../kv/name-index';
import * as ingestStore from '../d1/ingest-store';
import { logEvent } from '../observability/log';
// Static curated bill list — D1 truth; KV is the cache.
import ukraineBills from '../../src/data/ukraineBills.json';

/* ---------- Result type ---------- */

export interface SeedResult {
  roster: { membersScanned: number; handlesUpserted: number; mastodon: number; bluesky: number };
  keywords: { seeded: number };
  bills: { stubsInserted: number; alreadyPresent: number };
  youtubeResolved?: number;
  skipped: boolean;
}

/* ---------- Constants ---------- */

const UKRAINE_KEYWORDS = [
  { watchName: 'Ukraine (core)', pattern: 'ukraine|ukrainian|kyiv|zelensky|zelenskyy', isRegex: true },
  { watchName: 'Russia/Putin', pattern: 'russia|russian|putin|kremlin|moscow', isRegex: true },
  { watchName: 'NATO', pattern: 'nato|north atlantic treaty', isRegex: true },
  { watchName: 'Military aid', pattern: 'military aid|arms shipment|weapons package|defense package|security assistance', isRegex: true },
  { watchName: 'HIMARS/Weapons', pattern: 'himars|javelin|patriot missile|abrams|f-16|atacms|cluster munition', isRegex: true },
  { watchName: 'Sanctions', pattern: 'sanctions?\\b.*(?:russia|putin|oligarch)|oligarch.*sanctions?', isRegex: true },
  { watchName: 'Foreign aid', pattern: 'foreign aid|foreign assistance|supplemental funding|aid package', isRegex: true },
  { watchName: 'Crimea/Donbas', pattern: 'crimea|donbas|donetsk|luhansk|kherson|zaporizhzhia|mariupol', isRegex: true },
  { watchName: 'War crimes', pattern: 'war crimes?|icc|international criminal court|bucha|genocide', isRegex: true },
  { watchName: 'Lend-Lease', pattern: 'lend.lease|lend lease', isRegex: true },
  { watchName: 'Grain/Food', pattern: 'grain deal|black sea grain|food security.*ukraine', isRegex: true },
  { watchName: 'Nuclear threat', pattern: 'nuclear.*(?:russia|ukraine|threat|weapon)|dirty bomb', isRegex: true },
] as const;

const BSKY_PACK_AUTHOR = 'maxberger.bsky.social';
const BSKY_PACK_RKEY = '3laptkr7stu2c';
const BSK_API = 'https://public.api.bsky.app/xrpc';
const CONGRESS_SOCIALS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-social-media.json';

const SEED_ACTOR = 'auto-seed@system';

/* ---------- Main entry point ---------- */

/**
 * Ensure the ingest roster, Bluesky handles, and keywords are populated.
 * Idempotent — skips if data already exists (unless `force` is true).
 */
export async function ensureIngestSeeded(
  env: ProxyEnv,
  opts?: { force?: boolean },
): Promise<SeedResult> {
  const traceId = `seed-${Math.random().toString(36).slice(2, 10)}`;
  const envLabel = env.ENV_NAME ?? 'prod';
  const logCtx = { env: envLabel, traceId };
  const d1 = env.D1_VOTER_INFO;
  const kv = env.KV_VOTER_INFO;

  if (!d1 || !kv) {
    logEvent(logCtx, { event: 'ingest_seed_skipped', level: 'warn', reason: !d1 ? 'no_d1' : 'no_kv' });
    return { roster: { membersScanned: 0, handlesUpserted: 0, mastodon: 0, bluesky: 0 }, keywords: { seeded: 0 }, bills: { stubsInserted: 0, alreadyPresent: 0 }, skipped: true };
  }

  // The seed always runs — it uses check-then-update-or-insert, so it's
  // idempotent and cheap when data is already correct.  The old "skip if
  // >100 rows" guard prevented platform_id corrections (e.g. YouTube
  // channel IDs) from ever propagating after the initial seed.

  logEvent(logCtx, { event: 'ingest_seed_start', level: 'info', force: !!opts?.force });

  // 1. Seed roster from KV + congress-legislators upstream
  const rosterResult = await seedRosterFromSources(d1, kv, logCtx);

  // 2. Seed Bluesky from starter pack
  const bskyResult = await seedBlueskyHandles(d1, kv, logCtx);

  // 3. Seed keywords
  const kwResult = await seedKeywords(d1, logCtx);

  // 3b. Seed Ukraine bill stubs (D1 = source of truth). Stubs are minimal
  //     rows from src/data/ukraineBills.json; full Congress.gov enrichment
  //     happens via the backfill loop on the admin SPA's first auth.
  const billResult = await seedUkraineBillStubs(d1, logCtx);

  // 4. Resolve unresolved YouTube platform_ids via YouTube Data API.
  //    Runs inline but is capped at 50 handles per tick. Errors are
  //    non-fatal — unresolved handles will be retried on the next tick.
  let ytResolved = 0;
  if (env.YOUTUBE_API_KEY) {
    try {
      ytResolved = await resolveYouTubeChannelIds(d1, env.YOUTUBE_API_KEY, logCtx);
    } catch (e) {
      logEvent(logCtx, { event: 'youtube_resolve_error', level: 'warn', error: (e as Error).message });
    }
  }

  const result: SeedResult = {
    roster: {
      membersScanned: rosterResult.membersScanned,
      handlesUpserted: rosterResult.upserted,
      mastodon: rosterResult.mastodon,
      bluesky: bskyResult.matched,
    },
    keywords: { seeded: kwResult },
    bills: billResult,
    youtubeResolved: ytResolved,
    skipped: false,
  };

  logEvent(logCtx, { event: 'ingest_seed_done', level: 'info', ...result });
  return result;
}

/* ---------- Roster seeding ---------- */

interface NameEntryWithSocials extends NameIndexEntry {
  socials?: { twitter?: string; youtube?: string; mastodon?: string };
}

interface CongressLegSocial {
  id?: { bioguide?: string };
  social?: Record<string, unknown>;
}

async function seedRosterFromSources(
  d1: D1Like,
  kv: ProxyEnv['KV_VOTER_INFO'],
  logCtx: { env: string; traceId: string },
) {
  // Load KV name-index shards for member metadata.
  const allMembers: NameEntryWithSocials[] = [];
  const seen = new Set<string>();
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  for (const letter of letters) {
    const raw = await kv.get(KV_PREFIXES.nameIndex + letter, 'text') as string | null;
    if (!raw) continue;
    const shard = JSON.parse(raw) as { entries: NameEntryWithSocials[] };
    for (const entry of shard.entries) {
      if (seen.has(entry.bioguideId)) continue;
      seen.add(entry.bioguideId);
      allMembers.push(entry);
    }
  }

  // Fetch congress-legislators social-media JSON directly for mastodon
  // handles (and as authoritative source for all platforms).
  // Also extracts youtube_id (real UC... channel IDs) so YouTube polls work.
  const upstreamSocials = new Map<string, Record<string, string>>();
  const youtubeChannelIds = new Map<string, string>();
  let mastodonCount = 0;
  try {
    const res = await fetch(CONGRESS_SOCIALS_URL);
    if (res.ok) {
      const body = (await res.json()) as CongressLegSocial[];
      for (const entry of body) {
        const bid = entry.id?.bioguide;
        if (!bid || !entry.social) continue;
        const s: Record<string, string> = {};
        if (typeof entry.social.youtube === 'string') s.youtube = entry.social.youtube;
        if (typeof entry.social.youtube_id === 'string') youtubeChannelIds.set(bid, entry.social.youtube_id);
        if (typeof entry.social.mastodon === 'string') { s.mastodon = entry.social.mastodon; mastodonCount++; }
        upstreamSocials.set(bid, s);
      }
    }
  } catch (err) {
    logEvent(logCtx, { event: 'ingest_seed_congress_fetch_error', level: 'warn', error: (err as Error).message });
  }

  // Upsert handles.
  let upserted = 0;
  const platformMap: Record<string, string> = { youtube: 'youtube', mastodon: 'mastodon' };

  for (const m of allMembers) {
    const upstream = upstreamSocials.get(m.bioguideId) ?? {};
    const kvSocials = m.socials ?? {};
    const merged: Record<string, string> = { ...kvSocials, ...upstream };

    for (const [key, handle] of Object.entries(merged)) {
      if (!handle) continue;
      const platform = platformMap[key];
      if (!platform) continue;

      // For YouTube: use the real channel ID (UC...) as platformId when available,
      // so the YouTube search API works without an extra resolve call.
      let platformId = handle;
      if (platform === 'youtube') {
        const ytId = youtubeChannelIds.get(m.bioguideId);
        if (ytId) platformId = ytId;
      }

      // Check if an active row already exists for this member + platform + handle.
      // The UNIQUE constraint is (platform, platform_id, active_from) which changes
      // daily, so a blind upsert creates duplicates on each re-sync.  Instead: if
      // the row exists, update it in place; otherwise insert.
      try {
        const existing = await d1
          .prepare(
            `SELECT id, platform_id FROM mocs_social_handles
             WHERE bioguide_id = ? AND platform = ? AND handle = ? AND active_to IS NULL
             LIMIT 1`,
          )
          .bind(m.bioguideId, platform, handle)
          .first<{ id: string; platform_id: string }>();

        if (existing) {
          // Update metadata + platform_id if it changed (e.g. youtube_id now available).
          await d1
            .prepare(
              `UPDATE mocs_social_handles
               SET platform_id = ?, display_name = ?, entity_name = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(platformId, m.displayName, m.displayName, new Date().toISOString(), existing.id)
            .run();
        } else {
          await ingestStore.upsertHandle(d1, {
            bioguideId: m.bioguideId,
            entityName: m.displayName,
            accountCategory: 'congress',
            platform,
            accountKind: 'official',
            handle,
            platformId,
            displayName: m.displayName,
            source: 'congress-legislators',
          });
        }
        upserted++;
      } catch { /* constraint or other — skip */ }
    }
  }

  return { membersScanned: allMembers.length, upserted, mastodon: mastodonCount };
}

/* ---------- Bluesky starter pack seeding ---------- */

async function seedBlueskyHandles(
  d1: D1Like,
  kv: ProxyEnv['KV_VOTER_INFO'],
  logCtx: { env: string; traceId: string },
) {
  try {
    // Resolve pack author DID.
    const resolveRes = await fetch(`${BSK_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(BSKY_PACK_AUTHOR)}`);
    if (!resolveRes.ok) throw new Error(`Resolve failed: ${resolveRes.status}`);
    const { did: authorDid } = (await resolveRes.json()) as { did: string };

    // Get starter pack list URI.
    const packUri = `at://${authorDid}/app.bsky.graph.starterpack/${BSKY_PACK_RKEY}`;
    const packRes = await fetch(`${BSK_API}/app.bsky.graph.getStarterPack?starterPack=${encodeURIComponent(packUri)}`);
    if (!packRes.ok) throw new Error(`Pack fetch failed: ${packRes.status}`);
    const packData = (await packRes.json()) as { starterPack: { list: { uri: string } } };
    const listUri = packData.starterPack.list.uri;

    // Paginate list members.
    interface BskyListItem { subject: { handle: string; displayName?: string; did: string; avatar?: string } }
    const allHandles: BskyListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      let listUrl = `${BSK_API}/app.bsky.graph.getList?list=${encodeURIComponent(listUri)}&limit=100`;
      if (cursor) listUrl += `&cursor=${encodeURIComponent(cursor)}`;
      const listRes = await fetch(listUrl);
      if (!listRes.ok) break;
      const listData = (await listRes.json()) as { items?: BskyListItem[]; cursor?: string };
      if (listData.items) allHandles.push(...listData.items);
      cursor = listData.cursor;
      if (!cursor) break;
    }

    // Build name lookup from KV.
    interface NameEntryLite extends NameIndexEntry { socials?: Record<string, string | undefined> }
    const nameMap = new Map<string, NameEntryLite>();
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    for (const letter of letters) {
      const raw = await kv.get(KV_PREFIXES.nameIndex + letter, 'text') as string | null;
      if (!raw) continue;
      const shard = JSON.parse(raw) as { entries: NameEntryLite[] };
      for (const entry of shard.entries) {
        const normFull = `${entry.first} ${entry.last}`.toLowerCase();
        nameMap.set(normFull, entry);
        nameMap.set(entry.bioguideId.toLowerCase(), entry);
      }
    }

    // Match and upsert.
    let matched = 0;
    for (const item of allHandles) {
      const h = item.subject;
      const cleaned = (h.displayName ?? '')
        .replace(/^(rep\.|representative|sen\.|senator|congressman|congresswoman|u\.s\.\s*)/i, '')
        .replace(/\s*\(.*\)\s*$/, '')
        .replace(/,\s*(md|phd|ph\.d\.?|jr\.?|sr\.?|iii?|iv)$/i, '')
        .trim();

      let entry = nameMap.get(cleaned.toLowerCase());

      // Try last name only if unambiguous.
      if (!entry) {
        const parts = cleaned.split(/\s+/);
        const lastName = parts[parts.length - 1]?.toLowerCase() ?? '';
        let candidate: NameEntryLite | undefined;
        let ambiguous = false;
        for (const [key, e] of nameMap.entries()) {
          if (key === `${e.first} ${e.last}`.toLowerCase() && e.last.toLowerCase() === lastName) {
            if (!candidate) { candidate = e; } else { ambiguous = true; break; }
          }
        }
        if (!ambiguous) entry = candidate;
      }

      if (!entry) continue;

      try {
        // Check for existing active row to avoid duplicates across re-syncs.
        const existing = await d1
          .prepare(
            `SELECT id FROM mocs_social_handles
             WHERE bioguide_id = ? AND platform = 'bluesky' AND handle = ? AND active_to IS NULL
             LIMIT 1`,
          )
          .bind(entry.bioguideId, h.handle)
          .first<{ id: string }>();

        if (existing) {
          await d1
            .prepare(
              `UPDATE mocs_social_handles
               SET display_name = ?, avatar_url = ?, entity_name = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(entry.displayName, h.avatar ?? null, entry.displayName, new Date().toISOString(), existing.id)
            .run();
        } else {
          await ingestStore.upsertHandle(d1, {
            bioguideId: entry.bioguideId,
            entityName: entry.displayName,
            accountCategory: 'congress',
            platform: 'bluesky',
            accountKind: 'official',
            handle: h.handle,
            platformId: h.did,
            displayName: entry.displayName,
            avatarUrl: h.avatar,
            source: 'bluesky-starter-pack',
          });
        }
        matched++;
      } catch { /* constraint — skip */ }
    }

    return { totalInPack: allHandles.length, matched };
  } catch (err) {
    logEvent(logCtx, { event: 'ingest_seed_bluesky_error', level: 'warn', error: (err as Error).message });
    return { totalInPack: 0, matched: 0 };
  }
}

/* ---------- Keyword seeding ---------- */

async function seedKeywords(
  d1: D1Like,
  logCtx: { env: string; traceId: string },
): Promise<number> {
  // Check if keywords already exist.
  const existing = await ingestStore.listKeywordWatches(d1, false);
  if (existing.length > 0) return 0; // Already seeded.

  let created = 0;
  for (const kw of UKRAINE_KEYWORDS) {
    try {
      await ingestStore.createKeywordWatch(d1, {
        watchName: kw.watchName,
        pattern: kw.pattern,
        isRegex: kw.isRegex,
        createdBy: SEED_ACTOR,
      });
      created++;
    } catch { /* dupe or other — skip */ }
  }

  logEvent(logCtx, { event: 'ingest_seed_keywords_created', level: 'info', created, total: UKRAINE_KEYWORDS.length });
  return created;
}

/* ---------- Ukraine bill stubs (D1 = source of truth) ---------- */

interface UkraineBillEntry {
  congress: number;
  type: string;
  number: string | number;
  featured?: boolean;
  label?: string;
  title?: string;
  latestAction?: string;
  latestActionDate?: string;
  becameLaw?: boolean;
  congressGovUrl?: string;
  direction: string;
  directionReason?: string;
  summary?: unknown;
}

/**
 * Insert a stub row in `bills` for every entry in src/data/ukraineBills.json.
 * Idempotent — rows already present are left untouched (researcher edits
 * preserved). Full Congress.gov enrichment (votes, cosponsors, actions)
 * happens via the backfill loop kicked off by useAutoBackfill on the SPA.
 */
async function seedUkraineBillStubs(
  d1: D1Like,
  logCtx: { env: string; traceId: string },
): Promise<{ stubsInserted: number; alreadyPresent: number }> {
  const list = ukraineBills as unknown as UkraineBillEntry[];
  let inserted = 0;
  let already = 0;
  const now = new Date().toISOString();
  for (const b of list) {
    const billId = `${b.congress}-${b.type.toUpperCase()}-${b.number}`;
    const existing = await d1
      .prepare('SELECT id FROM bills WHERE bill_id = ?')
      .bind(billId)
      .first<{ id: string }>();
    if (existing) {
      already++;
      continue;
    }
    const id = `bill_${billId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
    try {
      await d1
        .prepare(
          `INSERT INTO bills (
            id, bill_id, congress, type, number, featured, label, title,
            latest_action, latest_action_date, became_law, congress_gov_url,
            direction, direction_reason, summary_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          billId,
          b.congress,
          b.type.toUpperCase(),
          String(b.number),
          b.featured ? 1 : 0,
          b.label ?? null,
          b.title ?? `${b.type.toUpperCase()} ${b.number} (${b.congress}th)`,
          b.latestAction ?? null,
          b.latestActionDate ?? null,
          b.becameLaw ? 1 : 0,
          b.congressGovUrl ?? null,
          b.direction,
          b.directionReason ?? 'manual override',
          b.summary ? JSON.stringify(b.summary) : null,
          now,
          now,
        )
        .run();
      inserted++;
    } catch (err) {
      logEvent(logCtx, { event: 'ingest_seed_bill_stub_error', level: 'warn', billId, error: (err as Error).message });
    }
  }
  logEvent(logCtx, { event: 'ingest_seed_bill_stubs_done', level: 'info', inserted, already, total: list.length });
  return { stubsInserted: inserted, alreadyPresent: already };
}

/* ---------- YouTube channel ID resolution ---------- */

const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Find YouTube handles whose platform_id is NOT a UC... channel ID and
 * resolve them via the YouTube Data API.  Updates the row in-place.
 *
 * Uses /channels?forHandle (1 unit) and /channels?forUsername (1 unit) —
 * avoids the expensive /search endpoint (100 units).  Capped at 50 per
 * seed tick to stay within the 10k daily quota.
 */
export async function resolveYouTubeChannelIds(
  d1: D1Like,
  apiKey: string,
  logCtx: { env: string; traceId: string },
): Promise<number> {
  // Find handles where platform_id doesn't start with UC (unresolved).
  const rows = await d1
    .prepare(
      `SELECT id, handle, platform_id FROM mocs_social_handles
       WHERE platform = 'youtube' AND active_to IS NULL
         AND platform_id NOT LIKE 'UC%'
       LIMIT 50`,
    )
    .all<{ id: string; handle: string; platform_id: string }>();

  const unresolved = rows.results ?? [];
  if (unresolved.length === 0) return 0;

  let resolved = 0;
  for (const row of unresolved) {
    const handle = row.handle.replace(/^@/, '');
    let channelId: string | null = null;

    // Try forHandle (@-style).
    try {
      const res = await fetch(
        `${YT_API}/channels?part=snippet&forHandle=${encodeURIComponent(`@${handle}`)}&key=${apiKey}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { items?: Array<{ id: string }> };
        if (data.items?.length) channelId = data.items[0]!.id;
      }
    } catch { /* continue to fallback */ }

    // Try forUsername (old-style, no @ prefix).
    if (!channelId) {
      try {
        const res = await fetch(
          `${YT_API}/channels?part=snippet&forUsername=${encodeURIComponent(handle)}&key=${apiKey}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { items?: Array<{ id: string }> };
          if (data.items?.length) channelId = data.items[0]!.id;
        }
      } catch { /* skip */ }
    }

    if (channelId && channelId.startsWith('UC')) {
      await d1
        .prepare(
          `UPDATE mocs_social_handles SET platform_id = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(channelId, new Date().toISOString(), row.id)
        .run();
      resolved++;
    }
  }

  if (resolved > 0) {
    logEvent(logCtx, {
      event: 'youtube_channel_ids_resolved',
      level: 'info',
      attempted: unresolved.length,
      resolved,
    });
  }

  return resolved;
}
