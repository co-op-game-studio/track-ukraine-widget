/**
 * Help › People & Polls — handles, polling, and rep profiles.
 */
import { HelpArticle, H1, H2, H3, P, Ul, Li, Callout, Code, Divider } from './HelpArticle';

export function PeopleAndPolls() {
  return (
    <HelpArticle>
      <H1>People &amp; Polls</H1>
      <P>
        The People section is the per-legislator hub. Each profile shows the rep's current
        score breakdown, their registered social handles, poll history, and curated quotes and
        votes attributed to them.
      </P>

      <H2>Finding a legislator</H2>
      <P>
        Open <strong>Workspace › People</strong> and type a name or Bioguide ID into the search
        box. The system searches the name index (updated each time the KV publish job runs).
        Click a result to open the profile.
      </P>
      <Ul>
        <Li>The <strong>Bioguide ID</strong> is the canonical identifier — a letter followed by six digits, e.g. <Code>P000197</Code> for Nancy Pelosi. It is stable for the legislator's career.</Li>
        <Li>To look up a Bioguide ID from outside the admin, search <Code>bioguide.congress.gov</Code>.</Li>
      </Ul>

      <H2>Social handles</H2>
      <P>
        The <strong>Handles</strong> panel on a profile lists all registered social media accounts
        for that legislator. The poller checks these accounts on each daily cron tick and enqueues
        any posts that match active keyword watches.
      </P>

      <H3>Adding a handle</H3>
      <Ul>
        <Li>Click <strong>+ Add handle</strong> on the profile.</Li>
        <Li>Select the platform (Bluesky, Mastodon, or YouTube).</Li>
        <Li>Enter the handle. Format varies by platform:</Li>
      </Ul>
      <Ul>
        <Li><strong>Bluesky</strong> — the full handle including domain, e.g. <Code>rep.bsky.social</Code> or a custom domain like <Code>pelosi.house.gov</Code>.</Li>
        <Li><strong>Mastodon</strong> — include the instance, e.g. <Code>@senator@mastodon.social</Code> or just <Code>senator@mastodon.social</Code>.</Li>
        <Li><strong>YouTube</strong> — the channel ID (starts with <Code>UC</Code>, 24 chars) or the <Code>@handle</Code> slug. The system resolves slugs to channel IDs on first poll.</Li>
      </Ul>
      <Callout kind="tip">
        For YouTube, prefer the channel ID over the <Code>@handle</Code> because handles can be
        changed by the account owner. The channel ID is permanent. Find it in the channel URL:
        <Code>youtube.com/channel/UCxxxxxxxx</Code>.
      </Callout>

      <H3>Activating and deactivating handles</H3>
      <P>
        Handles can be toggled active/inactive without deleting them. Inactive handles are skipped
        by the cron poller and by manual "Re-poll" but remain in the history. Use this when a
        legislator leaves office or abandons an account — preserving the handle history without
        burning poll quota on a dead account.
      </P>

      <H2>The daily poll cron</H2>
      <P>
        The social poller runs once daily at <strong>06:00 UTC</strong>. On each tick it:
      </P>
      <Ul>
        <Li>Fetches all active handles for Bluesky and Mastodon (YouTube is excluded from bulk polling — see below).</Li>
        <Li>Skips handles polled within the past ~23 hours to avoid double-pulling if a prior tick overlapped.</Li>
        <Li>For each handle, fetches posts newer than the last-seen post ID.</Li>
        <Li>Matches each post against the active keyword watch list.</Li>
        <Li>Enqueues matching posts in the inbox for researcher review.</Li>
        <Li>Updates each handle's <em>last polled at</em> and <em>last seen post ID</em>.</Li>
        <Li>Records failures with a trace ID so you can see exactly which handle failed and why in Admin › Poll status.</Li>
      </Ul>

      <H3>YouTube polling</H3>
      <Callout kind="warn">
        YouTube is <strong>excluded from bulk polling</strong> because the YouTube Data API v3 has
        a daily quota of 10,000 units and even a modest roster of 535 legislators would exhaust
        it in one run. YouTube channels should be re-polled individually via the <strong>Re-poll</strong>
        button on each profile.
      </Callout>

      <H2>Manual re-poll</H2>
      <P>
        Each handle row on a profile has a <strong>Re-poll</strong> button. Clicking it immediately
        fetches the latest posts for that handle — outside the daily cron. Use this when:
      </P>
      <Ul>
        <Li>A legislator just made a major statement and you don't want to wait until 06:00 UTC.</Li>
        <Li>A handle failed on the last cron tick and you've resolved the underlying issue.</Li>
        <Li>You added a new handle and want to backfill its recent posts immediately.</Li>
      </Ul>

      <Divider />

      <H2>Poll Status (Admin › Poll status)</H2>
      <P>
        The Poll Status view shows the last-poll result for every handle across all platforms.
        By default it filters to handles with failures. Each failure row shows:
      </P>
      <Ul>
        <Li><strong>Handle</strong> — the account identifier and platform.</Li>
        <Li><strong>Error message</strong> — the upstream or network error from the last failed poll.</Li>
        <Li><strong>Trace ID</strong> — a copyable identifier for the cron invocation that produced the failure. Include this in any bug report.</Li>
        <Li><strong>Failed at</strong> — timestamp of the failure.</Li>
      </Ul>
      <P>
        Failures do not update <em>last polled at</em>, so a failed handle is automatically retried
        on the next cron tick without needing manual intervention.
      </P>
    </HelpArticle>
  );
}
