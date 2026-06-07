/**
 * Help › Scoring Explained — how the Ukraine score is computed.
 */
import { HelpArticle, H1, H2, H3, P, Ul, Li, Callout, Code, Divider, Badge } from './HelpArticle';

export function ScoringExplained() {
  return (
    <HelpArticle>
      <H1>Scoring Explained</H1>
      <P>
        Each legislator receives a <strong>Ukraine score</strong> — a number from −100 to +100
        that reflects their aggregate stance on Ukraine based on their voting record, sponsored
        legislation, and curated public statements.
      </P>
      <Callout kind="info">
        The score is a research aid, not a grade. It reflects documented actions on Ukraine-tagged
        items only. A legislator with few curated items may have a less stable score than one with
        a long record — the UI surfaces confidence signals (vote count, quote count) so voters can
        judge for themselves.
      </Callout>

      <H2>Score range and interpretation</H2>
      <Ul>
        <Li><Badge color="#1a7f3c">+50 to +100</Badge> — Strong support. Consistent pro-Ukraine votes, sponsorships, and statements.</Li>
        <Li><Badge color="#2b7a2b">+10 to +49</Badge> — General support with occasional abstentions or mixed signals.</Li>
        <Li><Badge color="#888">−10 to +10</Badge> — Ambiguous or very limited record. Do not read this as "neutral" — it may simply mean the legislator has avoided taking a public position.</Li>
        <Li><Badge color="#b45309">−49 to −11</Badge> — Generally opposing, with some supportive votes or statements.</Li>
        <Li><Badge color="#b91c1c">−100 to −50</Badge> — Strongly opposing. Consistent anti-Ukraine votes, obstruction, or statements.</Li>
      </Ul>

      <H2>Score components</H2>
      <P>The raw score is the sum of contributions from four source types:</P>

      <H3>1. Roll-call votes</H3>
      <P>
        Each vote carries its OWN direction — <Code>pro</Code>, <Code>anti</Code>, or{' '}
        <Code>neutral</Code> — meaning "a Yea on this vote is pro / anti / neutral toward Ukraine."
        Scoring reads that directly; there is no "bill direction × multiplier" step.
      </P>
      <Ul>
        <Li><strong>Yea</strong> on a <Code>pro</Code> vote → positive contribution.</Li>
        <Li><strong>Nay</strong> on a <Code>pro</Code> vote → negative contribution.</Li>
        <Li><strong>Yea</strong> on an <Code>anti</Code> vote → negative contribution.</Li>
        <Li><strong>Nay</strong> on an <Code>anti</Code> vote → positive contribution.</Li>
        <Li><strong>Neutral votes, Present, or Not voting</strong> → zero contribution.</Li>
      </Ul>
      <P>
        The magnitude of the contribution is the vote's <strong>weight</strong>. A procedural vote
        like a motion to recommit (where a Yea tries to kill a pro-Ukraine bill) is simply marked{' '}
        <Code>anti</Code> — no sign-flipping to reason about.
      </P>

      <H3>2. Bill sponsorships and cosponsorships</H3>
      <Ul>
        <Li><strong>Primary sponsor</strong> of a pro-Ukraine bill → full bill-weight contribution.</Li>
        <Li><strong>Cosponsor</strong> of a pro-Ukraine bill → 0.5 × bill-weight contribution.</Li>
        <Li>For an anti-Ukraine bill, sponsoring/cosponsoring contributes negatively instead.</Li>
      </Ul>

      <H3>3. Curated quotes</H3>
      <P>
        Each saved quote contributes <strong>direction × weight</strong> to the score. A
        pro-Ukraine quote with weight 1.0 contributes the same as a Yea vote on a weight-1.0 bill.
        A dismissively anti-Ukraine floor speech scored anti-Ukraine at weight 2.0 contributes
        −2.0 — equivalent to two Nay votes on a standard bill.
      </P>

      <H3>4. Obstruction signals</H3>
      <P>
        Certain procedural patterns are treated as obstruction even if the underlying vote is
        technically "Yea":
      </P>
      <Ul>
        <Li>Voting <strong>Nay</strong> on cloture or a motion to proceed on a pro-Ukraine bill.</Li>
        <Li>Voting <strong>Yea</strong> on a motion to recommit a pro-Ukraine bill.</Li>
      </Ul>
      <P>
        These are captured simply by setting the vote's <strong>direction</strong> to{' '}
        <Code>anti</Code> on the relevant roll call, so a Yea scores as anti-Ukraine.
      </P>

      <H2>Normalization</H2>
      <P>
        Raw scores are normalized against the <strong>party prior</strong> — the median score
        for all legislators of the same party. This lets the widget show the score relative to
        what is typical for the legislator's party, not just in absolute terms.
      </P>
      <P>
        The normalization formula is approximately:
      </P>
      <Ul>
        <Li>If raw score ≥ party median: normalize to +10 to +100 proportionally.</Li>
        <Li>If raw score &lt; party median: normalize to −100 to +10 proportionally.</Li>
      </Ul>
      <Callout kind="info">
        Party priors are computed when scores are published and stored on each member's record. If the
        member roster changes significantly (many new scores, a wave election), the next publish
        re-normalizes all scores automatically.
      </Callout>

      <Divider />

      <H2>Score stability and confidence</H2>
      <P>
        A legislator with only 2 curated items has a less reliable score than one with 40. The
        embed shows the number of votes, quotes, and sponsorships included so viewers can weigh
        this themselves.
      </P>
      <P>
        As a researcher, prefer to add <em>more items</em> rather than inflating individual weights.
        A deep record with accurate weights is more defensible than a sparse record with high weights.
      </P>

      <H2>When scores change</H2>
      <Ul>
        <Li>Editing a quote's direction or weight → score changes the next time scores are published.</Li>
        <Li>Adding a new bill and setting its direction → all existing votes on that bill are now scored.</Li>
        <Li>Changing a bill's Ukraine direction → all existing votes and sponsorships on that bill flip.</Li>
        <Li>Deleting a quote → score decreases (or increases) by that quote's contribution.</Li>
      </Ul>
      <Callout kind="warn">
        Score changes are not immediate for public widget users. Scores are published on a regular
        schedule (and can be published manually). Plan accordingly if a score correction needs to
        go live quickly.
      </Callout>
    </HelpArticle>
  );
}
