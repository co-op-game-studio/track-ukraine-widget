/**
 * Tests for scripts/publish-d1-to-kv.ts pure projection helpers.
 * Traces to FR-51, FR-56, FR-58.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  projectBill,
  projectComments,
  projectSocialPosts,
  projectQuotes,
  projectStats,
  projectAuditFeedPublic,
  projectAuditFeedFull,
  buildPublishPlan,
  diffPlan,
  safeD1Query,
  isMissingTableError,
  type D1Bill,
  type D1Vote,
  type D1Comment,
  type D1SocialPost,
  type D1Quote,
  type D1Audit,
} from '../../scripts/publish-d1-to-kv';

const ISO = '2026-05-02T20:00:00.000Z';

function bill(overrides: Partial<D1Bill> = {}): D1Bill {
  return {
    id: '01HQROW00000000000000BILL1',
    bill_id: '117-HR-2471',
    congress: 117,
    type: 'HR',
    number: '2471',
    featured: 1,
    label: 'flagship',
    title: 'Consolidated Appropriations Act, 2022',
    latest_action: 'Became Public Law',
    latest_action_date: '2022-03-15',
    became_law: 1,
    congress_gov_url: 'https://example.com',
    direction: 'pro-ukraine',
    direction_reason: 'manual',
    summary_json: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function vote(overrides: Partial<D1Vote> = {}): D1Vote {
  return {
    id: '01HQROW00000000000000VOTE1',
    bill_id: '117-HR-2471',
    chamber: 'House',
    congress: 117,
    session: 2,
    roll_call: 65,
    date: '2022-03-10T02:49:07Z',
    url: null,
    action: null,
    action_date: null,
    weight: 0.9,
    direction_multiplier: 1,
    kind: 'concur',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                              canonicalJson                                 */
/* -------------------------------------------------------------------------- */

describe('canonicalJson', () => {
  it('produces byte-identical output across key orderings', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('recurses into nested objects and arrays', () => {
    const v = canonicalJson({ z: { c: [3, { b: 2, a: 1 }], a: 0 } });
    expect(v).toBe('{"z":{"a":0,"c":[3,{"a":1,"b":2}]}}');
  });

  it('preserves null + numbers + strings', () => {
    expect(canonicalJson({ a: null, b: 1.5, c: 'x' })).toBe('{"a":null,"b":1.5,"c":"x"}');
  });
});

/* -------------------------------------------------------------------------- */
/*                              projectBill                                   */
/* -------------------------------------------------------------------------- */

describe('projectBill (FR-51 AC-51.3)', () => {
  it('emits FR-32 AC-32.2-shaped record with weights from D1', () => {
    const b = bill();
    const vs = [
      vote({ chamber: 'House', roll_call: 65, weight: 0.9, kind: 'concur' }),
      vote({ chamber: 'Senate', roll_call: 78, weight: 0.9, kind: 'concur' }),
    ];
    const r = projectBill(b, vs, ISO);
    expect(r.billId).toBe('117-HR-2471');
    expect(r.direction).toBe('pro-ukraine');
    expect(r.weight).toBeCloseTo(1.8, 6);
    expect(r.curatedRollCalls).toHaveLength(2);
    expect(r.schemaVersion).toBe(1);
    expect(r.generatedAt).toBe(ISO);
  });

  it('sorts curated roll-calls by chamber/congress/session/rollCall for determinism', () => {
    const b = bill();
    const vs = [
      vote({ chamber: 'Senate', roll_call: 78 }),
      vote({ chamber: 'House', roll_call: 67 }),
      vote({ chamber: 'House', roll_call: 65 }),
    ];
    const r = projectBill(b, vs, ISO);
    expect(r.curatedRollCalls.map((v) => `${v.chamber}-${v.rollCall}`)).toEqual([
      'House-65',
      'House-67',
      'Senate-78',
    ]);
  });

  it('parses summary_json when present', () => {
    const b = bill({ summary_json: JSON.stringify({ text: 'foo', actionDate: '2022-03-15' }) });
    const r = projectBill(b, [], ISO);
    expect(r.summary).toEqual({ text: 'foo', actionDate: '2022-03-15' });
  });

  it('emits null summary when summary_json is null', () => {
    const r = projectBill(bill({ summary_json: null }), [], ISO);
    expect(r.summary).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              projectComments                               */
/* -------------------------------------------------------------------------- */

describe('projectComments (FR-51 AC-51.4)', () => {
  it('shapes comment records with camelCase keys', () => {
    const c: D1Comment = {
      id: 'c1',
      bill_id: '117-HR-2471',
      attached_to_roll_call_id: 'house:117:2:65',
      body_markdown: 'Floor speech ignored the procedural maneuver.',
      weight: 0.25, direction: -1,
      author_email: 'alice@example.com',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };
    const r = projectComments('117-HR-2471', [c], ISO);
    expect(r.billId).toBe('117-HR-2471');
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toEqual({
      id: 'c1',
      bodyMarkdown: 'Floor speech ignored the procedural maneuver.',
      weight: 0.25,
      direction: -1,
      attachedToRollCallId: 'house:117:2:65',
      authorEmail: 'alice@example.com',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    });
    expect(r.schemaVersion).toBe(1);
  });

  it('sorts comments by created_at ascending', () => {
    const a: D1Comment = {
      id: 'a',
      bill_id: 'b1',
      attached_to_roll_call_id: null,
      body_markdown: 'a',
      weight: 0, direction: 0,
      author_email: 'x@y',
      created_at: '2026-05-02T00:00:00Z',
      updated_at: '2026-05-02T00:00:00Z',
    };
    const b: D1Comment = { ...a, id: 'b', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' };
    const r = projectComments('b1', [a, b], ISO);
    expect(r.comments[0]!.id).toBe('b');
    expect(r.comments[1]!.id).toBe('a');
  });
});

/* -------------------------------------------------------------------------- */
/*                              projectSocialPosts                            */
/* -------------------------------------------------------------------------- */

describe('projectSocialPosts (FR-51 AC-51.5)', () => {
  it('shapes posts with newest first', () => {
    const a: D1SocialPost = {
      id: 'a',
      bioguide_id: 'D000563',
      platform: 'x',
      url: 'https://x.com/a',
      posted_at: '2026-04-01',
      body_text: 'older',
      weight: 0, direction: 0,
      comment: null,
      author_email: 'alice@x',
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    };
    const b: D1SocialPost = { ...a, id: 'b', posted_at: '2026-05-01', body_text: 'newer' };
    const r = projectSocialPosts('D000563', [a, b], ISO);
    expect(r.posts[0]!.bodyText).toBe('newer');
  });
});

/* -------------------------------------------------------------------------- */
/*                              projectQuotes                                 */
/* -------------------------------------------------------------------------- */

describe('projectQuotes (FR-51 AC-51.6)', () => {
  it('shapes quotes with media metadata', () => {
    const q: D1Quote = {
      id: 'q1',
      bioguide_id: 'D000563',
      media_kind: 'video',
      source_url: 'https://www.c-span.org/video/?123',
      source_label: 'C-SPAN floor speech',
      quoted_at: '2024-02-13',
      body_text: 'I support Ukraine.',
      weight: 0.25, direction: 1,
      comment: null,
      author_email: 'alice@x',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };
    const r = projectQuotes('D000563', [q], ISO);
    expect(r.quotes[0]!.mediaKind).toBe('video');
    expect(r.quotes[0]!.sourceUrl).toBe('https://www.c-span.org/video/?123');
    expect(r.quotes[0]!.sourceLabel).toBe('C-SPAN floor speech');
  });
});

/* -------------------------------------------------------------------------- */
/*                              projectStats                                  */
/* -------------------------------------------------------------------------- */

describe('projectStats (FR-56 AC-56.1)', () => {
  it('emits per-bill aggregates and daily comments timeseries', () => {
    const bs = [bill({ bill_id: '117-HR-2471', direction: 'pro-ukraine' })];
    const vs = [
      vote({ bill_id: '117-HR-2471', weight: 0.9 }),
      vote({ bill_id: '117-HR-2471', chamber: 'Senate', roll_call: 78, weight: 0.9 }),
    ];
    const cs: D1Comment[] = [
      {
        id: 'c1',
        bill_id: '117-HR-2471',
        attached_to_roll_call_id: null,
        body_markdown: 'a',
        weight: 0, direction: 0,
        author_email: 'x@y',
        created_at: '2026-04-25T10:00:00Z',
        updated_at: '2026-04-25T10:00:00Z',
      },
      {
        id: 'c2',
        bill_id: '117-HR-2471',
        attached_to_roll_call_id: null,
        body_markdown: 'b',
        weight: 0, direction: 0,
        author_email: 'x@y',
        created_at: '2026-04-25T11:00:00Z',
        updated_at: '2026-04-25T11:00:00Z',
      },
      {
        id: 'c3',
        bill_id: '117-HR-2471',
        attached_to_roll_call_id: null,
        body_markdown: 'c',
        weight: 0, direction: 0,
        author_email: 'x@y',
        created_at: '2026-04-26T10:00:00Z',
        updated_at: '2026-04-26T10:00:00Z',
      },
    ];
    const r = projectStats(bs, vs, cs, ISO);
    expect(r.perBill).toHaveLength(1);
    expect(r.perBill[0]!.voteCount).toBe(2);
    expect(r.perBill[0]!.weightTotal).toBeCloseTo(1.8, 6);
    expect(r.perBill[0]!.directionPro).toBe(2);
    expect(r.perBill[0]!.directionAnti).toBe(0);
    expect(r.commentsTimeseries).toEqual([
      { date: '2026-04-25', count: 2 },
      { date: '2026-04-26', count: 1 },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              audit feeds                                   */
/* -------------------------------------------------------------------------- */

const sampleAudit: D1Audit = {
  id: '01HQAUDIT0000000000000001',
  actor_email: 'alice@example.com',
  action: 'update',
  target_table: 'votes',
  row_id: '01HQROW0000000000000VOTE1',
  row_title: '117-HR-2471 / House roll 65',
  before_json: '{"weight":0.9}',
  after_json: '{"weight":2.0}',
  reason: 'reweighting',
  trace_id: 'tr_abcdef0123456789',
  created_at: '2026-05-02T19:00:00Z',
};

describe('projectAuditFeedPublic (FR-58 AC-58.2)', () => {
  it('strips email domain and omits before/after/reason', () => {
    const r = projectAuditFeedPublic([sampleAudit], ISO);
    expect(r.items).toHaveLength(1);
    const item = r.items[0] as Record<string, unknown>;
    expect(item['actorLocalPart']).toBe('alice');
    expect(item).not.toHaveProperty('actor_email');
    expect(item).not.toHaveProperty('before');
    expect(item).not.toHaveProperty('after');
    expect(item).not.toHaveProperty('reason');
    expect(item).not.toHaveProperty('traceId');
    expect(item['table']).toBe('votes');
  });

  it('sorts audits newest first and respects limit', () => {
    const a = { ...sampleAudit, id: 'a', created_at: '2026-05-01T00:00:00Z' };
    const b = { ...sampleAudit, id: 'b', created_at: '2026-05-02T00:00:00Z' };
    const c = { ...sampleAudit, id: 'c', created_at: '2026-05-03T00:00:00Z' };
    const r = projectAuditFeedPublic([a, b, c], ISO, 2);
    expect(r.items).toHaveLength(2);
    expect((r.items[0] as { id: string }).id).toBe('c');
    expect((r.items[1] as { id: string }).id).toBe('b');
  });
});

describe('projectAuditFeedFull (FR-58 AC-58.1)', () => {
  it('exposes before / after / reason / trace_id on the authenticated feed', () => {
    // Field names are snake_case per the AC-58.1 revision — match D1 column
    // names so handleAudit can return the KV projection unchanged.
    const r = projectAuditFeedFull([sampleAudit], ISO);
    const item = r.items[0] as Record<string, unknown>;
    expect(item['actor_email']).toBe('alice@example.com');
    expect(item['before']).toEqual({ weight: 0.9 });
    expect(item['after']).toEqual({ weight: 2.0 });
    expect(item['reason']).toBe('reweighting');
    expect(item['trace_id']).toBe('tr_abcdef0123456789');
  });
});

/* -------------------------------------------------------------------------- */
/*                              buildPublishPlan + diffPlan                   */
/* -------------------------------------------------------------------------- */

describe('safeD1Query fail-loud (AC-32.44)', () => {
  /** Build a fake D1Like whose .all() throws the given error. */
  function throwingD1(err: Error) {
    return {
      prepare() {
        return {
          bind() { return this; },
          async first() { throw err; },
          async all() { throw err; },
          async run() { throw err; },
        };
      },
      async batch() { return []; },
    } as never;
  }

  it('swallows ONLY a missing-table error → empty set', async () => {
    const d1 = throwingD1(new Error('D1_ERROR: no such table: members'));
    expect(await safeD1Query(d1, 'SELECT * FROM members')).toEqual([]);
  });

  it('re-throws a network error instead of returning []', async () => {
    const d1 = throwingD1(new Error('fetch failed: ECONNRESET'));
    await expect(safeD1Query(d1, 'SELECT * FROM vote_casts')).rejects.toThrow(/ECONNRESET/);
  });

  it('re-throws auth / 5xx / parse errors', async () => {
    await expect(safeD1Query(throwingD1(new Error('D1 REST 401 Unauthorized')), 'SELECT 1')).rejects.toThrow(/401/);
    await expect(safeD1Query(throwingD1(new SyntaxError('Unexpected end of JSON input')), 'SELECT 1')).rejects.toThrow(/JSON/);
  });

  it('isMissingTableError classifies correctly', () => {
    expect(isMissingTableError(new Error('no such table: vote_casts'))).toBe(true);
    expect(isMissingTableError(new Error('relation "members" does not exist'))).toBe(true);
    expect(isMissingTableError(new Error('D1 REST 500'))).toBe(false);
    expect(isMissingTableError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('buildPublishPlan + diffPlan', () => {
  it('produces deterministic output across two runs (FR-51 AC-51.2)', () => {
    const inputs = {
      bills: [bill()],
      votes: [vote()],
      comments: [],
      posts: [],
      quotes: [],
      audits: [],
      generatedAt: ISO,
    };
    const a = buildPublishPlan(inputs);
    const b = buildPublishPlan(inputs);
    expect(a.writes.size).toBe(b.writes.size);
    for (const [key, value] of a.writes) {
      expect(b.writes.get(key)).toBe(value);
    }
  });

  it('emits expected key set for a small fixture', () => {
    const inputs = {
      bills: [bill()],
      votes: [vote()],
      comments: [
        {
          id: 'c1',
          bill_id: '117-HR-2471',
          attached_to_roll_call_id: null,
          body_markdown: 'x',
          weight: 0, direction: 0,
          author_email: 'alice@example.com',
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        } as D1Comment,
      ],
      posts: [
        {
          id: 'p1',
          bioguide_id: 'D000563',
          platform: 'x',
          url: 'https://x.com/p1',
          posted_at: null,
          body_text: 'x',
          weight: 0, direction: 0,
          comment: null,
          author_email: 'alice@example.com',
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        } as D1SocialPost,
      ],
      quotes: [],
      audits: [sampleAudit],
      generatedAt: ISO,
    };
    const plan = buildPublishPlan(inputs);
    const keys = [...plan.writes.keys()].sort();
    expect(keys).toEqual([
      'audit-feed:v1:full',
      'audit-feed:v1:public',
      'bill:v1:117-HR-2471',
      'comment:v1:117-HR-2471',
      'roll-call:v1:house:117:2:65',
      'social-post:v1:D000563',
      'stats:v1:summary',
    ]);
  });

  it('AC-32.40 — projects member/state/name-index/roster keys from members + vote_casts', () => {
    const inputs = {
      bills: [], votes: [], comments: [], posts: [], quotes: [], audits: [],
      members: [
        {
          bioguide_id: 'D000563', first: 'Richard', last: 'Durbin', official_name: 'Richard J. Durbin',
          state: 'IL', chamber: 'Senate', district: null, party: 'D',
          photo_url: null, website: null, search_key: 'richard durbin', year_entered: 1997, is_non_voting: 0,
          socials_json: null, sponsored_json: '[]', cosponsored_json: '[]',
          congress_update_date: '2026-05-01', last_freshness_check_at: '2026-05-01',
        },
      ],
      voteCasts: [
        { chamber: 'House', congress: 117, session: 1, roll_call: 293, bioguide_id: 'S001150', last_name: null, first_name: null, state: null, party: null, cast: 'Yea' },
      ],
      generatedAt: ISO,
    };
    const plan = buildPublishPlan(inputs);
    const keys = [...plan.writes.keys()];
    expect(keys).toContain('member:v1:D000563');
    expect(keys).toContain('state-members:v1:IL');
    expect(keys).toContain('name-index:v1:meta');
    expect(keys.some((k) => k.startsWith('name-index:v1:') && k !== 'name-index:v1:meta')).toBe(true);
    expect(keys).toContain('roll-call-roster:v1:house:117:1:293');
  });

  it('diffPlan returns only changed keys when current matches plan exactly', () => {
    const inputs = {
      bills: [bill()],
      votes: [vote()],
      comments: [],
      posts: [],
      quotes: [],
      audits: [],
      generatedAt: ISO,
    };
    const plan = buildPublishPlan(inputs);
    const current = new Map(plan.writes);
    const { changed, unchanged } = diffPlan(plan, current);
    expect(changed.size).toBe(0);
    expect(unchanged).toBe(plan.writes.size);
  });

  it('diffPlan returns the changed key when one differs', () => {
    const inputs = {
      bills: [bill()],
      votes: [vote()],
      comments: [],
      posts: [],
      quotes: [],
      audits: [],
      generatedAt: ISO,
    };
    const plan = buildPublishPlan(inputs);
    const current = new Map(plan.writes);
    current.set('bill:v1:117-HR-2471', '{"different":"value"}');
    const { changed, unchanged } = diffPlan(plan, current);
    expect(changed.size).toBe(1);
    expect(changed.has('bill:v1:117-HR-2471')).toBe(true);
    expect(unchanged).toBe(plan.writes.size - 1);
  });
});
