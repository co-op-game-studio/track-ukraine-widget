/**
 * D1Like — narrow interface the `lw` CLI subcommands depend on.
 *
 * Matches the surface area of the Cloudflare Workers D1 binding (`D1Database`)
 * that the existing Worker code uses, so the same orchestrator helpers
 * (importBillCore, publishCore, …) can be called from either runtime.
 *
 * **Tests pass an in-memory fake.**
 * **CLI passes a REST-API-backed implementation** (`makeRestD1`) that talks
 * to `POST /accounts/{acct}/d1/database/{db}/query`. Native parameter
 * binding (no string interpolation), supports batches via the same endpoint.
 * **Worker passes the live `env.D1_VOTER_INFO` binding directly.**
 *
 * Why REST and not `wrangler d1 execute`: the shell-out via `wrangler …
 * --command=<SQL>` tokenizes the SQL on whitespace + commas because the
 * subprocess invocation goes through the shell on Windows. The REST API
 * has no such shell-parsing layer and supports `params: [...]` natively
 * so we never inline-interpolate values.
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
/*                       REST-API implementation                              */
/* -------------------------------------------------------------------------- */

export type EnvName = 'dev' | 'uat' | 'stg' | 'prod';

/** Per-env D1 database IDs — must match wrangler.toml. Mirrors KV_NAMESPACE_IDS
 *  in runtime.ts; both maps are owned by the CLI side. */
export const D1_DATABASE_IDS: Record<EnvName, string> = {
  dev: '05e0fc19-127c-4a7e-9708-1055996b134c',
  uat: '530a894e-8fc2-431f-9ade-d288fc9e0a1d',
  stg: '24506b27-d533-45a9-bb16-2d182630d587',
  prod: 'd22db275-7b64-472a-873b-76dd97020603',
};

export interface RestD1Opts {
  envName: EnvName;
  accountId: string;
  apiToken: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

interface CfApiResponse<T> {
  result?: T;
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: unknown[];
}

interface D1QueryResult {
  results?: unknown[];
  success: boolean;
  meta?: unknown;
}

/**
 * Build a D1Like that POSTs to the Cloudflare D1 REST query endpoint.
 * Native parameter binding — values are passed as a `params: [...]` array,
 * never inline-interpolated. No shell, no escaping, no quote bugs.
 */
export function makeRestD1(opts: RestD1Opts): D1Like {
  const dbId = D1_DATABASE_IDS[opts.envName];
  if (!dbId) {
    throw new Error(`makeRestD1: no D1 database ID configured for env '${opts.envName}'`);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${dbId}/query`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function execOne(sql: string, params: unknown[]): Promise<D1QueryResult> {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`D1 REST ${resp.status}: ${text.slice(0, 400)}`);
    }
    const body = (await resp.json()) as CfApiResponse<D1QueryResult[]>;
    if (!body.success) {
      const errs = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
      throw new Error(`D1 REST error: ${errs || 'unknown'}`);
    }
    // The query endpoint returns `result: [{results, success, meta}]` — array
    // because the endpoint historically supported semicolon-separated multi-
    // statement strings. We always send one statement.
    const arr = body.result ?? [];
    return arr[0] ?? { success: true };
  }

  return {
    prepare(query: string): D1PreparedStatement {
      const boundParams: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values) {
          boundParams.push(...values);
          return stmt;
        },
        async first<T>() {
          const res = await execOne(query, boundParams);
          const rows = (res.results ?? []) as T[];
          return rows[0] ?? null;
        },
        async all<T>() {
          const res = await execOne(query, boundParams);
          return { results: (res.results ?? []) as T[] };
        },
        async run() {
          const res = await execOne(query, boundParams);
          return { success: res.success, meta: res.meta };
        },
      };
      return stmt;
    },
    async batch(statements: D1PreparedStatement[]) {
      // Each statement carries its own `query` + `boundParams` via closure.
      // We can't introspect those from outside, so we wrap each statement
      // such that calling `run()` returns the underlying QueryResult and
      // we collect them. Simpler approach: each prepared statement's run()
      // already issues one HTTP call. We just iterate.
      const out: unknown[] = [];
      for (const s of statements) {
        out.push(await s.run());
      }
      return out;
    },
  };
}
