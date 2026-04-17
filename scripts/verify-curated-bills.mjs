#!/usr/bin/env node
/**
 * Verify a list of (congress, type, number) bills against Congress.gov.
 * Prints title + latest action for each so we can build the final curated list.
 */
import { readFileSync } from 'node:fs';

const KEY = process.env.CONGRESS_API_KEY || readFileSync('.env', 'utf8')
  .match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1];
if (!KEY) { console.error('No API key'); process.exit(1); }

const candidates = [
  // Featured — major supplementals + Lend-Lease + REPO
  [117, 'hr', 7691],    // $40B May 2022 supplemental
  [118, 'hr', 815],     // $95B Apr 2024 incl $61B Ukraine (includes REPO)
  [117, 's',  3522],    // Lend-Lease (Senate)
  [117, 'hr', 6753],    // Lend-Lease (House)
  [118, 'hr', 8035],    // Ukraine Security Supplemental 2024
  [118, 'hr', 5692],    // earlier Ukraine supplemental
  [118, 'hr', 4175],    // REPO (House)
  [118, 's',  2003],    // REPO (Senate companion)
  [118, 's',  536],     // early Russian asset confiscation
  // More — 117th
  [117, 'hr', 2471],    // FY22 Omnibus (first $13.6B)
  [117, 'hr', 6833],    // FY23 CR with Ukraine supplemental
  [117, 's',  3488],    // Defending Ukraine Sovereignty Act 2022
  [117, 'hr', 6470],    // Defending Ukraine Sovereignty Act 2022 (House)
  [117, 'hr', 7429],    // Russian Digital Asset Sanctions
  [117, 'hr', 7067],    // Closing loopholes in Russia sanctions
  [117, 's',  3723],    // Special Russian Sanctions Authority
  // 118th
  [118, 'hr', 2670],    // FY24 NDAA
  [118, 'hr', 855],     // Oversight of Ukrainian Assistance Act
  [118, 's',  4992],    // Stand with Ukraine Act
  [118, 'sjres', 117],  // Disapproval of Ukrainian Debt report
  // 119th
  [119, 's',  2592],    // Supporting Ukraine Act 2025
  [119, 'hr', 2913],    // Ukraine Support Act
  [119, 'hres', 158],   // Recognizing Three Years
  [119, 'hres', 155],   // Sovereignty resolution
];

const results = [];
for (const [congress, type, num] of candidates) {
  const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${num}?format=json&api_key=${KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      results.push({ congress, type, num, ok: false, status: res.status });
      continue;
    }
    const data = await res.json();
    const b = data.bill;
    results.push({
      congress, type, num,
      ok: true,
      title: b?.title,
      latestAction: b?.latestAction?.text?.slice(0, 80),
      actionDate: b?.latestAction?.actionDate,
    });
  } catch (e) {
    results.push({ congress, type, num, ok: false, error: e.message });
  }
  await new Promise(r => setTimeout(r, 100)); // be polite
}

for (const r of results) {
  const id = `${r.congress}/${r.type.toUpperCase()}/${r.num}`.padEnd(18);
  if (r.ok) {
    console.log(`OK  ${id}  ${r.title}`);
    console.log(`    ${r.actionDate} - ${r.latestAction}`);
  } else {
    console.log(`FAIL ${id}  status=${r.status ?? 'err'} ${r.error ?? ''}`);
  }
}

const passed = results.filter(r => r.ok);
console.log(`\n${passed.length}/${results.length} bills verified`);
