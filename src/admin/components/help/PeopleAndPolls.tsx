/**
 * Help › People & Sync — handles, social sync, and rep profiles.
 *
 * "Sync" is the researcher-facing name for the automated job that checks a
 * legislator's social accounts for new posts. (Internally the code still calls
 * this the social poll/poller; the user-facing vocabulary is "sync" because
 * "poll" reads as political-survey jargon — see punchlist v4.3.0.)
 */
import { HelpArticle, H1, H2, H3, P, Ul, Li, Callout, Code, Divider } from './HelpArticle';

export function PeopleAndPolls() {
  return (
    <HelpArticle>
      <H1>People &amp; Sync</H1>
      <P>
        The People section is the per-legislator hub. Each profile shows the rep's current
        score breakdown, their registered social handles, sync history, and curated quotes and
        votes attributed to them.
      </P>

      <H2>Finding a legislator</H2>
      <P>
        Open <strong>Workspace › People</strong> and type a name or Bioguide ID into the search
        box. Click a result to open the profile.
      </P>
      <Ul>
        <Li>The <strong>Bioguide ID</strong> is the canonical identifier — a letter followed by six digits, e.g. <Code>P000197</Code> for Nancy Pelosi. It is stable for the legislator's career.</Li>
        <Li>To look up a Bioguide ID from outside the admin, search <Code>bioguide.congress.gov</Code>.</Li>
      </Ul>

      <H2>Social handles</H2>
      <P>
        The <strong>Handles</strong> panel on a profile lists all registered social media accounts
        for that legislator. Each day, the system checks these accounts and queues
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
        <Li><strong>YouTube</strong> — the channel ID (starts with <Code>UC</Code>, 24 chars) or the <Code>@handle</Code> slug. The system resolves slugs to channel IDs on the first check.</Li>
      </Ul>
      <Callout kind="tip">
        For YouTube, prefer the channel ID over the <Code>@handle</Code> because handles can be
        changed by the account owner. The channel ID is permanent. Find it in the channel URL:
        <Code>youtube.com/channel/UCxxxxxxxx</Code>.
      </Callout>

      <H3>Activating and deactivating handles</H3>
      <P>
        Handles can be toggled active/inactive without deleting them. Inactive handles are skipped
        by the daily sync and by manual "Sync now" but remain in the history. Use this when a
        legislator leaves office or abandons an account — preserving the handle history without
        spending sync budget on a dead account.
      </P>

      <H2>The daily sync</H2>
      <P>
        The social sync runs once a day. On each run it:
      </P>
      <Ul>
        <Li>Checks all active handles for Bluesky and Mastodon (YouTube is checked individually — see below).</Li>
        <Li>Skips handles already checked within the past day to avoid double-pulling.</Li>
        <Li>For each handle, fetches posts newer than the last one already seen.</Li>
        <Li>Matches each post against the active keyword watch list.</Li>
        <Li>Queues matching posts in the inbox for researcher review.</Li>
        <Li>Records failures with a trace ID so you can see exactly which handle failed and why in Admin › Sync status.</Li>
      </Ul>

      <H3>YouTube</H3>
      <Callout kind="warn">
        YouTube is <strong>checked individually, not in the daily batch</strong>, because the
        YouTube data quota is small and checking every legislator at once would exhaust it. Use
        the <strong>Sync now</strong> button on a profile to check a YouTube channel.
      </Callout>

      <H2>Manual sync</H2>
      <P>
        Each handle row on a profile has a <strong>Sync now</strong> button. Clicking it immediately
        checks the latest posts for that handle — outside the daily run. Use this when:
      </P>
      <Ul>
        <Li>A legislator just made a major statement and you don't want to wait for the next daily run.</Li>
        <Li>A handle failed on the last run and you've resolved the underlying issue.</Li>
        <Li>You added a new handle and want to pull its recent posts immediately.</Li>
      </Ul>

      <Divider />

      <H2>Sync Status (Admin › Sync status)</H2>
      <P>
        The Sync Status view shows the last result for every handle across all platforms.
        By default it filters to handles with failures. Each failure row shows:
      </P>
      <Ul>
        <Li><strong>Handle</strong> — the account identifier and platform.</Li>
        <Li><strong>Error message</strong> — the upstream or network error from the last failed check.</Li>
        <Li><strong>Trace ID</strong> — a copyable identifier for the run that produced the failure. Include this in any bug report.</Li>
        <Li><strong>Failed at</strong> — timestamp of the failure.</Li>
      </Ul>
      <P>
        A failed handle is automatically retried on the next run without needing manual intervention.
      </P>
    </HelpArticle>
  );
}
