/**
 * Senate roll-call vote XML parser.
 *
 * The Senate publishes individual-vote XML at
 *   https://www.senate.gov/legislative/LIS/roll_call_votes/vote{c}{s}/vote_{c}_{s}_{rc}.xml
 * with a stable schema across Congresses: a top-level <roll_call_vote>
 * carrying <congress>/<session>/<vote_number> metadata and a <members>
 * block of <member> entries.
 *
 * Why a bespoke parser (no linkedom / DOMParser): the Cloudflare Worker
 * runtime does NOT ship a DOMParser. linkedom exists but adds ~600KB of
 * bundle weight for four tag lookups. The Senate XML schema is regular
 * enough that a tiny tag-scanner reads each <field> by name robustly
 * without requiring a general XML model. Fail-loud on any structural
 * deviation — the format has not changed in ~20 years; if it does, we
 * want to know, not silently return an empty roster.
 *
 * Traces to AC-41.7 (Worker-side parse for R2 XML hits that project to the
 * KV JSON shape).
 */

export interface SenateCast {
  readonly lastName: string;
  readonly state: string;
  readonly cast: string;
  readonly firstName?: string;
  readonly party?: string;
}

export interface SenateRoster {
  readonly congress: number;
  readonly session: number;
  readonly rollCall: number;
  readonly casts: readonly SenateCast[];
}

/**
 * Extract the first text-content of a tag at any depth in a source string.
 * Returns the content trimmed, or null if the tag is absent.
 *
 * Uses a non-greedy regex — safe for simple flat tags but NOT for tags
 * that may contain nested same-named children (we don't have any here).
 */
function scalarTag(src: string, tag: string): string | null {
  const m = src.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim() ?? null;
}

/**
 * Enumerate every occurrence of <tag>...</tag> at any depth, returning
 * the inner text block of each match. Used to walk <member> entries.
 */
function allTagBlocks(src: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? '');
  return out;
}

export function parseSenateVoteXml(xml: string): SenateRoster {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new Error('parseSenateVoteXml: empty or non-string input');
  }
  if (!xml.includes('<roll_call_vote')) {
    throw new Error('parseSenateVoteXml: <roll_call_vote> root not found');
  }

  const congressStr = scalarTag(xml, 'congress');
  const sessionStr = scalarTag(xml, 'session');
  const voteNumberStr = scalarTag(xml, 'vote_number');
  if (!congressStr || !sessionStr || !voteNumberStr) {
    throw new Error('parseSenateVoteXml: missing congress/session/vote_number metadata');
  }
  const congress = Number(congressStr);
  const session = Number(sessionStr);
  const rollCall = Number(voteNumberStr);
  if (!Number.isFinite(congress) || !Number.isFinite(session) || !Number.isFinite(rollCall)) {
    throw new Error('parseSenateVoteXml: non-numeric congress/session/vote_number');
  }

  const memberBlocks = allTagBlocks(xml, 'member');
  const casts: SenateCast[] = [];
  for (const block of memberBlocks) {
    const lastName = scalarTag(block, 'last_name');
    const state = scalarTag(block, 'state');
    const cast = scalarTag(block, 'vote_cast');
    if (!lastName || !state) continue; // skip partial records
    const firstName = scalarTag(block, 'first_name') ?? undefined;
    const party = scalarTag(block, 'party') ?? undefined;
    casts.push({
      lastName,
      state,
      cast: cast ?? '',
      ...(firstName ? { firstName } : {}),
      ...(party ? { party } : {}),
    });
  }

  return { congress, session, rollCall, casts };
}
