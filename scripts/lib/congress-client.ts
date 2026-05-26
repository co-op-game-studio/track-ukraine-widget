/**
 * CongressClient — the interface every ingest job uses to talk to
 * api.congress.gov.
 *
 * Wraps fetch with: API-key injection, format=json default, per-request
 * tracing header, rate-limit budget enforcement, and 5xx-with-backoff.
 *
 * **Tests pass a fake implementation** (deterministic responses, no network).
 * **CLI passes a `makeRealCongressClient`** that talks to the live API.
 * **Worker code (eventually) passes the same makeRealCongressClient** —
 *   the dependency injection means both call sites share the impl.
 */

export interface CongressClient {
  /** GET /v3/<path> with api_key + format=json. Returns null on 404. Throws otherwise. */
  get<T>(path: string, traceId: string): Promise<T | null>;
}

export interface CongressClientOpts {
  apiKey: string;
  /** Sustained requests-per-hour ceiling. Default 0 (no rate-limit).
   *  CLI sets this to 2500 (50% of Congress.gov's 5000/h);
   *  Worker leaves it at 0 since it uses Workers Subrequest budget instead. */
  ratePerHour?: number;
  /** Maximum retries on 5xx + 429. Default 3. */
  maxRetries?: number;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override sleep (for tests). Defaults to setTimeout-based. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional verbose/debug logger. When provided:
   *   - debug: every request URL (api_key redacted) + status + ms + bytes
   *   - verbose (via event hook): retries + backoff waits + budget waits >100ms
   *   - warn: 429s + 5xx retries
   *  When absent: silent (Worker path). */
  logger?: {
    debug?: (msg: string) => void;
    verbose?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export function makeRealCongressClient(opts: CongressClientOpts): CongressClient {
  if (!opts.apiKey) throw new Error('CongressClient: apiKey is required');
  // Defaults are zeroed-out so the Worker path (which constructs this
  // client without explicit opts) gets pre-v4.1.0 behavior: no rate-limit,
  // no automatic retries. The CLI opts in to both via resolveRuntime().
  const ratePerHour = opts.ratePerHour ?? 0;
  const maxRetries = opts.maxRetries ?? 0;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const logger = opts.logger;

  // Token-bucket: spacing between requests. When ratePerHour=0, the budget
  // is effectively disabled (minSpacingMs = 0).
  const minSpacingMs = ratePerHour > 0 ? Math.ceil((60 * 60 * 1000) / ratePerHour) : 0;
  let nextEarliestRequestAt = 0;

  async function waitForBudget(): Promise<void> {
    if (minSpacingMs === 0) return;
    const now = Date.now();
    const wait = nextEarliestRequestAt - now;
    if (wait > 0) {
      if (wait > 100 && logger?.verbose) {
        logger.verbose(`rate-limit budget wait ${wait}ms`);
      }
      await sleep(wait);
    }
    nextEarliestRequestAt = Math.max(now, nextEarliestRequestAt) + minSpacingMs;
  }

  /** Redact the api_key from a URL for safe logging. */
  function redact(u: URL): string {
    const clone = new URL(u.toString());
    if (clone.searchParams.has('api_key')) clone.searchParams.set('api_key', 'REDACTED');
    return clone.toString();
  }

  return {
    async get<T>(path: string, traceId: string): Promise<T | null> {
      const url = new URL(`https://api.congress.gov/${path.replace(/^\//, '')}`);
      url.searchParams.set('api_key', opts.apiKey);
      if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');

      let attempt = 0;
      while (true) {
        await waitForBudget();
        const t0 = Date.now();
        const resp = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'lw-cli/4.1.0',
            'X-Trace-Id': traceId,
          },
        });
        const elapsedMs = Date.now() - t0;

        if (resp.status === 404) {
          logger?.debug?.(`GET ${redact(url)} → 404 (${elapsedMs}ms) trace=${traceId}`);
          return null;
        }
        if (resp.ok) {
          const text = await resp.text();
          logger?.debug?.(
            `GET ${redact(url)} → ${resp.status} (${elapsedMs}ms, ${text.length}B) trace=${traceId}`,
          );
          return JSON.parse(text) as T;
        }

        // 429 or 5xx → maybe retry.
        if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
          const retryAfter = resp.headers.get('Retry-After');
          const backoffMs = retryAfter
            ? Number(retryAfter) * 1000
            : Math.min(60_000, 1000 * 2 ** attempt);
          attempt++;
          logger?.warn?.(
            `GET ${redact(url)} → ${resp.status}, retry ${attempt}/${maxRetries} in ${backoffMs}ms trace=${traceId}`,
          );
          await sleep(backoffMs);
          continue;
        }

        // sanitize URL for the error message
        const sanitizedUrl = new URL(url.toString());
        sanitizedUrl.searchParams.delete('api_key');
        logger?.warn?.(
          `GET ${redact(url)} → ${resp.status} (final, ${elapsedMs}ms) trace=${traceId}`,
        );
        throw new Error(`congress_upstream_${resp.status} ${sanitizedUrl.pathname}`);
      }
    },
  };
}
