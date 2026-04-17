/**
 * FIPS Map Utilities
 * Maps FIPS state codes to two-letter abbreviations and provides state lookups.
 * Traces to: FR-2, T-003
 */

const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA',
  '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN',
  '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS',
  '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT',
  '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY',
  // Territories
  '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

const STATE_TO_NAME: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida',
  GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming',
  // Territories
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
};

const NAME_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_TO_NAME).map(([code, name]) => [name.toLowerCase(), code]),
);

const TERRITORIES = new Set(['DC', 'AS', 'GU', 'MP', 'PR', 'VI']);

/** Convert a FIPS state code (e.g., "17") to a two-letter state abbreviation (e.g., "IL") */
export function fipsToStateCode(fips: string): string | undefined {
  return FIPS_TO_STATE[fips];
}

/** Convert a two-letter state code to full state name */
export function stateCodeToName(code: string): string | undefined {
  return STATE_TO_NAME[code.toUpperCase()];
}

/** Convert a full state name to two-letter code */
export function stateNameToCode(name: string): string | undefined {
  return NAME_TO_STATE[name.toLowerCase()];
}

/** Returns true if the state code is a territory (DC, PR, GU, VI, AS, MP) */
export function isTerritory(code: string): boolean {
  return TERRITORIES.has(code.toUpperCase());
}
