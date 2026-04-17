#!/usr/bin/env node
/** Check whether the -1.00 senators truly have identical patterns. */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const KEY = readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1];
const BILLS = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8'));

const SENATORS = [
  { last: 'Paul',      st: 'KY' },
  { last: 'Lee',       st: 'UT' },
  { last: 'Hawley',    st: 'MO' },
  { last: 'Marshall',  st: 'KS' },
  { last: 'Blackburn', st: 'TN' },
  { last: 'Hagerty',   st: 'TN' },
  { last: 'Tuberville', st: 'AL' },
];

async function fetchXml(congress, session, rc) {
  const p = String(rc).padStart(5, '0');
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${p}.xml`;
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

function extract(xml, last, st) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const m of doc.getElementsByTagName('member')) {
    if (m.getElementsByTagName('last_name')[0]?.textContent?.trim() === last &&
        m.getElementsByTagName('state')[0]?.textContent?.trim() === st) {
      return m.getElementsByTagName('vote_cast')[0]?.textContent?.trim();
    }
  }
  return null;
}

console.log('Fetching all Senate vote XMLs...');
const cache = new Map();
const keys = new Set();
for (const b of BILLS) for (const v of b.votes) if (v.chamber === 'Senate') keys.add(`${v.congress}|${v.session}|${v.rollCall}`);
for (const k of keys) {
  const [c, s, r] = k.split('|').map(Number);
  cache.set(k, await fetchXml(c, s, r));
  await new Promise(x => setTimeout(x, 40));
}
console.log();

// Build a row per senator, column per (bill.rollCall), cell = vote cast
const senatorVotes = SENATORS.map(s => ({ sen: s, votes: {} }));
for (const b of BILLS) {
  for (const v of b.votes) {
    if (v.chamber !== 'Senate') continue;
    const xml = cache.get(`${v.congress}|${v.session}|${v.rollCall}`);
    if (!xml) continue;
    for (const row of senatorVotes) {
      const cast = extract(xml, row.sen.last, row.sen.st);
      row.votes[`${b.type}${b.number}#${v.rollCall}`] = cast ?? '—';
    }
  }
}

// Display on PRIMARY votes only (weight >= 0.7)
const primaryKeys = [];
for (const b of BILLS) {
  for (const v of b.votes) {
    if (v.chamber === 'Senate' && v.weight >= 0.7) {
      primaryKeys.push({ key: `${b.type}${b.number}#${v.rollCall}`, weight: v.weight, dir: b.direction });
    }
  }
}

console.log('Primary Senate votes (weight ≥ 0.7) — Aye/Nay patterns:');
console.log('(cols = bill#rollcall, blanks where senator wasn\'t in office yet)\n');
console.log('  Bill               w     dir          ' + SENATORS.map(s => s.last.padEnd(11)).join(' '));
for (const { key, weight, dir } of primaryKeys) {
  const row = senatorVotes.map(r => (r.votes[key] ?? '—').padEnd(11));
  console.log('  ' + key.padEnd(18) + ' ' + weight.toFixed(2).padEnd(5) + ' ' + dir.padEnd(12) + ' ' + row.join(' '));
}
