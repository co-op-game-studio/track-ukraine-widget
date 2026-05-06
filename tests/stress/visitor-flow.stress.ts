/**
 * Concurrent-visitor stress test (FR-44 AC-44.8).
 *
 * NOT part of the regular `npm test` run — vitest's include glob is
 * `tests/**\/*.test.{ts,tsx}` and this file deliberately uses `.stress.ts`
 * so it doesn't fire on every CI tick. Invoked manually:
 *
 *   E2E_TARGET=https://stg.vote.cogs.it.com \
 *   CF_ACCESS_CLIENT_ID=... \
 *   CF_ACCESS_CLIENT_SECRET=... \
 *   tsx tests/stress/visitor-flow.stress.ts [--scenario cold|warm] [--concurrency N] [--duration-sec S]
 *
 * Two scenarios per AC-44.8:
 *   cold — fresh R2 + KV (operator purges first), 50 concurrent visitors, 60s burst
 *   warm — after cold, another 50 concurrent for 60s, KV/R2 mostly hot
 *
 * Acceptance:
 *   p95 latency ≤ 5s
 *   0 Worker 5xx
 *   upstream 429 ≤ 0 (warm) or ≤ 5 (cold)
 *
 * The `visitor flow` per voter is: name-search → member profile → bill
 * detail. Each visitor walks the same flow with a randomized member.
 *
 * Auth: relies on CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET service-token
 * env vars (same as the remote e2e). Without them the stress harness gets
 * 302'd to SSO and the metrics are meaningless; the script asserts both
 * are present at boot.
 *
 * Traces: FR-44 AC-44.8.
 */

interface CliArgs {
  scenario: 'cold' | 'warm';
  concurrency: number;
  durationSec: number;
  target: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scenario = (get('--scenario') ?? 'cold') as 'cold' | 'warm';
  if (scenario !== 'cold' && scenario !== 'warm') {
    console.error(`Invalid --scenario: ${scenario}. Must be 'cold' or 'warm'.`);
    process.exit(2);
  }
  const concurrency = Number.parseInt(get('--concurrency') ?? '50', 10);
  const durationSec = Number.parseInt(get('--duration-sec') ?? '60', 10);
  const target = process.env['E2E_TARGET'] ?? '';
  if (!target) {
    console.error('E2E_TARGET env var is required (e.g. https://stg.vote.cogs.it.com).');
    process.exit(2);
  }
  return { scenario, concurrency, durationSec, target };
}

function authHeaders(): Record<string, string> {
  const id = process.env['CF_ACCESS_CLIENT_ID'];
  const secret = process.env['CF_ACCESS_CLIENT_SECRET'];
  if (!id || !secret) {
    console.error('CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET required for protected envs.');
    console.error('On prod (no Access), set them to empty strings to skip the header.');
    process.exit(2);
  }
  return id && secret
    ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
    : {};
}

interface SampleMember {
  bioguideId: string;
  name: string;
}

/**
 * The set of bioguide IDs to walk during the stress run. Hard-coded so
 * the test is hermetic — no /name-search dependency to bootstrap. Pick
 * representatives across both chambers to exercise different cache shapes.
 */
const SAMPLE_MEMBERS: SampleMember[] = [
  { bioguideId: 'S001150', name: 'Schiff' },
  { bioguideId: 'C001075', name: 'Crawford' },
  { bioguideId: 'L000557', name: 'Lieu' },
  { bioguideId: 'M001236', name: 'Moolenaar' },
  { bioguideId: 'O000172', name: 'Ocasio-Cortez' },
  { bioguideId: 'B001288', name: 'Booker' },
  { bioguideId: 'W000817', name: 'Warren' },
  { bioguideId: 'S001181', name: 'Sanders' },
];

interface RequestSample {
  url: string;
  status: number;
  durationMs: number;
  okWorker: boolean; // false if 5xx (worker error, not upstream)
}

async function timedFetch(url: string, headers: Record<string, string>): Promise<RequestSample> {
  const start = performance.now();
  let status = 0;
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    // Drain the body so we measure full response time, not just headers.
    await res.arrayBuffer();
  } catch {
    status = 0; // network error counts as failure
  }
  const durationMs = performance.now() - start;
  return { url, status, durationMs, okWorker: status < 500 && status > 0 };
}

/** One synthetic visitor's flow: name lookup → member profile → bill detail. */
async function visitorFlow(args: CliArgs, headers: Record<string, string>): Promise<RequestSample[]> {
  const member = SAMPLE_MEMBERS[Math.floor(Math.random() * SAMPLE_MEMBERS.length)]!;
  const samples: RequestSample[] = [];

  // 1. name-search
  samples.push(await timedFetch(`${args.target}/api/name-search?q=${encodeURIComponent(member.name)}`, headers));
  // 2. member profile
  samples.push(await timedFetch(`${args.target}/api/members/${member.bioguideId}`, headers));
  // 3. one of the canonical Ukraine bills (HR 815 = supplemental)
  samples.push(await timedFetch(`${args.target}/api/bills/118-HR-815`, headers));
  return samples;
}

async function runStress(args: CliArgs): Promise<void> {
  const headers = authHeaders();
  console.log(`[stress] scenario=${args.scenario} concurrency=${args.concurrency} duration=${args.durationSec}s target=${args.target}`);

  const endAt = Date.now() + args.durationSec * 1000;
  const allSamples: RequestSample[] = [];

  async function worker(id: number): Promise<void> {
    while (Date.now() < endAt) {
      const samples = await visitorFlow(args, headers);
      allSamples.push(...samples);
      void id;
    }
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  // ── Reporting ──
  const total = allSamples.length;
  const sortedDur = [...allSamples].map((s) => s.durationMs).sort((a, b) => a - b);
  const p50 = sortedDur[Math.floor(sortedDur.length * 0.5)] ?? 0;
  const p95 = sortedDur[Math.floor(sortedDur.length * 0.95)] ?? 0;
  const p99 = sortedDur[Math.floor(sortedDur.length * 0.99)] ?? 0;
  const worker5xx = allSamples.filter((s) => s.status >= 500).length;
  const upstream429 = allSamples.filter((s) => s.status === 429).length;
  const networkErrors = allSamples.filter((s) => s.status === 0).length;

  console.log('\n[stress] RESULTS');
  console.log(`  total requests:   ${total}`);
  console.log(`  p50 latency:      ${p50.toFixed(0)} ms`);
  console.log(`  p95 latency:      ${p95.toFixed(0)} ms`);
  console.log(`  p99 latency:      ${p99.toFixed(0)} ms`);
  console.log(`  Worker 5xx:       ${worker5xx}`);
  console.log(`  upstream 429:     ${upstream429}`);
  console.log(`  network errors:   ${networkErrors}`);

  // ── Acceptance gates (AC-44.8) ──
  let passed = true;
  const fails: string[] = [];
  if (p95 > 5000) {
    passed = false;
    fails.push(`p95 ${p95.toFixed(0)}ms > 5000ms threshold`);
  }
  if (worker5xx > 0) {
    passed = false;
    fails.push(`Worker 5xx count ${worker5xx} > 0`);
  }
  const upstreamCap = args.scenario === 'warm' ? 0 : 5;
  if (upstream429 > upstreamCap) {
    passed = false;
    fails.push(`upstream 429 count ${upstream429} > ${upstreamCap} (${args.scenario} cap)`);
  }

  if (passed) {
    console.log('\n[stress] PASS');
    process.exit(0);
  } else {
    console.error('\n[stress] FAIL');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void runStress(parseArgs());
