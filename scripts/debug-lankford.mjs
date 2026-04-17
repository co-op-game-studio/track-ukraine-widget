#!/usr/bin/env node
/**
 * Debug: compute Lankford's Ukraine Support Score from real live API data,
 * matching the widget's current score engine behavior (procedural votes excluded).
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';

const KEY = readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1];
if (!KEY) { console.error('No key'); process.exit(1); }

const BILLS = JSON.parse(readFileSync('src/data/ukraineBills.json', 'utf8'));
const MEMBER = { bioguideId: 'L000575', lastName: 'Lankford', state: 'OK', party: 'R' };

const PROCEDURAL_THRESHOLD = 0.2; // matches src/services/ukraineScore.ts

async function fetchSenateXml(congress, session, rollCall) {
  const padded = String(rollCall).padStart(5, '0');
  const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

function extractSenateVote(xmlText, lastName, state) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const members = Array.from(doc.getElementsByTagName('member'));
  for (const m of members) {
    const ln = m.getElementsByTagName('last_name')[0]?.textContent?.trim();
    const st = m.getElementsByTagName('state')[0]?.textContent?.trim();
    if (ln === lastName && st === state) {
      return m.getElementsByTagName('vote_cast')[0]?.textContent?.trim();
    }
  }
  return null;
}

function normalizeCast(raw) {
  if (raw === 'Yea' || raw === 'Aye') return 'Aye';
  if (raw === 'Nay') return 'Nay';
  if (raw === 'Present') return 'Present';
  return 'Not Voting';
}

function valence(direction, cast) {
  if (cast === 'Present' || cast === 'Not Voting') return 'unstated';
  if (direction === 'neutral') return 'unstated';
  const isPro = direction === 'pro-ukraine';
  if (isPro) return cast === 'Aye' ? 'voted-pro' : 'voted-anti';
  return cast === 'Aye' ? 'voted-anti' : 'voted-pro';
}

const SIGN = { 'voted-pro': +1, 'voted-anti': -1, 'unstated': 0, 'sponsor-pro': +1, 'sponsor-anti': -1 };
const AMP  = { 'voted-pro':  1, 'voted-anti':  1, 'unstated': 0, 'sponsor-pro': 1.5, 'sponsor-anti': 1.5 };

const contributing = [];
for (const bill of BILLS) {
  for (const vote of bill.votes) {
    if (vote.chamber !== 'Senate') continue;
    const xml = await fetchSenateXml(vote.congress, vote.session, vote.rollCall);
    await new Promise(r => setTimeout(r, 80));
    if (!xml) continue;
    const raw = extractSenateVote(xml, MEMBER.lastName, MEMBER.state);
    const cast = raw ? normalizeCast(raw) : 'Not Voting';
    const v = valence(bill.direction, cast);
    const included = vote.weight > PROCEDURAL_THRESHOLD && SIGN[v] !== 0;
    if (!included) continue;

    contributing.push({
      bill: `${bill.type}${bill.number}`,
      dir: bill.direction,
      rollCall: `${vote.chamber}#${vote.rollCall}`,
      weight: vote.weight,
      cast,
      valence: v,
      contribution: SIGN[v] * AMP[v] * vote.weight,
      denom: AMP[v] * vote.weight,
    });
  }
}

console.log('Lankford contributing actions (procedurals excluded):');
for (const c of contributing) {
  console.log(
    `  ${c.bill.padEnd(10)} ${c.rollCall.padEnd(13)} w=${c.weight} ${c.cast.padEnd(4)} → ${c.valence.padEnd(11)} ${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(3)}`,
  );
}

const num = contributing.reduce((s, c) => s + c.contribution, 0);
const denom = contributing.reduce((s, c) => s + c.denom, 0);
const score = denom === 0 ? null : num / denom;
console.log('\n=== Score ===');
console.log(`  Contributing: ${contributing.length}`);
console.log(`  Numerator:    ${num.toFixed(3)}`);
console.log(`  Denominator:  ${denom.toFixed(3)}`);
console.log(`  Score:        ${score === null ? 'N/A' : score.toFixed(3)}`);
