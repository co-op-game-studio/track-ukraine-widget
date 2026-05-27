/**
 * AuditLogger — writes one structured row to D1 `audit_log` per operation.
 *
 * The runtime stack (admin SPA's Data Freshness panel, ad-hoc queries)
 * observes ingest activity by reading these rows. That's the entire contract
 * between the build-time CLI and the runtime UI.
 *
 * **Tests pass an in-memory fake** (captures calls, asserts shape).
 * **CLI passes a D1-backed implementation.**
 *
 * Per memory `feedback_tracing_everywhere_backend`: every write carries a
 * `trace_id` so logs and audit rows correlate.
 */

import type { D1Like } from './d1-client';

export interface AuditEvent {
  /** What happened. Conventionally `<verb>_<resource>[_<outcome>]`,
   *  e.g. `bill_backfill_error`, `bill_imported`, `direction_corrected`. */
  action: string;
  /** Who/what initiated. `ci@backfill`, `v4.1.0@release`, an email, etc. */
  actorEmail: string;
  /** Table the event pertains to (e.g. `bills`, `votes`). */
  targetTable: string;
  /** PK or natural ID of the row (e.g. `118-HR-815`). */
  rowId: string;
  /** Human-readable title for fast scanning in the audit feed. */
  rowTitle?: string | null;
  /** Free-text rationale or error message. */
  reason?: string | null;
  /** Pre-image of the row, JSON-encoded. Null on create. */
  beforeJson?: string | null;
  /** Post-image of the row, JSON-encoded. Null on delete. */
  afterJson?: string | null;
  /** Trace ID for correlation with structured logs. */
  traceId: string;
}

export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                       D1-backed implementation                             */
/* -------------------------------------------------------------------------- */

import { generateTraceId } from './trace';

/**
 * Standard implementation: writes to `audit_log` table.
 *
 * The table schema is established in `migrations/d1/0001_init.sql` and
 * extended over time. This logger writes the canonical column set; if the
 * schema gets new optional columns later they default to NULL.
 */
export function makeD1AuditLogger(d1: D1Like): AuditLogger {
  return {
    async log(event: AuditEvent): Promise<void> {
      const id = `audit_${generateTraceId().slice(3)}`;
      await d1
        .prepare(
          `INSERT INTO audit_log (
             id, actor_email, action, target_table, row_id, row_title,
             before_json, after_json, reason, trace_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          event.actorEmail,
          event.action,
          event.targetTable,
          event.rowId,
          event.rowTitle ?? null,
          event.beforeJson ?? null,
          event.afterJson ?? null,
          event.reason ?? null,
          event.traceId,
          new Date().toISOString(),
        )
        .run();
    },
  };
}
