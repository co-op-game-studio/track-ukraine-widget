/**
 * Extended coverage for proxy/routes/api-admin.ts — exercises the per-resource
 * handler tables (`bills`, `votes`, `comments`, `social-posts`, `quotes`) and
 * the cross-cutting error / dispatch branches that aren't covered by
 * `apiAdminRoutes.test.ts` (which focuses on /config, /tags, /cache, /audit,
 * /import-bill) or `adminRoutes.test.ts` (which focuses on
 * `_reason` plumbing and the `?billId=` filter shape).
 *
 * Goal: push api-admin.ts above 90% lines + 85% functions. The function gap
 * was the big one — list/get/create/update/remove for the social-posts and
 * quotes resources, plus get/update/remove for votes and comments, were all
 * unexercised. We add at least one happy-path test per uncovered handler and
 * one failure-path test for the error-translation paths in `handleResource`
 * (ValidationError → 400, FOREIGN KEY / UNIQUE → 500 with friendly text).
 *
 * Auth gate: same RS256 + JWKS-stub pattern as `apiAdminRoutes.test.ts`.
 * No `vi.mock` is used — every dependency is real, with a self-contained
 * FakeD1 / FakeKV stand-in for the bindings.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { handleAdmin } from '../../proxy/routes/api-admin';
import { clearJwksMemoCache, type Jwks } from '../../proxy/security/cf-access-jwt';
import { ACCESS_JWT_HEADER } from '../../proxy/security/admin-actor';
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
const KID = 'api-admin-routes-ext-kid';

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

/** FakeStmt — supports the queries this test file needs:
 *   - INSERT INTO <table> (cols) VALUES (?, …)            → push row
 *   - INSERT … ON CONFLICT … DO NOTHING                   → idempotent insert
 *   - UPDATE <table> SET ... WHERE id = ?                  → patch row by id
 *   - DELETE FROM <table> WHERE id = ?                     → drop row by id
 *   - DELETE FROM quote_tags WHERE quote_id = ?            → drop join rows
 *   - SELECT 1 FROM <table> WHERE col = ? LIMIT 1          → existence probe
 *   - SELECT * FROM <table> WHERE id = ?                   → row by id
 *   - SELECT * FROM <table> WHERE bill_id = ? [ORDER ...]  → by-bill listings
 *   - SELECT * FROM bills ORDER BY ... LIMIT ? OFFSET ?    → list bills
 *   - SELECT * FROM quotes WHERE bioguide_id = ? ORDER BY created_at DESC
 *       LIMIT ? OFFSET ?                                   → list by person
 *   - SELECT * FROM quotes ORDER BY created_at DESC LIMIT ? OFFSET ?
 *   - SELECT id, weight, direction FROM quotes WHERE source_url = ?
 *       AND bioguide_id = ?                                → quote dup check
 *   - failureMode: throw a custom error message on the next batch  */
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

    // Quote dup-check probe (admin-store.createQuote): match before generic SELECT.
    const dup = q.match(
      /^SELECT\s+id,\s+weight,\s+direction\s+FROM\s+quotes\s+WHERE\s+source_url\s*=\s*\?\s+AND\s+bioguide_id\s*=\s*\?/i,
    );
    if (dup) {
      const rows = (this.d1.tables.quotes ?? []).filter(
        (r) => r['source_url'] === this.bindings[0] && r['bioguide_id'] === this.bindings[1],
      );
      return { success: true, results: rows };
    }

    const ins = q.match(/^INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (ins) {
      const table = ins[1]!;
      const cols = ins[2]!.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = this.bindings[i] ?? null; });
      if (!this.d1.tables[table]) this.d1.tables[table] = [];
      // Honor ON CONFLICT DO NOTHING for researchers: skip dupes by email.
      if (table === 'researchers' && /ON\s+CONFLICT/i.test(q)) {
        const exists = this.d1.tables[table]!.some((r) => r['email'] === row['email']);
        if (exists) return { success: true, meta: { changes: 0 } };
      }
      // Failure injection: throw if this insert is the targeted table.
      if (this.d1.failOnInsert === table) {
        this.d1.failOnInsert = null;
        throw new Error(this.d1.failMessage ?? 'forced failure');
      }
      this.d1.tables[table]!.push(row);
      return { success: true, meta: { changes: 1 } };
    }

    const upd = q.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+id\s*=\s*\?/is);
    if (upd) {
      const table = upd[1]!;
      const fields = upd[2]!.split(',').map((f) => f.split('=')[0]!.trim());
      const id = this.bindings[this.bindings.length - 1] as string;
      const rows = this.d1.tables[table] ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx === -1) return { success: true, meta: { changes: 0 } };
      const row = { ...rows[idx]! };
      fields.forEach((f, i) => { row[f] = this.bindings[i] ?? null; });
      rows[idx] = row;
      return { success: true, meta: { changes: 1 } };
    }

    const delById = q.match(/^DELETE\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i);
    if (delById) {
      const table = delById[1]!;
      const id = this.bindings[0] as string;
      const rows = this.d1.tables[table] ?? [];
      const idx = rows.findIndex((r) => r['id'] === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } };
    }
    const delByQuote = q.match(/^DELETE\s+FROM\s+quote_tags\s+WHERE\s+quote_id\s*=\s*\?/i);
    if (delByQuote) {
      const id = this.bindings[0] as string;
      const rows = this.d1.tables.quote_tags ?? [];
      this.d1.tables.quote_tags = rows.filter((r) => r['quote_id'] !== id);
      return { success: true, meta: { changes: 1 } };
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

    // SELECT * FROM <table> WHERE bioguide_id = ? ORDER BY ... LIMIT ? OFFSET ?
    const selByBioguide = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+bioguide_id\s*=\s*\?/i);
    if (selByBioguide) {
      const table = selByBioguide[1]!;
      const id = this.bindings[0];
      const rows = (this.d1.tables[table] ?? []).filter((r) => r['bioguide_id'] === id);
      // If LIMIT/OFFSET were bound, slice.
      if (this.bindings.length >= 3) {
        const limit = Number(this.bindings[1]);
        const offset = Number(this.bindings[2]);
        return { success: true, results: rows.slice(offset, offset + limit) };
      }
      return { success: true, results: rows };
    }

    // SELECT * FROM <table> WHERE bill_id = ? [ORDER BY ...]
    const byBill = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+bill_id\s*=\s*\?/i);
    if (byBill) {
      const table = byBill[1]!;
      const rows = (this.d1.tables[table] ?? []).filter(
        (r) => r['bill_id'] === this.bindings[0],
      );
      return { success: true, results: rows };
    }

    // SELECT * FROM <table> ORDER BY ... LIMIT ? OFFSET ?
    const selOrderLimit = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+ORDER\s+BY/i);
    if (selOrderLimit) {
      const table = selOrderLimit[1]!;
      const rows = this.d1.tables[table] ?? [];
      if (this.bindings.length >= 2) {
        const limit = Number(this.bindings[0]);
        const offset = Number(this.bindings[1]);
        return { success: true, results: rows.slice(offset, offset + limit) };
      }
      if (this.bindings.length === 1) {
        const limit = Number(this.bindings[0]);
        return { success: true, results: rows.slice(0, limit) };
      }
      return { success: true, results: rows };
    }

    // tags-store INNER JOIN queries → return empty (no tags applied) so the
    // route-layer enrichment paths execute without us seeding the join table.
    if (/INNER\s+JOIN\s+quote_tags/i.test(q)) {
      return { success: true, results: [] };
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
  /** Test hook: name the next INSERT-target that should throw. */
  failOnInsert: string | null = null;
  failMessage: string | null = null;

  prepare(q: string) { return new FakeStmt(this, q); }
  async batch<T>(stmts: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const snapshot = JSON.parse(JSON.stringify(this.tables));
    const out: D1ResultLike<T>[] = [];
    try {
      for (const s of stmts) out.push(await s.run() as D1ResultLike<T>);
      return out;
    } catch (err) {
      this.tables = snapshot;
      // Mimic real D1: surface the error so runMutationWithAudit re-throws it.
      throw err;
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

function makeEnv(d1: FakeD1, kv: FakeKV): ProxyEnv {
  return {
    CF_ACCESS_TEAM: TEAM,
    CF_ACCESS_AUD: AUD,
    D1_VOTER_INFO: d1,
    KV_VOTER_INFO: kv,
  } as unknown as ProxyEnv;
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

/** Seed a bill via the API so the audit + researcher rows are realistic. */
async function seedBill(env: ProxyEnv, billId: string): Promise<string> {
  const [c, t, n] = billId.split('-');
  const r = await call(env, 'POST', 'bills', {
    bill_id: billId,
    congress: Number(c),
    type: t,
    number: n,
    title: `Title for ${billId}`,
    direction: 'pro-ukraine',
    _reason: 'seed',
  });
  expect(r.status).toBe(201);
  return (r.json as { row: { id: string } }).row.id;
}

/* -------------------------------------------------------------------------- */
/*                            Bills resource handlers                         */
/* -------------------------------------------------------------------------- */

describe('api-admin: /bills resource handlers', () => {
  it('GET /bills lists every bill', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedBill(env, '117-HR-2471');
    await seedBill(env, '118-HR-8035');
    const r = await call(env, 'GET', 'bills');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ bill_id: string }> }).items;
    expect(items).toHaveLength(2);
    expect(items.map((b) => b.bill_id).sort()).toEqual(['117-HR-2471', '118-HR-8035']);
  });

  it('GET /bills/<id> returns the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const id = await seedBill(env, '117-HR-2471');
    const r = await call(env, 'GET', `bills/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, bill_id: '117-HR-2471' });
  });

  it('GET /bills/<unknown-id> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'bills/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });
});

/* -------------------------------------------------------------------------- */
/*                            Votes resource handlers                         */
/* -------------------------------------------------------------------------- */

describe('api-admin: /votes resource handlers', () => {
  async function seedVote(env: ProxyEnv, billId: string, rollCall = 65): Promise<string> {
    const r = await call(env, 'POST', 'votes', {
      bill_id: billId,
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: rollCall,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
      _reason: 'seed',
    });
    expect(r.status).toBe(201);
    return (r.json as { row: { id: string } }).row.id;
  }

  it('GET /votes/<id> returns the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedBill(env, '117-HR-2471');
    const id = await seedVote(env, '117-HR-2471');
    const r = await call(env, 'GET', `votes/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, roll_call: 65 });
  });

  it('GET /votes/<unknown-id> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'votes/missing');
    expect(r.status).toBe(404);
  });

  it('PATCH /votes/<id> with _reason updates and returns 200', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedBill(env, '117-HR-2471');
    const id = await seedVote(env, '117-HR-2471');
    const r = await call(env, 'PATCH', `votes/${id}`, {
      weight: 3,
      _reason: 'reweight after analysis',
    });
    expect(r.status).toBe(200);
    expect((r.json as { row: { weight: number } }).row.weight).toBe(3);
  });

  it('DELETE /votes/<id> with ?reason= removes the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    await seedBill(env, '117-HR-2471');
    const id = await seedVote(env, '117-HR-2471');
    const r = await call(env, 'DELETE', `votes/${id}?reason=duplicate`);
    expect(r.status).toBe(200);
    expect(d1.tables.votes!.some((v) => v['id'] === id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Comments resource handlers                        */
/* -------------------------------------------------------------------------- */

describe('api-admin: /comments resource handlers', () => {
  async function seedComment(env: ProxyEnv, billId: string, body = 'Body'): Promise<string> {
    const r = await call(env, 'POST', 'comments', {
      bill_id: billId,
      body_markdown: body,
      weight: 1,
      direction: 1,
      _reason: 'seed',
    });
    expect(r.status).toBe(201);
    return (r.json as { row: { id: string } }).row.id;
  }

  it('GET /comments/<id> returns the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedBill(env, '117-HR-2471');
    const id = await seedComment(env, '117-HR-2471', 'Senate amendment context');
    const r = await call(env, 'GET', `comments/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, body_markdown: 'Senate amendment context' });
  });

  it('GET /comments/<unknown-id> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'comments/missing');
    expect(r.status).toBe(404);
  });

  it('PATCH /comments/<id> with _reason updates and returns 200', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedBill(env, '117-HR-2471');
    const id = await seedComment(env, '117-HR-2471');
    const r = await call(env, 'PATCH', `comments/${id}`, {
      body_markdown: 'updated text',
      _reason: 'rewrite for clarity',
    });
    expect(r.status).toBe(200);
    expect((r.json as { row: { body_markdown: string } }).row.body_markdown).toBe('updated text');
  });

  it('DELETE /comments/<id> with ?reason= removes the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    await seedBill(env, '117-HR-2471');
    const id = await seedComment(env, '117-HR-2471');
    const r = await call(env, 'DELETE', `comments/${id}?reason=spam`);
    expect(r.status).toBe(200);
    expect(d1.tables.comments!.some((c) => c['id'] === id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                       Social-posts resource handlers                       */
/* -------------------------------------------------------------------------- */

describe('api-admin: /social-posts resource handlers', () => {
  async function seedSocial(env: ProxyEnv, url = 'https://x.com/sen/status/1'): Promise<string> {
    const r = await call(env, 'POST', 'social-posts', {
      bioguide_id: 'P000197',
      platform: 'x',
      url,
      body_text: 'A statement on Ukraine aid.',
      weight: 1,
      direction: 1,
      _reason: 'seed',
    });
    expect(r.status).toBe(201);
    return (r.json as { row: { id: string } }).row.id;
  }

  it('GET /social-posts (list) returns empty items (bulk listing out of scope)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedSocial(env);
    const r = await call(env, 'GET', 'social-posts');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ items: [] });
  });

  it('GET /social-posts/<id> returns the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const id = await seedSocial(env);
    const r = await call(env, 'GET', `social-posts/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, platform: 'x' });
  });

  it('GET /social-posts/<unknown-id> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'social-posts/missing');
    expect(r.status).toBe(404);
  });

  it('PATCH /social-posts/<id> with _reason updates and returns 200', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const id = await seedSocial(env);
    const r = await call(env, 'PATCH', `social-posts/${id}`, {
      weight: 2,
      _reason: 'increase salience',
    });
    expect(r.status).toBe(200);
    expect((r.json as { row: { weight: number } }).row.weight).toBe(2);
  });

  it('DELETE /social-posts/<id> with ?reason= removes the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    const id = await seedSocial(env);
    const r = await call(env, 'DELETE', `social-posts/${id}?reason=cleanup`);
    expect(r.status).toBe(200);
    expect(d1.tables.social_posts!.some((s) => s['id'] === id)).toBe(false);
  });

  it('POST /social-posts with invalid platform returns 400 (ValidationError path)', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'social-posts', {
      bioguide_id: 'P000197',
      platform: 'tiktok-not-supported',
      url: 'https://x.com/x/status/1',
      body_text: 'x',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_platform' });
  });
});

/* -------------------------------------------------------------------------- */
/*                          Quotes resource handlers                          */
/* -------------------------------------------------------------------------- */

describe('api-admin: /quotes resource handlers', () => {
  async function seedQuote(env: ProxyEnv, sourceUrl: string, opts: Partial<{
    bioguide_id: string;
    body_text: string;
  }> = {}): Promise<string> {
    const r = await call(env, 'POST', 'quotes', {
      bioguide_id: opts.bioguide_id ?? 'P000197',
      media_kind: 'video',
      source_url: sourceUrl,
      body_text: opts.body_text ?? 'A quote about Ukraine.',
      weight: 1,
      direction: 1,
      _reason: 'seed',
    });
    expect(r.status).toBe(201);
    return (r.json as { row: { id: string } }).row.id;
  }

  it('GET /quotes (list, no filters) returns all rows with empty tags', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedQuote(env, 'https://example.com/v/1');
    await seedQuote(env, 'https://example.com/v/2');
    const r = await call(env, 'GET', 'quotes');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ id: string; tags: unknown[] }> }).items;
    expect(items).toHaveLength(2);
    // Enrichment path: every quote has a tags array (empty in this fixture).
    expect(items.every((q) => Array.isArray(q.tags))).toBe(true);
  });

  it('GET /quotes?bioguideId=… filters by person', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    await seedQuote(env, 'https://example.com/v/3', { bioguide_id: 'P000197' });
    await seedQuote(env, 'https://example.com/v/4', { bioguide_id: 'B001230' });
    const r = await call(env, 'GET', 'quotes?bioguideId=P000197');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ bioguide_id: string }> }).items;
    expect(items.every((q) => q.bioguide_id === 'P000197')).toBe(true);
  });

  it('GET /quotes/<id> returns the row + tags', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const id = await seedQuote(env, 'https://example.com/v/5');
    const r = await call(env, 'GET', `quotes/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, tags: [] });
  });

  it('GET /quotes/<unknown-id> returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'quotes/missing');
    expect(r.status).toBe(404);
  });

  it('POST /quotes returns 201 with row + tags array', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'quotes', {
      bioguide_id: 'P000197',
      media_kind: 'text',
      source_url: 'https://example.com/v/6',
      body_text: 'Floor speech excerpt.',
      weight: 1,
      direction: 1,
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ row: { tags: [] } });
  });

  it('PATCH /quotes/<id> with _reason updates and returns 200', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const id = await seedQuote(env, 'https://example.com/v/7');
    const r = await call(env, 'PATCH', `quotes/${id}`, {
      body_text: 'Revised excerpt.',
      _reason: 'fix transcription',
    });
    expect(r.status).toBe(200);
    expect((r.json as { row: { body_text: string } }).row.body_text).toBe('Revised excerpt.');
  });

  it('PATCH /quotes/<id> with tag_ids reassigns the tag set', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    const id = await seedQuote(env, 'https://example.com/v/8');
    // Pre-seed a tag id directly so the tag-set update has something to write.
    d1.tables.tags!.push({
      id: 'tag-foreign-policy', slug: 'foreign-policy', label: 'Foreign Policy',
      color: '#ef4444', description: null, created_at: 'now', created_by: null,
      updated_at: 'now', updated_by: null,
    });
    const r = await call(env, 'PATCH', `quotes/${id}`, {
      body_text: 'still revising',
      tag_ids: ['tag-foreign-policy'],
      _reason: 'add tag',
    });
    expect(r.status).toBe(200);
    // The tag-set replacement should have inserted into quote_tags.
    expect(d1.tables.quote_tags!.some(
      (qt) => qt['quote_id'] === id && qt['tag_id'] === 'tag-foreign-policy',
    )).toBe(true);
  });

  it('DELETE /quotes/<id> with ?reason= removes the row', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    const id = await seedQuote(env, 'https://example.com/v/9');
    const r = await call(env, 'DELETE', `quotes/${id}?reason=incorrect`);
    expect(r.status).toBe(200);
    expect(d1.tables.quotes!.some((q) => q['id'] === id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*               handleResource: cross-cutting dispatch + errors              */
/* -------------------------------------------------------------------------- */

describe('api-admin: handleResource dispatch + error translation', () => {
  it('POST with an id segment returns 400 invalid_path', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'bills/bogus-id', { _reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_path' });
  });

  it('PATCH without an id segment returns 400 invalid_path', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'PATCH', 'bills', { _reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_path' });
  });

  it('DELETE without an id segment returns 400 invalid_path', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'DELETE', 'bills?reason=x');
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid_path' });
  });

  it('unknown sub-action under a resource returns 404', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'bills/some-id/unsupported');
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: 'not_found' });
  });

  it('ValidationError (e.g. unknown bill_id on vote create) → 400 with code', async () => {
    // Don't seed a bill — createVote will raise ValidationError('unknown_bill_id').
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'POST', 'votes', {
      bill_id: '117-HR-9999',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 1,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'unknown_bill_id' });
  });

  it('FOREIGN KEY raw error → 500 with friendly text', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    await seedBill(env, '117-HR-2471');
    // Force the next insert into `votes` to throw a FOREIGN-KEY-shaped error.
    d1.failOnInsert = 'votes';
    d1.failMessage = 'D1_ERROR: FOREIGN KEY constraint failed';
    const r = await call(env, 'POST', 'votes', {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 1,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    expect(r.status).toBe(500);
    expect((r.json as { detail: string }).detail).toMatch(/referenced record/i);
  });

  it('UNIQUE constraint raw error → 500 with friendly "duplicate" text', async () => {
    const env = makeEnv(new FakeD1(), new FakeKV());
    const d1 = env.D1_VOTER_INFO as unknown as FakeD1;
    await seedBill(env, '117-HR-2471');
    d1.failOnInsert = 'votes';
    d1.failMessage = 'D1_ERROR: UNIQUE constraint failed: votes.bill_id';
    const r = await call(env, 'POST', 'votes', {
      bill_id: '117-HR-2471',
      chamber: 'House',
      congress: 117,
      session: 2,
      roll_call: 1,
      date: '2022-03-10',
      weight: 1,
      kind: 'concur',
    });
    expect(r.status).toBe(500);
    expect((r.json as { detail: string }).detail).toMatch(/duplicate/i);
  });
});

/* -------------------------------------------------------------------------- */
/*                       Top-level dispatch: small remainders                 */
/* -------------------------------------------------------------------------- */

describe('api-admin: dispatch remainders', () => {
  it('GET /ingest/categories delegates to handleIngest and returns 200', async () => {
    // Exercises the resource === "ingest" branch (lines 121-126) without
    // exercising the full ingest surface. `categories` is a deterministic
    // GET that requires no D1/KV data.
    const env = makeEnv(new FakeD1(), new FakeKV());
    const r = await call(env, 'GET', 'ingest/categories');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ categories: expect.any(Array) });
  });
});
