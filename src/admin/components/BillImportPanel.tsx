/**
 * BillImportPanel — modal overlay that replaces the empty-bill "+ New" flow.
 *
 * Two tabs: Browse (list bills by congress + type, client-side title filter)
 * and Direct (paste a Congress.gov URL or type the triple). On pick →
 * POST /api/admin/import-bill → resolves with the imported `bill_id`.
 *
 * Traces to AC-52.46.
 */
import { useEffect, useState } from 'react';
import { post, type FetchError } from '../fetcher';

interface BillImportPanelProps {
  onResolve: (billId: string | null) => void;
}

interface ImportResult {
  bill: { bill_id: string; title: string };
  votes_imported: number;
  votes_updated: number;
  votes_skipped: number;
  cached: boolean;
  duration_ms: number;
}

const BILL_URL_RE = /congress\.gov\/bill\/(\d+)(?:th|st|nd|rd)-congress\/([a-z-]+)\/(\d+)/i;
// Map URL bill-type slugs ("house-bill", "senate-joint-resolution") to type codes.
const URL_TYPE_TO_CODE: Record<string, string> = {
  'house-bill': 'HR',
  'senate-bill': 'S',
  'house-resolution': 'HRES',
  'senate-resolution': 'SRES',
  'house-joint-resolution': 'HJRES',
  'senate-joint-resolution': 'SJRES',
  'house-concurrent-resolution': 'HCONRES',
  'senate-concurrent-resolution': 'SCONRES',
};

export function BillImportPanel({ onResolve }: BillImportPanelProps) {
  const [tab, setTab] = useState<'direct' | 'paste'>('direct');
  const [congress, setCongress] = useState('119');
  const [type, setType] = useState('HR');
  const [number, setNumber] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) onResolve(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onResolve]);

  const parsedFromPaste = (() => {
    const m = pasteUrl.match(BILL_URL_RE);
    if (!m) return null;
    const c = m[1]!;
    const slug = m[2]!.toLowerCase();
    const n = m[3]!;
    const code = URL_TYPE_TO_CODE[slug] ?? slug.toUpperCase();
    return { congress: c, type: code, number: n };
  })();

  async function runImport(c: string, t: string, n: string) {
    setImporting(true);
    setError(null);
    setProgress(`Importing ${c}-${t.toUpperCase()}-${n} from Congress.gov…`);
    try {
      const r = await post<ImportResult>('/api/admin/import-bill', {
        congress: Number(c),
        type: t,
        number: n,
        _reason: `Onboarding via admin SPA${parsedFromPaste ? ' (URL parse)' : ''}`,
      });
      setProgress(
        `Imported ${r.bill.bill_id}. Votes: ${r.votes_imported} new, ${r.votes_updated} refreshed, ${r.votes_skipped} skipped${r.cached ? ' (cached)' : ''}.`,
      );
      // Brief pause so the success line is visible, then close.
      setTimeout(() => onResolve(r.bill.bill_id), 600);
    } catch (e) {
      const fe = e as FetchError;
      setError(fe.detail ?? fe.error ?? 'unknown error');
      setProgress('');
      setImporting(false);
    }
  }

  function submitDirect(e: React.FormEvent) {
    e.preventDefault();
    if (!congress || !type || !number) return;
    void runImport(congress, type, number);
  }

  function submitPaste(e: React.FormEvent) {
    e.preventDefault();
    if (!parsedFromPaste) {
      setError('Could not parse a Congress.gov bill URL. Try the Direct tab.');
      return;
    }
    const { congress: c, type: t, number: n } = parsedFromPaste;
    void runImport(c, t, n);
  }

  return (
    <div style={overlayStyle} role="dialog" aria-label="Import bill from Congress.gov">
      <div style={panelStyle}>
        <header style={headerStyle}>
          <strong>Import bill from Congress.gov</strong>
          <button
            type="button"
            onClick={() => onResolve(null)}
            disabled={importing}
            style={closeBtnStyle}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <nav style={tabsStyle}>
          <button
            type="button"
            onClick={() => setTab('direct')}
            style={tab === 'direct' ? tabActiveStyle : tabStyle}
          >
            Direct (Congress / Type / Number)
          </button>
          <button
            type="button"
            onClick={() => setTab('paste')}
            style={tab === 'paste' ? tabActiveStyle : tabStyle}
          >
            Paste Congress.gov URL
          </button>
        </nav>

        {tab === 'direct' && (
          <form onSubmit={submitDirect} style={formStyle}>
            <label style={labelStyle}>
              <span style={labelText}>Congress</span>
              <input
                type="number"
                value={congress}
                onChange={(e) => setCongress(e.target.value)}
                disabled={importing}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <span style={labelText}>Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                disabled={importing}
                style={inputStyle}
              >
                <option value="HR">HR</option>
                <option value="S">S</option>
                <option value="HRES">HRES</option>
                <option value="SRES">SRES</option>
                <option value="HJRES">HJRES</option>
                <option value="SJRES">SJRES</option>
              </select>
            </label>
            <label style={labelStyle}>
              <span style={labelText}>Number</span>
              <input
                type="text"
                value={number}
                onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
                disabled={importing}
                placeholder="1601"
                style={inputStyle}
                autoFocus
              />
            </label>
            <div style={actionRow}>
              <button type="submit" disabled={importing || !number} style={primaryBtn}>
                {importing ? 'Importing…' : 'Import'}
              </button>
              <button
                type="button"
                onClick={() => onResolve(null)}
                disabled={importing}
                style={cancelBtn}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {tab === 'paste' && (
          <form onSubmit={submitPaste} style={formStyle}>
            <label style={{ ...labelStyle, gridColumn: '1 / -1' }}>
              <span style={labelText}>Congress.gov URL</span>
              <input
                type="url"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                disabled={importing}
                placeholder="https://www.congress.gov/bill/119th-congress/house-bill/1601"
                style={inputStyle}
                autoFocus
              />
            </label>
            {parsedFromPaste && (
              <div style={parseHint}>
                Parsed: <strong>{parsedFromPaste.congress}-{parsedFromPaste.type}-{parsedFromPaste.number}</strong>
              </div>
            )}
            <div style={actionRow}>
              <button
                type="submit"
                disabled={importing || !parsedFromPaste}
                style={primaryBtn}
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
              <button
                type="button"
                onClick={() => onResolve(null)}
                disabled={importing}
                style={cancelBtn}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {progress && <div style={progressStyle}>{progress}</div>}
        {error && <div style={errorStyle}>Error: {error}</div>}

        <footer style={footerStyle}>
          Imports may take 5–30 seconds for bills with many roll-calls. Researcher
          edits to existing bills are preserved on re-import.
        </footer>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const panelStyle: React.CSSProperties = {
  background: 'var(--tk-bg)',
  border: '2px solid var(--tk-border)',
  width: 'min(640px, 90vw)',
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--tk-font)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '2px solid var(--tk-border-soft)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 'var(--tk-fs-base)',
};
const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  padding: '8px 16px 0',
  borderBottom: '2px solid var(--tk-border-soft)',
};
const tabStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--tk-fg)',
  border: '2px solid transparent',
  borderRadius: 0,
  padding: '6px 14px',
  cursor: 'pointer',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: -2,
};
const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  background: 'var(--tk-surface)',
  border: '2px solid var(--tk-border-soft)',
  borderBottom: '2px solid var(--tk-surface)',
};
const formStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 12,
  padding: 16,
};
const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const labelText: React.CSSProperties = {
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const inputStyle: React.CSSProperties = {
  background: 'var(--tk-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 8px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-base)',
};
const actionRow: React.CSSProperties = {
  gridColumn: '1 / -1',
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
};
const primaryBtn: React.CSSProperties = {
  background: 'var(--tk-accent)',
  color: 'var(--tk-accent-fg)',
  border: '2px solid var(--tk-border)',
  borderRadius: 0,
  padding: '6px 16px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  cursor: 'pointer',
};
const cancelBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 16px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  cursor: 'pointer',
};
const progressStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderTop: '2px solid var(--tk-border-soft)',
  fontSize: 'var(--tk-fs-base)',
  color: 'var(--tk-fg)',
};
const errorStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderTop: '2px solid var(--tk-danger)',
  fontSize: 'var(--tk-fs-sm)',
  color: 'var(--tk-danger)',
};
const footerStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderTop: '2px solid var(--tk-border-soft)',
  fontSize: 'var(--tk-fs-xs)',
  color: 'var(--tk-muted)',
  fontStyle: 'italic',
};
const parseHint: React.CSSProperties = {
  gridColumn: '1 / -1',
  fontSize: 'var(--tk-fs-sm)',
  color: 'var(--tk-muted)',
};
