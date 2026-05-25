/**
 * Runtime — resolves per-env config + builds the trio of clients
 * (D1, Congress, AuditLogger) that every CLI subcommand depends on.
 *
 * The CLI never reads env vars or constructs clients itself — it asks
 * `resolveRuntime({ env: 'uat' })` and gets back a fully-wired bundle.
 *
 * Tests don't call this; they build their own fake bundles directly.
 */

import { makeWranglerD1, type D1Like } from './d1-client';
import { makeRealCongressClient, type CongressClient } from './congress-client';
import { makeD1AuditLogger, type AuditLogger } from './audit-log';
import { makeCliLogger, type CliLogger } from './logger';

export type EnvName = 'dev' | 'uat' | 'stg' | 'prod';

const VALID_ENVS: ReadonlySet<EnvName> = new Set(['dev', 'uat', 'stg', 'prod']);

export interface RuntimeBundle {
  envName: EnvName;
  d1: D1Like;
  congressClient: CongressClient;
  auditLog: AuditLogger;
  logger: CliLogger;
  /** Whether the CLI is hitting a remote (deployed) D1 binding or the local one.
   *  Always remote for non-dev envs; defaults to local for dev. */
  remote: boolean;
}

export interface ResolveRuntimeOpts {
  env: string;
  /** Force remote D1 (overrides default-by-env). */
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

  // Default: remote for everything except dev, where we prefer the local
  // wrangler binding so iteration is fast and free.
  const remote = opts.remote ?? envName !== 'dev';

  const logger = makeCliLogger();
  const database = 'voter-info-d1';
  const d1 = makeWranglerD1({ database, env: envName, remote });
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

  return { envName, d1, congressClient, auditLog, logger, remote };
}
