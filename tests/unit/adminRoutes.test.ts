/**
 * Tests for proxy/routes/api-admin.ts — change-notes (`_reason`) handling.
 * Traces to FR-50 AC-50.8.
 *
 * The route layer is responsible for two things on top of the store:
 *   1. Strip `_reason` out of the body so it never lands as a column key.
 *   2. Enforce that `_reason` is REQUIRED on PATCH and DELETE (400 reason_required).
 *
 * To exercise these we bypass the JWT verifier by stubbing the global
 * fetch JWKS endpoint and minting a real RS256 token, then invoke
 * `handleAdmin` directly through the router's dispatch shape.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleAdmin } from '../../proxy/routes/api-admin';
import { clearJwksMemoCache, type Jwks } from '../../proxy/security/cf-access-jwt';
import { ACCESS_JWT_HEADER } from '../../proxy/security/admin-actor';
import type { ProxyEnv, D1Like, D1PreparedStatementLike, D1ResultLike } from '../../proxy/env';

const TEAM = 'cogs';
const AUD = 'a'.repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const KID = 'admin-routes-kid';

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
      const rows = this.d1.tables[table]!;
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
    const byBill = q.match(/^SELECT\s+\*\s+FROM\s+(\w+)\s+WHERE\s+bill_id\s*=\s*\?/i);
    if (byBill) {
      const table = byBill[1]!;
      const rows = (this.d1.tables[table] ?? []).filter(
        (r) => r['bill_id'] === this.bindings[0],
      );
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
    audit_log: [], score_adjustments: [], researchers: [],
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

function makeEnv(d1: FakeD1): ProxyEnv {
  return {
    CF_ACCESS_TEAM: TEAM,
    CF_ACCESS_AUD: AUD,
    D1_VOTER_INFO: d1,
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
  d1: FakeD1,
  method: string,
  rest: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  // Mirror what proxy/router.ts#dispatch does: keep the query string on the
  // Request URL, but pass `rest` (the path-only portion) to handleAdmin.
  const path = `/api/admin/${rest}`;
  const queryIdx = rest.indexOf('?');
  const restPathOnly = queryIdx >= 0 ? rest.slice(0, queryIdx) : rest;
  const result = await handleAdmin(
    restPathOnly,
    makeRequest(method, path, body),
    makeEnv(d1),
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
/*                              Tests: AC-50.8                                */
/* -------------------------------------------------------------------------- */

describe('api-admin: change-notes (FR-50 AC-50.8)', () => {
  it('CREATE accepts body without _reason (reason optional on create)', async () => {
    const d1 = new FakeD1();
    const r = await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
    });
    expect(r.status).toBe(201);
  });

  it('CREATE strips _reason from body so it doesn\'t land as a column', async () => {
    const d1 = new FakeD1();
    const r = await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'initial seed',
    });
    expect(r.status).toBe(201);
    const created = (r.json as { row: Record<string, unknown> }).row;
    // The bill row should have NO `_reason` key — it was stripped.
    expect(Object.keys(created)).not.toContain('_reason');
    // And the audit row's reason should be populated.
    const audits = d1.tables.audit_log!;
    expect(audits[0]!['reason']).toBe('initial seed');
  });

  it('PATCH without _reason returns 400 reason_required', async () => {
    const d1 = new FakeD1();
    await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    const billId = (d1.tables.bills![0]!['id'] as string);
    const r = await call(d1, 'PATCH', `bills/${billId}`, { title: 'updated' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
  });

  it('PATCH with whitespace-only _reason returns 400 reason_required', async () => {
    const d1 = new FakeD1();
    await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    const billId = (d1.tables.bills![0]!['id'] as string);
    const r = await call(d1, 'PATCH', `bills/${billId}`, {
      title: 'u',
      _reason: '   \t\n  ',
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
  });

  it('PATCH with non-empty _reason succeeds and stamps audit_log.reason', async () => {
    const d1 = new FakeD1();
    await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    const billId = (d1.tables.bills![0]!['id'] as string);
    const r = await call(d1, 'PATCH', `bills/${billId}`, {
      featured: true,
      _reason: 'flag for ranking review',
    });
    expect(r.status).toBe(200);
    const update = d1.tables.audit_log!.find(
      (a) => a['action'] === 'update' && a['target_table'] === 'bills',
    );
    expect(update).toBeDefined();
    expect(update!['reason']).toBe('flag for ranking review');
  });

  it('DELETE without reason (body or query) returns 400 reason_required', async () => {
    const d1 = new FakeD1();
    await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    const billId = (d1.tables.bills![0]!['id'] as string);
    const r = await call(d1, 'DELETE', `bills/${billId}`);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'reason_required' });
  });

  it('DELETE accepts ?reason=… query param and stamps audit_log.reason', async () => {
    const d1 = new FakeD1();
    await call(d1, 'POST', 'bills', {
      bill_id: '117-HR-2471',
      congress: 117,
      type: 'HR',
      number: '2471',
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    const billId = (d1.tables.bills![0]!['id'] as string);
    const r = await call(
      d1,
      'DELETE',
      `bills/${billId}?reason=duplicate%20of%20118-HR-815`,
    );
    expect(r.status).toBe(200);
    const del = d1.tables.audit_log!.find((a) => a['action'] === 'delete');
    expect(del).toBeDefined();
    expect(del!['reason']).toBe('duplicate of 118-HR-815');
  });
});

/* -------------------------------------------------------------------------- */
/*                          Tests: AC-52.22 (billId list)                     */
/* -------------------------------------------------------------------------- */

describe('api-admin: GET ?billId=… filtered listings (AC-52.22)', () => {
  async function seedBill(d1: FakeD1, billId: string): Promise<string> {
    const r = await call(d1, 'POST', 'bills', {
      bill_id: billId,
      congress: 117,
      type: 'HR',
      number: billId.split('-').pop()!,
      title: 't',
      direction: 'pro-ukraine',
      _reason: 'seed',
    });
    return (r.json as { row: { id: string } }).row.id;
  }

  async function seedVote(d1: FakeD1, billId: string, rollCall: number): Promise<void> {
    const r = await call(d1, 'POST', 'votes', {
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
  }

  async function seedComment(d1: FakeD1, billId: string, body: string): Promise<void> {
    const r = await call(d1, 'POST', 'comments', {
      bill_id: billId,
      body_markdown: body,
      weight: 0,
      direction: 0,
      _reason: 'seed',
    });
    expect(r.status).toBe(201);
  }

  it('AC-52.22(a): GET /votes?billId=X returns rows whose bill_id matches', async () => {
    const d1 = new FakeD1();
    await seedBill(d1, '117-HR-2471');
    await seedBill(d1, '118-HR-8035');
    await seedVote(d1, '117-HR-2471', 65);
    await seedVote(d1, '117-HR-2471', 66);
    await seedVote(d1, '118-HR-8035', 149);

    const r = await call(d1, 'GET', 'votes?billId=117-HR-2471');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ bill_id: string; roll_call: number }> }).items;
    expect(items).toHaveLength(2);
    expect(items.every((v) => v.bill_id === '117-HR-2471')).toBe(true);
  });

  it('AC-52.22(b): GET /votes?billId=X with no matches returns 200 + empty items', async () => {
    const d1 = new FakeD1();
    await seedBill(d1, '117-HR-2471');
    const r = await call(d1, 'GET', 'votes?billId=119-HR-9999');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toEqual([]);
  });

  it('AC-52.22(c): GET /votes without billId returns empty items (bulk listing out of scope)', async () => {
    const d1 = new FakeD1();
    await seedBill(d1, '117-HR-2471');
    await seedVote(d1, '117-HR-2471', 65);
    const r = await call(d1, 'GET', 'votes');
    expect(r.status).toBe(200);
    expect((r.json as { items: unknown[] }).items).toEqual([]);
  });

  it('AC-52.22(d): GET /comments?billId=X returns matching comment rows', async () => {
    const d1 = new FakeD1();
    await seedBill(d1, '117-HR-2471');
    await seedBill(d1, '118-HR-8035');
    await seedComment(d1, '117-HR-2471', 'Bipartisan support note');
    await seedComment(d1, '117-HR-2471', 'Senate amendment context');
    await seedComment(d1, '118-HR-8035', 'House passage note');

    const r = await call(d1, 'GET', 'comments?billId=117-HR-2471');
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ bill_id: string }> }).items;
    expect(items).toHaveLength(2);
    expect(items.every((c) => c.bill_id === '117-HR-2471')).toBe(true);
  });
});
