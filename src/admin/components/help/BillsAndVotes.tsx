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
        Bills are imported and refreshed automatically from the official Congress.gov record.
        The system pulls bill metadata, the latest action, cosponsors, and summaries on a regular
        schedule. Researchers can annotate bill records — but the automatic refresh will overwrite
        most official fields on the next run, so your curation lives in the separate
        researcher-editable fields described below.
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
        Changing <strong>Ukraine direction</strong> on a bill changes how every sponsorship on that
        bill is scored. This will shift legislator scores the next time scores are published.
        Double-check before saving.
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
        <Li><strong>Direction</strong> — each vote states its OWN direction: <Code>pro</Code> (a Yea on this vote counts as pro-Ukraine), <Code>anti</Code> (a Yea counts as anti-Ukraine), or <Code>neutral</Code> (the vote doesn't count toward the score). You set this directly per vote — there is no "multiply by the bill" step.</Li>
        <Li><strong>Details</strong> — optional context shown in the embed.</Li>
      </Ul>

      <H3>Setting a vote's direction</H3>
      <P>
        Read each vote on its own terms: "if a member votes Yea here, is that good or bad for
        Ukraine?" Set the direction to match. The bill's own direction is a separate field and does
        not change how a vote is scored.
      </P>
      <Ul>
        <Li><strong>Passage, cloture (invoke), motion-to-proceed on a pro-Ukraine bill</strong> — <Code>pro</Code>. A Yea advances the bill.</Li>
        <Li><strong>Motion to recommit a pro-Ukraine bill</strong> — <Code>anti</Code>. A Yea here tries to kill the bill, so a Yea is anti-Ukraine. (No inversion — you simply mark the vote <Code>anti</Code>.)</Li>
        <Li><strong>A vote on an anti-Ukraine measure</strong> — <Code>anti</Code>. A Yea supports the anti-Ukraine measure.</Li>
        <Li><strong>Truly ambiguous procedural votes</strong> — <Code>neutral</Code>. The vote doesn't cleanly signal a Ukraine stance, so it contributes nothing.</Li>
      </Ul>
      <Callout kind="tip">
        Use <strong>Admin › Vote review</strong> to walk through every vote and confirm its
        direction. Votes that were historically scored by an "inversion" rule are flagged there for
        a closer look.
      </Callout>

      <H2>Cosponsors</H2>
      <P>
        Cosponsors are imported automatically from the official record. A cosponsor on a pro-Ukraine bill
        earns a positive score contribution (weight × 0.5 by default — half of a direct vote). A
        cosponsor on an anti-Ukraine bill earns a negative contribution.
      </P>
      <Callout kind="info">
        The sponsor of a bill earns a full 1× weight contribution, not 0.5×. The system
        distinguishes between primary sponsor and cosponsor automatically from the official record.
      </Callout>

      <Divider />

      <H2>Adding a new bill</H2>
      <Ul>
        <Li>Click <strong>+ New bill</strong> in Workspace › Bills.</Li>
        <Li>Enter the Bill ID in the format <Code>hr815-118</Code> (type + number + dash + congress).</Li>
        <Li>Set the Ukraine direction immediately — you cannot set it after the fact without changing scores.</Li>
        <Li>The automatic refresh will fill in the official fields (title, dates, etc.) on its next run.</Li>
      </Ul>

      <H2>When your edits go live</H2>
      <P>
        Your edits are saved immediately, but the public widget reads from a published copy of the
        data that is refreshed periodically. Score changes from your edits become visible to the
        public the next time scores are published — not instantly.
      </P>
    </HelpArticle>
  );
}
