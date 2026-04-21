/**
 * /api/bills/{billId} — handleBill route handler.
 * Traces: FR-32 AC-32.2.
 */
import { describe, it, expect } from 'vitest';
import { handleFetch, type ProxyEnv, type CacheLike } from '../../../proxy/lib';

function makeFakeKV(store: Record<string, string> = {}): ProxyEnv['KV_VOTER_INFO'] {
  return {
    async get(key: string) { return store[key] ?? null; },
    async put(key: string, value: string) { store[key] = value; },
    async list({ prefix }: { prefix: string }) {
      return { keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    async delete(key: string) { delete store[key]; },
  };
}

function makeFakeCache(): CacheLike {
  const store = new Map<string, Response>();
  return {
    async match(req: Request | string) {
      const key = typeof req === 'string' ? req : req.url;
      return store.get(key)?.clone();
    },
    async put(req: Request | string, resp: Response) {
      const key = typeof req === 'string' ? req : req.url;
      store.set(key, resp);
    },
  };
}

function makeEnv(kvStore: Record<string, string> = {}): ProxyEnv {
  return {
    CONGRESS_API_KEY: 'TEST',
    ALLOWED_ORIGINS: 'https://trackukraine.com',
    KV_VOTER_INFO: makeFakeKV(kvStore),
    ENV_NAME: 'dev',
  };
}

describe('handleBill — 400 on invalid bill-id shape', () => {
  it('rejects a bill-id that contains punctuation', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bills/HR-815', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'invalid_bill_id' });
  });

  it('routes /api/bills/ (trailing slash, no id) through the fallthrough 404 path', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bills/', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    // The KV-route regex requires a non-empty rest; trailing-slash URLs
    // that don't supply a bill-id bypass the handler and hit the
    // unknown-path branch.
    expect(r.status).toBe(404);
  });

  it('returns 404 with the bill-id echoed when the KV record is missing', async () => {
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bills/HR42', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      makeEnv(),
      makeFakeCache(),
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'bill_not_found', billId: 'HR42' });
  });

  it('returns 200 with the stored JSON when the KV record exists', async () => {
    const env = makeEnv({ 'bill:v1:HR42': JSON.stringify({ billId: 'HR42', title: 'Test bill' }) });
    const r = await handleFetch(
      new Request('https://vote.cogs.it.com/api/bills/HR42', {
        headers: { Origin: 'https://trackukraine.com' },
      }),
      env,
      makeFakeCache(),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ billId: 'HR42', title: 'Test bill' });
  });
});
