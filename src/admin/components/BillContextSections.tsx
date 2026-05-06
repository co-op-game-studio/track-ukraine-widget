/**
 * BillContextSections — bill state badges + collapsible summary text.
 * Rendered above the inline Votes/Comments sections in the Bill editor.
 *
 * Traces to AC-52.33 (inline summary disclosure) + Phase-4 polish.
 */
import { useEffect, useState } from 'react';
import { resolveApiBase, type FetchError } from '../fetcher';
import type { BillRow } from '../types';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

/* -------------------------------------------------------------------------- */
/*                              Bill state pills                              */
/* -------------------------------------------------------------------------- */

/** Coarse legislative state derived from `bills` columns + the `latest_action`
 *  text. Congress.gov doesn't expose a single "status" enum, so we infer from
 *  what's available. We only render pills for things we can prove from the
 *  data — no "In progress" guesswork. The `latest_action_date` is shown
 *  separately so a researcher can tell a still-active bill from a dormant
 *  one (e.g. 2022 bill stuck at "Referred to Committee"). */
function deriveBillState(bill: Partial<BillRow>): Array<{ label: string; tone: 'passed' | 'law' }> {
  const out: Array<{ label: string; tone: 'passed' | 'law' }> = [];
  const action = (bill.latest_action ?? '').toLowerCase();

  // The bill exists in our system → it has been introduced.
  out.push({ label: 'Introduced', tone: 'passed' });
  if (/passed.*house|on passage.*passed/i.test(action) || /house.*passed/.test(action)) {
    out.push({ label: 'Passed House', tone: 'passed' });
  }
  if (/passed.*senate|senate.*passed/i.test(action)) {
    out.push({ label: 'Passed Senate', tone: 'passed' });
  }
  if (bill.became_law === 1 || /became public law|signed by president/i.test(action)) {
    out.push({ label: 'Signed into law', tone: 'law' });
  }
  return out;
}

function formatLastActionDate(date: string | null | undefined): string | null {
  if (!date) return null;
  // Accept both `2025-04-01` and `2025-04-01T16:38:41Z` shapes.
  const d = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d;
}

export function BillStatePills({ bill }: { bill: Partial<BillRow> }) {
  const states = deriveBillState(bill);
  return (
    <div style={pillsRow} role="group" aria-label="Bill legislative status">
      <span style={pillsLabel}>Status:</span>
      {states.map((s) => (
        <span key={s.label} style={s.tone === 'law' ? pillLaw : pillPassed}>
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Last-action date as a compact inline pill — rendered next to the Identity
 *  static block (NOT full-width on its own row). */
export function BillLastActionInline({ bill }: { bill: Partial<BillRow> }) {
  const lastDate = formatLastActionDate(bill.latest_action_date);
  if (!lastDate) return null;
  return (
    <span style={lastActionInline}>
      last action: <strong>{lastDate}</strong>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Bill summary disclosure                           */
/* -------------------------------------------------------------------------- */

interface SummaryItem {
  actionDesc?: string;
  text?: string;
  updateDate?: string;
}
interface SummariesResponse {
  summaries?: SummaryItem[];
}

function stripHtml(s: string): string {
  if (typeof DOMParser === 'undefined') return s;
  try {
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body.textContent ?? '').trim();
  } catch {
    return s;
  }
}

/** Strip the markdown-ish bullets / emphasis Congress.gov sometimes embeds in
 *  CRS summary text (literal `*` chars, `**bold**`, leading list markers).
 *  Quietly normalize whitespace so the immutable text box is readable. */
function cleanSummaryText(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold** → plain
    .replace(/(^|\s)\*+\s?/g, '$1')          // * leading bullets → space
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface TextFormat {
  type?: string;     // "Formatted Text" | "Formatted XML" | "PDF" | "Generated HTML" | …
  url?: string;
}
interface TextVersion {
  date?: string;
  type?: string;     // "Introduced in House" | "Engrossed" | "Enrolled Bill" | …
  formats?: TextFormat[];
}
interface TextVersionsResponse {
  textVersions?: TextVersion[];
}

interface BillTextDisclosureProps {
  congress: number;
  type: string;
  number: string;
  congressGovUrl: string | null;
}

/** Pick the best inline-renderable URL out of a version's `formats[]`.
 *  Order of preference: Formatted Text (htm) > Generated HTML > Formatted XML
 *  (last resort, parser handles it as text). PDF is excluded — we can't
 *  inline a PDF, only link out. */
function pickFormat(formats: TextFormat[] = []): TextFormat | null {
  const order = ['Formatted Text', 'Generated HTML', 'Formatted XML'];
  for (const want of order) {
    const f = formats.find((x) => (x.type ?? '') === want);
    if (f?.url) return f;
  }
  return null;
}

/** Newest version first (date desc), with `Enrolled` tied last in case of
 *  same-day publication (Enrolled means signed-into-law text). */
function sortVersionsNewestFirst(vs: TextVersion[]): TextVersion[] {
  return [...vs].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export function BillTextDisclosure({
  congress,
  type,
  number,
  congressGovUrl,
}: BillTextDisclosureProps) {
  const [open, setOpen] = useState(false);
  // Text (primary): list of versions + the inline-fetched body of the
  // most-recent version with a usable format.
  const [versions, setVersions] = useState<TextVersion[] | null>(null);
  const [textErr, setTextErr] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyErr, setBodyErr] = useState<string | null>(null);
  // Summary (secondary, often missing).
  const [summary, setSummary] = useState<SummaryItem | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  useEffect(() => {
    if (!open || versions || textErr || textLoading) return;
    setTextLoading(true);
    const base = resolveApiBase();
    const url = `${base}/api/congress/v3/bill/${congress}/${type.toLowerCase()}/${number}/text`;
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`http_${r.status}`);
        return r.json() as Promise<TextVersionsResponse>;
      })
      .then((j) => {
        const all = sortVersionsNewestFirst(j.textVersions ?? []);
        setVersions(all);
      })
      .catch((e) => setTextErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setTextLoading(false));
  }, [open, versions, textErr, textLoading, congress, type, number]);

  // Lazy-fetch the body of the newest version with a usable format.
  useEffect(() => {
    if (!open || !versions || versions.length === 0 || bodyHtml || bodyErr || bodyLoading) return;
    const newest = versions.find((v) => pickFormat(v.formats));
    const fmt = newest ? pickFormat(newest.formats) : null;
    if (!fmt?.url) {
      setBodyErr('no inline-renderable format');
      return;
    }
    setBodyLoading(true);
    // Congress.gov text URLs are *.congress.gov — same-origin from the embed
    // is impossible, but the admin SPA runs in a CF Access-gated context and
    // can fetch them directly (no CORS issues for a server-side text/html
    // resource fetched cross-origin and shown inside our DOM as a string).
    fetch(fmt.url, { credentials: 'omit' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`http_${r.status}`);
        return r.text();
      })
      .then((html) => setBodyHtml(html))
      .catch((e) => setBodyErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBodyLoading(false));
  }, [open, versions, bodyHtml, bodyErr, bodyLoading]);

  // Fetch summary in parallel with text (often missing — that's expected).
  useEffect(() => {
    if (!open || summary || summaryErr || summaryLoading) return;
    setSummaryLoading(true);
    const base = resolveApiBase();
    const url = `${base}/api/congress/v3/bill/${congress}/${type.toLowerCase()}/${number}/summaries`;
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`http_${r.status}`);
        return r.json() as Promise<SummariesResponse>;
      })
      .then((j) => {
        const all = j.summaries ?? [];
        if (all.length === 0) {
          setSummary({ actionDesc: '(no summary published yet)', text: '' });
          return;
        }
        const newest = [...all].sort((a, b) =>
          (b.updateDate ?? '').localeCompare(a.updateDate ?? ''),
        )[0]!;
        setSummary(newest);
      })
      .catch((e: unknown) => {
        if (e && typeof e === 'object' && 'detail' in e) {
          const fe = e as FetchError;
          setSummaryErr(fe.detail ?? fe.error ?? 'unknown error');
        } else if (e instanceof Error) {
          setSummaryErr(e.message);
        } else {
          setSummaryErr(String(e));
        }
      })
      .finally(() => setSummaryLoading(false));
  }, [open, summary, summaryErr, summaryLoading, congress, type, number]);

  const safeUrl = sanitizeUrl(congressGovUrl);
  const newestVersion = versions?.find((v) => pickFormat(v.formats)) ?? null;
  const newestFmt = newestVersion ? pickFormat(newestVersion.formats) : null;
  const bodyText = bodyHtml ? stripHtml(bodyHtml) : null;

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
          Bill text & summary
        </button>
      </legend>
      {open && (
        <div style={bodyStyle}>
          {/* ─── PRIMARY: full text ─────────────────────────────────────── */}
          <section style={section}>
            <div style={sectionHeading}>Full text</div>
            {textLoading && <div style={bodyDim}>Loading text versions from Congress.gov…</div>}
            {textErr && <div style={bodyError}>Could not load text versions: {textErr}</div>}
            {versions && versions.length === 0 && !textErr && (
              <div style={bodyDim}>(no text versions published yet by Congress.gov)</div>
            )}
            {versions && versions.length > 0 && (
              <>
                <div style={versionsList} role="list" aria-label="Bill text versions">
                  {versions.map((v, i) => {
                    const fmt = pickFormat(v.formats);
                    const safeFmt = sanitizeUrl(fmt?.url ?? null);
                    const isPrimary = i === 0;
                    return (
                      <span
                        key={`${v.date ?? i}-${v.type ?? i}`}
                        style={isPrimary ? versionPillPrimary : versionPill}
                      >
                        {v.type ?? 'version'}
                        {v.date ? ` · ${v.date.slice(0, 10)}` : ''}
                        {safeFmt && (
                          <>
                            {' '}
                            <a
                              href={safeFmt}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={openLinkStyle}
                            >
                              ↗
                            </a>
                          </>
                        )}
                      </span>
                    );
                  })}
                </div>
                {newestFmt?.url && (
                  <div style={sourceLine}>
                    Inline preview of <strong>{newestVersion?.type ?? 'newest version'}</strong> ({newestFmt.type ?? 'text'}):
                  </div>
                )}
                {bodyLoading && <div style={bodyDim}>Loading bill text…</div>}
                {bodyErr && (
                  <div style={bodyError}>
                    Could not load bill text inline: {bodyErr}.{' '}
                    {newestFmt?.url && (
                      <a
                        href={sanitizeUrl(newestFmt.url) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={openLinkStyle}
                      >
                        Open on Congress.gov ↗
                      </a>
                    )}
                  </div>
                )}
                {bodyText && (
                  <div style={fullTextStyle}>{bodyText}</div>
                )}
              </>
            )}
          </section>

          {/* ─── SECONDARY: CRS summary (often missing) ─────────────────── */}
          <section style={section}>
            <div style={sectionHeading}>
              Summary{' '}
              <span style={sectionHeadingNote}>
                — CRS-authored, often unavailable
              </span>
            </div>
            {summaryLoading && <div style={bodyDim}>Loading summary…</div>}
            {summaryErr && <div style={bodyError}>Could not load summary: {summaryErr}</div>}
            {summary && !summaryErr && (
              <details style={summaryDetails}>
                <summary style={summaryToggle}>
                  {summary.actionDesc ?? 'Show summary'}
                </summary>
                {summary.text && (
                  <div
                    style={summaryScrollBox}
                    aria-readonly="true"
                    role="region"
                    aria-label="Bill summary text"
                  >
                    {cleanSummaryText(stripHtml(summary.text))}
                  </div>
                )}
              </details>
            )}
          </section>

          {safeUrl && (
            <div style={sourceLine}>
              Source:{' '}
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={openLinkStyle}
              >
                Congress.gov ↗
              </a>
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

/** Backwards compatible export so existing imports keep working until the
 *  callsite migrates to the new name. */
export { BillTextDisclosure as BillSummaryDisclosure };

/* -------------------------------------------------------------------------- */
/*                                  Styles                                    */
/* -------------------------------------------------------------------------- */

const pillsRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
  padding: '6px 8px',
  borderLeft: '2px solid var(--tk-accent)',
  fontSize: 'var(--tk-fs-sm)',
};
const pillsLabel: React.CSSProperties = {
  color: 'var(--tk-muted)',
  fontSize: 'var(--tk-fs-xs)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginRight: 4,
};
const pillBase: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  border: '2px solid var(--tk-border-soft)',
  fontSize: 'var(--tk-fs-xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const pillPassed: React.CSSProperties = {
  ...pillBase,
  color: 'var(--tk-fg)',
  background: 'var(--tk-surface)',
};
const pillLaw: React.CSSProperties = {
  ...pillBase,
  background: 'var(--tk-accent)',
  color: 'var(--tk-accent-fg)',
  border: '2px solid var(--tk-border)',
};
const lastActionInline: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  fontStyle: 'italic',
  marginLeft: 8,
  whiteSpace: 'nowrap',
};
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
const summaryDetails: React.CSSProperties = {
  // Native <details> wrapper. Closed by default; click summary to open.
};
const summaryToggle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '4px 0',
};
const summaryScrollBox: React.CSSProperties = {
  // Immutable, scrollable, capped height. Pre-wrap honors paragraph breaks
  // from the cleaned text without rendering as one wall.
  fontSize: 'var(--tk-fs-sm)',
  color: 'var(--tk-fg)',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  maxHeight: 240,
  maxWidth: '80ch',
  overflowY: 'auto',
  padding: '8px 10px',
  marginTop: 6,
  border: '1px solid var(--tk-border-soft)',
  background: 'var(--tk-surface)',
  userSelect: 'text',
};
const sourceLine: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  fontStyle: 'italic',
};
const openLinkStyle: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-fg)',
  textDecoration: 'underline',
};
const section: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 4,
  borderTop: '1px solid var(--tk-border-soft)',
};
const sectionHeading: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontWeight: 700,
};
const sectionHeadingNote: React.CSSProperties = {
  fontWeight: 400,
  fontStyle: 'italic',
  textTransform: 'none',
  letterSpacing: 0,
};
const versionsList: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};
const versionPill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 2,
  padding: '2px 8px',
  border: '2px solid var(--tk-border-soft)',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-fg)',
};
const versionPillPrimary: React.CSSProperties = {
  ...versionPill,
  background: 'var(--tk-surface)',
  border: '2px solid var(--tk-border)',
  fontWeight: 700,
};
const fullTextStyle: React.CSSProperties = {
  fontSize: 'var(--tk-fs-base)',
  color: 'var(--tk-fg)',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  fontFamily: 'var(--tk-font-mono)',
  maxHeight: 480,
  overflowY: 'auto',
  padding: 10,
  border: '1px solid var(--tk-border-soft)',
  background: 'var(--tk-surface)',
};
