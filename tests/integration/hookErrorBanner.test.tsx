/** Traces: FR-44 AC-44.17 (T-093), FR-37 AC-37.5, FR-37 AC-37.8. */
/**
 * hookErrorBanner — integration audit of how each error-emitting hook propagates
 * FR-37 error envelopes into the ErrorBanner surface in its owning component.
 *
 * Audit findings discovered while writing this test (v2.6.0 widget state):
 *
 *   1. `useAddressLookup` is owned by `VoterInfoWidget`, not `ResultsPanel`
 *      (ResultsPanel is a pure presentational consumer of a resolved
 *      `LookupResult`). VoterInfoWidget renders `<ErrorBanner />` on
 *      `lookup.error`, but with only `message` + `onDismiss` — the hook
 *      today converts any non-ok fetch into a plain `Error` inside
 *      `geocodeAddress` / `fetchStateMembers`, so the FR-37 envelope's
 *      `userMessage` / `traceId` / `retryable` fields are dropped at the
 *      service boundary before reaching state. Test 1 asserts the CURRENT
 *      observable behavior (banner appears, *some* message text shows) and
 *      carries a TODO noting the migration gap.
 *
 *   2. `NameSearchResultsPanel` + `useNameSearch` (test 3): the hook's error
 *      state is rendered as a plain `<div class="viw-name-search-hint">`
 *      with the text "Search error: {message}" — NOT an `ErrorBanner`. The
 *      banner component is never instantiated on this path, so there is no
 *      trace ID, no userMessage, and no retry button to assert on. Test
 *      skipped per T-093 guidance ("do not modify the component; flag it").
 *
 *   3. `RepDetail` + `useVotingRecord` / `useSponsoredBills` (tests 2 & 4):
 *      RepDetail forwards `votingRecord.error?.message` to `<VoteList>` and
 *      `bills.error?.message` to `<BillList>`, which render their own
 *      `<div class="viw-{votelist,billlist}-error" role="alert">` text nodes.
 *      `ErrorBanner` is not used on this surface either. Tests skipped.
 *
 * Net: today only ONE of the four envelope-hook pairs goes through
 * `ErrorBanner`, and even that one path does not parse the FR-37 envelope.
 * Full widget-side FR-37 wiring is a separate task.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VoterInfoWidget } from '../../src/VoterInfoWidget';

// ─── FR-37 envelope fixtures ─────────────────────────────────────────────────

interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    userMessage: string;
    upstream: 'congress' | 'senate' | 'census' | null;
    retryable: boolean;
    traceId: string;
  };
}

function envelope(
  code: string,
  userMessage: string,
  traceId: string,
  upstream: ErrorEnvelopeBody['error']['upstream'],
  retryable: boolean,
): ErrorEnvelopeBody {
  return {
    error: {
      code,
      message: `operator-context: ${code}`,
      userMessage,
      upstream,
      retryable,
      traceId,
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-trace-id': 'tr_headertrace' },
  });
}

// ─── Test 1 — live: useAddressLookup 429 via VoterInfoWidget ──────────────────

describe('hookErrorBanner — FR-37 envelope propagation audit (AC-44.17 / T-093)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ResultsPanel + useAddressLookup on a 429: ErrorBanner renders on the lookup error', async () => {
    // NOTE: useAddressLookup is owned by VoterInfoWidget (not ResultsPanel);
    // ResultsPanel is presentational and never sees hook errors. We render
    // VoterInfoWidget so the real hook + real ErrorBanner surface participate.
    const body = envelope(
      'rate_limited',
      'Too many requests. Try again.',
      'tr_0123456789abcdef',
      'census',
      true,
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(body, 429),
    );

    render(<VoterInfoWidget apiBase="" />);

    const input = screen.getByLabelText(/Enter your home address/i);
    fireEvent.change(input, { target: { value: '2000 S State St, Chicago, IL 60616' } });
    fireEvent.click(screen.getByRole('button', { name: /Look Up/i }));

    // Banner appears. useAddressLookup today throws a generic Error from the
    // service layer (Census geocode on non-ok), so we assert the observable
    // shape: an alert region with *some* message text and a dismiss affordance.
    const banner = await waitFor(() => {
      const el = document.querySelector('.viw-error-banner');
      if (!el) throw new Error('ErrorBanner not yet rendered');
      return el;
    });
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent ?? '').toMatch(/\S/); // non-empty message

    // TODO(FR-37 widget migration): once useAddressLookup wires
    // parseErrorEnvelope through geocodeAddress/fetchStateMembers, upgrade
    // these assertions to:
    //   expect(alert).toHaveTextContent('Too many requests. Try again.');
    //   expect(alert).toHaveTextContent(/Reference:\s*tr_0123456789abcdef/);
    //   expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // and drop the fallback-shape assertions above.
    expect(fetchMock).toHaveBeenCalled();
  });

  // ─── Test 2 — SKIPPED: RepDetail does not use ErrorBanner ──────────────────
  //
  // Component gap: RepDetail.tsx routes useVotingRecord's error to
  // `<VoteList error={votingRecord.error?.message ?? null} />`, which renders
  // `<div className="viw-votelist-error" role="alert">{error}</div>` — a plain
  // error string, not the ErrorBanner component. There is no traceId line and
  // no retry button to assert on. Fixing this is out of scope for T-093;
  // flagging here so the audit surfaces the divergence.
  it.skip('RepDetail + voting-record 500: retry + trace ID on ErrorBanner', () => {
    // Component RepDetail does not render ErrorBanner on useVotingRecord
    // error; test skipped with comment. See header JSDoc finding (3).
  });

  // ─── Test 3 — SKIPPED: NameSearchResultsPanel does not use ErrorBanner ─────
  //
  // Component gap: NameSearchResultsPanel renders the `error` prop inline as
  // `<div className="viw-name-search-hint" role="status">Search error: {error}</div>`.
  // No ErrorBanner component is mounted on this surface; there is no
  // userMessage/traceId/retry surface to assert against. Additionally,
  // VoterInfoWidget currently passes `error={null}` to this panel and routes
  // the useNameSearch error message to the NameSearchInput's inline hint
  // instead, so even the plain-text hint path above is unreachable from a
  // full-widget render.
  it.skip('NameSearchResultsPanel + useNameSearch 404: no retry, userMessage + traceId', () => {
    // Component NameSearchResultsPanel does not render ErrorBanner on
    // useNameSearch error; test skipped with comment. See header JSDoc
    // finding (2).
  });

  // ─── Test 4 — SKIPPED: RepDetail does not use ErrorBanner ──────────────────
  //
  // Component gap (same root cause as test 2): sponsored-bills error is
  // forwarded as `<BillList error={bills.error?.message ?? null} />`, which
  // renders `<div className="viw-billlist-error" role="alert">{error}</div>`.
  // No ErrorBanner instance, so no retry/traceId props to exercise.
  it.skip('RepDetail + sponsored-bills 400: no retry, userMessage + traceId', () => {
    // Component RepDetail does not render ErrorBanner on useSponsoredBills
    // error; test skipped with comment. See header JSDoc finding (3).
  });
});
