/**
 * Adapter-level structured logger for the social ingest pipeline.
 *
 * Each adapter operation (resolveAccount, listAuthorPosts, fetchPostByUrl)
 * logs start, success, and failure events with timing, platform, and
 * handle context. Output goes to the Worker's structured log (console.log
 * JSON lines) and is visible in Cloudflare Logpush / Real-time Logs.
 *
 * Adapters accept an optional `AdapterLogger` at construction. When absent
 * (tests, local dev), all logging is silently skipped — zero side effects.
 *
 * Traces: FR-59 (social ingest observability).
 */

export type AdapterLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AdapterLogEntry {
  event: string;
  level: AdapterLogLevel;
  platform: string;
  operation: string;
  durationMs?: number;
  handle?: string;
  url?: string;
  statusCode?: number;
  postCount?: number;
  error?: string;
  [extra: string]: unknown;
}

/**
 * Minimal logging surface that adapters use. The Worker wires up a real
 * implementation backed by `proxy/observability/log.ts`; tests pass nothing.
 */
export interface AdapterLogger {
  log(entry: AdapterLogEntry): void;
}

/**
 * Create a Worker-context logger that emits structured JSON lines.
 * Called once at adapter registration time, not per-request.
 */
export function createAdapterLogger(env: string, traceId?: string): AdapterLogger {
  return {
    log(entry: AdapterLogEntry) {
      const line = {
        ts: new Date().toISOString(),
        env,
        traceId: traceId ?? 'ingest',
        ...entry,
      };
      try {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(line));
      } catch {
        // Never throw from a logger.
      }
    },
  };
}

/**
 * Convenience: wrap an async adapter operation with start/success/error logging.
 */
export async function withAdapterLog<T>(
  logger: AdapterLogger | undefined,
  meta: { platform: string; operation: string; handle?: string; url?: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!logger) return fn();

  const start = Date.now();
  logger.log({
    event: 'ingest_adapter_start',
    level: 'debug',
    ...meta,
  });

  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    const extra: Record<string, unknown> = { durationMs };

    // Attach post count if result looks like a post list.
    if (result && typeof result === 'object' && 'posts' in result) {
      extra.postCount = (result as { posts: unknown[] }).posts.length;
    }

    logger.log({
      event: 'ingest_adapter_ok',
      level: 'info',
      ...meta,
      ...extra,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.log({
      event: 'ingest_adapter_error',
      level: 'error',
      ...meta,
      durationMs,
      error: message,
    });
    throw err;
  }
}
