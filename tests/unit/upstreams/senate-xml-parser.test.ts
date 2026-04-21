/**
 * Tests for proxy/upstreams/senate-xml-parser.ts.
 *
 * Shared parser for Senate roll-call vote XML. Consumed by the
 * SenateXmlFetcher (for the tier-3 miss path) and by the on-demand parser
 * invoked when R2-hit XML needs to be projected to the JSON roster shape
 * per AC-41.7.
 *
 * Traces to AC-41.7.
 */
import { describe, expect, it } from 'vitest';
import { parseSenateVoteXml } from '../../../proxy/upstreams/senate-xml-parser';

const FIXTURE_VOTE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<roll_call_vote>
  <congress>117</congress>
  <session>2</session>
  <vote_number>00078</vote_number>
  <vote_date>May 12, 2022, 06:55 PM</vote_date>
  <vote_result>Agreed to</vote_result>
  <vote_document_text>H.R. 7691 — Additional Ukraine Supplemental Appropriations Act</vote_document_text>
  <members>
    <member>
      <last_name>Schumer</last_name>
      <first_name>Charles</first_name>
      <state>NY</state>
      <party>D</party>
      <vote_cast>Yea</vote_cast>
    </member>
    <member>
      <last_name>Paul</last_name>
      <first_name>Rand</first_name>
      <state>KY</state>
      <party>R</party>
      <vote_cast>Nay</vote_cast>
    </member>
    <member>
      <last_name>Sinema</last_name>
      <first_name>Kyrsten</first_name>
      <state>AZ</state>
      <party>I</party>
      <vote_cast>Yea</vote_cast>
    </member>
  </members>
</roll_call_vote>
`;

describe('parseSenateVoteXml — happy path', () => {
  it('returns a roster with the three members', () => {
    const roster = parseSenateVoteXml(FIXTURE_VOTE_XML);
    expect(roster.casts).toHaveLength(3);
  });

  it('extracts congress, session, rollCall from the XML', () => {
    const roster = parseSenateVoteXml(FIXTURE_VOTE_XML);
    expect(roster.congress).toBe(117);
    expect(roster.session).toBe(2);
    expect(roster.rollCall).toBe(78);
  });

  it('populates last_name + state + cast on each member', () => {
    const roster = parseSenateVoteXml(FIXTURE_VOTE_XML);
    const schumer = roster.casts.find((c) => c.lastName === 'Schumer');
    expect(schumer).toBeDefined();
    expect(schumer?.state).toBe('NY');
    expect(schumer?.cast).toBe('Yea');
    expect(schumer?.party).toBe('D');
  });

  it('exposes optional firstName + party when present', () => {
    const roster = parseSenateVoteXml(FIXTURE_VOTE_XML);
    const paul = roster.casts.find((c) => c.lastName === 'Paul');
    expect(paul?.firstName).toBe('Rand');
    expect(paul?.party).toBe('R');
  });
});

describe('parseSenateVoteXml — resilience', () => {
  it('throws on malformed (non-XML) input', () => {
    expect(() => parseSenateVoteXml('not xml at all')).toThrow();
  });

  it('throws on XML missing the roll_call_vote root', () => {
    const bad = '<?xml version="1.0"?><other_root><x/></other_root>';
    expect(() => parseSenateVoteXml(bad)).toThrow();
  });

  it('ignores member entries with missing last_name', () => {
    const partial = FIXTURE_VOTE_XML.replace('<last_name>Schumer</last_name>', '');
    const roster = parseSenateVoteXml(partial);
    expect(roster.casts.find((c) => c.lastName === 'Schumer')).toBeUndefined();
    // The other two members still come through.
    expect(roster.casts.length).toBe(2);
  });

  it('trims whitespace inside text nodes', () => {
    const padded = FIXTURE_VOTE_XML.replace('<state>NY</state>', '<state>  NY  </state>');
    const roster = parseSenateVoteXml(padded);
    expect(roster.casts.find((c) => c.lastName === 'Schumer')?.state).toBe('NY');
  });
});
