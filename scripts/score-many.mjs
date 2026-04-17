#!/usr/bin/env node
/**
 * Compute the current (v2.1.3) Ukraine Support Score for a list of senators
 * from their Senate.gov XML votes, using the same logic as the widget.
 *
 * Input: SENATORS list below — [bioguideId, lastName, state, partyAbbrev].
 * Output: table of scores + pro/anti breakdown so we can see whether the
 * current algorithm produces sensible rankings before we change it.
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const KEY = readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1];
if (!KEY) { console.error('No key'); process.exit(1); }

const BILLS = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8'));

const SENATORS = [
  // Known strong pro-UA (D/R hawks)
  { id: 'D000563', last: 'Durbin',     st: 'IL', p: 'D', expect: 'strong pro'  },
  { id: 'M000355', last: 'McConnell',  st: 'KY', p: 'R', expect: 'strong pro (R hawk)' },
  { id: 'S001191', last: 'Schumer',    st: 'NY', p: 'D', expect: 'strong pro'  },
  { id: 'R000122', last: 'Risch',      st: 'ID', p: 'R', expect: 'pro (foreign affairs)' },
  { id: 'B001277', last: 'Blumenthal', st: 'CT', p: 'D', expect: 'strong pro'  },
  // Known anti / skeptical
  { id: 'P000603', last: 'Paul',       st: 'KY', p: 'R', expect: 'deep anti'   },
  { id: 'L000577', last: 'Lee',        st: 'UT', p: 'R', expect: 'deep anti'   },
  { id: 'H001089', last: 'Hawley',     st: 'MO', p: 'R', expect: 'deep anti'   },
  { id: 'T000278', last: 'Tuberville', st: 'AL', p: 'R', expect: 'anti'        },
  { id: 'M001236', last: 'Marshall',   st: 'KS', p: 'R', expect: 'anti'        },
  { id: 'B001261', last: 'Blackburn',  st: 'TN', p: 'R', expect: 'anti-ish'    },
  { id: 'H000601', last: 'Hagerty',    st: 'TN', p: 'R', expect: 'anti-ish'    },
  // The Lankford case
  { id: 'L000575', last: 'Lankford',   st: 'OK', p: 'R', expect: 'mixed, leaning anti?' },
];

const PROCEDURAL_THRESHOLD = 0;
const SIGN = { 'voted-pro': +1, 'voted-anti': -1, unstated: 0 };
const AMP  = { 'voted-pro':  1, 'voted-anti':  1, unstated: 0 };

async function fetchXml(congress, session, rollCall) {
  const padded = String(rollCall).padStart(5, '0');
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

function extractVote(xml, last, st) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const m of doc.getElementsByTagName('member')) {
    if (m.getElementsByTagName('last_name')[0]?.textContent?.trim() === last &&
        m.getElementsByTagName('state')[0]?.textContent?.trim() === st) {
      return m.getElementsByTagName('vote_cast')[0]?.textContent?.trim();
    }
  }
  return null;
}

function normalize(cast) {
  if (cast === 'Yea' || cast === 'Aye') return 'Aye';
  if (cast === 'Nay') return 'Nay';
  if (cast === 'Present') return 'Present';
  return 'Not Voting';
}

function valence(dir, cast, mult) {
  if (mult === 0 || cast === 'Present' || cast === 'Not Voting') return 'unstated';
  if (dir === 'neutral') return 'unstated';
  const eff = mult === 1 ? (dir === 'pro-ukraine') : (dir !== 'pro-ukraine');
  if (eff) return cast === 'Aye' ? 'voted-pro' : 'voted-anti';
  return cast === 'Aye' ? 'voted-anti' : 'voted-pro';
}

// Pre-fetch all Senate votes once into a cache keyed by roll call
console.log('Fetching Senate votes...');
const voteCache = new Map();
const allSenateVotes = new Set();
for (const b of BILLS) {
  for (const v of b.votes) {
    if (v.chamber === 'Senate') {
      allSenateVotes.add(`${v.congress}|${v.session}|${v.rollCall}`);
    }
  }
}
for (const key of allSenateVotes) {
  const [c, s, r] = key.split('|').map(Number);
  const xml = await fetchXml(c, s, r);
  voteCache.set(key, xml);
  process.stdout.write('.');
  await new Promise(r2 => setTimeout(r2, 40));
}
console.log('\n');

function score(sen) {
  let num = 0, den = 0, contrib = 0;
  const byBill = [];
  for (const b of BILLS) {
    const rows = [];
    for (const v of b.votes) {
      if (v.chamber !== 'Senate') continue;
      const xml = voteCache.get(`${v.congress}|${v.session}|${v.rollCall}`);
      if (!xml) continue;
      const raw = extractVote(xml, sen.last, sen.st);
      const cast = raw ? normalize(raw) : 'Not Voting';
      const val = valence(b.direction, cast, v.directionMultiplier);
      rows.push({ rc: v.rollCall, kind: v.kind, w: v.weight, cast, val });
      if (v.weight > PROCEDURAL_THRESHOLD && SIGN[val] !== 0) {
        const mag = AMP[val] * v.weight;
        num += SIGN[val] * mag;
        den += mag;
        contrib++;
      }
    }
    if (rows.length) byBill.push({ bill: b.type + b.number, dir: b.direction, rows });
  }
  return { score: den === 0 ? null : num / den, contrib, num, den, byBill };
}

const results = [];
for (const sen of SENATORS) {
  const r = score(sen);
  results.push({ sen, r });
}

// Sort by score descending (most pro on top)
results.sort((a, b) => (b.r.score ?? -99) - (a.r.score ?? -99));

console.log('┌─────────────┬────────┬───────┬───────┬──────────────────────────────┐');
console.log('│ Senator     │ Party  │ Score │ #acts │ Expectation                  │');
console.log('├─────────────┼────────┼───────┼───────┼──────────────────────────────┤');
for (const { sen, r } of results) {
  const scoreStr = r.score === null ? '  N/A ' : (r.score >= 0 ? '+' : '') + r.score.toFixed(2);
  console.log(
    `│ ${sen.last.padEnd(11)} │ ${sen.p}-${sen.st.padEnd(2)}   │ ${scoreStr.padStart(5)} │ ${String(r.contrib).padStart(5)} │ ${sen.expect.padEnd(28).slice(0, 28)} │`,
  );
}
console.log('└─────────────┴────────┴───────┴───────┴──────────────────────────────┘');
