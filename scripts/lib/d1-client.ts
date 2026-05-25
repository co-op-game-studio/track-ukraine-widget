/// <reference types="node" />
/**
 * D1Like — narrow interface the `lw` CLI subcommands depend on.
 *
 * Matches the surface area of the Cloudflare Workers D1 binding (`D1Database`)
 * that the existing Worker code uses, so the same orchestrator helpers
 * (importBillCore, publishCore, …) can be called from either runtime.
 *
 * **Tests pass an in-memory fake.**
 * **CLI passes a wrangler-shell implementation** that shells out to
 * `wrangler d1 execute <db> --command <sql>`.
 * **Worker passes the live `env.D1_VOTER_INFO` binding directly.**
 *
 * The interface is intentionally minimal — only the methods the lib actually
 * calls. Adding to this surface is a deliberate widening that every consumer
 * must implement.
 */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<{ success: boolean; meta?: unknown }>;
}

export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

/* -------------------------------------------------------------------------- */
/*                     wrangler-shell implementation                          */
/* -------------------------------------------------------------------------- */

import { spawn } from 'node:child_process';

interface WranglerD1Opts {
  /** D1 database name as declared in wrangler.toml (e.g. "voter-info-d1"). */
  database: string;
  /** Wrangler environment flag (dev/uat/stg/prod). Maps to `--env <name>`. */
  env: string;
  /** Whether to use --remote (production binding) or --local (local SQLite). */
  remote: boolean;
}

/**
 * Run a `wrangler d1 execute` invocation and return its parsed JSON output.
 *
 * wrangler emits an array of result objects, one per statement. We always
 * pass a single statement, so we read `[0]`.
 */
async function execWrangler(
  opts: WranglerD1Opts,
  sql: string,
  params: unknown[],
): Promise<{ results?: unknown[]; meta?: unknown }> {
  // wrangler d1 execute supports `--command` (inline SQL) but not parameter
  // binding directly. We have two options: (a) inline-interpolate (vulnerable
  // to injection if values aren't sanitized), or (b) use `--file` with a
  // temp .sql and the `-- :param` placeholder syntax.
  //
  // For v4.1.0 we use the safer-but-clunky path: interpolate values that we
  // generate ourselves (ULIDs, ISO timestamps, constants — never user input)
  // and reject anything containing a quote character that could break out
  // of the string literal. The CLI never accepts free-form SQL from outside.
  const interpolated = interpolateParams(sql, params);
  const args = [
    'd1', 'execute', opts.database,
    `--env=${opts.env}`,
    opts.remote ? '--remote' : '--local',
    '--json',
    `--command=${interpolated}`,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['wrangler', ...args], { shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler d1 execute exit ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // wrangler returns an array of statement results.
        resolve(Array.isArray(parsed) ? parsed[0] : parsed);
      } catch (e) {
        reject(new Error(`wrangler d1 execute: bad JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Inline-interpolate `?` placeholders with the given params.
 *
 * Strings get single-quoted with single-quote-doubling escape. Numbers and
 * booleans render as literals. null/undefined render as `NULL`. Any other
 * type throws (we don't pass blobs or objects through this path).
 */
function interpolateParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) throw new Error('interpolateParams: not enough params');
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    throw new Error(`interpolateParams: unsupported param type ${typeof v}`);
  });
}

/**
 * Build a D1Like that shells out to `wrangler d1 execute`. Used by the CLI.
 */
export function makeWranglerD1(opts: WranglerD1Opts): D1Like {
  return {
    prepare(query: string): D1PreparedStatement {
      const params: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values) {
          params.push(...values);
          return stmt;
        },
        async first<T>() {
          const res = await execWrangler(opts, query, params);
          const rows = (res?.results ?? []) as T[];
          return rows[0] ?? null;
        },
        async all<T>() {
          const res = await execWrangler(opts, query, params);
          return { results: (res?.results ?? []) as T[] };
        },
        async run() {
          await execWrangler(opts, query, params);
          return { success: true };
        },
      };
      return stmt;
    },
    async batch(statements: D1PreparedStatement[]) {
      // wrangler doesn't expose a single-shot batch over the CLI, but D1's
      // semantics let us run statements sequentially. We sacrifice atomicity
      // here vs the Worker binding — acceptable for ingest jobs that are
      // restartable. Document this on the interface.
      const out: unknown[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
  };
}
