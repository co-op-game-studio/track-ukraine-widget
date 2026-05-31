/**
 * Member-field normalizers shared by the seed CLI (and mirrored from the
 * legacy publish-to-kv.ts so D1 rows match the KV projection exactly).
 */

export const STATE_NAME_TO_CODE: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR',
  California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI',
  Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME',
  Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'American Samoa': 'AS', Guam: 'GU', 'Northern Mariana Islands': 'MP',
  'Puerto Rico': 'PR', 'Virgin Islands': 'VI',
};

const NON_VOTING_STATES = new Set(['AS', 'DC', 'GU', 'MP', 'PR', 'VI']);

/** Normalize a state to its two-letter code (passes through codes unchanged). */
export function stateToCode(state: string): string {
  if (state.length === 2) return state.toUpperCase();
  return STATE_NAME_TO_CODE[state] ?? state;
}

export function partyLetter(partyName: string): string {
  const p = (partyName ?? '').toLowerCase();
  if (p.startsWith('democrat')) return 'D';
  if (p.startsWith('republican')) return 'R';
  if (p.startsWith('independent')) return 'I';
  if (p.startsWith('libertarian')) return 'L';
  if (p.startsWith('green')) return 'G';
  return (partyName ?? '').charAt(0).toUpperCase();
}

export function isNonVotingDelegate(chamber: string, stateCode: string): boolean {
  return chamber === 'House' && NON_VOTING_STATES.has(stateCode);
}
