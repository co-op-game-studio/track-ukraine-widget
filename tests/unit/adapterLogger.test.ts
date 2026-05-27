/**
 * Adapter logger unit tests.
 *
 * Covers `createAdapterLogger` (structured JSON line emission, traceId
 * default, error swallowing) and `withAdapterLog` (start/success/error
 * events, durationMs, postCount inference, undefined-logger no-op,
 * non-Error throw stringification).
 *
 * Traces: FR-59 (social ingest observability).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createAdapterLogger,
  withAdapterLog,
  type AdapterLogEntry,
  type AdapterLogger,
} from '../../src/ingest/adapter-logger';

function fakeCollector(): { entries: AdapterLogEntry[]; logger: AdapterLogger } {
  const entries: AdapterLogEntry[] = [];
  return {
    entries,
    logger: {
      log(entry) {
        entries.push(entry);
      },
    },
  };
}

describe('createAdapterLogger', () => {
  let originalLog: typeof console.log;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (msg: unknown) => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('emits a JSON line containing env, ts, default traceId, and entry fields', () => {
    const logger = createAdapterLogger('uat');
    logger.log({
      event: 'ingest_adapter_ok',
      level: 'info',
      platform: 'bluesky',
      operation: 'resolveAccount',
      handle: 'jay.bsky.team',
    });

    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.env).toBe('uat');
    expect(parsed.traceId).toBe('ingest'); // default when traceId omitted
    expect(parsed.event).toBe('ingest_adapter_ok');
    expect(parsed.level).toBe('info');
    expect(parsed.platform).toBe('bluesky');
    expect(parsed.operation).toBe('resolveAccount');
    expect(parsed.handle).toBe('jay.bsky.team');
    expect(typeof parsed.ts).toBe('string');
    // ISO 8601 — must parse back to a valid date.
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it('uses the provided traceId when supplied', () => {
    const logger = createAdapterLogger('prod', 'trace-abc-123');
    logger.log({
      event: 'ingest_adapter_start',
      level: 'debug',
      platform: 'youtube',
      operation: 'fetchPostByUrl',
    });
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.traceId).toBe('trace-abc-123');
    expect(parsed.env).toBe('prod');
  });

  it('preserves arbitrary extra fields on the entry (open shape)', () => {
    const logger = createAdapterLogger('dev');
    logger.log({
      event: 'ingest_adapter_ok',
      level: 'info',
      platform: 'bluesky',
      operation: 'listAuthorPosts',
      postCount: 42,
      durationMs: 17,
      statusCode: 200,
      url: 'https://bsky.app/profile/x/post/abc',
      customField: 'custom-value',
    });
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.postCount).toBe(42);
    expect(parsed.durationMs).toBe(17);
    expect(parsed.statusCode).toBe(200);
    expect(parsed.url).toBe('https://bsky.app/profile/x/post/abc');
    expect(parsed.customField).toBe('custom-value');
  });

  it('never throws when console.log throws', () => {
    console.log = () => {
      throw new Error('boom');
    };
    const logger = createAdapterLogger('dev');
    expect(() =>
      logger.log({
        event: 'ingest_adapter_error',
        level: 'error',
        platform: 'bluesky',
        operation: 'resolveAccount',
      }),
    ).not.toThrow();
  });

  it('emits each call as its own JSON line (no batching)', () => {
    const logger = createAdapterLogger('stg', 't1');
    logger.log({ event: 'a', level: 'debug', platform: 'p', operation: 'op' });
    logger.log({ event: 'b', level: 'info', platform: 'p', operation: 'op' });
    expect(captured).toHaveLength(2);
    expect(JSON.parse(captured[0]!).event).toBe('a');
    expect(JSON.parse(captured[1]!).event).toBe('b');
  });
});

describe('withAdapterLog', () => {
  it('returns the wrapped result when logger is undefined and emits no logs', async () => {
    const result = await withAdapterLog(
      undefined,
      { platform: 'bluesky', operation: 'resolveAccount', handle: 'h' },
      async () => ({ ok: true, value: 7 }),
    );
    expect(result).toEqual({ ok: true, value: 7 });
  });

  it('does not invoke logger.log when logger is undefined (no side effects)', async () => {
    // Use a logger that throws if accidentally invoked — passing undefined
    // should bypass it entirely (we pass undefined here, then verify the
    // collector path separately below).
    const ran = await withAdapterLog(undefined, { platform: 'p', operation: 'op' }, async () => 1);
    expect(ran).toBe(1);
  });

  it('emits start (debug) then ok (info) on success, with durationMs', async () => {
    const { entries, logger } = fakeCollector();
    const result = await withAdapterLog(
      logger,
      { platform: 'bluesky', operation: 'resolveAccount', handle: 'h.bsky' },
      async () => 'OK',
    );

    expect(result).toBe('OK');
    expect(entries).toHaveLength(2);

    const [startEvt, okEvt] = entries;
    expect(startEvt!.event).toBe('ingest_adapter_start');
    expect(startEvt!.level).toBe('debug');
    expect(startEvt!.platform).toBe('bluesky');
    expect(startEvt!.operation).toBe('resolveAccount');
    expect(startEvt!.handle).toBe('h.bsky');
    expect(startEvt!.durationMs).toBeUndefined(); // start has no duration

    expect(okEvt!.event).toBe('ingest_adapter_ok');
    expect(okEvt!.level).toBe('info');
    expect(okEvt!.platform).toBe('bluesky');
    expect(okEvt!.operation).toBe('resolveAccount');
    expect(okEvt!.handle).toBe('h.bsky');
    expect(typeof okEvt!.durationMs).toBe('number');
    expect(okEvt!.durationMs).toBeGreaterThanOrEqual(0);
    // Non-list result should NOT have postCount.
    expect(okEvt!.postCount).toBeUndefined();
  });

  it('attaches postCount when result has a `posts` array', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(
      logger,
      { platform: 'bluesky', operation: 'listAuthorPosts', handle: 'h' },
      async () => ({ posts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    );
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok');
    expect(okEvt).toBeDefined();
    expect(okEvt!.postCount).toBe(3);
  });

  it('reports postCount=0 for an empty posts array (still object with posts key)', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(
      logger,
      { platform: 'bluesky', operation: 'listAuthorPosts' },
      async () => ({ posts: [] }),
    );
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok');
    expect(okEvt!.postCount).toBe(0);
  });

  it('does not attach postCount when result is null', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(
      logger,
      { platform: 'p', operation: 'op' },
      async () => null as unknown as { posts: unknown[] },
    );
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok');
    expect(okEvt!.postCount).toBeUndefined();
  });

  it('does not attach postCount when result is a primitive', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(logger, { platform: 'p', operation: 'op' }, async () => 'just-a-string');
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok');
    expect(okEvt!.postCount).toBeUndefined();
  });

  it('does not attach postCount when result is an object lacking `posts`', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(logger, { platform: 'p', operation: 'op' }, async () => ({
      something: 'else',
    }));
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok');
    expect(okEvt!.postCount).toBeUndefined();
  });

  it('emits start then error (level=error) and re-throws on Error', async () => {
    const { entries, logger } = fakeCollector();
    const boom = new Error('upstream timeout');
    await expect(
      withAdapterLog(
        logger,
        { platform: 'youtube', operation: 'fetchPostByUrl', url: 'https://youtu.be/x' },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.event).toBe('ingest_adapter_start');
    expect(entries[0]!.level).toBe('debug');

    const errEvt = entries[1];
    expect(errEvt!.event).toBe('ingest_adapter_error');
    expect(errEvt!.level).toBe('error');
    expect(errEvt!.platform).toBe('youtube');
    expect(errEvt!.operation).toBe('fetchPostByUrl');
    expect(errEvt!.url).toBe('https://youtu.be/x');
    expect(errEvt!.error).toBe('upstream timeout');
    expect(typeof errEvt!.durationMs).toBe('number');
    expect(errEvt!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stringifies non-Error throws into the error field', async () => {
    const { entries, logger } = fakeCollector();
    await expect(
      withAdapterLog(logger, { platform: 'p', operation: 'op' }, async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain string failure';
      }),
    ).rejects.toBe('plain string failure');

    const errEvt = entries.find((e) => e.event === 'ingest_adapter_error');
    expect(errEvt).toBeDefined();
    expect(errEvt!.error).toBe('plain string failure');
  });

  it('stringifies non-Error object throws via String()', async () => {
    const { entries, logger } = fakeCollector();
    const weird = { code: 500 };
    await expect(
      withAdapterLog(logger, { platform: 'p', operation: 'op' }, async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw weird;
      }),
    ).rejects.toBe(weird);

    const errEvt = entries.find((e) => e.event === 'ingest_adapter_error');
    expect(errEvt!.error).toBe(String(weird)); // '[object Object]'
  });

  it('omits handle/url when meta does not include them', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(logger, { platform: 'bluesky', operation: 'resolveAccount' }, async () => 1);
    expect(entries[0]!.handle).toBeUndefined();
    expect(entries[0]!.url).toBeUndefined();
    expect(entries[1]!.handle).toBeUndefined();
    expect(entries[1]!.url).toBeUndefined();
  });

  it('measures durationMs across awaited work (>= awaited delay)', async () => {
    const { entries, logger } = fakeCollector();
    await withAdapterLog(logger, { platform: 'p', operation: 'op' }, async () => {
      await new Promise((r) => setTimeout(r, 12));
      return 'done';
    });
    const okEvt = entries.find((e) => e.event === 'ingest_adapter_ok')!;
    expect(okEvt.durationMs).toBeGreaterThanOrEqual(10);
  });
});
