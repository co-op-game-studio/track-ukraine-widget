/**
 * Help › Curation Guide — how to score statements.
 */
import { HelpArticle, H1, H2, P, Ul, Li, Callout, Divider, Badge } from './HelpArticle';

export function CurationGuide() {
  return (
    <HelpArticle>
      <H1>Curation Guide</H1>
      <P>
        Curation is the core researcher workflow. You review statements made by legislators —
        pulled automatically from the social-media poller or added manually — and assign them
        a <strong>direction</strong> and a <strong>weight</strong> so they contribute to the
        legislator's Ukraine score.
      </P>

      <H2>The Inbox</H2>
      <P>
        The Inbox (Curation › Inbox) surfaces posts the automated poller has flagged against your
        keyword watches. Each card shows the platform, handle, post text, and detected keywords.
      </P>
      <Ul>
        <Li><strong>Curate</strong> — opens the Add Quote form pre-filled with the post data. You add direction, weight, and an optional note, then save.</Li>
        <Li><strong>Dismiss</strong> — removes the item from the inbox without creating a quote. Use this for false positives.</Li>
        <Li><strong>Open original</strong> — opens the source post URL in a new tab for verification.</Li>
      </Ul>
      <Callout kind="tip">
        Always open the original before scoring. The poller captures post text at poll time; the
        author may have edited or deleted the post since.
      </Callout>

      <H2>Adding a quote manually</H2>
      <P>
        Use <strong>Curation › Add quote</strong> for statements found outside the poller — press releases,
        floor speeches, committee testimony, op-eds, or posts from platforms the poller doesn't cover.
      </P>
      <Ul>
        <Li>Paste the source URL. The system will auto-detect the platform from the domain.</Li>
        <Li>Set the <strong>Bioguide ID</strong> — the legislator the quote belongs to. Use People › search to look it up.</Li>
        <Li>Set the <strong>Posted at</strong> date (ISO-8601: <code>2025-03-14</code> or <code>2025-03-14T15:30:00Z</code>).</Li>
        <Li>Paste the full statement text into <strong>Post text</strong>.</Li>
        <Li>Assign direction and weight (see below).</Li>
        <Li>Optionally add a <strong>Researcher note</strong> — this is visible in the public embed.</Li>
      </Ul>

      <H2>Add by URL</H2>
      <P>
        <strong>Curation › Add by URL</strong> is a shortcut for posts on supported platforms. Paste
        the post URL; the system fetches and pre-fills the text, platform, handle, and date. You only
        need to confirm the bioguide ID and scoring fields before saving.
      </P>

      <H2>Direction</H2>
      <P>Direction indicates whether the statement is pro-Ukraine, anti-Ukraine, or unstated:</P>
      <Ul>
        <Li><Badge color="#1a7f3c">+1 Pro-Ukraine</Badge> — statement clearly supports Ukraine, aid, or sanctions against Russia. Examples: calling for more aid, condemning the invasion, supporting NATO allies.</Li>
        <Li><Badge color="#aaa">0 Unstated</Badge> — statement is ambiguous, neutral, procedural, or doesn't take a position. When in doubt, use 0.</Li>
        <Li><Badge color="#b91c1c">−1 Anti-Ukraine</Badge> — statement opposes aid, repeats Russian narratives, or advocates cutting support. Examples: calling Ukraine a "money pit," opposing aid packages, blaming Ukraine for the war.</Li>
      </Ul>
      <Callout kind="warn">
        Use −1 carefully and only for clear opposition. Skepticism about spending levels or calls
        for oversight alone do not qualify as anti-Ukraine. Focus on the core stance on Ukraine's
        right to defend itself and U.S. support for that.
      </Callout>

      <H2>Weight</H2>
      <P>
        Weight (0–5) controls how strongly this quote affects the score relative to a vote.
        A vote on major Ukraine aid legislation is worth roughly 1.0. Use this scale:
      </P>
      <Ul>
        <Li><strong>0.0</strong> — informational; included for the record but contributes nothing to the score (e.g. a procedural retweet).</Li>
        <Li><strong>0.25–0.5</strong> — minor signal: a social post acknowledging Ukraine, a brief floor comment.</Li>
        <Li><strong>0.75–1.0</strong> — on par with a vote: a major floor speech, a signed letter to the President, a co-sponsored resolution specifically about Ukraine.</Li>
        <Li><strong>1.5–2.0</strong> — high-impact: a committee hearing statement, a major op-ed, a televised interview.</Li>
        <Li><strong>3.0–5.0</strong> — reserved for defining moments: authoring major legislation, a press conference announcing a position reversal, a widely-covered speech.</Li>
      </Ul>
      <Callout kind="tip">
        Start conservative. You can always edit a quote and raise the weight later if the statement
        proves to be a defining moment in the legislative record.
      </Callout>

      <H2>Tags</H2>
      <P>
        Tags are optional color-coded labels (managed under Admin › Tags) that help you organize
        quotes. Common uses: marking quotes as <em>verified</em>, <em>needs-review</em>,
        <em>floor-speech</em>, or <em>press-release</em>. Tags are for internal researcher
        organization; they are not displayed in the public embed.
      </P>

      <H2>Researcher notes</H2>
      <P>
        The <strong>Researcher note</strong> field is optional free text that appears in the public
        embed alongside the quote card. Use it to give voters context — e.g. "Said during markup of
        H.R. 815, which provided $60B in Ukraine aid." Keep notes factual and brief.
      </P>

      <Divider />

      <H2>Editing and deleting quotes</H2>
      <P>
        All quotes are editable from <strong>Curation › All quotes</strong>. Select a quote from
        the list, change any field, and click Save. Every save is logged in the audit trail with
        your email and a trace ID.
      </P>
      <P>
        To delete a quote, click Delete and enter a reason. Deletions are permanent but audited.
        A trace ID is returned — copy it before navigating away if you need to reference it.
      </P>
    </HelpArticle>
  );
}
