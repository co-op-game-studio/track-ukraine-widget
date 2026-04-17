#!/usr/bin/env node
/**
 * Print the complete Senate-vote row for senators whose scores look off:
 *   Schumer (+0.82, should be ~+1.0)
 *   McConnell (+0.82, should be ~+1.0)
 *   Risch (+0.01, should be high-positive)
 *   Durbin (+1.00 — control)
 *   Lankford (-0.11 — to verify)
 *
 * Show the cast on every curated Senate vote so we can see exactly what's
 * dragging each score.
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const KEY = readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1];
const BILLS = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8'));

const SENATORS = [
  { last: 'Schumer',   st: 'NY' },
  { last: 'McConnell', st: 'KY' },
  { last: 'Risch',     st: 'ID' },
  { last: 'Durbin',    st: 'IL' }, // control: scored +1.00
  { last: 'Lankford',  st: 'OK' },
];

const SIGN = { 'voted-pro': +1, 'voted-anti': -1, unstated: 0 };
const AMP  = { 'voted-pro':  1, 'voted-anti':  1, unstated: 0 };

async function fetchXml(c, s, rc) {
  const p = String(rc).padStart(5, '0');
  const res = await fetch(`https://www.senate.gov/legislative/LIS/roll_call_votes/vote${c}${s}/vote_${c}_${s}_${p}.xml`);
  return res.ok ? res.text() : null;
}

function extractCast(xml, last, st) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const m of doc.getElementsByTagName('member')) {
    if (m.getElementsByTagName('last_name')[0]?.textContent?.trim() === last &&
        m.getElementsByTagName('state')[0]?.textContent?.trim() === st) {
      return m.getElementsByTagName('vote_cast')[0]?.textContent?.trim() ?? '—';
    }
  }
  return null; // not present in roster at all
}

function normalize(cast) {
  if (cast === 'Yea' || cast === 'Aye') return 'Aye';
  if (cast === 'Nay') return 'Nay';
  if (cast === 'Present') return 'Present';
  if (cast === null || cast === undefined) return 'absent-from-roster';
  return 'Not Voting';
}

function valence(dir, cast, mult) {
  if (mult === 0 || cast === 'Present' || cast === 'Not Voting' || cast === 'absent-from-roster') return 'unstated';
  if (dir === 'neutral') return 'unstated';
  const eff = mult === 1 ? (dir === 'pro-ukraine') : (dir !== 'pro-ukraine');
  if (eff) return cast === 'Aye' ? 'voted-pro' : 'voted-anti';
  return cast === 'Aye' ? 'voted-anti' : 'voted-pro';
}

// Gather all Senate votes
console.log('Fetching Senate XML...');
const cache = new Map();
const keys = new Set();
for (const b of BILLS) for (const v of b.votes) if (v.chamber === 'Senate') {
  keys.add(`${v.congress}|${v.session}|${v.rollCall}`);
}
for (const k of keys) {
  const [c, s, r] = k.split('|').map(Number);
  cache.set(k, await fetchXml(c, s, r));
  await new Promise(x => setTimeout(x, 40));
}
console.log();

for (const sen of SENATORS) {
  console.log(`\n===== ${sen.last} (${sen.st}) =====`);
  let num = 0, den = 0, contrib = 0, absent = 0, inOfficeContrib = 0;

  for (const b of BILLS) {
    const senateVotes = b.votes.filter(v => v.chamber === 'Senate');
    if (senateVotes.length === 0) continue;

    for (const v of senateVotes) {
      const xml = cache.get(`${v.congress}|${v.session}|${v.rollCall}`);
      let cast;
      if (!xml) { cast = 'xml-missing'; }
      else {
        const raw = extractCast(xml, sen.last, sen.st);
        cast = raw === null ? 'absent-from-roster' : normalize(raw);
      }

      const val = valence(b.direction, cast, v.directionMultiplier);
      const included = v.weight > 0 && SIGN[val] !== 0;
      const signed = included ? SIGN[val] * AMP[val] * v.weight : 0;

      if (included) {
        num += signed;
        den += AMP[val] * v.weight;
        contrib++;
      }
      if (cast === 'absent-from-roster') absent++;

      const flag = !included
        ? (cast === 'absent-from-roster' ? '[pre-office]' : cast === 'xml-missing' ? '[xml-miss]' : v.weight === 0 ? '[w=0]' : '[unstated]')
        : (signed >= 0 ? `[+${signed.toFixed(2)}]` : `[${signed.toFixed(2)}]`);

      console.log(
        `  ${b.type}${b.number} ${v.chamber}#${String(v.rollCall).padStart(4)} ` +
        `w=${v.weight.toFixed(2)} dir=${b.direction.padEnd(12)} kind=${v.kind.padEnd(20)} ` +
        `cast=${(cast || '—').padEnd(20)} ${flag}`
      );
    }
  }

  const score = den === 0 ? null : num / den;
  console.log(`  ---`);
  console.log(`  contributing: ${contrib} | absent-from-roster (pre-office): ${absent}`);
  console.log(`  numerator: ${num.toFixed(3)} | denominator: ${den.toFixed(3)}`);
  console.log(`  SCORE: ${score === null ? 'N/A' : score.toFixed(3)}`);
}
