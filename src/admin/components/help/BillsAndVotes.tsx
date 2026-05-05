/**
 * Help › Bills & Votes — how bill data flows and what researchers can edit.
 */
import { HelpArticle, H1, H2, H3, P, Ul, Li, Callout, Code, Divider } from './HelpArticle';

export function BillsAndVotes() {
  return (
    <HelpArticle>
      <H1>Bills &amp; Votes</H1>
      <P>
        The Bills section manages the universe of Ukraine-tagged legislation that feeds into
        scoring. Each bill entry records the legislation's metadata, its Ukraine stance (direction),
        and the roll-call votes and cosponsors that are scored against it.
      </P>

      <H2>Where bill data comes from</H2>
      <P>
        Bills are seeded and refreshed from the <strong>Congress.gov API v3</strong>. The publish
        job fetches bill metadata, latest action, cosponsors, and summaries nightly and writes
        them to the D1 database. Researchers can annotate bill records — but the upstream sync
        will overwrite most fields on the next run, so curation lives in the separate fields
        described below.
      </P>

      <H2>Bill fields</H2>

      <H3>Read-only (set by upstream sync)</H3>
      <Ul>
        <Li><strong>Bill ID</strong> — canonical identifier: <Code>hr815-118</Code> = H.R. 815, 118th Congress.</Li>
        <Li><strong>Title</strong> — official short title from Congress.gov.</Li>
        <Li><strong>Congress</strong> — session number (e.g. <Code>118</Code>).</Li>
        <Li><strong>Chamber</strong> — <Code>House</Code> or <Code>Senate</Code>.</Li>
        <Li><strong>Introduced date</strong> — date the bill was introduced.</Li>
        <Li><strong>Latest action</strong> — most recent legislative action and its date (e.g. "Became Public Law").</Li>
        <Li><strong>Congress.gov URL</strong> — direct link to the official record.</Li>
      </Ul>

      <H3>Researcher-editable fields</H3>
      <Ul>
        <Li><strong>Ukraine direction</strong> — <Code>pro-ukraine</Code>, <Code>anti-ukraine</Code>, or <Code>ambiguous</Code>. This is the single most important field: it determines how every vote and sponsorship on this bill is scored.</Li>
        <Li><strong>Weight</strong> — a multiplier (0–5) applied to all votes and sponsorships on this bill. Default 1.0. Raise it for landmark legislation; lower it for symbolic resolutions.</Li>
        <Li><strong>Summary</strong> — a researcher-written plain-English description of what the bill does and why it is Ukraine-relevant. Appears in the public embed.</Li>
        <Li><strong>Tags</strong> — optional labels for internal organization (e.g. "sanctions", "military-aid", "lend-lease").</Li>
      </Ul>

      <Callout kind="warn">
        Changing <strong>Ukraine direction</strong> on a bill immediately changes how every existing
        vote and sponsorship on that bill is scored. This will shift legislator scores on the next
        KV publish run. Double-check before saving.
      </Callout>

      <H2>Votes (roll calls)</H2>
      <P>
        Each bill has one or more associated roll-call votes in the <strong>Votes</strong> sub-panel.
        Votes are linked by their Congress.gov roll-call ID and carry:
      </P>
      <Ul>
        <Li><strong>Roll call ID</strong> — the Congress.gov identifier (<Code>house-118-456</Code> or <Code>senate-118-123</Code>).</Li>
        <Li><strong>Vote date</strong> — when the vote was held.</Li>
        <Li><strong>Vote type</strong> — e.g. <Code>passage</Code>, <Code>cloture</Code>, <Code>amendment</Code>, <Code>motion-to-recommit</Code>.</Li>
        <Li><strong>Direction multiplier</strong> — <Code>+1</Code> (normal), <Code>−1</Code> (inverted — a Yea vote is actually anti-Ukraine, e.g. a motion to recommit), or <Code>0</Code> (ambiguous; vote contributes nothing to score).</Li>
        <Li><strong>Researcher note</strong> — optional context shown in the embed.</Li>
      </Ul>

      <H3>Vote type and direction multiplier</H3>
      <P>
        Most votes are straightforward: Yea = pro-Ukraine (if the bill is pro-Ukraine). But some
        procedural votes are inverted. Use the direction multiplier to capture this:
      </P>
      <Ul>
        <Li><strong>Passage, cloture (invoke), motion-to-proceed</strong> — multiplier <Code>+1</Code>. A Yea advances the bill.</Li>
        <Li><strong>Motion to recommit, tabling</strong> — multiplier <Code>−1</Code>. A Yea on a motion to recommit a pro-Ukraine bill kills it; the scorer inverts the direction.</Li>
        <Li><strong>Truly ambiguous procedural votes</strong> — multiplier <Code>0</Code>. The vote doesn't cleanly signal Ukraine stance; use <Code>0</Code> to neutralize it from scoring.</Li>
      </Ul>

      <H2>Cosponsors</H2>
      <P>
        Cosponsors are synced automatically from Congress.gov. A cosponsor on a pro-Ukraine bill
        earns a positive score contribution (weight × 0.5 by default — half of a direct vote). A
        cosponsor on an anti-Ukraine bill earns a negative contribution.
      </P>
      <Callout kind="info">
        The sponsor of a bill earns a full 1× weight contribution, not 0.5×. The system
        distinguishes between primary sponsor and cosponsor automatically via the Congress.gov data.
      </Callout>

      <Divider />

      <H2>Adding a new bill</H2>
      <Ul>
        <Li>Click <strong>+ New bill</strong> in Workspace › Bills.</Li>
        <Li>Enter the Bill ID in the format <Code>hr815-118</Code> (type + number + dash + congress).</Li>
        <Li>Set the Ukraine direction immediately — you cannot set it after the fact without changing scores.</Li>
        <Li>The upstream sync will populate metadata fields (title, dates, etc.) on the next nightly run.</Li>
      </Ul>

      <H2>The publish job</H2>
      <P>
        The KV publish job reads from D1 and writes structured JSON to Cloudflare KV — the fast
        read path the public widget uses. It runs after each deploy and can be triggered manually.
        Score changes from your edits are not visible to widget users until the next publish run.
      </P>
    </HelpArticle>
  );
}
