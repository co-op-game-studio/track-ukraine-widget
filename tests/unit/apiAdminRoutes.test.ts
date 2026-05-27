/**
 * Tests for proxy/routes/api-admin.ts — V4 surfaces (FR-49, FR-50, FR-58).
 *
 * Sister file to `adminRoutes.test.ts`. That file covers `_reason` plumbing
 * across the older bills/votes/comments resource handlers; this one covers
 * the newer surfaces:
 *
 *   - GET  /api/admin/config        — env-derived runtime knobs
 *   - CRUD /api/admin/tags          — Settings ▸ Tags
 *   - GET/POST/DELETE /api/admin/cache — operator-only KV inspection + purge
 *   - GET  /api/admin/audit         — KV-first feed with D1 fallback
 *
 * We exercise everything through `handleAdmin` (the real dispatch entry
 * point) so path routing, auth, and `_reason` plumbing all run the way they
 * do in production.
 *
 * Auth gate is satisfied by minting a real RS256 CF Access JWT and stubbing
 * the JWKS endpoint, mirroring the pattern in `adminRoutes.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Mock the upstream importer used by /import-bill and /backfill-bills so we
// can exercise the route layer without standing up a fake Congress.gov.
vi.mock('../../proxy/services/import-bill', () => ({
  importBillFromCongress: vi.fn(async (input: { congress: number; type: string; number: string }) => ({
    bill: { bill_id: `${input.congress}-${input.type.toUpperCase()}-${input.number}` },
    votes_imported: 1,
    votes_updated: 0,
    votes_skipped: 0,
    cosponsors_imported: 2,
    actions_imported: 3,
    cached: false,
    duration_ms: 5,
  })),
}));

import { handleAdmin } from '../../proxy/routes/api-admin';
import { importBillFromCongress } from '../../proxy/services/import-bill';
import { clearJwksMemoCache, type Jwks } from '../../proxy/security/cf-access-jwt';
import { ACCESS_JWT_HEADER } from '../../proxy/security/admin-actor';
import { KV_PREFIXES } from '../../proxy/kv/prefixes';
import type {
  ProxyEnv,
  D1Like,
  D1PreparedStatementLike,
  D1ResultLike,
  KVLike,
} from '../../proxy/env';

/* -------------------------------------------------------------------------- */
/*                               JWT plumbing                                 */
/* -------------------------------------------------------------------------- */

const TEAM = 'cogs';
const AUD = 'a'.repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const KID = 'api-admin-routes-kid';

function uint8ToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToBase64Url(s: string): string {
  return uint8ToBase64Url(new TextEncoder().encode(s));
}

interface KeyPair { privateKey: CryptoKey; publicJwk: JsonWebKey; }
let kp: KeyPair;
let jwt: string;

async function makeKeyPair(): Promise<KeyPair> {
  const k = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', k.publicKey);
  return { privateKey: k.privateKey, publicJwk };
}

async function mintJwt(privateKey: CryptoKey, email: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = { iss: ISS, aud: AUD, exp: nowSec + 600, iat: nowSec, email };
  const headerB64 = strToBase64Url(JSON.stringify(header));
  const payloadB64 = strToBase64Url(JSON.stringify(payload));
  const sigBuf = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  return `${headerB64}.${payloadB64}.${uint8ToBase64Url(new Uint8Array(sigBuf))}`;
}

beforeAll(async () => {
  kp = await makeKeyPair();
  const jwks: Jwks = {
    keys: [{
      kid: KID,
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      n: kp.publicJwk.n!,
      e: kp.publicJwk.e!,
    }],
  };
  jwt = await mintJwt(kp.privateKey, 'alice@example.com');
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('cloudflareaccess.com/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify(jwks), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => clearJwksMemoCache());

/* -------------------------------------------------------------------------- */
/*                              Minimal fake D1                               */
/* -------------------------------------------------------------------------- */
/* Lifted from adminRoutes.test.ts and lightly extended:                      */
/*   - `tags` table added                                                     */
/*   - `SELECT * FROM tags ORDER BY label` (bindings-less) returns all rows   */
/*   - `WHERE created_at >= ? ORDER BY ... LIMIT ?` for the audit `since`     */
/*     filter (already present in the older shim, replicated for parity)      */

class FakeStmt implements D1PreparedStatementLike {
  constructor(public d1: FakeD1, public q: string, public bindings: unknown[] = []) {}
  bind(...vs: unknown[]) {
    return new FakeStmt(this.d1, this.q, [...this.bindings, ...vs]);
  }
  async first<T = unknown>(): Promise<T | null> {
    const r = this.execute();
    return ((r.results?.[0] ?? null) as T | null);
  }
  async run() { return this.execute(); }
  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return this.execute() as D1ResultLike<T>;
  }
  private execute(): D1ResultLike<unknown> {
    const q = this.q.trim();

    const ins = q.match(/^INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (ins) {
      const table = ins[1]!;
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      // Auto-create unknown tables so we don't need to enumerate every one.
      if (!this.d1.tables[table]) this.d1.tables[table] = [];
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    const upd = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (upd) {
      const table = upd[1]!;
      const fields = upd[2]!.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table]!;
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }
    const del = q.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (del) {
      const table = del[1]!;
      const id = this.bindings[0] as string;
      const rows = this.d1.tables[table] ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } };
    }
    const exists = q.match(/^SELECT\s+1\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i);
    if (exists) {
      const table = exists[1]!, col = exists[2]!;
      const found = (this.d1.tables[table] ?? []).find((r) => r[col] === this.bindings[0]);
      return { success: true, results: found ? [{ '1': 1 }] : [] };
    }
    const sel = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (sel) {
      const table = sel[1]!;
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['id'] === this.bindings[0]);
      return { success: true, results: rows };
    }
    // audit_log with `since` filter
    const auditSince = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+WHERE\s+created_at\s*>=\s*\?/i);
    if (auditSince) {
      const since = String(this.bindings[0]);
      const limit = Number(this.bindings[1] ?? 50);
      const rows = (this.d1.tables.audit_log ?? [])
        .filter((r) => String(r['created_at']) >= since)
        .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])))
        .slice(0, limit);
      return { success: true, results: rows };
    }
    // audit_log plain
    const auditList = q.match(/^SELECT\s+\*\s+FROM\s+audit_log\s+ORDER\s+BY/i);
    if (auditList) {
      const limit = Number(this.bindings[0] ?? 50);
      const rows = [...(this.d1.tables.audit_log ?? [])]
        .sort((a, b) => String(b['created_at']).localeCompare(String(a['created_at'])))
        .slice(0, limit);
      return { success: true, results: rows };
    }
    // SELECT * FROM <table> ORDER BY ... [LIMIT/OFFSET optional]
    const selListLimit = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+ORDER\s+BY/i);
    if (selListLimit) {
      const table = selListLimit[1]!;
      const rows = this.d1.tables[table] ?? [];
      // If there are bindings, treat as LIMIT/OFFSET; otherwise return all.
      if (this.bindings.length >= 2) {
        const limit = Number(this.bindings[this.bindings.length - 2] ?? rows.length);
        const offset = Number(this.bindings[this.bindings.length - 1] ?? 0);
        return { success: true, results: rows.slice(offset, offset + limit) };
      }
      if (this.bindings.length === 1) {
        const limit = Number(this.bindings[0] ?? rows.length);
        return { success: true, results: rows.slice(0, limit) };
      }
      return { success: true, results: rows };
    }
    const byBill = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+bill_id\s*=\s*\?/i);
    if (byBill) {
      const table = byBill[1]!;
      const rows = (this.d1.tables[table] ?? []).filter(
        (r) => r['bill_id'] === this.bindings[0],
      );
      return { success: true, results: rows };
    }
    // backfill cursor: SELECT congress, type, number, bill_id FROM bills WHERE bill_id > ? ORDER BY bill_id ASC LIMIT ?
    const cursor = q.match(/^SELECT\s+[\w\s,]+\s+FROM\s+bills\s+WHERE\s+bill_id\s*>\s*\?\s+ORDER\s+BY\s+bill_id/i);
    if (cursor) {
      const after = String(this.bindings[0] ?? '');
      const limit = Number(this.bindings[1] ?? 25);
      const rows = (this.d1.tables.bills ?? [])
        .filter((r) => String(r['bill_id']) > after)
        .sort((a, b) => String(a['bill_id']).localeCompare(String(b['bill_id'])))
        .slice(0, limit);
      return { success: true, results: rows };
    }
    const list = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)/i);
    if (list) return { success: true, results: this.d1.tables[list[1]!] ?? [] };
    throw new Error(`unhandled: ${q}`);
  }
}

class FakeD1 implements D1Like {
  tables: Record<string, Record<string, unknown>[]> = {
    bills: [], votes: [], comments: [], social_posts: [], quotes: [],
    audit_log: [], score_adjustments: [], researchers: [], tags: [],
    quote_tags: [],
  };
  prepare(q: string) { return new FakeStmt(this, q); }
  async batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const snapshot = JSON.parse(JSON.stringify(this.tables));
    const out: D1ResultLike<T>[] = [];
    try {
      for (const s of stmts) out.push(await s.run() as D1ResultLike<T>);
      return out;
    } catch (err) {
      this.tables = snapshot;
      return [{ success: false, error: (err as Error).message } as D1ResultLike<T>];
    }
  }
  async exec() { return { count: 0, duration: 0 }; }
}

/* -------------------------------------------------------------------------- */
/*                              Minimal fake KV                               */
/* -------------------------------------------------------------------------- */

class FakeKV implements KVLike {
  store = new Map<string, string>();
  async get(key: string, type?: 'text' | 'json'): Promise<string | null | unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    void opts.cursor;
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

interface MakeEnvOpts {
  pollConcurrency?: string;
  socialPollCron?: string;
}

function makeEnv(d1: FakeD1, kv: FakeKV, opts: MakeEnvOpts = {}): ProxyEnv {
  const env: Record<string, unknown> = {
    CF_ACCESS_TEAM: TEAM,
    CF_ACCESS_AUD: AUD,
    D1_VOTER_INFO: d1,
    KV_VOTER_INFO: kv,
  };
  if (opts.pollConcurrency !== undefined) env['POLL_CONCURRENCY'] = opts.pollConcurrency;
  if (opts.socialPollCron !== undefined) env['SOCIAL_POLL_CRON'] = opts.socialPollCron;
  return env as unknown as ProxyEnv;
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      [ACCESS_JWT_HEADER]: jwt,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  return new Request(`https://worker.example${path}`, init);
}

async function call(
  env: ProxyEnv,
  method: string,
  rest: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const path = `/api/admin/${rest}`;
  const queryIdx = rest.indexOf('?');
  const restPathOnly = queryIdx >= 0 ? rest.slice(0, queryIdx) : rest;
  const result = await handleAdmin(
    restPathOnly,
    makeRequest(method, path, body),
    env,
    { waitUntil: () => {} },
    'https://embed.example',
    'tr_test0123456789ab',
    'test',
  );
  const text = await result.response.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: result.response.status, json };
}

/* -------------------------------------------------------------------------- */
/*                              handleConfig                                  */
/* -------------------------------------------------------------------------- */

describe('api-admin: GET /config (env-derived runtime knobs)', () => {
  it('falls back to defaults when env vars are unset', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'config');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      pollConcurrency: 4,            // default from parsePosInt
      socialPollCron: '0 * * * *',   // default
      // hourly cron → interval 60min - safety 5min = 55
      socialPollStalenessMin: 55,
    });
  });

  it('returns env-supplied values when set', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV(), {
      pollConcurrency: '12',
      socialPollCron: '*/15 * * * *',
    });
    const r = await call(env, 'GET', 'config');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      pollConcurrency: 12,
      socialPollCron: '*/15 * * * *',
      // every 15min → 15-5 = 10
      socialPollStalenessMin: 10,
    });
  });

  it('rejects garbage POLL_CONCURRENCY (non-positive) by falling back to 4', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV(), { pollConcurrency: 'abc' });
    const r = await call(env, 'GET', 'config');
    expect((r.json as { pollConcurrency: number }).pollConcurrency).toBe(4);
  });

  it('derives staleness from a daily cron schedule', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV(), { socialPollCron: '0 6 * * *' });
    const r = await call(env, 'GET', 'config');
    // 24*60 - 5 = 1435
    expect((r.json as { socialPollStalenessMin: number }).socialPollStalenessMin).toBe(1435);
  });
});

/* -------------------------------------------------------------------------- */
/*                                handleTags                                  */
/* -------------------------------------------------------------------------- */

async function createTag(
  env: ProxyEnv,
  body: Partial<{ slug: string; label: string; color: string; description: string | null }> = {},
): Promise<{ status: number; tag: Record<string, unknown> | undefined }> {
  const r = await call(env, 'POST', 'tags', {
    slug: 'foreign-policy',
    label: 'Foreign Policy',
    color: '#ef4444',
    ...body,
  });
  return {
    status: r.status,
    tag: (r.json as { tag?: Record<string, unknown> })?.tag,
  };
}

describe('api-admin: /tags CRUD', () => {
  it('GET list returns the items array (initially empty)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'tags');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ items: [] });
  });

  it('GET list returns created tags', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await createTag(env);
    const r = await call(env, 'GET', 'tags');
    expect(r.status).toBe(200);
    const items = (r.json as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
  });

  it('GET by unknown id returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'tags/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });

  it('GET by id returns the existing tag', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'GET', `tags/${id}`);
    expect(r.status).toBe(200);
    expect((r.json as { tag: { id: string } }).tag.id).toBe(id);
  });

  it('POST create succeeds with valid input + 201', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    expect(c.status).toBe(201);
    expect(c.tag).toMatchObject({
      slug: 'foreign-policy',
      label: 'Foreign Policy',
      color: '#ef4444',
    });
  });

  it('POST rejects invalid slug (uppercase)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'tags', {
      slug: 'BadSlug',
      label: 'Bad',
      color: '#ef4444',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_tag' });
  });

  it('POST rejects invalid color (not hex)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'tags', {
      slug: 'ok',
      label: 'OK',
      color: 'red',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_tag' });
  });

  it('POST rejects empty label', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'tags', {
      slug: 'ok',
      label: '   ',
      color: '#ef4444',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_tag' });
  });

  it('PATCH updates an existing tag with valid input + reason', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'PATCH', `tags/${id}`, {
      label: 'Updated Label',
      _reason: 'rename for clarity',
    });
    expect(r.status).toBe(200);
    expect((r.json as { tag: { label: string } }).tag.label).toBe('Updated Label');
  });

  it('PATCH without _reason returns 400 reason_required', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'PATCH', `tags/${id}`, { label: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
  });

  it('PATCH unknown id returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'PATCH', 'tags/does-not-exist', {
      label: 'x',
      _reason: 'try',
    });
    expect(r.status).toBe(404);
  });

  it('PATCH validates new color', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'PATCH', `tags/${id}`, {
      color: 'not-a-color',
      _reason: 'fix',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_tag' });
  });

  it('DELETE existing tag with ?reason= succeeds', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'DELETE', `tags/${id}?reason=cleanup`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deleted: true });
  });

  it('DELETE without reason returns 400 reason_required', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const c = await createTag(env);
    const id = c.tag!['id'] as string;
    const r = await call(env, 'DELETE', `tags/${id}`);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
  });

  it('DELETE unknown id returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'DELETE', 'tags/missing?reason=x');
    expect(r.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/*                                handleCache                                 */
/* -------------------------------------------------------------------------- */

describe('api-admin: /cache (KV inspection + purge)', () => {
  it('GET /cache returns the prefix overview with key counts', async () => {
    const kv = new FakeKV();
    // Seed a couple of keys under different known prefixes.
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    await kv.put(KV_PREFIXES.member + 'B001230', 'y');
    await kv.put(KV_PREFIXES.bill + '117-HR-2471', 'z');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'GET', 'cache');
    expect(r.status).toBe(200);
    const body = r.json as { prefixes: Array<{ slug: string; approxCount: number }> };
    expect(body.prefixes.length).toBeGreaterThan(5);
    const member = body.prefixes.find((p) => p.slug === 'member')!;
    const bill = body.prefixes.find((p) => p.slug === 'bill')!;
    expect(member.approxCount).toBe(2);
    expect(bill.approxCount).toBe(1);
  });

  it('GET /cache/<slug> returns the key list under one prefix', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    await kv.put(KV_PREFIXES.member + 'B001230', 'y');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'GET', 'cache/member');
    expect(r.status).toBe(200);
    const body = r.json as { slug: string; keys: string[] };
    expect(body.slug).toBe('member');
    expect(body.keys).toEqual(expect.arrayContaining([
      KV_PREFIXES.member + 'P000197',
      KV_PREFIXES.member + 'B001230',
    ]));
  });

  it('GET /cache/<unknown-slug> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'cache/not-a-prefix');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });

  it('POST /cache/<slug> without _reason returns 400 reason_required', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'POST', 'cache/member', { /* no _reason */ });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
    // And the keys should NOT have been touched.
    expect(kv.store.has(KV_PREFIXES.member + 'P000197')).toBe(true);
  });

  it('POST /cache/<slug> with _reason purges every key under the prefix', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    await kv.put(KV_PREFIXES.member + 'B001230', 'y');
    // A key under a *different* prefix must survive.
    await kv.put(KV_PREFIXES.bill + 'survives', 'z');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'POST', 'cache/member', { _reason: 'stale member data' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ slug: 'member', purged: 2, reason: 'stale member data' });
    expect(kv.store.has(KV_PREFIXES.member + 'P000197')).toBe(false);
    expect(kv.store.has(KV_PREFIXES.bill + 'survives')).toBe(true);
  });

  it('DELETE /cache/<slug>/<key-tail> with ?reason= purges single key', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    await kv.put(KV_PREFIXES.member + 'B001230', 'y');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'DELETE', 'cache/member/P000197?reason=fix');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      key: KV_PREFIXES.member + 'P000197',
      purged: 1,
      reason: 'fix',
    });
    expect(kv.store.has(KV_PREFIXES.member + 'P000197')).toBe(false);
    expect(kv.store.has(KV_PREFIXES.member + 'B001230')).toBe(true);
  });

  it('DELETE /cache/<slug>/<key> without ?reason= returns 400 reason_required', async () => {
    const kv = new FakeKV();
    await kv.put(KV_PREFIXES.member + 'P000197', 'x');
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'DELETE', 'cache/member/P000197');
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
    // Key should still be present.
    expect(kv.store.has(KV_PREFIXES.member + 'P000197')).toBe(true);
  });

  it('DELETE /cache/<unknown-slug>/<key> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'DELETE', 'cache/not-a-prefix/some-key?reason=x');
    expect(r.status).toBe(404);
  });

  it('PATCH /cache returns 400 method_not_allowed (unsupported method)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'PATCH', 'cache', { _reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'method_not_allowed' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                handleAudit                                 */
/* -------------------------------------------------------------------------- */

describe('api-admin: GET /audit (KV-first with D1 fallback)', () => {
  const KV_KEY = KV_PREFIXES.auditFeed + 'full';

  function seedKv(kv: FakeKV, items: Array<Record<string, unknown>>): void {
    kv.store.set(KV_KEY, JSON.stringify({ items }));
  }

  function seedD1Audit(d1: FakeD1, rows: Partial<Record<string, unknown>>[]): void {
    for (const row of rows) {
      d1.tables.audit_log!.push({
        id: 'aid_' + Math.random().toString(36).slice(2, 10),
        actor_email: 'alice@example.com',
        action: 'create',
        target_table: 'bills',
        row_id: 'row_x',
        row_title: 'r',
        before_json: null,
        after_json: null,
        reason: 'seed',
        trace_id: 'tr_x',
        created_at: '2026-05-01T12:00:00.000Z',
        ...row,
      });
    }
  }

  it('reads from KV when the projection record exists', async () => {
    const kv = new FakeKV();
    seedKv(kv, [
      { id: 'a1', action: 'create', target_table: 'bills', created_at: '2026-05-04T10:00:00.000Z' },
      { id: 'a2', action: 'update', target_table: 'bills', created_at: '2026-05-03T09:00:00.000Z' },
    ]);
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'GET', 'audit');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ source: 'kv' });
    expect((r.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('falls back to D1 when KV record is absent (source: d1-fallback)', async () => {
    const kv = new FakeKV(); // empty
    const d1 = new FakeD1();
    seedD1Audit(d1, [
      { id: 'a1', created_at: '2026-05-04T10:00:00.000Z' },
      { id: 'a2', created_at: '2026-05-03T09:00:00.000Z' },
    ]);
    const env = makeEnv(d1, kv);
    const r = await call(env, 'GET', 'audit');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ source: 'd1-fallback' });
    expect((r.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('?source=d1 forces D1 read even if KV record is present (source: d1)', async () => {
    const kv = new FakeKV();
    seedKv(kv, [
      { id: 'kv-only', created_at: '2026-05-04T10:00:00.000Z' },
    ]);
    const d1 = new FakeD1();
    seedD1Audit(d1, [{ id: 'd1-row', created_at: '2026-05-04T10:00:00.000Z' }]);
    const env = makeEnv(d1, kv);
    const r = await call(env, 'GET', 'audit?source=d1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ source: 'd1' });
    const items = (r.json as { items: Array<{ id: string }> }).items;
    expect(items.find((i) => i.id === 'kv-only')).toBeUndefined();
    expect(items.find((i) => i.id === 'd1-row')).toBeDefined();
  });

  it('?since=ISO filters KV items to the requested window', async () => {
    const kv = new FakeKV();
    seedKv(kv, [
      { id: 'newer', created_at: '2026-05-04T10:00:00.000Z' },
      { id: 'older', created_at: '2026-04-01T00:00:00.000Z' },
    ]);
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'GET', 'audit?since=2026-05-01T00:00:00.000Z');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ id: string }> }).items;
    expect(items.map((i) => i.id)).toEqual(['newer']);
  });

  it('?limit=N caps the number of items returned from KV', async () => {
    const kv = new FakeKV();
    seedKv(kv, [
      { id: 'a', created_at: '2026-05-04T10:00:00.000Z' },
      { id: 'b', created_at: '2026-05-04T09:00:00.000Z' },
      { id: 'c', created_at: '2026-05-04T08:00:00.000Z' },
    ]);
    const env = makeEnv(new FakeD1(), kv);
    const r = await call(env, 'GET', 'audit?limit=2');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('non-GET on /audit returns 400 method_not_allowed', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'audit', { _reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'method_not_allowed' });
  });
});

/* -------------------------------------------------------------------------- */
/*                       Top-level dispatch + small helpers                   */
/* -------------------------------------------------------------------------- */

describe('api-admin: dispatch top-level', () => {
  it('OPTIONS preflight returns 204 with Allow header', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    // Bypass call() because OPTIONS shouldn't carry the JWT/body shape.
    const result = await handleAdmin(
      'tags',
      new Request('https://worker.example/api/admin/tags', { method: 'OPTIONS' }),
      env,
      { waitUntil: () => {} },
      'https://embed.example',
      'tr_x',
      'test',
    );
    expect(result.response.status).toBe(204);
    expect(result.response.headers.get('Allow')).toContain('OPTIONS');
  });

  it('PUT (unsupported method) returns 405', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const result = await handleAdmin(
      'tags',
      new Request('https://worker.example/api/admin/tags', { method: 'PUT' }),
      env,
      { waitUntil: () => {} },
      'https://embed.example',
      'tr_x',
      'test',
    );
    expect(result.response.status).toBe(405);
  });

  it('returns 503 when D1 binding is missing', async () => {
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD, KV_VOTER_INFO: new FakeKV() } as unknown as ProxyEnv;
    const r = await call(env, 'GET', 'tags');
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ error: 'd1_unavailable' });
  });

  it('GET /whoami returns the authenticated email', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'whoami');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ email: 'alice@example.com' });
  });

  it('unknown resource returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'flibbertigibbets');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });

  it('POST without JSON Content-Type returns 415', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const req = new Request('https://worker.example/api/admin/tags', {
      method: 'POST',
      headers: { [ACCESS_JWT_HEADER]: jwt },
      body: 'not json',
    });
    const result = await handleAdmin(
      'tags', req, env, { waitUntil: () => {} },
      'https://embed.example', 'tr_x', 'test',
    );
    expect(result.response.status).toBe(415);
  });

  it('POST with malformed JSON body returns 400 invalid_body', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const req = new Request('https://worker.example/api/admin/tags', {
      method: 'POST',
      headers: { [ACCESS_JWT_HEADER]: jwt, 'Content-Type': 'application/json' },
      body: '{not valid',
    });
    const result = await handleAdmin(
      'tags', req, env, { waitUntil: () => {} },
      'https://embed.example', 'tr_x', 'test',
    );
    expect(result.response.status).toBe(400);
    const json = JSON.parse(await result.response.text());
    expect(json).toMatchObject({ error: 'invalid_body' });
  });

  it('POST with non-object JSON body returns 400 invalid_body', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'tags', ['not', 'an', 'object']);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_body' });
  });
});

/* -------------------------------------------------------------------------- */
/*                              handleListByBill                              */
/* -------------------------------------------------------------------------- */

describe('api-admin: /cosponsors and /actions (read-only by-bill listings)', () => {
  it('GET /cosponsors without billId returns 200 + empty items', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'cosponsors');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ items: [] });
  });

  it('GET /cosponsors?billId=X returns matching rows from bill_cosponsors', async () => {
    const d1 = new FakeD1();
    d1.tables['bill_cosponsors'] = [
      { id: 'c1', bill_id: '117-HR-2471', full_name: 'Smith' },
      { id: 'c2', bill_id: '117-HR-2471', full_name: 'Jones' },
      { id: 'c3', bill_id: '118-HR-8035', full_name: 'Doe' },
    ];
    const env = makeEnv(d1, new FakeKV());
    const r = await call(env, 'GET', 'cosponsors?billId=117-HR-2471');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toHaveLength(2);
  });

  it('GET /actions?billId=X returns matching rows from bill_actions', async () => {
    const d1 = new FakeD1();
    d1.tables['bill_actions'] = [
      { id: 'a1', bill_id: '117-HR-2471', action_text: 'Introduced' },
      { id: 'a2', bill_id: '118-HR-8035', action_text: 'Passed House' },
    ];
    const env = makeEnv(d1, new FakeKV());
    const r = await call(env, 'GET', 'actions?billId=117-HR-2471');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ id: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('a1');
  });

  it('POST /cosponsors returns 400 method_not_allowed (read-only)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'cosponsors', { _reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'method_not_allowed' });
  });
});

/* -------------------------------------------------------------------------- */
/*                              handleImportBill                              */
/* -------------------------------------------------------------------------- */

describe('api-admin: POST /import-bill', () => {
  it('POST with valid (congress, type, number) calls the importer and returns 200', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    (importBillFromCongress as unknown as { mockClear: () => void }).mockClear();
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117,
      type: 'HR',
      number: '2471',
    });
    expect(r.status).toBe(200);
    expect(importBillFromCongress).toHaveBeenCalledTimes(1);
  });

  it('GET on /import-bill is 400 method_not_allowed', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'import-bill');
    expect(r.status).toBe(400);
  });

  it('rejects non-integer / out-of-range congress', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 99,
      type: 'HR',
      number: '1',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_congress' });
  });

  it('rejects non-alphabetic type', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117,
      type: 'HR1',
      number: '1',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_type' });
  });

  it('rejects non-numeric number', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117,
      type: 'HR',
      number: 'foo',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_number' });
  });

  it('translates "bill_not_found" upstream error to 404', async () => {
    (importBillFromCongress as unknown as { mockImplementationOnce: (fn: () => unknown) => void })
      .mockImplementationOnce(() => { throw new Error('bill_not_found'); });
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117, type: 'HR', number: '2471',
    });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'bill_not_found' });
  });

  it('translates congress_upstream_* errors to 502', async () => {
    (importBillFromCongress as unknown as { mockImplementationOnce: (fn: () => unknown) => void })
      .mockImplementationOnce(() => { throw new Error('congress_upstream_503'); });
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117, type: 'HR', number: '2471',
    });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ error: 'upstream_failed' });
  });

  it('translates other thrown errors to 500', async () => {
    (importBillFromCongress as unknown as { mockImplementationOnce: (fn: () => unknown) => void })
      .mockImplementationOnce(() => { throw new Error('something else broke'); });
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'import-bill', {
      congress: 117, type: 'HR', number: '2471',
    });
    expect(r.status).toBe(500);
  });
});

// `POST /api/admin/backfill-bills` test block removed in v4.1.0.
// The route was deleted (ingest is now `lw bills backfill` in CI).
// CLI-side backfill tests live in tests/unit/bills/backfill.test.ts.
