/**
 * Runtime — resolves per-env config + builds the trio of clients
 * (D1, Congress, AuditLogger) that every CLI subcommand depends on.
 *
 * The CLI never reads env vars or constructs clients itself — it asks
 * `resolveRuntime({ env: 'uat' })` and gets back a fully-wired bundle.
 *
 * Tests don't call this; they build their own fake bundles directly.
 */

import { makeRestD1, type D1Like } from './d1-client';
import { makeRealCongressClient, type CongressClient } from './congress-client';
import { makeD1AuditLogger, type AuditLogger } from './audit-log';
import { makeCliLogger, type CliLogger } from './logger';

export type EnvName = 'dev' | 'uat' | 'stg' | 'prod';

const VALID_ENVS: ReadonlySet<EnvName> = new Set(['dev', 'uat', 'stg', 'prod']);

// Per-env KV namespace IDs — must match wrangler.toml + scripts/publish-to-kv.ts.
const KV_NAMESPACE_IDS: Record<EnvName, string> = {
  dev: '743b2feda53648cd8242d3b89538bfac',
  uat: '3756142363984d218d5f489151716b30',
  stg: '4ff9a8e54b82489fb9a300466bd68686',
  prod: '72d3dbce1a1d4ea4aec74b305d7995e6',
};

export interface RuntimeBundle {
  envName: EnvName;
  d1: D1Like;
  congressClient: CongressClient;
  auditLog: AuditLogger;
  /** Best-effort KV-key delete callback. Used by importBillCore + future
   *  per-resource invalidators to bust the stale projection after a write. */
  kvInvalidate: (key: string) => Promise<void>;
  logger: CliLogger;
  /** Whether the CLI is hitting the env's remote D1 binding (default) or
   *  the local wrangler binding (--local opt-in for dev iteration). */
  remote: boolean;
}

export interface ResolveRuntimeOpts {
  env: string;
  /** Whether to use the env's remote D1 binding (default: true, every env).
   *  Pass `false` (via CLI `--local`) for fast local iteration during dev.
   *  Environment-agnostic posture: the same code path runs against any env;
   *  this flag only changes the transport, not the orchestration logic. */
  remote?: boolean;
  /** Override the Congress API key (defaults to env var). */
  congressApiKey?: string;
}

export function resolveRuntime(opts: ResolveRuntimeOpts): RuntimeBundle {
  if (!VALID_ENVS.has(opts.env as EnvName)) {
    throw new Error(
      `resolveRuntime: env must be one of ${[...VALID_ENVS].join(', ')}, got '${opts.env}'`,
    );
  }
  const envName = opts.env as EnvName;

  const apiKey = opts.congressApiKey ?? process.env.CONGRESS_API_KEY ?? process.env.VITE_CONGRESS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'resolveRuntime: CONGRESS_API_KEY env var not set (or VITE_CONGRESS_API_KEY for local dev)',
    );
  }

  // Default: remote for every env (env-agnostic). The `remote` flag here is
  // a no-op now that the D1 transport uses the REST API; --local is no
  // longer supported in v4.1.0 (the wrangler-shell transport that backed it
  // had a fatal SQL-tokenization bug — see release-v4.1.0-rollout-log.md).
  // Local iteration is `npx wrangler d1 execute --local …` for ad-hoc SQL,
  // not via `lw bills seed`.
  const remote = opts.remote ?? true;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      'resolveRuntime: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars required for D1 REST access',
    );
  }

  const logger = makeCliLogger();
  const d1 = makeRestD1({ envName, accountId, apiToken });
  const congressClient = makeRealCongressClient({
    apiKey,
    // CLI is the ingest job — runs at the full Congress.gov ceiling of
    // 5,000/h. The token bucket honors Retry-After if the upstream pushes
    // back, so we self-throttle on actual 429s rather than leaving budget
    // unused. Worker bypasses this (per-request handlers shouldn't block
    // on a global token bucket).
    ratePerHour: 5000,
    maxRetries: 3,
    logger: {
      debug: (m) => logger.debug(m),
      verbose: (m) => logger.verbose(m),
      warn: (m) => logger.warn(m),
    },
  });
  const auditLog = makeD1AuditLogger(d1);
  const kvInvalidate = makeKvInvalidate(envName, logger);

  return { envName, d1, congressClient, auditLog, kvInvalidate, logger, remote };
}

/**
 * Build a best-effort KV-key delete callback using the Cloudflare REST API.
 *
 * Requires CLOUDFLARE_API_TOKEN (with KV:Edit scope) + CLOUDFLARE_ACCOUNT_ID
 * in env. If either is missing, returns a no-op that warns once at construct
 * time — the backfill still works (D1 truth is correct), KV just stays stale
 * until next `lw kv publish` run.
 *
 * Per-bill invalidation uses POST /bulk with single-item payload (instead of
 * DELETE /values/{key}) because the bulk API supports up to 10k keys per call
 * and gives us a consistent error-handling shape. For v4.1.0's 63-bill corpus
 * the difference is irrelevant; FR-60's 48k corpus benefits.
 */
function makeKvInvalidate(
  envName: EnvName,
  logger: CliLogger,
): (key: string) => Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = KV_NAMESPACE_IDS[envName];

  if (!token || !accountId) {
    logger.warn(
      'kvInvalidate: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing — KV invalidation will no-op. ' +
      "Backfill writes D1 correctly; run `lw kv publish --env " + envName + "` to repopulate KV.",
    );
    return async () => {};
  }

  return async (key: string) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
    try {
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok && resp.status !== 404) {
        // 404 = key didn't exist, which is fine.
        logger.warn(`kvInvalidate: ${key} → ${resp.status}`);
      } else {
        logger.debug(`kvInvalidate: ${key} → ${resp.status}`);
      }
    } catch (err) {
      logger.warn(`kvInvalidate: ${key} → ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
