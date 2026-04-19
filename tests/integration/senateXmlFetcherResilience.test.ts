/**
 * Integration test: SenateXmlFetcher composed with parseSenateVoteXml.
 *
 * The fetcher returns raw XML bytes verbatim; parsing happens in a
 * separate step invoked by the /api/roll-call-rosters/senate/* route
 * after an R2 hit (AC-41.7). This test exercises that composition
 * against upstream weirdness — HTML error pages served with 200, and
 * truncated XML bodies — to confirm each produces a catchable Error
 * (so the pipeline can translate it to an `upstream_parse_error`
 * envelope) rather than crashing the Worker.
 *
 * Traces: FR-44 AC-44.20 (T-096), FR-41 AC-41.7.
 */
import { describe, expect, it, vi } from 'vitest';
import { SenateXmlFetcher } from '../../proxy/upstreams/senate-xml-fetcher';
import { parseSenateVoteXml } from '../../proxy/upstreams/senate-xml-parser';
import type { CacheKey } from '../../proxy/cache/key';

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

const NOW = new Date('2026-04-19T00:00:00Z');
const KEY: CacheKey = {
  kind: 'senate-xml',
  params: { congress: 117, session: 2, rollCall: 78 },
};
const CTX = { traceId: 'tr_0123456789abcdef' };

function makeFetcher(body: string, contentType = 'application/xml'): SenateXmlFetcher {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { 'Content-Type': contentType } }),
  );
  return new SenateXmlFetcher({ fetch: mockFetch, now: () => NOW });
}

describe('SenateXmlFetcher + parseSenateVoteXml — resilience (AC-44.20)', () => {
  it('happy path: valid XML body fetches and parses into a non-empty roster', async () => {
    const fetcher = makeFetcher(FIXTURE_VOTE_XML);
    const entry = await fetcher.fetch(KEY, CTX);

    expect(entry.sourceUpstream).toBe('senate');
    expect(typeof entry.value).toBe('string');

    const roster = parseSenateVoteXml(entry.value);
    expect(roster.congress).toBe(117);
    expect(roster.session).toBe(2);
    expect(roster.rollCall).toBe(78);
    expect(roster.casts.length).toBeGreaterThan(0);
    expect(roster.casts).toHaveLength(3);
  });

  it('HTML error page with 200 status: parser throws a catchable Error', async () => {
    const htmlBody = '<html><body>Not Found</body></html>';
    const fetcher = makeFetcher(htmlBody, 'text/html');
    const entry = await fetcher.fetch(KEY, CTX);

    // Fetcher itself does NOT parse — it returns bytes verbatim.
    expect(entry.value).toBe(htmlBody);

    // Parser must fail loudly so the pipeline can translate to
    // upstream_parse_error rather than silently returning an empty roster.
    expect(() => parseSenateVoteXml(entry.value)).toThrow(
      /<roll_call_vote>|roll_call_vote/,
    );
  });

  it('truncated XML body: parser throws a catchable Error', async () => {
    // Truncate mid-<members> so the opening <roll_call_vote> + scalar metadata
    // are intact but the closing tags and every <member> block are lost.
    // A well-behaved parser should detect the missing </roll_call_vote>
    // sentinel and reject; if it silently returns an empty roster instead,
    // that is a fail-loud violation the pipeline cannot translate to
    // upstream_parse_error.
    const truncated = FIXTURE_VOTE_XML.slice(0, 150);
    const fetcher = makeFetcher(truncated);
    const entry = await fetcher.fetch(KEY, CTX);

    expect(entry.value).toBe(truncated);
    expect(entry.value.length).toBe(150);

    expect(() => parseSenateVoteXml(entry.value)).toThrow(Error);
  });
});
