/**
 * Pure-function tests for the Senate URL helper + Senate XML parser used by
 * the vote-row inline context.
 *
 * Traces:
 *   AC-52.60 — senateHumanUrl prefers human page over XML
 *   AC-52.64 — parseSenateVoteContextXml extracts question/result/totals
 */
import { describe, it, expect } from 'vitest';
import {
  senateHumanUrl,
  parseSenateVoteContextXml,
} from '../../src/admin/components/BillInlineSections';

describe('senateHumanUrl (AC-52.60)', () => {
  it('returns the row URL untouched if not an .xml file', () => {
    const u = senateHumanUrl(118, 2, 99, 'https://www.senate.gov/legislative/something.htm');
    expect(u).toBe('https://www.senate.gov/legislative/something.htm');
  });

  it('falls through to the derived CFM page when row URL is the XML file', () => {
    const u = senateHumanUrl(118, 2, 99, 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1182/vote_118_2_00099.xml');
    expect(u).toMatch(/roll_call_vote_cfm\.cfm/);
    expect(u).toContain('congress=118');
    expect(u).toContain('session=2');
    expect(u).toContain('vote=00099');
  });

  it('zero-pads the vote number to 5 digits in the derived URL', () => {
    const u = senateHumanUrl(117, 1, 7, null);
    expect(u).toContain('vote=00007');
  });

  it('still produces a valid URL when no row URL is present', () => {
    const u = senateHumanUrl(119, 1, 290, null);
    expect(u).toBe(
      'https://www.senate.gov/legislative/LIS/roll_call_lists/roll_call_vote_cfm.cfm?congress=119&session=1&vote=00290',
    );
  });
});

describe('parseSenateVoteContextXml (AC-52.64)', () => {
  const SAMPLE_XML = `
    <?xml version="1.0" encoding="UTF-8"?>
    <roll_call_vote>
      <congress>118</congress>
      <session>2</session>
      <vote_number>148</vote_number>
      <vote_question_text>On Cloture on the Motion to Proceed</vote_question_text>
      <vote_result_text>Cloture Motion Agreed to</vote_result_text>
      <count>
        <yeas>71</yeas>
        <nays>14</nays>
        <present>0</present>
        <absent>15</absent>
      </count>
    </roll_call_vote>
  `;

  it('extracts question + result text', () => {
    const out = parseSenateVoteContextXml(SAMPLE_XML);
    expect(out.question).toBe('On Cloture on the Motion to Proceed');
    expect(out.result).toBe('Cloture Motion Agreed to');
  });

  it('extracts the totals from the <count> block', () => {
    const out = parseSenateVoteContextXml(SAMPLE_XML);
    expect(out.totals).toEqual({ yea: 71, nay: 14, present: 0, notVoting: 15 });
  });

  it('falls back to placeholder text when question/result tags absent', () => {
    const out = parseSenateVoteContextXml('<roll_call_vote></roll_call_vote>');
    expect(out.question).toBe('(no question recorded)');
    expect(out.result).toBe('(no result recorded)');
    expect(out.totals).toEqual({ yea: 0, nay: 0, present: 0, notVoting: 0 });
  });

  it('handles missing <count> block gracefully (zeros)', () => {
    const xml = `
      <roll_call_vote>
        <vote_question_text>Q</vote_question_text>
        <vote_result_text>R</vote_result_text>
      </roll_call_vote>
    `;
    const out = parseSenateVoteContextXml(xml);
    expect(out.question).toBe('Q');
    expect(out.result).toBe('R');
    expect(out.totals).toEqual({ yea: 0, nay: 0, present: 0, notVoting: 0 });
  });
});
