/**
 * Senate Vote XML Service
 * See: docs/design.md §4.3, docs/api-contracts.md §3
 * Traces to: FR-6
 *
 * Fetches roll call vote data from senate.gov's public XML feeds and parses
 * with the browser's DOMParser (or jsdom's DOMParser in tests).
 */

// ─── Shapes returned by this service ───

export interface SenateVoteIndexEntry {
  voteNumber: number;
  voteDate: string;
  issue: string;
  question: string;
  result: string;
  yeas: number;
  nays: number;
  title: string;
}

export interface SenateVoteMember {
  memberFull: string;
  lastName: string;
  firstName: string;
  party: string;        // "D" | "R" | "I"
  state: string;        // two-letter
  voteCast: string;     // "Yea" | "Nay" | "Present" | "Not Voting" (raw — not normalized)
  lisMemberId: string;
}

export interface SenateVoteCount {
  yeas: number;
  nays: number;
  present: number;
  absent: number;
}

export interface SenateVoteDetail {
  congress: number;
  session: number;
  voteNumber: number;
  voteDate: string;
  voteQuestionText: string;
  voteDocumentText: string;
  voteResultText: string;
  question: string;
  voteTitle: string;
  voteResult: string;
  count: SenateVoteCount;
  members: SenateVoteMember[];
}

// ─── Helpers ───

function getText(el: Element | null | undefined, tag: string): string {
  if (!el) return '';
  const child = el.getElementsByTagName(tag)[0];
  return child?.textContent?.trim() ?? '';
}

function getInt(el: Element | null | undefined, tag: string): number {
  const s = getText(el, tag);
  if (s === '') return 0; // per S-3: self-closing or empty => 0
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function parseXml(text: string): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  // DOMParser never throws; check for parsererror element
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) {
    throw new Error(`XML parse error: ${err.textContent}`);
  }
  return doc;
}

async function fetchXml(url: string): Promise<Document> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Senate.gov returned ${res.status}`);
  }
  const text = await res.text();
  return parseXml(text);
}

function padVoteNumber(n: number): string {
  return String(n).padStart(5, '0');
}

// ─── Public API ───

export async function fetchSenateVoteIndex(
  congress: number,
  session: number,
  apiBase: string,
): Promise<SenateVoteIndexEntry[]> {
  const url = `${apiBase}/api/senate/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
  const doc = await fetchXml(url);
  const voteEls = Array.from(doc.getElementsByTagName('vote'));
  return voteEls.map((el) => {
    const tally = el.getElementsByTagName('vote_tally')[0];
    return {
      voteNumber: parseInt(getText(el, 'vote_number'), 10),
      voteDate: getText(el, 'vote_date'),
      issue: getText(el, 'issue'),
      question: getText(el, 'question'),
      result: getText(el, 'result'),
      yeas: getInt(tally, 'yeas'),
      nays: getInt(tally, 'nays'),
      title: getText(el, 'title'),
    };
  });
}

export async function fetchSenateVoteDetail(
  congress: number,
  session: number,
  voteNumber: number,
  apiBase: string,
): Promise<SenateVoteDetail> {
  const padded = padVoteNumber(voteNumber);
  const url = `${apiBase}/api/senate/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${padded}.xml`;
  const doc = await fetchXml(url);

  const root = doc.getElementsByTagName('roll_call_vote')[0];
  if (!root) {
    throw new Error('Invalid Senate vote XML — no <roll_call_vote> root');
  }

  const countEl = root.getElementsByTagName('count')[0];
  const memberEls = Array.from(root.getElementsByTagName('member'));

  return {
    congress: parseInt(getText(root, 'congress'), 10),
    session: parseInt(getText(root, 'session'), 10),
    voteNumber: parseInt(getText(root, 'vote_number'), 10),
    voteDate: getText(root, 'vote_date'),
    voteQuestionText: getText(root, 'vote_question_text'),
    voteDocumentText: getText(root, 'vote_document_text'),
    voteResultText: getText(root, 'vote_result_text'),
    question: getText(root, 'question'),
    voteTitle: getText(root, 'vote_title'),
    voteResult: getText(root, 'vote_result'),
    count: {
      yeas: getInt(countEl, 'yeas'),
      nays: getInt(countEl, 'nays'),
      present: getInt(countEl, 'present'),
      absent: getInt(countEl, 'absent'),
    },
    members: memberEls.map((m) => ({
      memberFull: getText(m, 'member_full'),
      lastName: getText(m, 'last_name'),
      firstName: getText(m, 'first_name'),
      party: getText(m, 'party'),
      state: getText(m, 'state'),
      voteCast: getText(m, 'vote_cast'),
      lisMemberId: getText(m, 'lis_member_id'),
    })),
  };
}

/** Normalize Senate `Yea`/`Nay` to domain `Aye`/`Nay`. */
export function normalizeVoteCast(
  raw: string,
): 'Aye' | 'Nay' | 'Present' | 'Not Voting' {
  switch (raw) {
    case 'Yea':
    case 'Aye':
      return 'Aye';
    case 'Nay':
      return 'Nay';
    case 'Present':
      return 'Present';
    default:
      return 'Not Voting';
  }
}
