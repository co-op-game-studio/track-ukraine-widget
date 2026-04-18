/**
 * Proxy Worker — pure library.
 *
 * This module contains all testable logic for the Cloudflare Worker proxy.
 * It is intentionally free of Workers-runtime specifics:
 *   - No `caches.default` access (the Cache is passed in via `CacheLike`)
 *   - No `R2Bucket` type import (the binding is typed via a local interface)
 *   - No module-scope mutable state
 *
 * proxy/worker.ts is a thin shim that wires `caches.default` and the R2
 * binding into `handleFetch()` and exports the default Worker handler.
 *
 * Traces to: FR-10, FR-24, FR-25 (AC-25.5..25.10), FR-26, FR-27 (AC-27.1..27.10),
 * design.md §4.4, ADR-002, ADR-006.
 */

// ─── Types ────────────────────────────────────────────────────────────────

/** Minimal surface of `caches.default` that handleFetch uses. */
export interface CacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, resp: Response): Promise<void>;
}

/** Minimal KV surface for tests. */
export interface KVLike {
  get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  delete(key: string): Promise<void>;
}

export interface ProxyEnv {
  /** Congress.gov API key. Injected into /api/congress/v3/* upstream requests. */
  CONGRESS_API_KEY: string;
  /**
   * Comma-separated exact `scheme://host[:port]` values. Defaults to the prod
   * whitelist when unset. See AC-25.6.
   */
  ALLOWED_ORIGINS?: string;
  /**
   * When exactly "true", permit `http://localhost[:port]` and `http://127.0.0.1[:port]`
   * origins. Any other value (including unset) denies localhost. See AC-25.9.
   */
  ALLOW_LOCALHOST?: string;
  /**
   * When exactly "true", the Worker serves a preview HTML page at / instead of
   * 301-redirecting to trackukraine.com. Enabled on dev/uat/stg for "open in
   * browser to see the widget live". Prod omits this so voters still land on
   * the embed host.
   */
  PREVIEW_MODE?: string;
  /** Short env label (dev/uat/stg/prod) shown in preview HTML for orientation. */
  ENV_NAME?: string;
  /** KV namespace for curator records (member:, bill:, roll-call:, name-index:) + response cache (cache:). */
  KV_VOTER_INFO: KVLike;
  /**
   * Worker Sites assets binding. Serves static files from ./dist (the
   * widget IIFE bundle etc.). The Worker explicitly calls env.ASSETS.fetch
   * for unknown paths so assets serve after Worker route matching fails.
   */
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

interface ApiRouteRule {
  prefix: string;
  /** Short name used in normalized error envelopes (AC-27.5). */
  upstreamName: 'census' | 'senate' | 'congress';
  target: string;
  injectKey: boolean;
  cacheControl: string;
  /** Pinned upstream Accept header (AC-27.11). Server-side pinned, never from client. */
  upstreamAccept: string;
}

const API_ROUTES: ApiRouteRule[] = [
  {
    prefix: '/api/census/',
    upstreamName: 'census',
    target: 'https://geocoding.geo.census.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=86400, max-age=3600',
    upstreamAccept: 'application/json',
  },
  {
    prefix: '/api/senate/',
    upstreamName: 'senate',
    target: 'https://www.senate.gov',
    injectKey: false,
    cacheControl: 'public, s-maxage=31536000, max-age=31536000, immutable',
    upstreamAccept: 'application/xml, text/xml, */*;q=0.1',
  },
  {
    prefix: '/api/congress/',
    upstreamName: 'congress',
    target: 'https://api.congress.gov',
    injectKey: true,
    cacheControl: 'public, s-maxage=3600, max-age=300',
    upstreamAccept: 'application/json',
  },
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://trackukraine.com',
  'https://www.trackukraine.com',
];

// ─── Pure helpers (exported for unit testing) ─────────────────────────────

/**
 * Is the request Origin header on the allowlist?
 *
 * Exact string match only (AC-25.7). Localhost is permitted ONLY when
 * `allowLocalhost` is true (AC-25.9) — and even then, only for the `http://`
 * scheme against the literal host names `localhost` and `127.0.0.1`.
 */
export function isOriginAllowed(
  origin: string | null,
  allowlist: string[],
  allowLocalhost: boolean,
): boolean {
  if (!origin) return false;
  if (allowlist.includes(origin)) return true;
  if (allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) {
    return true;
  }
  return false;
}

/**
 * Non-prod envs (dev/uat/stg) are gated by Cloudflare Access. Requests that
 * reach the Worker have already passed OTP auth or carry a service token.
 * We drop the Origin allowlist check on these envs — Access is the gate.
 * Prod stays strict.
 */
export function isPreviewEnv(env: { PREVIEW_MODE?: string }): boolean {
  return env.PREVIEW_MODE === 'true';
}

/**
 * Same-origin GET/HEAD bypass: browsers omit the Origin header on same-origin
 * read requests. Sec-Fetch-Site is browser-set (Forbidden Header) and
 * unforgeable by client script, so 'same-origin' with method=GET is a reliable
 * signal that this request came from a document served by this Worker's own
 * host. That's legitimate (our /embed page talking to our own /api/*).
 *
 * Narrowly scoped: GET/HEAD only, Origin absent. Doesn't widen the surface
 * vs. any allowlisted cross-origin GET (which bypasses the allowlist by
 * matching it).
 */
export function isSameOriginBypass(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('Origin')) return false;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

/**
 * Is the upstream-path (the portion after the route prefix) structurally safe?
 *
 * Rejects `..`, `//`, `@`, any raw control character, any DEL (`\x7f`), and
 * any percent-encoded control byte (`%00`-`%1f`, `%7f`, case-insensitive).
 * See AC-27.7. The last check is critical — `URL.pathname` preserves percent-
 * encoded bytes, so an attacker-supplied `%0d%0a` survives parsing and would
 * be forwarded to upstream verbatim if we only checked decoded bytes.
 *
 * The URL constructor in handleFetch also normalizes away `..` segments
 * before they reach this check, but keeping the `..` rejection here makes
 * the guarantee local and defends any future code path that bypasses URL
 * parsing.
 */
export function isValidUpstreamPath(path: string): boolean {
  if (path.includes('..')) return false;
  if (path.includes('//')) return false;
  if (path.includes('@')) return false;
  // Raw control characters (including CR, LF, null, DEL).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  // Percent-encoded control bytes: %00-%1f and %7f in any hex case.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return false;
  return true;
}

/** Serialize the canonical upstream-error JSON envelope (AC-27.5). */
export function normalizeUpstreamErrorBody(status: number, upstream: string): string {
  return JSON.stringify({ error: 'upstream_error', status, upstream });
}

/**
 * What shape of content does this response carry? Used to pick which tier
 * of headers to layer on top of the universal baseline.
 *
 * - 'worker-emitted' — the Worker generated this response itself (error JSON,
 *   redirect, unknown-path 404). Gets CSP + Permissions-Policy + strict CORP.
 * - 'api-proxied'    — a 2xx upstream response flowing through /api/*. Gets
 *   CORP cross-origin so the embedder's browser can read it.
 * - 'static-asset'   — served from R2 (JS bundle, JSON datasets). Gets CORP
 *   cross-origin for embedding; CSP/Permissions-Policy intentionally absent
 *   (they apply to documents, not subresources).
 */
export type ResponseShape = 'worker-emitted' | 'api-proxied' | 'static-asset' | 'embeddable-html';

/** CSP used on any HTML/error content the Worker emits itself. */
const WORKER_EMITTED_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Permissions-Policy denying every feature we don't use. The empty-allowlist
 * `feature=()` syntax is the strictest form — no origin (including self) may
 * use the feature. List pulled from the MDN feature registry plus a few
 * quasi-standard ones (`interest-cohort`) that major browsers honor.
 */
const WORKER_EMITTED_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'cross-origin-isolated=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'interest-cohort=()',
  'keyboard-map=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'sync-xhr=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
].join(', ');

/**
 * Apply the AC-27.1 universal baseline plus the AC-27.1a/b/c shape-specific
 * layer. Returns a new Response (body reused). Shape defaults to
 * 'worker-emitted' — safe fallback if a caller forgets to pass one.
 */
export function applySecurityHeaders(
  resp: Response,
  shape: ResponseShape = 'worker-emitted',
): Response {
  const headers = new Headers(resp.headers);

  // Universal baseline (AC-27.1) — set on EVERY response except 'embeddable-html'
  // which needs to be frameable. Everything else gets X-Frame-Options: DENY.
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (shape !== 'embeddable-html') {
    headers.set('X-Frame-Options', 'DENY');
  }
  headers.set('X-DNS-Prefetch-Control', 'off');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Origin-Agent-Cluster', '?1');

  // Shape-specific layer.
  if (shape === 'worker-emitted') {
    // AC-27.1a: CSP + Permissions-Policy + strict CORP.
    headers.set('Content-Security-Policy', WORKER_EMITTED_CSP);
    headers.set('Permissions-Policy', WORKER_EMITTED_PERMISSIONS_POLICY);
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    // All worker-emitted responses are error/redirect content — never cache.
    if (resp.status >= 400) {
      headers.set('Cache-Control', 'no-store');
    }
  } else if (shape === 'api-proxied') {
    // AC-27.1c: allow cross-origin read for embedder browsers.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  } else if (shape === 'embeddable-html') {
    // Embed page — designed for iframing on third-party sites. No CSP
    // restriction from our side (set inline on the response with embed-friendly
    // directives). CORP cross-origin so the iframe's browser can render it.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  } else {
    // 'static-asset' — AC-27.1b: cross-origin embed.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

const FINGERPRINT_HEADER_PREFIXES = [
  'x-vcap-',
  'x-api-umbrella-',
  'x-amz-',
  'x-azure-',
  'x-appengine-',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-b3-',
];
const FINGERPRINT_HEADERS_EXACT = new Set([
  'set-cookie',
  'access-control-allow-credentials',
  'server',
  'via',
  'link',
  'report-to',
  'nel',
  'reporting-endpoints',
  'p3p',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
]);

/** Remove fingerprinting / sensitive upstream headers in place (AC-27.4). */
export function stripFingerprintingHeaders(headers: Headers): void {
  const toDelete: string[] = [];
  headers.forEach((_value, name) => {
    const lower = name.toLowerCase();
    if (FINGERPRINT_HEADERS_EXACT.has(lower)) {
      toDelete.push(name);
      return;
    }
    for (const prefix of FINGERPRINT_HEADER_PREFIXES) {
      if (lower.startsWith(prefix)) {
        toDelete.push(name);
        return;
      }
    }
  });
  for (const name of toDelete) headers.delete(name);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function parseAllowedOrigins(env: ProxyEnv): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_ALLOWED_ORIGINS];
}

function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  // On same-origin requests the browser doesn't need (and ignores) ACAO; we
  // omit it entirely rather than echoing a null/empty string that some
  // validators flag as malformed.
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowedOrigin) base['Access-Control-Allow-Origin'] = allowedOrigin;
  return base;
}

function pickApiCacheControl(route: ApiRouteRule, upstreamPath: string): string {
  if (route.upstreamName !== 'congress') return route.cacheControl;
  if (/^v3\/house-vote\//.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/^v3\/bill\/\d+\/\w+\/\d+\/(actions|summaries)/.test(upstreamPath)) {
    return 'public, s-maxage=31536000, max-age=31536000, immutable';
  }
  if (/^v3\/member\/.*\/(sponsored|cosponsored)-legislation/.test(upstreamPath)) {
    return 'public, s-maxage=3600, max-age=300';
  }
  return 'public, s-maxage=3600, max-age=3600';
}

function sanitizeBody(body: string, redactList: string[]): string {
  let out = body;
  for (const v of redactList) {
    if (v) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

function jsonResponse(status: number, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

// ─── KV helpers (ADR-011, FR-32) ──────────────────────────────────────────

const KV_PREFIXES = {
  member: 'member:v1:',
  bill: 'bill:v1:',
  rollCall: 'roll-call:v1:',
  nameIndex: 'name-index:v1:',
  cache: 'cache:v1:',
} as const;

/** Normalize a name-search query or indexed name: lowercase, strip diacritics,
 *  remove apostrophes/hyphens, collapse whitespace. See AC-31.7. */
export function normalizeSearchKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NameIndexEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  party: string;
  photoUrl?: string | null;
  searchKeys: string[];
}

/** Rank matches per AC-31.4: exact-prefix first, then substring, then by chamber then state. */
export function rankMatches(query: string, entries: NameIndexEntry[]): NameIndexEntry[] {
  const q = normalizeSearchKey(query);
  if (!q) return [];
  const scored = entries
    .map((e) => {
      const anyPrefix = e.searchKeys.some((k) => k.startsWith(q));
      const anySubstring = e.searchKeys.some((k) => k.includes(q));
      if (!anySubstring) return null;
      return { e, prefix: anyPrefix };
    })
    .filter((x): x is { e: NameIndexEntry; prefix: boolean } => x !== null);
  scored.sort((a, b) => {
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
    if (a.e.chamber !== b.e.chamber) return a.e.chamber === 'Senate' ? -1 : 1;
    if (a.e.state !== b.e.state) return a.e.state.localeCompare(b.e.state);
    return a.e.last.localeCompare(b.e.last);
  });
  return scored.map((s) => s.e);
}

const API_ALLOW_METHODS = 'GET, HEAD, OPTIONS';

/** Minimal shape of the ExecutionContext's waitUntil — lets tests inject. */
export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Member profile — the canonical shape returned by /api/members/{bioguideId}. */
export interface MemberProfile {
  bioguideId: string;
  first: string;
  last: string;
  officialName: string;
  state: string;
  district: number | null;
  chamber: 'House' | 'Senate';
  party: string;
  photoUrl: string | null;
  website: string | null;
  searchKey: string;
  sponsored: unknown[];
  cosponsored: unknown[];
  generatedAt: string;
  schemaVersion: number;
}

const PROFILE_TTL_SECONDS = 30 * 24 * 3600; // 30d per ADR-009 member-detail class

async function buildProfileFromUpstream(
  bioguideId: string,
  env: ProxyEnv,
): Promise<MemberProfile | null> {
  if (!env.CONGRESS_API_KEY) return null;
  const keyQS = `api_key=${env.CONGRESS_API_KEY}`;

  const [detailRes, sponsoredRes, cosponsoredRes] = await Promise.all([
    fetch(`https://api.congress.gov/v3/member/${bioguideId}?format=json&${keyQS}`, {
      headers: { Accept: 'application/json' },
    }),
    fetch(
      `https://api.congress.gov/v3/member/${bioguideId}/sponsored-legislation?limit=250&format=json&${keyQS}`,
      { headers: { Accept: 'application/json' } },
    ),
    fetch(
      `https://api.congress.gov/v3/member/${bioguideId}/cosponsored-legislation?limit=250&format=json&${keyQS}`,
      { headers: { Accept: 'application/json' } },
    ),
  ]);

  if (detailRes.status === 404) return null;
  if (!detailRes.ok) throw new Error(`member detail ${detailRes.status}`);

  interface TermEntry {
    chamber?: 'House of Representatives' | 'Senate';
    congress?: number;
    district?: number;
    startYear?: number;
    endYear?: number;
  }
  const detail = (await detailRes.json()) as {
    member: {
      bioguideId: string;
      firstName?: string;
      lastName?: string;
      directOrderName?: string;
      state: string;
      district?: number;
      partyHistory?: { partyName: string }[];
      // /v3/member/{id} returns a flat array; /v3/member?list wraps in {item:[]}.
      terms?: TermEntry[] | { item: TermEntry[] };
      depiction?: { imageUrl?: string };
      officialWebsiteUrl?: string;
    };
  };
  const m = detail.member;
  const rawTerms = m.terms;
  const terms: TermEntry[] = Array.isArray(rawTerms) ? rawTerms : (rawTerms?.item ?? []);
  // Current term = the one with the largest endYear (chronologically latest).
  let currentTerm: TermEntry | undefined;
  for (const t of terms) {
    if (!currentTerm || (t.endYear ?? 0) >= (currentTerm.endYear ?? 0)) currentTerm = t;
  }
  const chamber: 'House' | 'Senate' =
    currentTerm?.chamber === 'Senate' ? 'Senate' : 'House';
  const partyName = m.partyHistory?.[m.partyHistory.length - 1]?.partyName ?? '';
  const party = partyName.startsWith('Democrat')
    ? 'D'
    : partyName.startsWith('Republican')
      ? 'R'
      : partyName.startsWith('Independent')
        ? 'I'
        : partyName.charAt(0).toUpperCase();

  const sponsored = sponsoredRes.ok
    ? ((await sponsoredRes.json()) as { sponsoredLegislation?: unknown[] }).sponsoredLegislation ?? []
    : [];
  const cosponsored = cosponsoredRes.ok
    ? ((await cosponsoredRes.json()) as { cosponsoredLegislation?: unknown[] }).cosponsoredLegislation ?? []
    : [];

  const first = m.firstName ?? '';
  const last = m.lastName ?? '';
  const officialName = m.directOrderName ?? `${first} ${last}`.trim();
  return {
    bioguideId: m.bioguideId,
    first,
    last,
    officialName,
    state: m.state,
    district: currentTerm?.district ?? m.district ?? null,
    chamber,
    party,
    photoUrl: m.depiction?.imageUrl ?? null,
    website: m.officialWebsiteUrl ?? null,
    searchKey: normalizeSearchKey(`${first} ${last}`),
    sponsored,
    cosponsored,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

async function handleMemberProfile(
  bioguideId: string,
  request: Request,
  env: ProxyEnv,
  ctx: WaitUntilLike,
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Z][0-9]{6}$/.test(bioguideId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bioguide_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  // Cache read first (fast path).
  const cached = await env.KV_VOTER_INFO.get(KV_PREFIXES.member + bioguideId, 'text');
  if (cached) {
    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    headers.set('X-Cache', 'HIT');
    return {
      response: new Response(request.method === 'HEAD' ? null : (cached as string), {
        status: 200,
        headers,
      }),
      shape: 'api-proxied',
    };
  }

  // Read-through: fetch upstream, cache, return.
  let profile: MemberProfile | null;
  try {
    profile = await buildProfileFromUpstream(bioguideId, env);
  } catch (e) {
    return {
      response: jsonResponse(
        502,
        { error: 'upstream_error', detail: (e as Error).message },
        corsHeaders(origin),
      ),
      shape: 'worker-emitted',
    };
  }

  if (!profile) {
    return {
      response: jsonResponse(404, { error: 'member_not_found', bioguideId }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  const body = JSON.stringify(profile);
  ctx.waitUntil(
    env.KV_VOTER_INFO.put(KV_PREFIXES.member + bioguideId, body, {
      expirationTtl: PROFILE_TTL_SECONDS,
    }),
  );

  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  headers.set('X-Cache', 'MISS');
  return {
    response: new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}

async function handleNameSearch(
  request: Request,
  url: URL,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  const q = url.searchParams.get('q') ?? '';
  const normalized = normalizeSearchKey(q);
  if (normalized.length < 2) {
    return {
      response: jsonResponse(400, { error: 'query_too_short' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const meta = await env.KV_VOTER_INFO.get(KV_PREFIXES.nameIndex + 'meta', 'text');
  if (!meta) {
    return {
      response: jsonResponse(503, { error: 'index_not_ready' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  // For multi-word queries ("van hollen"), scan shards for each word's first letter.
  const letters = new Set<string>();
  for (const word of normalized.split(' ')) {
    const first = word[0];
    if (first) letters.add(first);
  }
  const allEntries: NameIndexEntry[] = [];
  const seen = new Set<string>();
  for (const letter of letters) {
    const shardJson = await env.KV_VOTER_INFO.get(KV_PREFIXES.nameIndex + letter, 'text');
    if (!shardJson) continue;
    const shard = JSON.parse(shardJson as string) as { entries: NameIndexEntry[] };
    for (const entry of shard.entries) {
      if (seen.has(entry.bioguideId)) continue;
      seen.add(entry.bioguideId);
      allEntries.push(entry);
    }
  }
  const ranked = rankMatches(normalized, allEntries);
  const truncated = ranked.length > 10;
  const results = ranked.slice(0, 10);
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(
      request.method === 'HEAD' ? null : JSON.stringify({ results, truncated }),
      { status: 200, headers },
    ),
    shape: 'api-proxied',
  };
}

async function handleBill(
  billId: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  if (!/^[A-Z]+\d+$/i.test(billId)) {
    return {
      response: jsonResponse(400, { error: 'invalid_bill_id' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const record = await env.KV_VOTER_INFO.get(KV_PREFIXES.bill + billId, 'text');
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'bill_not_found', billId }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}

async function handleRollCall(
  key: string,
  request: Request,
  env: ProxyEnv,
  origin: string,
): Promise<DispatchResult> {
  // key is "chamber/congress/session/rollCall"
  const parts = key.split('/');
  if (parts.length !== 4) {
    return {
      response: jsonResponse(400, { error: 'invalid_roll_call_key' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const [chamber, congress, session, rollCall] = parts as [string, string, string, string];
  if (!/^(house|senate)$/i.test(chamber) || !/^\d+$/.test(congress) || !/^\d+$/.test(session) || !/^\d+$/.test(rollCall)) {
    return {
      response: jsonResponse(400, { error: 'invalid_roll_call_key' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const record = await env.KV_VOTER_INFO.get(
    `${KV_PREFIXES.rollCall}${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`,
    'text',
  );
  if (!record) {
    return {
      response: jsonResponse(404, { error: 'roll_call_not_found' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');
  return {
    response: new Response(request.method === 'HEAD' ? null : (record as string), {
      status: 200,
      headers,
    }),
    shape: 'api-proxied',
  };
}

async function handleApi(
  request: Request,
  url: URL,
  env: ProxyEnv,
  origin: string | null,
  allowedOrigins: string[],
  allowLocalhost: boolean,
  cache: CacheLike,
): Promise<DispatchResult> {
  // AC-27.13: route-match BEFORE preflight so unknown /api/<foo>/* paths
  // don't get a 204 preflight-success (which would advertise CORS on paths
  // we don't actually serve).
  const route = API_ROUTES.find((r) => url.pathname.startsWith(r.prefix));
  if (!route) {
    return {
      response: jsonResponse(
        404,
        { error: 'no_such_api_route' },
        { Allow: API_ALLOW_METHODS },
      ),
      shape: 'worker-emitted',
    };
  }

  // Preflight (OPTIONS) — now only reached when route is known.
  if (request.method === 'OPTIONS') {
    if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
      return {
        response: new Response('Origin not allowed', {
          status: 403,
          headers: { Allow: API_ALLOW_METHODS },
        }),
        shape: 'worker-emitted',
      };
    }
    return {
      response: new Response(null, {
        status: 204,
        headers: { ...corsHeaders(origin), Allow: API_ALLOW_METHODS },
      }),
      shape: 'api-proxied',
    };
  }

  // AC-27.9: accept GET and HEAD. Anything else → 405 with Allow.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return {
      response: new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: API_ALLOW_METHODS },
      }),
      shape: 'worker-emitted',
    };
  }

  if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
    return {
      response: new Response('Origin not allowed', {
        status: 403,
        headers: { Allow: API_ALLOW_METHODS },
      }),
      shape: 'worker-emitted',
    };
  }

  const upstreamPath = url.pathname.slice(route.prefix.length);

  // AC-27.7: structural validation of upstream path.
  if (!isValidUpstreamPath(upstreamPath)) {
    return {
      response: jsonResponse(400, { error: 'invalid_upstream_path' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  // AC-27.6 + AC-27.12: congress.gov key is injected only on /v3/<alpha>*
  // paths. `^v3\/[a-z]` requires at least one lowercase alpha char after
  // the `v3/` prefix — rejects bare `v3/`, `v3/0`, `v3/-x`, etc.
  if (route.injectKey && !/^v3\/[a-z]/.test(upstreamPath)) {
    return {
      response: jsonResponse(400, { error: 'unsupported_upstream_path' }, corsHeaders(origin)),
      shape: 'worker-emitted',
    };
  }

  const upstreamUrl = new URL(`${route.target}/${upstreamPath}`);
  upstreamUrl.search = url.search;

  // AC-25.10: strip client-supplied api_key before maybe overwriting.
  upstreamUrl.searchParams.delete('api_key');

  if (route.injectKey) {
    if (!env.CONGRESS_API_KEY) {
      return {
        response: jsonResponse(
          500,
          { error: 'server_misconfigured', detail: 'CONGRESS_API_KEY not set' },
          corsHeaders(origin),
        ),
        shape: 'worker-emitted',
      };
    }
    upstreamUrl.searchParams.set('api_key', env.CONGRESS_API_KEY);
  }

  const cacheControl = pickApiCacheControl(route, upstreamPath);

  // Cache key MUST NOT include the API key or the Origin.
  const cacheKeyUrl = new URL(upstreamUrl.toString());
  cacheKeyUrl.searchParams.delete('api_key');
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

  let upstreamResponse = await cache.match(cacheKey);
  const wasCacheHit = !!upstreamResponse;

  if (!upstreamResponse) {
    try {
      // AC-27.11: pin upstream Accept server-side. Never forward client Accept.
      // This makes the cache key semantically complete without including
      // Accept, and prevents an attacker from poisoning the shared cache by
      // requesting HTML for a URL that legitimate clients request as JSON.
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: route.upstreamAccept,
          'User-Agent': 'voter-info-widget-proxy/2.4',
        },
      });
    } catch {
      return {
        response: jsonResponse(
          502,
          { error: 'upstream_unreachable', upstream: route.upstreamName },
          corsHeaders(origin),
        ),
        shape: 'worker-emitted',
      };
    }

    if (upstreamResponse.ok) {
      const cacheableHeaders = new Headers(upstreamResponse.headers);
      cacheableHeaders.set('Cache-Control', cacheControl);
      const cacheable = new Response(upstreamResponse.clone().body, {
        status: upstreamResponse.status,
        headers: cacheableHeaders,
      });
      await cache.put(cacheKey, cacheable);
    }
  }

  // AC-27.5: non-2xx upstream responses are normalized to a JSON envelope.
  if (!upstreamResponse.ok) {
    const envelope = normalizeUpstreamErrorBody(upstreamResponse.status, route.upstreamName);
    const sanitized = sanitizeBody(envelope, [env.CONGRESS_API_KEY]);
    const finalHeaders = new Headers(corsHeaders(origin));
    finalHeaders.set('Content-Type', 'application/json; charset=utf-8');
    finalHeaders.set('Cache-Control', 'no-store');
    finalHeaders.set('X-Proxy-Cache', wasCacheHit ? 'HIT' : 'MISS');
    return {
      response: new Response(sanitized, {
        status: upstreamResponse.status,
        headers: finalHeaders,
      }),
      shape: 'worker-emitted',
    };
  }

  // 2xx: pass upstream body, strip fingerprinting headers, apply CORS.
  const finalHeaders = new Headers(upstreamResponse.headers);
  stripFingerprintingHeaders(finalHeaders);
  for (const [k, v] of Object.entries(corsHeaders(origin))) finalHeaders.set(k, v);
  finalHeaders.set('Cache-Control', cacheControl);
  finalHeaders.set('X-Proxy-Cache', wasCacheHit ? 'HIT' : 'MISS');

  // AC-27.9: HEAD returns headers only — no body.
  const body = request.method === 'HEAD' ? null : upstreamResponse.body;

  return {
    response: new Response(body, {
      status: upstreamResponse.status,
      headers: finalHeaders,
    }),
    shape: 'api-proxied',
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────

/**
 * Default fetch handler. Called per-request; stateless; pure over its
 * (request, env, cache) inputs.
 *
 * Every response is funneled through `applySecurityHeaders` with its
 * shape so the AC-27.1 baseline is guaranteed regardless of control flow,
 * and the shape-specific layer (AC-27.1a/b/c) is correct.
 */
export async function handleFetch(
  request: Request,
  env: ProxyEnv,
  cache: CacheLike,
  ctx: WaitUntilLike = { waitUntil: () => {} },
): Promise<Response> {
  const { response, shape } = await dispatch(request, env, cache, ctx);
  return applySecurityHeaders(response, shape);
}

type DispatchResult = { response: Response; shape: ResponseShape };

async function dispatch(
  request: Request,
  env: ProxyEnv,
  cache: CacheLike,
  ctx: WaitUntilLike,
): Promise<DispatchResult> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env);
  const allowLocalhost = env.ALLOW_LOCALHOST === 'true';

  // 1. KV-backed curator read routes (ADR-011, FR-32) — all go through origin check.
  const kvRouteMatch = url.pathname.match(
    /^\/api\/(members|bills|roll-calls|name-search)(?:\/(.+))?$/,
  );
  if (kvRouteMatch) {
    // OPTIONS preflight for these routes
    if (request.method === 'OPTIONS') {
      if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
        return {
          response: new Response('Origin not allowed', {
            status: 403,
            headers: { Allow: API_ALLOW_METHODS },
          }),
          shape: 'worker-emitted',
        };
      }
      return {
        response: new Response(null, {
          status: 204,
          headers: { ...corsHeaders(origin), Allow: API_ALLOW_METHODS },
        }),
        shape: 'api-proxied',
      };
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return {
        response: new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: API_ALLOW_METHODS },
        }),
        shape: 'worker-emitted',
      };
    }
    if (!isPreviewEnv(env) && !isOriginAllowed(origin, allowedOrigins, allowLocalhost) && !isSameOriginBypass(request)) {
      return {
        response: new Response('Origin not allowed', {
          status: 403,
          headers: { Allow: API_ALLOW_METHODS },
        }),
        shape: 'worker-emitted',
      };
    }
    const [, kind, rest] = kvRouteMatch;
    if (kind === 'members') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bioguide_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleMemberProfile(rest, request, env, ctx, origin!);
    }
    if (kind === 'bills') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_bill_id' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleBill(rest, request, env, origin!);
    }
    if (kind === 'roll-calls') {
      if (!rest) return { response: jsonResponse(400, { error: 'missing_roll_call_key' }, corsHeaders(origin)), shape: 'worker-emitted' };
      return handleRollCall(rest, request, env, origin!);
    }
    if (kind === 'name-search') {
      return handleNameSearch(request, url, env, origin!);
    }
  }

  // 2. /api/* proxied with CORS + origin whitelist (unchanged legacy routes)
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, url, env, origin, allowedOrigins, allowLocalhost, cache);
  }

  // 3. Browser navigation.
  //    - PREVIEW_MODE (dev/uat/stg) at root path "/": serve a preview page
  //      that renders the widget live.
  //    - Any other text/html GET: 301 → trackukraine.com.
  const accept = request.headers.get('Accept') ?? '';
  if (request.method === 'GET' && accept.includes('text/html')) {
    // /embed on any env (including prod): serve the embed-ready widget page
    // designed for iframe embedding on third-party sites. Frames allowed
    // from anywhere; no CSP frame-ancestors restriction.
    if (url.pathname === '/embed' || url.pathname === '/embed/') {
      return {
        response: new Response(buildEmbedHtml(env.ENV_NAME ?? 'prod'), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=600',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; " +
              "img-src 'self' data: https:; " +
              "connect-src 'self'; " +
              "base-uri 'none'",
          },
        }),
        shape: 'embeddable-html',
      };
    }
    // Non-prod (PREVIEW_MODE='true'): serve widget preview at any HTML request.
    // Worker-level Access gate is already upstream; if we're here, the user is
    // authenticated or on localhost. Always render the preview — never redirect
    // to trackukraine.com on a lower env.
    if (env.PREVIEW_MODE === 'true') {
      // Preview HTML loads the widget IIFE bundle from the same origin + needs
      // inline style for the env-label styling. Relax CSP vs. the default
      // worker-emitted baseline. Shape 'static-asset' skips the restrictive
      // CSP in applySecurityHeaders (that branch sets CORP cross-origin only).
      return {
        response: new Response(buildPreviewHtml(env.ENV_NAME ?? 'non-prod'), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; " +
              "img-src 'self' data: https:; " +
              "connect-src 'self'; " +
              "frame-ancestors 'none'; base-uri 'none'",
            'X-Preview-Mode': 'served',
          },
        }),
        shape: 'static-asset',
      };
    }
    // Prod only: bounce voters to the embed host.
    const resp = Response.redirect('https://trackukraine.com/', 301);
    const headers = new Headers(resp.headers);
    headers.set('X-Preview-Mode', `skipped (prod)`);
    return {
      response: new Response(resp.body, { status: resp.status, headers }),
      shape: 'worker-emitted',
    };
  }

  // 4. Unknown path: delegate to Worker Sites assets (serves dist/ files
  //    like /voter-info-widget.iife.js). 404 if assets don't have it either.
  if (env.ASSETS) {
    try {
      const assetResp = await env.ASSETS.fetch(request);
      if (assetResp.status !== 404) {
        return { response: assetResp, shape: 'static-asset' };
      }
    } catch {
      /* fall through */
    }
  }
  return { response: new Response('Not Found', { status: 404 }), shape: 'worker-emitted' };
}

/**
 * Embed-friendly HTML served at /embed on any env. Designed for iframe
 * embedding on third-party sites (e.g. trackukraine.com, Discord link
 * previews, WordPress). Notifies the parent frame of its content height
 * via postMessage so the host can auto-size the iframe.
 */
function buildEmbedHtml(envName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Voter Info Widget</title>
    <meta property="og:title" content="Voter Info Widget — Ukraine Focus" />
    <meta property="og:description" content="See how your U.S. Senators and Representative voted on major Ukraine aid, sanctions, and oversight legislation." />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      body { font-family: "Hanken Grotesk", system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <div id="viw-mount"></div>
    <script src="/voter-info-widget.iife.js" defer></script>
    <script>
      // Mount the widget with api-base = this page's origin. This forces
      // fetch() calls to be cross-origin (vs. same-origin with no Origin
      // header) so the Worker's ALLOWED_ORIGINS check sees a real Origin.
      window.addEventListener('load', function () {
        var el = document.createElement('voter-info-widget');
        el.setAttribute('api-base', window.location.origin);
        document.getElementById('viw-mount').appendChild(el);
      });
      // Auto-size iframe: on content-height changes, postMessage to parent.
      (function () {
        var lastHeight = 0;
        function notify() {
          var h = document.documentElement.scrollHeight;
          if (h !== lastHeight) {
            lastHeight = h;
            window.parent.postMessage(
              { type: 'viw:resize', height: h, env: ${JSON.stringify(envName)} },
              '*'
            );
          }
        }
        var ro = new ResizeObserver(notify);
        ro.observe(document.body);
        // Also fire on window load + periodic fallback for pre-ResizeObserver cases.
        window.addEventListener('load', notify);
        setInterval(notify, 500);
      })();
    </script>
  </body>
</html>`;
}

function buildPreviewHtml(envName: string): string {
  // Non-prod preview served behind CF Access. The Worker skips the Origin
  // allowlist check on PREVIEW_MODE envs because Access is the gate. Only
  // prod enforces the cross-site embed allowlist.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Voter Info Widget — ${envName}</title>
    <style>
      html, body { margin: 0; padding: 0; min-height: 100vh; }
      body { background: #00b4e6; font-family: "Hanken Grotesk", system-ui, sans-serif; }
      .viw-env-label {
        position: fixed; top: 8px; right: 8px;
        background: #000; color: #ffd400; padding: 6px 10px; border-radius: 4px;
        font-family: monospace; font-size: 12px; border: 2px solid #ffd400; z-index: 9999;
      }
    </style>
  </head>
  <body>
    <div class="viw-env-label">ENV: ${envName}</div>
    <voter-info-widget api-base=""></voter-info-widget>
    <script src="/voter-info-widget.iife.js" defer></script>
  </body>
</html>`;
}
