#!/usr/bin/env tsx
/**
 * Build the curated Ukraine bill dataset.
 * See docs/design.md §4.6–4.7 for classifier + weighting rules,
 *     docs/spec.md FR-22 for the override layer.
 *
 * Output: src/data/ukraineBills.json
 * Run:    npm run curate     (which invokes `tsx scripts/build-curated-bills.ts`)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadVoteOverrides, lookupOverride, type Chamber } from './load-vote-overrides';

// ─── API key ────────────────────────────────────────────────────────────────

const KEY: string =
  process.env.CONGRESS_API_KEY ||
  (readFileSync('.env', 'utf8').match(/VITE_CONGRESS_API_KEY=(\S+)/)?.[1] ?? '');

if (!KEY) {
  console.error('No API key in env or .env');
  process.exit(1);
}

// ─── Override layer (FR-22) ─────────────────────────────────────────────────

const OVERRIDES = loadVoteOverrides('scripts/vote-overrides.yaml');
const appliedOverrides = new Set<string>();

// ─── Curated seed list ──────────────────────────────────────────────────────

type BillType = 'hr' | 's' | 'hjres' | 'sjres' | 'hconres' | 'sconres' | 'hres' | 'sres';
type BillDirection = 'pro-ukraine' | 'anti-ukraine' | 'neutral';

interface CuratedSeed {
  congress: number;
  type: BillType;
  number: number;
  featured?: boolean;
  direction?: BillDirection;
  label: string;
}

const CURATED: CuratedSeed[] = [
  // ─── FEATURED ───
  { congress: 117, type: 'hr', number: 2471, featured: true, direction: 'pro-ukraine',
    label: 'FY22 Consolidated Appropriations — first $13.6B Ukraine emergency (Mar 2022)' },
  { congress: 117, type: 'hr', number: 7691, featured: true, direction: 'pro-ukraine',
    label: '$40B Ukraine Supplemental (May 2022)' },
  { congress: 117, type: 's',  number: 3522, featured: true, direction: 'pro-ukraine',
    label: 'Ukraine Democracy Defense Lend-Lease Act' },
  { congress: 118, type: 'hr', number: 8035, featured: true, direction: 'pro-ukraine',
    label: 'Ukraine Security Supplemental Appropriations Act (Apr 2024 House passage, $61B)' },
  { congress: 118, type: 'hr', number: 815,  featured: true, direction: 'pro-ukraine',
    label: '$95B National Security Supplemental (Apr 2024, incl. $61B Ukraine + REPO Act)' },

  // ─── Additional ───
  { congress: 118, type: 'hr', number: 4175, direction: 'pro-ukraine',
    label: 'REPO for Ukrainians Act (Russian asset seizure, folded into HR 815)' },
  { congress: 117, type: 'hr', number: 6833, direction: 'pro-ukraine',
    label: 'FY23 CR with Ukraine Supplemental ($12.35B)' },
  { congress: 117, type: 'hr', number: 6753, direction: 'pro-ukraine',
    label: 'Ukraine Democracy Defense Lend-Lease Act (House version)' },
  { congress: 117, type: 's',  number: 3488, direction: 'pro-ukraine',
    label: 'Defending Ukraine Sovereignty Act 2022 (Senate)' },
  { congress: 117, type: 'hr', number: 6470, direction: 'pro-ukraine',
    label: 'Defending Ukraine Sovereignty Act 2022 (House)' },
  { congress: 117, type: 'hr', number: 7429, direction: 'pro-ukraine',
    label: 'Russian Digital Asset Sanctions Compliance Act' },
  { congress: 117, type: 'hr', number: 7067, direction: 'pro-ukraine',
    label: 'Closing Loopholes in Russia Sanctions Act' },
  { congress: 117, type: 's',  number: 3723, direction: 'pro-ukraine',
    label: 'Special Russian Sanctions Authority Act' },
  { congress: 117, type: 'hres', number: 956, direction: 'pro-ukraine',
    label: 'Supporting the people of Ukraine (resolution)' },
  { congress: 118, type: 'hr', number: 5692, direction: 'pro-ukraine',
    label: 'Ukraine Security Assistance & Oversight Supplemental 2024' },
  { congress: 118, type: 's',  number: 2003, direction: 'pro-ukraine',
    label: 'REPO for Ukrainians Act (Senate companion)' },
  { congress: 118, type: 's',  number: 536,  direction: 'pro-ukraine',
    label: 'Russian Asset Confiscation / Ukraine Recovery (early)' },
  { congress: 118, type: 'hr', number: 2670, direction: 'neutral',
    label: 'FY24 NDAA (Ukraine amendments voted on floor — mix of pro and anti)' },
  { congress: 118, type: 'hr', number: 855,  direction: 'neutral',
    label: 'Independent Oversight of Ukrainian Assistance Act' },
  { congress: 118, type: 's',  number: 4992, direction: 'pro-ukraine',
    label: 'Stand with Ukraine Act of 2024' },
  { congress: 118, type: 'sjres', number: 117, direction: 'anti-ukraine',
    label: 'Disapproval of Presidential report on Ukrainian debt (would block debt relief)' },
  { congress: 118, type: 'hres', number: 561, direction: 'neutral',
    label: 'Ukraine-related resolution (118th)' },
  { congress: 119, type: 's',  number: 1241, direction: 'pro-ukraine',
    label: 'Sanctioning Russia Act of 2025' },
  { congress: 119, type: 's',  number: 2592, direction: 'pro-ukraine',
    label: 'Supporting Ukraine Act of 2025' },
  { congress: 119, type: 'hr', number: 2913, direction: 'pro-ukraine',
    label: 'Ukraine Support Act (119th)' },
  { congress: 119, type: 'hres', number: 158, direction: 'pro-ukraine',
    label: 'Recognizing three years of Ukraine defense' },
  { congress: 119, type: 'hres', number: 155, direction: 'pro-ukraine',
    label: "Reaffirming support for Ukraine's sovereignty" },
];

// ─── Congress.gov API response shapes (minimal) ─────────────────────────────

interface CongressBillResponse {
  bill?: {
    title?: string;
    latestAction?: { text?: string; actionDate?: string };
  };
}

interface CongressAction {
  text?: string;
  actionDate?: string;
  recordedVotes?: Array<{
    chamber: Chamber;
    congress: number;
    sessionNumber: number;
    rollNumber: number;
    date: string;
    url: string;
  }>;
}

interface CongressActionsResponse {
  actions?: CongressAction[];
}

interface CongressSummary {
  text?: string;
  actionDate?: string;
  actionDesc?: string;
  updateDate?: string;
}

interface CongressSummariesResponse {
  summaries?: CongressSummary[];
}

// ─── API helper ─────────────────────────────────────────────────────────────

async function api<T>(path: string): Promise<T | null> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.congress.gov${path}${sep}api_key=${KEY}&format=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} for ${path}`);
    return (await res.json()) as T;
  }
  throw new Error(`persistent 429/503 for ${path}`);
}

// ─── Classifiers ────────────────────────────────────────────────────────────

interface DirectionClassification {
  direction: BillDirection;
  reason: string;
}

function classifyDirection(
  bill: CongressBillResponse['bill'] | undefined,
  latestActionText?: string,
): DirectionClassification {
  const title = (bill?.title ?? '').toLowerCase();
  const action = (latestActionText ?? '').toLowerCase();
  const combined = `${title} | ${action}`;

  const ANTI_RULES = [
    /strike.*ukraine/,
    /prohibit.*security assistance/,
    /prohibit.*ukraine/,
    /remove.*ukraine.*(funding|assistance|aid)/,
    /block.*ukraine/,
    /end.*ukraine.*aid/,
    /no.*funding.*ukraine/,
    /disapproval of.*ukrainian/,
  ];
  for (const r of ANTI_RULES) {
    if (r.test(combined)) return { direction: 'anti-ukraine', reason: `matched /${r.source}/` };
  }

  const PRO_RULES = [
    /ukraine.*(supplemental|appropriation|aid|assistance|support|security)/,
    /lend-lease.*ukraine/,
    /repo.*ukrainians/,
    /russian.*(sanctions|asset.*seizure|confiscation)/,
    /defending ukraine sovereignty/,
    /sanctioning russia/,
    /stand with ukraine/,
    /supporting.*ukraine/,
    /recognizing.*ukraine/,
    /reaffirming.*ukraine/,
  ];
  for (const r of PRO_RULES) {
    if (r.test(combined)) return { direction: 'pro-ukraine', reason: `matched /${r.source}/` };
  }

  return { direction: 'neutral', reason: 'no keyword match' };
}

type VoteKind =
  | 'passage'
  | 'concur'
  | 'amendment'
  | 'cloture'
  | 'motion-to-proceed'
  | 'motion-to-recommit'
  | 'waive-budget'
  | 'motion-to-table'
  | 'motion-to-reconsider'
  | 'other-procedural'
  | 'other';

interface VoteClassification {
  weight: number;
  directionMultiplier: -1 | 0 | 1;
  kind: VoteKind;
}

function classifyVote(actionText?: string): VoteClassification {
  const t = (actionText ?? '').toLowerCase();

  if (/motion to table/.test(t))        return { weight: 0,    directionMultiplier:  0, kind: 'motion-to-table' };
  if (/motion to reconsider/.test(t))   return { weight: 0,    directionMultiplier:  0, kind: 'motion-to-reconsider' };
  if (/motion to recommit/.test(t))     return { weight: 0.3,  directionMultiplier: -1, kind: 'motion-to-recommit' };
  if (/cloture/.test(t))                return { weight: 0.45, directionMultiplier: +1, kind: 'cloture' };
  if (/waive.*budgetary/.test(t))       return { weight: 0.25, directionMultiplier: +1, kind: 'waive-budget' };
  if (/motion to proceed/.test(t))      return { weight: 0.3,  directionMultiplier: +1, kind: 'motion-to-proceed' };
  if (/motion to insist/.test(t) || /motion to close portions/.test(t)) {
    return { weight: 0, directionMultiplier: 0, kind: 'other-procedural' };
  }
  if (/resolving differences/.test(t))                                 return { weight: 0.9, directionMultiplier: +1, kind: 'concur' };
  if (/motion to concur|concur.*amendment|conference report/.test(t))  return { weight: 0.9, directionMultiplier: +1, kind: 'concur' };
  if (/senate agreed to.*house amendment|house agreed to.*senate amendment/.test(t)) return { weight: 0.9, directionMultiplier: +1, kind: 'concur' };
  if (/on motion that the house (agree|disagree)/.test(t))             return { weight: 0.9, directionMultiplier: +1, kind: 'concur' };
  if (/agreed to conference/.test(t))                                  return { weight: 0.9, directionMultiplier: +1, kind: 'concur' };
  if (/on passage|passed\/agreed to|became public law|passed house|passed senate/.test(t)) return { weight: 1.0, directionMultiplier: +1, kind: 'passage' };
  if (/amendment|amdt\./.test(t))                                      return { weight: 0.7, directionMultiplier: +1, kind: 'amendment' };
  if (/agreed to/.test(t))                                             return { weight: 0.7, directionMultiplier: +1, kind: 'other' };
  return { weight: 0.5, directionMultiplier: +1, kind: 'other' };
}

function billTypeSlug(type: BillType): string {
  const map: Record<BillType, string> = {
    hr: 'house-bill', s: 'senate-bill',
    hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution',
    hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution',
    hres: 'house-resolution', sres: 'senate-resolution',
  };
  return map[type];
}

// ─── Output shapes ──────────────────────────────────────────────────────────

interface CuratedVote {
  chamber: Chamber;
  congress: number;
  session: number;
  rollCall: number;
  date: string;
  url: string;
  action: string;
  actionDate: string;
  weight: number;
  directionMultiplier: -1 | 0 | 1;
  kind: VoteKind;
  overrideApplied?: true;
  overrideNote?: string | null;
}

interface CuratedBill {
  congress: number;
  type: string;
  number: string;
  featured: boolean;
  label: string;
  title: string | null;
  latestAction: string | null;
  latestActionDate: string | null;
  becameLaw: boolean;
  congressGovUrl: string;
  direction: BillDirection;
  directionReason: string;
  summary: {
    text: string;
    actionDate: string | null;
    actionDesc: string | null;
    updateDate: string | null;
  } | null;
  votes: CuratedVote[];
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

async function enrichBill(entry: CuratedSeed): Promise<CuratedBill> {
  const { congress, type, number } = entry;
  const billResp = await api<CongressBillResponse>(`/v3/bill/${congress}/${type}/${number}`);
  const bill = billResp?.bill ?? {};

  const [actionsResp, summariesResp] = await Promise.all([
    api<CongressActionsResponse>(`/v3/bill/${congress}/${type}/${number}/actions?limit=250`),
    api<CongressSummariesResponse>(`/v3/bill/${congress}/${type}/${number}/summaries`),
  ]);

  const actions = actionsResp?.actions ?? [];
  const summaries = summariesResp?.summaries ?? [];

  const votes: CuratedVote[] = [];
  for (const a of actions) {
    for (const v of a.recordedVotes ?? []) {
      const text = (a.text ?? '').toLowerCase();
      const isPassageRelated =
        /passed|on passage|agreed to|motion to concur|conference report|motion to suspend|motion to recommit|cloture|motion to proceed|waive.*budgetary|motion to reconsider|motion to table|amendment|amdt\./i.test(
          text,
        );
      if (!isPassageRelated) continue;

      const cls = classifyVote(a.text);

      // FR-22: apply YAML override if present for this (chamber, congress, session, rollCall).
      const override = lookupOverride(
        OVERRIDES,
        v.chamber,
        v.congress,
        v.sessionNumber,
        v.rollNumber,
      );
      const finalWeight = override?.weight ?? cls.weight;
      const finalDirMult = (override?.directionMultiplier ?? cls.directionMultiplier) as -1 | 0 | 1;
      const finalKind = (override?.kind as VoteKind) ?? cls.kind;
      const overrideApplied = !!override;
      if (overrideApplied) {
        appliedOverrides.add(`${v.chamber}|${v.congress}|${v.sessionNumber}|${v.rollNumber}`);
      }

      votes.push({
        chamber: v.chamber,
        congress: v.congress,
        session: v.sessionNumber,
        rollCall: v.rollNumber,
        date: v.date,
        url: v.url,
        action: a.text ?? '',
        actionDate: a.actionDate ?? '',
        weight: finalWeight,
        directionMultiplier: finalDirMult,
        kind: finalKind,
        ...(overrideApplied
          ? { overrideApplied: true as const, overrideNote: override!.note ?? null }
          : {}),
      });
    }
  }

  // Dedupe by (chamber, rollCall)
  const uniq = new Map<string, CuratedVote>();
  for (const v of votes) uniq.set(`${v.chamber}#${v.rollCall}`, v);
  const dedupedVotes = Array.from(uniq.values()).sort(
    (a, b) => (b.weight - a.weight) || a.date.localeCompare(b.date),
  );

  const latestSummary = summaries.length
    ? summaries.slice().sort((a, b) => (b.actionDate ?? '').localeCompare(a.actionDate ?? ''))[0]
    : null;

  const classification: DirectionClassification = entry.direction
    ? { direction: entry.direction, reason: 'manual override' }
    : classifyDirection(bill, bill.latestAction?.text);

  return {
    congress,
    type: type.toUpperCase(),
    number: String(number),
    featured: entry.featured === true,
    label: entry.label,
    title: bill.title ?? null,
    latestAction: bill.latestAction?.text ?? null,
    latestActionDate: bill.latestAction?.actionDate ?? null,
    becameLaw: /became public law/i.test(bill.latestAction?.text ?? ''),
    congressGovUrl: `https://www.congress.gov/bill/${congress}th-congress/${billTypeSlug(type)}/${number}`,
    direction: classification.direction,
    directionReason: classification.reason,
    summary: latestSummary
      ? {
          text: stripHtml(latestSummary.text ?? ''),
          actionDate: latestSummary.actionDate ?? null,
          actionDesc: latestSummary.actionDesc ?? null,
          updateDate: latestSummary.updateDate ?? null,
        }
      : null,
    votes: dedupedVotes,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Building curated bill dataset (${CURATED.length} bills)...`);
  const enriched: CuratedBill[] = [];
  for (const entry of CURATED) {
    process.stdout.write(`  ${entry.congress}/${entry.type.toUpperCase()}/${entry.number} ... `);
    try {
      const e = await enrichBill(entry);
      console.log(`OK [${e.direction.padEnd(12)}] ${e.votes.length} votes`);
      enriched.push(e);
    } catch (err) {
      console.log(`FAIL: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  mkdirSync('src/data', { recursive: true });
  writeFileSync('src/data/ukraineBills.json', JSON.stringify(enriched, null, 2));

  const stats = {
    total: enriched.length,
    featured: enriched.filter((b) => b.featured).length,
    pro: enriched.filter((b) => b.direction === 'pro-ukraine').length,
    anti: enriched.filter((b) => b.direction === 'anti-ukraine').length,
    neutral: enriched.filter((b) => b.direction === 'neutral').length,
    votes: enriched.reduce((s, b) => s + b.votes.length, 0),
    withSummary: enriched.filter((b) => b.summary).length,
  };
  const voteKinds: Record<string, number> = {};
  for (const b of enriched) for (const v of b.votes) voteKinds[v.kind] = (voteKinds[v.kind] ?? 0) + 1;

  console.log(
    `\nWrote src/data/ukraineBills.json\n  ${stats.total} bills | ${stats.featured} featured\n  ${stats.pro} pro-UA · ${stats.anti} anti-UA · ${stats.neutral} neutral\n  ${stats.votes} roll-call votes | ${stats.withSummary} with CRS summary\n  vote kinds: ${JSON.stringify(voteKinds)}`,
  );

  console.log(`\nOverrides loaded: ${OVERRIDES.size}`);
  console.log(`Overrides applied: ${appliedOverrides.size}`);
  if (OVERRIDES.size > appliedOverrides.size) {
    const dormant = [...OVERRIDES.keys()].filter((k) => !appliedOverrides.has(k));
    console.log(`  Dormant (no matching vote in curated bills):`);
    for (const k of dormant) console.log(`    - ${k}`);
  }
  for (const k of appliedOverrides) {
    const o = OVERRIDES.get(k)!;
    console.log(
      `  ✓ ${k}: weight=${o.weight ?? '—'} dirMult=${o.directionMultiplier ?? '—'} kind=${o.kind ?? '—'}${o.bill ? ` [${o.bill}]` : ''}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
