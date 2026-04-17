/**
 * BillList — sponsored & cosponsored Ukraine bills, valence-colored, with
 * expand-on-click CRS summary.
 * Traces to: US-4 (AC-4.1–4.5), FR-15, FR-18, T-017
 */
import { Fragment, useMemo, useState } from 'react';
import type { UkraineBill } from '../hooks/useSponsoredBills';
import type { Valence } from '../services/valence';
import { formatDate } from '../utils/formatters';

const PAGE_SIZE = 5;

export interface BillListProps {
  sponsored: UkraineBill[];
  cosponsored: UkraineBill[];
  loading?: boolean;
  error?: string | null;
}

export function BillList({
  sponsored,
  cosponsored,
  loading = false,
  error = null,
}: BillListProps) {
  // AC-4.6: default to the non-empty tab when the primary (Sponsored) has no
  // entries but Cosponsored does. Stable fallback otherwise.
  const initialTab: 'sponsored' | 'cosponsored' =
    sponsored.length === 0 && cosponsored.length > 0 ? 'cosponsored' : 'sponsored';
  const [tab, setTab] = useState<'sponsored' | 'cosponsored'>(initialTab);
  const [page, setPage] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const activeList = tab === 'sponsored' ? sponsored : cosponsored;
  const pageCount = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);

  const visible = useMemo(
    () => activeList.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE),
    [activeList, clampedPage],
  );

  if (loading && sponsored.length === 0 && cosponsored.length === 0) {
    return <div className="viw-billlist-empty">Loading Ukraine legislation…</div>;
  }
  if (error) {
    return <div className="viw-billlist-error" role="alert">{error}</div>;
  }

  return (
    <div className="viw-billlist-wrap">
      <div className="viw-billlist-toggle" role="tablist">
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'sponsored'}
          className={`viw-billlist-tab ${tab === 'sponsored' ? 'active' : ''}`}
          onClick={() => { setTab('sponsored'); setPage(0); setExpandedKey(null); }}
        >
          Sponsored ({sponsored.length})
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'cosponsored'}
          className={`viw-billlist-tab ${tab === 'cosponsored' ? 'active' : ''}`}
          onClick={() => { setTab('cosponsored'); setPage(0); setExpandedKey(null); }}
        >
          Cosponsored ({cosponsored.length})
        </button>
      </div>

      {activeList.length === 0 ? (
        <div className="viw-billlist-empty">
          This member has not {tab} any curated Ukraine-related legislation.
        </div>
      ) : (
        <>
          <table className="viw-billlist" aria-label={`${tab} legislation`}>
            <thead>
              <tr>
                <th scope="col">Bill</th>
                <th scope="col">Title</th>
                <th scope="col">Introduced</th>
                <th scope="col">Latest Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b, i) => {
                const key = `${b.number}-${i}`;
                const expanded = expandedKey === key;
                return (
                  <Fragment key={key}>
                    <tr
                      className={`viw-valence-${valenceCss(b.valence)} ${b.featured ? 'viw-billlist-row-featured' : ''} ${b.valence === 'sponsor-anti' ? 'viw-billlist-row-obstruction' : ''} viw-billlist-row-clickable`}
                      onClick={() =>
                        setExpandedKey((curr) => (curr === key ? null : key))
                      }
                    >
                      <td>
                        <a
                          href={b.congressGovUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="viw-billlist-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {b.number}
                        </a>
                        {b.featured && (
                          <span className="viw-billlist-featured" title="Featured Ukraine bill">
                            ★
                          </span>
                        )}
                        {b.valence === 'sponsor-anti' && (
                          <span
                            className="viw-obstruction-tag"
                            title="Obstruction: sponsored or cosponsored an anti-Ukraine bill"
                          >
                            OBSTRUCTION
                          </span>
                        )}
                      </td>
                      <td className="viw-billlist-title">{b.title}</td>
                      <td>{b.dateIntroduced ? formatDate(b.dateIntroduced) : '—'}</td>
                      <td className="viw-billlist-action">
                        {b.latestAction}{' '}
                        <span className="viw-billlist-expand-hint">
                          {expanded ? '▾' : '▸'}
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="viw-billlist-summary-row">
                        <td colSpan={4}>
                          <BillSummary bill={b} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          {pageCount > 1 && (
            <div className="viw-billlist-pagination" role="navigation" aria-label="Pagination">
              <button
                type="button"
                className="viw-billlist-pager"
                onClick={() => { setPage((p) => Math.max(0, p - 1)); setExpandedKey(null); }}
                disabled={clampedPage === 0}
              >
                ‹ Prev
              </button>
              <span className="viw-billlist-pageinfo">
                Page {clampedPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                className="viw-billlist-pager"
                onClick={() => { setPage((p) => Math.min(pageCount - 1, p + 1)); setExpandedKey(null); }}
                disabled={clampedPage >= pageCount - 1}
              >
                Next ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BillSummary({ bill }: { bill: UkraineBill }) {
  if (!bill.summary) {
    return (
      <div className="viw-billlist-summary">
        <div className="viw-billlist-summary-title">Bill summary</div>
        <div className="viw-billlist-summary-text viw-billlist-summary-na">
          No summary is available for this bill yet. Read the full text on{' '}
          <a href={bill.congressGovUrl} target="_blank" rel="noopener noreferrer">congress.gov</a>.
        </div>
      </div>
    );
  }
  return (
    <div className="viw-billlist-summary">
      <div className="viw-billlist-summary-title">
        Bill summary{' '}
        {bill.summary.actionDesc && (
          <span className="viw-billlist-summary-meta">
            ({bill.summary.actionDesc}
            {bill.summary.actionDate && ` — ${formatDate(bill.summary.actionDate)}`}
            )
          </span>
        )}
      </div>
      <div className="viw-billlist-summary-text">
        {bill.summary.text.split(/\n\n+/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
    </div>
  );
}

function valenceCss(v: Valence): string {
  return v;
}
