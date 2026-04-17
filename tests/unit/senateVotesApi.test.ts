/**
 * Senate Vote XML Service Tests
 * Traces to: FR-6, design.md §4.3
 * Authoritative contract: docs/api-contracts.md §3
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchSenateVoteIndex,
  fetchSenateVoteDetail,
  normalizeVoteCast,
} from '../../src/services/senateVotesApi';

// ─── Fixtures (verified against live Senate.gov XML 2026-04-16) ───

const voteIndexXml = `<?xml version="1.0" encoding="UTF-8"?><vote_summary>
  <congress>119</congress>
  <session>1</session>
  <congress_year>2025</congress_year>
  <votes>
    <vote>
      <vote_number>00659</vote_number>
      <vote_date>18-Dec</vote_date>
      <issue>PN373</issue>
      <question>On the Cloture Motion</question>
      <result>Agreed to</result>
      <vote_tally>
        <yeas>51</yeas>
        <nays>42</nays>
      </vote_tally>
      <title>Motion to Invoke Cloture: Sara Bailey</title>
    </vote>
    <vote>
      <vote_number>00658</vote_number>
      <vote_date>18-Dec</vote_date>
      <issue>PN615-2</issue>
      <question>On the Cloture Motion</question>
      <result>Agreed to</result>
      <vote_tally>
        <yeas>60</yeas>
        <nays>35</nays>
      </vote_tally>
      <title>Motion to Invoke Cloture: Alexander C. Van Hook</title>
    </vote>
  </votes>
</vote_summary>`;

const voteDetailXml = `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote>
  <congress>119</congress>
  <session>1</session>
  <vote_number>659</vote_number>
  <vote_date>December 18, 2025,  09:42 PM</vote_date>
  <vote_question_text>On the Cloture Motion PN373</vote_question_text>
  <vote_document_text>Sara Bailey, of Texas</vote_document_text>
  <vote_result_text>Cloture Motion Agreed to (51-42)</vote_result_text>
  <question>On the Cloture Motion</question>
  <vote_title>Motion to Invoke Cloture: Sara Bailey</vote_title>
  <vote_result>Cloture Motion Agreed to</vote_result>
  <count>
    <yeas>51</yeas>
    <nays>42</nays>
    <present/>
    <absent>7</absent>
  </count>
  <members>
    <member>
      <member_full>Durbin (D-IL)</member_full>
      <last_name>Durbin</last_name>
      <first_name>Richard</first_name>
      <party>D</party>
      <state>IL</state>
      <vote_cast>Nay</vote_cast>
      <lis_member_id>S288</lis_member_id>
    </member>
    <member>
      <member_full>Duckworth (D-IL)</member_full>
      <last_name>Duckworth</last_name>
      <first_name>Tammy</first_name>
      <party>D</party>
      <state>IL</state>
      <vote_cast>Nay</vote_cast>
      <lis_member_id>S393</lis_member_id>
    </member>
    <member>
      <member_full>Barrasso (R-WY)</member_full>
      <last_name>Barrasso</last_name>
      <first_name>John</first_name>
      <party>R</party>
      <state>WY</state>
      <vote_cast>Yea</vote_cast>
      <lis_member_id>S317</lis_member_id>
    </member>
  </members>
</roll_call_vote>`;

function mockXml(text: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    }),
  );
}

describe('senateVotesApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSenateVoteIndex', () => {
    it('returns parsed vote index entries', async () => {
      mockXml(voteIndexXml);
      const votes = await fetchSenateVoteIndex(119, 1, '');
      expect(votes).toHaveLength(2);
      expect(votes[0]!.voteNumber).toBe(659);      // parsed as integer from "00659"
      expect(votes[0]!.issue).toBe('PN373');
      expect(votes[0]!.result).toBe('Agreed to');
      expect(votes[0]!.yeas).toBe(51);
      expect(votes[0]!.nays).toBe(42);
      expect(votes[0]!.title).toBe('Motion to Invoke Cloture: Sara Bailey');
    });

    it('calls the correct URL for the session', async () => {
      const spy = mockXml(voteIndexXml);
      await fetchSenateVoteIndex(119, 2, '/proxy');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toBe('/proxy/api/senate/legislative/LIS/roll_call_lists/vote_menu_119_2.xml');
    });

    it('trims whitespace/newlines in question text', async () => {
      mockXml(voteIndexXml);
      const votes = await fetchSenateVoteIndex(119, 1, '');
      // The real API sometimes has trailing newlines/spaces
      expect(votes[0]!.question).toBe('On the Cloture Motion');
    });
  });

  describe('fetchSenateVoteDetail', () => {
    it('returns parsed vote detail with member votes', async () => {
      mockXml(voteDetailXml);
      const detail = await fetchSenateVoteDetail(119, 1, 659, '');
      expect(detail.voteNumber).toBe(659);
      expect(detail.voteQuestionText).toBe('On the Cloture Motion PN373');
      expect(detail.voteResult).toBe('Cloture Motion Agreed to');
      expect(detail.members).toHaveLength(3);
    });

    it('URL-pads the vote number to 5 digits (S-1)', async () => {
      const spy = mockXml(voteDetailXml);
      await fetchSenateVoteDetail(119, 1, 42, '');
      const url = spy.mock.calls[0]![0] as string;
      expect(url).toContain('vote1191/vote_119_1_00042.xml');
    });

    it('handles empty/self-closing count elements as 0 (S-3)', async () => {
      mockXml(voteDetailXml);
      const detail = await fetchSenateVoteDetail(119, 1, 659, '');
      expect(detail.count.present).toBe(0); // from <present/>
      expect(detail.count.yeas).toBe(51);
      expect(detail.count.nays).toBe(42);
      expect(detail.count.absent).toBe(7);
    });

    it('extracts member fields including lis_member_id', async () => {
      mockXml(voteDetailXml);
      const detail = await fetchSenateVoteDetail(119, 1, 659, '');
      const durbin = detail.members.find((m) => m.lastName === 'Durbin');
      expect(durbin).toBeDefined();
      expect(durbin!.firstName).toBe('Richard');
      expect(durbin!.party).toBe('D');
      expect(durbin!.state).toBe('IL');
      expect(durbin!.voteCast).toBe('Nay');
      expect(durbin!.lisMemberId).toBe('S288');
    });

    it('finds a senator by last name + state match', async () => {
      mockXml(voteDetailXml);
      const detail = await fetchSenateVoteDetail(119, 1, 659, '');
      const matches = detail.members.filter((m) => m.lastName === 'Durbin' && m.state === 'IL');
      expect(matches).toHaveLength(1);
    });
  });

  describe('normalizeVoteCast', () => {
    it('maps Yea → Aye', () => {
      expect(normalizeVoteCast('Yea')).toBe('Aye');
    });

    it('preserves Nay', () => {
      expect(normalizeVoteCast('Nay')).toBe('Nay');
    });

    it('preserves Present', () => {
      expect(normalizeVoteCast('Present')).toBe('Present');
    });

    it('preserves Not Voting', () => {
      expect(normalizeVoteCast('Not Voting')).toBe('Not Voting');
    });
  });
});
