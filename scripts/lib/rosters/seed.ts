/**
 * seedRosters — pure orchestrator for "for every curated roll-call in D1
 * `votes`, fetch the member casts from upstream and store them durably in
 * D1 `vote_casts`." Mirrors scripts/lib/bills/seed.ts.
 *
 * Source of truth for WHICH roll-calls to seed is the D1 `votes` table
 * (SELECT DISTINCT chamber, congress, session, roll_call). Idempotent: each
 * roll-call's casts are replaced wholesale (delete-then-insert) so a re-run
 * against unchanged upstream yields the same rows. Per-roll-call failures are
 * logged to audit_log and do NOT abort the run.
 *
 * Traces to: FR-32 AC-32.36, AC-32.38.
 */
import type { D1Like } from '../d1-client';
import type { AuditLogger } from '../audit-log';
import type { CliLogger } from '../logger';
import type { CastFetchers } from './fetch-casts';
import { generateTraceId } from '../trace';

export interface RollCallRef {
  chamber: string; // 'House' | 'Senate'
  congress: number;
  session: number;
  roll_call: number;
}

export interface SeedRostersInput {
  d1: D1Like;
  fetchers: CastFetchers;
  auditLog: AuditLogger;
  logger: CliLogger;
  concurrency?: number;
  actorEmail?: string;
  /** Make `id`s deterministic in tests (default: ULID-ish from trace + index). */
  idFor?: (ref: RollCallRef, i: number) => string;
}

export interface SeedRostersResult {
  processed: number;
  ok: number;
  failed: number;
  castsWritten: number;
  errors: Array<{ rollCall: string; error: string; traceId: string }>;
  durationMs: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ACTOR = 'ci@seed';

function rollCallId(ref: RollCallRef): string {
  return `${ref.chamber.toLowerCase()}:${ref.congress}:${ref.session}:${ref.roll_call}`;
}

export async function seedRosters(input: SeedRostersInput): Promise<SeedRostersResult> {
  const t0 = Date.now();
  const {
    d1, fetchers, auditLog, logger,
    concurrency = DEFAULT_CONCURRENCY,
    actorEmail = DEFAULT_ACTOR,
    idFor,
  } = input;

  // 1. Work list: distinct curated roll-calls from the votes table.
  const queryRes = await d1
    .prepare('SELECT DISTINCT chamber, congress, session, roll_call FROM votes ORDER BY chamber, congress, session, roll_call')
    .all<RollCallRef>();
  const rolls = queryRes.results ?? [];
  logger.info(`rosters seed start: ${rolls.length} roll-calls, concurrency=${concurrency}`);

  const result: SeedRostersResult = {
    processed: 0, ok: 0, failed: 0, castsWritten: 0, errors: [], durationMs: 0,
  };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < rolls.length) {
      const ref = rolls[cursor++]!;
      const traceId = generateTraceId();
      const rcId = rollCallId(ref);
      const isHouse = ref.chamber.toLowerCase() === 'house';
      try {
        const now = new Date().toISOString();
        const rows: Array<{ id: string; bioguideId: string | null; lastName: string | null; firstName: string | null; state: string | null; party: string | null; cast: string }> = [];

        if (isHouse) {
          const casts = await fetchers.fetchHouse(ref.congress, ref.session, ref.roll_call);
          (casts ?? []).forEach((c, i) => rows.push({
            id: idFor ? idFor(ref, i) : `${rcId}:${c.bioguideId}`,
            bioguideId: c.bioguideId, lastName: null, firstName: null, state: null, party: null, cast: c.cast,
          }));
        } else {
          const casts = await fetchers.fetchSenate(ref.congress, ref.session, ref.roll_call);
          (casts ?? []).forEach((c, i) => rows.push({
            id: idFor ? idFor(ref, i) : `${rcId}:${c.lastName}:${c.state}`,
            bioguideId: null, lastName: c.lastName, firstName: c.firstName ?? null, state: c.state, party: c.party ?? null, cast: c.cast,
          }));
        }

        // Idempotent: replace this roll-call's casts wholesale.
        const stmts = [
          d1.prepare('DELETE FROM vote_casts WHERE chamber = ? AND congress = ? AND session = ? AND roll_call = ?')
            .bind(ref.chamber, ref.congress, ref.session, ref.roll_call),
          ...rows.map((r) =>
            d1.prepare(
              `INSERT INTO vote_casts
                 (id, chamber, congress, session, roll_call, bioguide_id, last_name, first_name, state, party, cast, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              r.id, ref.chamber, ref.congress, ref.session, ref.roll_call,
              r.bioguideId, r.lastName, r.firstName, r.state, r.party, r.cast, now, now,
            ),
          ),
        ];
        await d1.batch(stmts);
        result.ok++;
        result.castsWritten += rows.length;
        logger.info(`[rosters] ${rcId} ok ${rows.length} casts`);
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ rollCall: rcId, error: message, traceId });
        logger.error(`[rosters] ${rcId} FAILED trace=${traceId}: ${message}`);
        try {
          await auditLog.log({
            action: 'roster_seed_error', actorEmail, targetTable: 'vote_casts',
            rowId: rcId, reason: message, traceId,
          });
        } catch { /* best-effort */ }
      } finally {
        result.processed++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(rolls.length, 1)) }, () => worker());
  await Promise.all(workers);

  result.durationMs = Date.now() - t0;
  logger.info(
    `rosters seed done: processed=${result.processed} ok=${result.ok} failed=${result.failed} casts=${result.castsWritten} ${(result.durationMs / 1000).toFixed(1)}s`,
  );
  return result;
}
