/**
 * BillSponsorshipSections — sponsor panel + cosponsors list + actions list.
 *
 * Traces:
 *   AC-52.58 — sponsor + cosponsors persisted by import; collapsible panel
 *              with sponsor highlighted, cosponsors listed, original-cosponsor
 *              marker, count badge.
 *   AC-52.59 — actions list with source system + Congressional Record link
 *              when present.
 */
import { useEffect, useState } from 'react';
import { get, type FetchError } from '../fetcher';
import type { BillRow, BillCosponsorRow, BillActionRow } from '../types';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

interface Resp<T> {
  items: T[];
}

/* -------------------------------------------------------------------------- */
/*                              Sponsorship panel                              */
/* -------------------------------------------------------------------------- */

interface SponsorshipProps {
  billId: string;
  bill: Partial<BillRow>;
}

export function BillSponsorshipSection({ billId, bill }: SponsorshipProps) {
  const [items, setItems] = useState<BillCosponsorRow[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!billId) return;
    let cancel = false;
    get<Resp<BillCosponsorRow>>(
      `/api/admin/cosponsors?billId=${encodeURIComponent(billId)}`,
    )
      .then((r) => {
        if (cancel) return;
        setItems(r.items ?? []);
        setError(null);
      })
      .catch((e: FetchError) => {
        if (cancel) return;
        setError(e.detail ?? e.error);
      });
    return () => {
      cancel = true;
    };
  }, [billId]);

  const sponsorLabel = bill.sponsor_full_name
    ? `${bill.sponsor_full_name}${bill.sponsor_party ? ` (${bill.sponsor_party}-${bill.sponsor_state ?? '??'})` : ''}`
    : null;
  const originalCount = items.filter((c) => c.is_original_cosponsor === 1).length;

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={legendBtn}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease-out',
              width: '0.7em',
            }}
          >
            ▶
          </span>{' '}
          Sponsorship ({items.length} cosponsor{items.length === 1 ? '' : 's'},{' '}
          {originalCount} original)
        </button>
      </legend>
      {open && (
        <div style={bodyStyle}>
          {error && <div style={bodyError}>Error loading cosponsors: {error}</div>}
          {sponsorLabel && (
            <div style={sponsorRow}>
              <span style={sponsorKey}>Sponsor:</span>{' '}
              <strong>{sponsorLabel}</strong>
              {bill.introduced_date && (
                <span style={dateMuted}> · introduced {bill.introduced_date.slice(0, 10)}</span>
              )}
            </div>
          )}
          {items.length === 0 && !error && (
            <div style={bodyDim}>(no cosponsors recorded)</div>
          )}
          {items.length > 0 && (
            <ul style={listStyle} role="list">
              {items.map((c) => (
                <li key={c.id} style={liStyle}>
                  <span>
                    {c.full_name}
                    {c.party && ` (${c.party}-${c.state ?? '??'})`}
                    {c.district ? `-${c.district}` : ''}
                    {c.is_original_cosponsor === 1 && (
                      <span style={originalMarker} title="Original cosponsor">
                        {' '}
                        ★
                      </span>
                    )}
                  </span>
                  <span style={dateMuted}>
                    {c.sponsorship_date?.slice(0, 10) ?? '—'}
                    {c.sponsorship_withdrawn_date && ` · withdrew ${c.sponsorship_withdrawn_date.slice(0, 10)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Action history panel                            */
/* -------------------------------------------------------------------------- */

export function BillActionsSection({ billId }: { billId: string }) {
  const [items, setItems] = useState<BillActionRow[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!billId) return;
    let cancel = false;
    get<Resp<BillActionRow>>(
      `/api/admin/actions?billId=${encodeURIComponent(billId)}`,
    )
      .then((r) => {
        if (cancel) return;
        setItems(r.items ?? []);
        setError(null);
      })
      .catch((e: FetchError) => {
        if (cancel) return;
        setError(e.detail ?? e.error);
      });
    return () => {
      cancel = true;
    };
  }, [billId]);

  const crCount = items.filter((a) => a.congressional_record_url).length;

  return (
    <fieldset style={fieldsetStyle}>
      <legend style={legendStyle}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={legendBtn}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease-out',
              width: '0.7em',
            }}
          >
            ▶
          </span>{' '}
          Action history ({items.length}
          {crCount > 0 ? `, ${crCount} CR refs` : ''})
        </button>
      </legend>
      {open && (
        <div style={bodyStyle}>
          {error && <div style={bodyError}>Error loading actions: {error}</div>}
          {items.length === 0 && !error && (
            <div style={bodyDim}>(no actions recorded yet)</div>
          )}
          {items.length > 0 && (
            <ul style={actionsList} role="list">
              {items.map((a) => {
                const safeCr = sanitizeUrl(a.congressional_record_url);
                return (
                  <li key={a.id} style={actionLi}>
                    <div style={actionMeta}>
                      <span style={actionDate}>
                        {a.action_date?.slice(0, 10) ?? '—'}
                      </span>
                      {a.source_system && (
                        <span style={actionSrc}>{a.source_system}</span>
                      )}
                      {a.recorded_chamber && a.recorded_roll_call !== null && (
                        <span style={actionVote}>
                          recorded vote: {a.recorded_chamber.toLowerCase()} roll{' '}
                          {a.recorded_roll_call}
                        </span>
                      )}
                    </div>
                    <div style={actionText}>{a.action_text ?? '(no text)'}</div>
                    {safeCr && (
                      <div>
                        <a
                          href={safeCr}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={crLink}
                        >
                          ↗ Congressional Record
                          {a.congressional_record_citation
                            ? ` (${a.congressional_record_citation})`
                            : ''}
                        </a>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Styles                                    */
/* -------------------------------------------------------------------------- */

const fieldsetStyle: React.CSSProperties = {
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '4px 12px 10px',
  margin: 0,
};
const legendStyle: React.CSSProperties = {
  padding: '0 6px',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const legendBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  padding: 0,
  textTransform: 'inherit',
  letterSpacing: 'inherit',
};
const bodyStyle: React.CSSProperties = {
  paddingTop: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const bodyDim: React.CSSProperties = { color: 'var(--tk-muted)', fontStyle: 'italic' };
const bodyError: React.CSSProperties = { color: 'var(--tk-danger)' };
const sponsorRow: React.CSSProperties = {
  fontSize: 'var(--tk-fs-base)',
  padding: '6px 8px',
  background: 'var(--tk-surface)',
  borderLeft: '2px solid var(--tk-accent)',
};
const sponsorKey: React.CSSProperties = {
  color: 'var(--tk-muted)',
  fontSize: 'var(--tk-fs-xs)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginRight: 4,
};
const dateMuted: React.CSSProperties = {
  color: 'var(--tk-muted)',
  fontSize: 'var(--tk-fs-xs)',
  fontStyle: 'italic',
};
const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
const liStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  padding: '2px 8px',
  fontSize: 'var(--tk-fs-sm)',
  borderBottom: '1px solid var(--tk-border-soft)',
};
const originalMarker: React.CSSProperties = {
  color: 'var(--tk-link)',
  fontWeight: 700,
};
const actionsList: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 480,
  overflowY: 'auto',
};
const actionLi: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 8px',
  borderLeft: '2px solid var(--tk-border-soft)',
};
const actionMeta: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'baseline',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
};
const actionDate: React.CSSProperties = {
  color: 'var(--tk-fg)',
  fontVariantNumeric: 'tabular-nums',
};
const actionSrc: React.CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const actionVote: React.CSSProperties = {
  color: 'var(--tk-link)',
  fontWeight: 700,
};
const actionText: React.CSSProperties = {
  fontSize: 'var(--tk-fs-sm)',
  color: 'var(--tk-fg)',
};
const crLink: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-fg)',
  textDecoration: 'underline',
};
