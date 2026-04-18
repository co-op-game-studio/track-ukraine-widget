/**
 * Convert a Congress.gov member (list or detail response) into our domain Representative.
 * Traces to: design.md §3.3, spec.md §6 Data Dictionary, FR-19.
 */
import type {
  CongressMemberSummary,
  CongressMemberDetail,
} from '../types/api';
import type { Representative } from '../types/domain';
import { stateNameToCode, isTerritory } from '../utils/fipsMap';
import { sanitizeUrl } from '../utils/sanitizeUrl';

/** Heuristic: member is non-voting if they represent a territory */
function isNonVotingDelegate(stateCode: string): boolean {
  return isTerritory(stateCode);
}

function stateCodeFromFullName(name: string): string {
  return stateNameToCode(name) ?? name.toUpperCase().slice(0, 2);
}

/**
 * Infer the single-letter party abbreviation from a full party name.
 * Used only when the authoritative abbreviation (from partyHistory) is unavailable.
 */
function partyAbbreviationFromName(name: string): 'D' | 'R' | 'I' | string {
  const n = name.toLowerCase();
  if (n.startsWith('democrat')) return 'D';         // Democratic / Democrat / Democratic-Farmer-Labor
  if (n.startsWith('republican')) return 'R';
  if (n.startsWith('independent')) return 'I';
  if (n.startsWith('libertarian')) return 'L';
  if (n.startsWith('green')) return 'G';
  return name[0]?.toUpperCase() ?? 'I';
}

export function mapSummaryToRepresentative(
  m: CongressMemberSummary,
): Representative {
  const stateCode = stateCodeFromFullName(m.state);
  const chamber: 'house' | 'senate' =
    m.district === null ? 'senate' : 'house';
  return {
    bioguideId: m.bioguideId,
    name: m.name,
    party: m.partyName,
    partyAbbreviation: partyAbbreviationFromName(m.partyName),
    state: stateCode,
    district: m.district,
    chamber,
    photoUrl: sanitizeUrl(m.depiction?.imageUrl),
    isNonVoting: isNonVotingDelegate(stateCode) && chamber === 'house',
    officialWebsiteUrl: null, // only populated by the detail endpoint
  };
}

/** Merge fields from member detail (partyHistory, officialWebsiteUrl) onto a Representative. */
export function enrichWithMemberDetail(
  base: Representative,
  detail: CongressMemberDetail,
): Representative {
  // Current party = most recent entry in partyHistory (FR-19 — authoritative source)
  const currentParty =
    detail.partyHistory.find((p) => p.endYear === undefined) ??
    detail.partyHistory[detail.partyHistory.length - 1];

  return {
    ...base,
    party: currentParty?.partyName ?? base.party,
    partyAbbreviation:
      (currentParty?.partyAbbreviation as Representative['partyAbbreviation']) ??
      base.partyAbbreviation,
    photoUrl: sanitizeUrl(detail.depiction?.imageUrl) ?? base.photoUrl,
    officialWebsiteUrl:
      sanitizeUrl(detail.officialWebsiteUrl) ?? base.officialWebsiteUrl ?? null,
  };
}
