/**
 * Help › Getting Started — orientation for new researchers.
 */
import { HelpArticle, H1, H2, P, Ul, Li, Callout, Kbd } from './HelpArticle';

export function GettingStarted() {
  return (
    <HelpArticle>
      <H1>Getting Started</H1>
      <P>
        This admin panel is the researcher interface for Track Ukraine — a tool that scores every
        U.S. federal legislator on their support for Ukraine based on votes, sponsored bills,
        and curated public statements.
      </P>
      <Callout kind="info">
        Access is gated by Cloudflare Access SSO. You must be signed in with an authorized
        Google account. If you see an access-denied screen, contact the project administrator.
      </Callout>

      <H2>What researchers do here</H2>
      <Ul>
        <Li><strong>Curate quotes</strong> — pull posts from the social-media inbox or add them manually, then score them by direction and weight.</Li>
        <Li><strong>Manage handles</strong> — register a legislator's Bluesky, Mastodon, or YouTube channel so the system polls it automatically.</Li>
        <Li><strong>Review bills</strong> — inspect and annotate the Ukraine-tagged legislation that feeds into scoring.</Li>
        <Li><strong>Monitor the pipeline</strong> — check poll-status failures, clear stuck cache entries, and audit the full activity log.</Li>
      </Ul>

      <H2>Navigation</H2>
      <P>
        The <strong>≡ menu</strong> in the top-left is the single navigation surface. Click it to
        open the megamenu, then click any section. The URL hash updates (e.g. <code>#/curation/inbox</code>)
        so you can bookmark deep-links and use the browser back button.
      </P>
      <Ul>
        <Li><strong>Workspace › People</strong> — search for a legislator and open their profile to manage handles and view their score breakdown.</Li>
        <Li><strong>Workspace › Bills</strong> — CRUD for Ukraine-tagged legislation entries.</Li>
        <Li><strong>Workspace › Activity</strong> — full audit log of every write made through this panel.</Li>
        <Li><strong>Curation › Inbox</strong> — review posts the automated poller flagged against keyword watches.</Li>
        <Li><strong>Curation › Add quote</strong> — manually score a statement by a legislator.</Li>
        <Li><strong>Curation › All quotes</strong> — browse and edit every curated quote.</Li>
        <Li><strong>Curation › Research</strong> — search posts by platform handle, keyword, or date range.</Li>
        <Li><strong>Curation › Add by URL</strong> — paste a post URL directly to ingest and score it.</Li>
        <Li><strong>Admin › Keywords</strong> — manage the keyword patterns the poller uses to flag posts.</Li>
        <Li><strong>Admin › Tags</strong> — manage color-coded labels you can attach to quotes.</Li>
        <Li><strong>Admin › Cache</strong> — inspect and purge the KV response cache.</Li>
        <Li><strong>Admin › Poll status</strong> — per-handle health overview with error trace IDs.</Li>
        <Li><strong>Admin › App config</strong> — deployment-time settings (read-only; change via wrangler.toml).</Li>
        <Li><strong>Help</strong> — this documentation.</Li>
      </Ul>

      <H2>Keyboard shortcuts</H2>
      <Ul>
        <Li><Kbd>Escape</Kbd> — close the megamenu when it is open.</Li>
        <Li><Kbd>Ctrl</Kbd> + click (or <Kbd>⌘</Kbd> + click) a menu link — opens in a new tab.</Li>
      </Ul>

      <H2>Theme</H2>
      <P>
        Use the <strong>◑</strong> toggle in the top-right corner to switch between light and dark mode.
        The preference is saved in <code>localStorage</code> and persists across sessions.
      </P>

      <H2>Who to contact</H2>
      <P>
        For access requests, data questions, or bugs, reach out to the project lead. Audit-log
        entries include your email and a trace ID that can be used to look up exactly what changed
        and when.
      </P>
    </HelpArticle>
  );
}
