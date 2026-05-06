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
  socials?: {
    twitter?: string;
    youtube?: string;
    mastodon?: string;
    facebook?: string;
    instagram?: string;
    threads?: string;
    bluesky?: string;
  };
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
        // Pollable platforms — we automate (mastodon) or special-case (youtube).
        if (typeof entry.social.youtube === 'string') s.youtube = entry.social.youtube;
        if (typeof entry.social.youtube_id === 'string') youtubeChannelIds.set(bid, entry.social.youtube_id);
        if (typeof entry.social.mastodon === 'string') { s.mastodon = entry.social.mastodon; mastodonCount++; }
        // Display-only platforms — researchers use the link to open the
        // member's profile; we don't poll the API but voters need the link.
        if (typeof entry.social.twitter === 'string') s.twitter = entry.social.twitter;
        if (typeof entry.social.facebook === 'string') s.facebook = entry.social.facebook;
        if (typeof entry.social.instagram === 'string') s.instagram = entry.social.instagram;
        if (typeof entry.social.threads === 'string') s.threads = entry.social.threads;
        upstreamSocials.set(bid, s);
      }
    }
  } catch (err) {
    logEvent(logCtx, { event: 'ingest_seed_congress_fetch_error', level: 'warn', error: (err as Error).message });
  }

  // Upsert handles. Display-only platforms (twitter/x, facebook, instagram,
  // threads) get rows too — researchers see them on profile cards even
  // though there's no API adapter to poll them automatically.
  const platformMap: Record<string, string> = {
    youtube: 'youtube',
    mastodon: 'mastodon',
    twitter: 'twitter',
    facebook: 'facebook',
    instagram: 'instagram',
    threads: 'threads',
  };

  // Batch path. Previous version did ~6 sequential D1 calls per member
  // (one SELECT + one UPDATE/INSERT × 6 platforms × 535 members ≈ 3.2k
  // round trips), which blew through the Worker's 30s CPU budget. Now:
  //   1. One SELECT to load every active congress handle into memory.
  //   2. Build all decisions (insert vs update vs noop) in memory.
  //   3. Flush as D1 batches of ≤50 statements per round trip.
  type ExistingKey = string; // `${bioguideId}|${platform}|${handle}`
  const existingMap = new Map<ExistingKey, { id: string; platformId: string }>();
  try {
    const existingRes = await d1
      .prepare(
        `SELECT id, bioguide_id, platform, handle, platform_id
         FROM mocs_social_handles
         WHERE active_to IS NULL AND account_category = 'congress'`,
      )
      .all<{ id: string; bioguide_id: string; platform: string; handle: string; platform_id: string }>();
    for (const row of existingRes.results ?? []) {
      existingMap.set(`${row.bioguide_id}|${row.platform}|${row.handle}`, {
        id: row.id,
        platformId: row.platform_id,
      });
    }
  } catch (err) {
    logEvent(logCtx, { event: 'ingest_seed_handles_load_error', level: 'warn', error: (err as Error).message });
  }

  const now = new Date().toISOString();
  const updateStmt = d1.prepare(
    `UPDATE mocs_social_handles
     SET platform_id = ?, display_name = ?, entity_name = ?, updated_at = ?
     WHERE id = ?`,
  );
  const insertBatch: ReturnType<typeof d1.prepare>[] = [];
  const updateBatch: ReturnType<typeof d1.prepare>[] = [];

  for (const m of allMembers) {
    const upstream = upstreamSocials.get(m.bioguideId) ?? {};
    const kvSocials = m.socials ?? {};
    const merged: Record<string, string> = { ...kvSocials, ...upstream };
    for (const [key, handle] of Object.entries(merged)) {
      if (!handle) continue;
      const platform = platformMap[key];
      if (!platform) continue;
      let platformId = handle;
      if (platform === 'youtube') {
        const ytId = youtubeChannelIds.get(m.bioguideId);
        if (ytId) platformId = ytId;
      }
      const existing = existingMap.get(`${m.bioguideId}|${platform}|${handle}`);
      if (existing) {
        if (existing.platformId !== platformId) {
          updateBatch.push(updateStmt.bind(platformId, m.displayName, m.displayName, now, existing.id));
        }
        continue;
      }
      // Build the same row shape ingestStore.upsertHandle() would write
      // but as a batchable statement. Keep aligned with the migrations:
      //   id, bioguide_id, entity_name, account_category, platform,
      //   account_kind, handle, platform_id, display_name, source,
      //   active_from, created_at, updated_at
      const id = `h_${crypto.randomUUID()}`;
      insertBatch.push(
        d1.prepare(
          `INSERT INTO mocs_social_handles
           (id, bioguide_id, entity_name, account_category, platform, account_kind,
            handle, platform_id, display_name, source, active_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (platform, platform_id, active_from) DO NOTHING`,
        ).bind(
          id,
          m.bioguideId,
          m.displayName,
          'congress',
          platform,
          'official',
          handle,
          platformId,
          m.displayName,
          'congress-legislators',
          now,
          now,
          now,
        ),
      );
    }
  }

  // Flush in chunks of 50. CF D1 batch caps at ~100 statements; 50 keeps
  // headroom and gives finer progress logging if anything throws.
  const flushChunked = async (stmts: ReturnType<typeof d1.prepare>[]): Promise<number> => {
    let written = 0;
    for (let i = 0; i < stmts.length; i += 50) {
      const slice = stmts.slice(i, i + 50);
      try {
        await d1.batch(slice);
        written += slice.length;
      } catch (err) {
        logEvent(logCtx, { event: 'ingest_seed_handles_batch_error', level: 'warn', chunk: i, error: (err as Error).message });
      }
    }
    return written;
  };

  const inserted = await flushChunked(insertBatch);
  const updated = await flushChunked(updateBatch);
  const upserted = inserted + updated;
  logEvent(logCtx, { event: 'ingest_seed_handles_done', level: 'info', inserted, updated, members: allMembers.length });

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

    // Bulk-load existing bluesky handles upfront, then build all writes in
    // memory, then flush as D1 batches. Same pattern as the roster seed.
    const existingMap = new Map<string, string>(); // `${bioguide}|${handle}` → id
    try {
      const res = await d1
        .prepare(
          `SELECT id, bioguide_id, handle FROM mocs_social_handles
           WHERE platform = 'bluesky' AND active_to IS NULL`,
        )
        .all<{ id: string; bioguide_id: string; handle: string }>();
      for (const r of res.results ?? []) existingMap.set(`${r.bioguide_id}|${r.handle}`, r.id);
    } catch (err) {
      logEvent(logCtx, { event: 'ingest_seed_bluesky_load_error', level: 'warn', error: (err as Error).message });
    }

    const now = new Date().toISOString();
    const updateStmt = d1.prepare(
      `UPDATE mocs_social_handles
       SET display_name = ?, avatar_url = ?, entity_name = ?, updated_at = ?
       WHERE id = ?`,
    );
    const insertStmt = d1.prepare(
      `INSERT INTO mocs_social_handles
       (id, bioguide_id, entity_name, account_category, platform, account_kind,
        handle, platform_id, display_name, avatar_url, source, active_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, platform_id, active_from) DO NOTHING`,
    );
    const updateBatch: ReturnType<typeof d1.prepare>[] = [];
    const insertBatch: ReturnType<typeof d1.prepare>[] = [];
    let matched = 0;

    for (const item of allHandles) {
      const h = item.subject;
      const cleaned = (h.displayName ?? '')
        .replace(/^(rep\.|representative|sen\.|senator|congressman|congresswoman|u\.s\.\s*)/i, '')
        .replace(/\s*\(.*\)\s*$/, '')
        .replace(/,\s*(md|phd|ph\.d\.?|jr\.?|sr\.?|iii?|iv)$/i, '')
        .trim();

      let entry = nameMap.get(cleaned.toLowerCase());
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

      const existingId = existingMap.get(`${entry.bioguideId}|${h.handle}`);
      if (existingId) {
        updateBatch.push(updateStmt.bind(entry.displayName, h.avatar ?? null, entry.displayName, now, existingId));
      } else {
        const id = `h_${crypto.randomUUID()}`;
        insertBatch.push(insertStmt.bind(
          id,
          entry.bioguideId,
          entry.displayName,
          'congress',
          'bluesky',
          'official',
          h.handle,
          h.did,
          entry.displayName,
          h.avatar ?? null,
          'bluesky-starter-pack',
          now,
          now,
          now,
        ));
      }
      matched++;
    }

    const flushChunked = async (stmts: ReturnType<typeof d1.prepare>[]) => {
      for (let i = 0; i < stmts.length; i += 50) {
        try { await d1.batch(stmts.slice(i, i + 50)); }
        catch (err) { logEvent(logCtx, { event: 'ingest_seed_bluesky_batch_error', level: 'warn', chunk: i, error: (err as Error).message }); }
      }
    };
    await flushChunked(insertBatch);
    await flushChunked(updateBatch);

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
  const now = new Date().toISOString();

  // Bulk-load existing bill_ids in one query, then build all inserts in
  // memory, then flush as D1 batches. Same pattern as handle seeding.
  const existing = new Set<string>();
  try {
    const res = await d1
      .prepare('SELECT bill_id FROM bills')
      .all<{ bill_id: string }>();
    for (const r of res.results ?? []) existing.add(r.bill_id);
  } catch (err) {
    logEvent(logCtx, { event: 'ingest_seed_bills_load_error', level: 'warn', error: (err as Error).message });
  }

  const insertStmt = d1.prepare(
    `INSERT INTO bills (
      id, bill_id, congress, type, number, featured, label, title,
      latest_action, latest_action_date, became_law, congress_gov_url,
      direction, direction_reason, summary_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bill_id) DO NOTHING`,
  );
  const inserts: ReturnType<typeof d1.prepare>[] = [];
  let already = 0;
  for (const b of list) {
    const billId = `${b.congress}-${b.type.toUpperCase()}-${b.number}`;
    if (existing.has(billId)) { already++; continue; }
    const id = `bill_${billId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
    inserts.push(
      insertStmt.bind(
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
      ),
    );
  }

  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 50) {
    const slice = inserts.slice(i, i + 50);
    try {
      await d1.batch(slice);
      inserted += slice.length;
    } catch (err) {
      logEvent(logCtx, { event: 'ingest_seed_bill_stub_batch_error', level: 'warn', chunk: i, error: (err as Error).message });
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
