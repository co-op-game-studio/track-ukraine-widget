#!/usr/bin/env node
/**
 * Stress test — sustained load against a target env's edge.
 *
 * Hits representative endpoints (geocode, state-members, name-search,
 * member profile, voting record, sponsored bills) at configurable
 * concurrency for a configurable duration. Reports p50/p95/p99
 * latencies, error rate, and X-Trace-Id canonical-format compliance
 * under load.
 *
 * Designed to run in CI (stg-rehearsal.yml) where CF Access service
 * token env vars are available. Pass/fail thresholds are intentionally
 * loose — this catches collapse, not tail-latency regressions.
 *
 * Usage:
 *   node scripts/stress-test.mjs --host https://stg.vote.cogs.it.com \
 *     --concurrency 20 --duration 30
 *
 * Env:
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET — for Access-gated envs
 *
 * Pass criteria:
 *   - error rate < 2% across all requests
 *   - p95 latency < 3000ms
 *   - every response carries canonical X-Trace-Id (tr_<16hex>)
 */

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const HOST = (arg('--host', process.env.HOST) || '').replace(/\/$/, '');
const CONCURRENCY = Number(arg('--concurrency', 20));
const DURATION_S = Number(arg('--duration', 30));
const ERROR_RATE_MAX = Number(arg('--error-rate-max', 0.02));
const P95_MAX_MS = Number(arg('--p95-max-ms', 3000));

if (!HOST) {
  console.error('Usage: node scripts/stress-test.mjs --host <url> [--concurrency N] [--duration SECS]');
  process.exit(2);
}

const ACCESS_ID = process.env.CF_ACCESS_CLIENT_ID ?? '';
const ACCESS_SECRET = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
const headers = {
  Origin: 'https://trackukraine.com',
};
if (ACCESS_ID) headers['CF-Access-Client-Id'] = ACCESS_ID;
if (ACCESS_SECRET) headers['CF-Access-Client-Secret'] = ACCESS_SECRET;

// Representative request mix. Weights roughly reflect the address-lookup
// → detail-panel-open → voting-record user journey.
const REQUESTS = [
  { weight: 2, method: 'GET', path: '/api/state-members/CA' },
  { weight: 2, method: 'GET', path: '/api/state-members/TX' },
  { weight: 1, method: 'GET', path: '/api/state-members/IA' },
  { weight: 1, method: 'GET', path: '/api/state-members/NY' },
  { weight: 1, method: 'GET', path: '/api/name-search?q=durb' },
  { weight: 1, method: 'GET', path: '/api/name-search?q=hins' },
  { weight: 1, method: 'GET', path: '/api/name-search?q=mccon' },
  { weight: 1, method: 'GET', path: '/api/members/D000563' }, // Durbin
  { weight: 1, method: 'GET', path: '/api/members/M000355' }, // McConnell
  { weight: 1, method: 'GET', path: '/api/members/A000382' }, // Alsobrooks
];
const WEIGHTED = [];
for (const r of REQUESTS) for (let i = 0; i < r.weight; i++) WEIGHTED.push(r);

const pickRequest = () => WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)];

const TRACE_RE = /^tr_[0-9a-f]{16}$/;

const results = {
  started: Date.now(),
  total: 0,
  errors: 0,
  byStatus: new Map(),
  latencies: [],
  traceIdMissing: 0,
  traceIdMalformed: 0,
};

async function fire() {
  const req = pickRequest();
  const url = `${HOST}${req.path}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: req.method, headers });
    const dt = Date.now() - t0;
    results.total++;
    results.latencies.push(dt);
    results.byStatus.set(res.status, (results.byStatus.get(res.status) ?? 0) + 1);
    if (res.status >= 500) results.errors++;
    const trace = res.headers.get('x-trace-id');
    if (!trace) results.traceIdMissing++;
    else if (!TRACE_RE.test(trace)) results.traceIdMalformed++;
    // Drain body so connection pool frees promptly.
    await res.arrayBuffer();
  } catch (err) {
    results.total++;
    results.errors++;
    results.latencies.push(Date.now() - t0);
  }
}

async function worker(deadline) {
  while (Date.now() < deadline) {
    await fire();
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const deadline = Date.now() + DURATION_S * 1000;
  console.log(`Stress target: ${HOST}`);
  console.log(`Concurrency: ${CONCURRENCY} | duration: ${DURATION_S}s | pool: ${REQUESTS.length} endpoints`);

  const workers = Array.from({ length: CONCURRENCY }, () => worker(deadline));
  await Promise.all(workers);

  const sorted = results.latencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const max = sorted[sorted.length - 1] ?? 0;
  const errorRate = results.total === 0 ? 0 : results.errors / results.total;
  const rps = results.total / DURATION_S;

  console.log('\n--- Stress test results ---');
  console.log(`Total requests : ${results.total}`);
  console.log(`Req/sec        : ${rps.toFixed(1)}`);
  console.log(`Errors (5xx)   : ${results.errors} (${(errorRate * 100).toFixed(2)}%)`);
  console.log(`Latency p50    : ${p50}ms`);
  console.log(`Latency p95    : ${p95}ms`);
  console.log(`Latency p99    : ${p99}ms`);
  console.log(`Latency max    : ${max}ms`);
  console.log(`Trace-ID missing: ${results.traceIdMissing}`);
  console.log(`Trace-ID malformed: ${results.traceIdMalformed}`);
  console.log(`Status breakdown:`);
  const statusKeys = [...results.byStatus.keys()].sort((a, b) => a - b);
  for (const s of statusKeys) {
    console.log(`  ${s}: ${results.byStatus.get(s)}`);
  }

  let failed = false;
  if (errorRate > ERROR_RATE_MAX) {
    console.error(`::error::Error rate ${(errorRate * 100).toFixed(2)}% exceeds threshold ${(ERROR_RATE_MAX * 100).toFixed(2)}%`);
    failed = true;
  }
  if (p95 > P95_MAX_MS) {
    console.error(`::error::p95 ${p95}ms exceeds threshold ${P95_MAX_MS}ms`);
    failed = true;
  }
  if (results.traceIdMissing > 0 || results.traceIdMalformed > 0) {
    console.error(`::error::Trace-ID compliance broken under load: missing=${results.traceIdMissing} malformed=${results.traceIdMalformed}`);
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}

main();
