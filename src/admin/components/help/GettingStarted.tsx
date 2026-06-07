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
        Access is gated by sign-in. You must be signed in with an authorized
        account. If you see an access-denied screen, contact the project lead (see below).
      </Callout>

      <H2>What researchers do here</H2>
      <Ul>
        <Li><strong>Curate statements</strong> — review legislator posts the system has collected, or add them by hand, then score them by direction and weight.</Li>
        <Li><strong>Manage handles</strong> — register a legislator's Bluesky, Mastodon, or YouTube account so the system checks it for new posts.</Li>
        <Li><strong>Review bills</strong> — read and annotate the Ukraine-related legislation that feeds into scoring.</Li>
      </Ul>

      <H2>Navigation</H2>
      <P>
        The <strong>≡ menu</strong> in the top-left is the main navigation. Click it to
        open the menu, then click any section. You can bookmark any section and use the
        browser back button.
      </P>
      <Ul>
        <Li><strong>Workspace › People</strong> — search for a legislator and open their profile to manage handles and view their score breakdown.</Li>
        <Li><strong>Workspace › Bills</strong> — review and edit the Ukraine-related legislation that feeds scoring.</Li>
        <Li><strong>Workspace › Activity</strong> — a running history of every change made through this panel.</Li>
        <Li><strong>Curation › Add quote</strong> — score a statement made by a legislator.</Li>
        <Li><strong>Curation › All quotes</strong> — browse and edit every curated statement.</Li>
        <Li><strong>Curation › Research</strong> — search a legislator's social posts by handle, keyword, or date range.</Li>
        <Li><strong>Curation › Add by URL</strong> — paste a post link to bring it in and score it.</Li>
        <Li><strong>Help</strong> — this documentation.</Li>
      </Ul>

      <H2>Keyboard shortcuts</H2>
      <Ul>
        <Li><Kbd>Escape</Kbd> — close the menu when it is open.</Li>
        <Li><Kbd>Ctrl</Kbd> + click (or <Kbd>⌘</Kbd> + click) a menu link — opens in a new tab.</Li>
      </Ul>

      <H2>Theme</H2>
      <P>
        Use the <strong>◑</strong> toggle in the top-right corner to switch between light and dark mode.
        Your preference is remembered across sessions.
      </P>

      <H2>Who to contact</H2>
      <P>
        {/* TODO(v4.3.0): replace with Kody's contact details (name / email /
            preferred channel) once provided. Punchlist item "Add my details
            to the who to contact." */}
        For access requests, data questions, or bugs, reach out to the project lead.
        Every change you make is recorded with your account and a trace ID, so we can
        look up exactly what changed and when.
      </P>
    </HelpArticle>
  );
}
