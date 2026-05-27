/**
 * Shared MoC typeahead picker with photo + party colors.
 * Used by SocialFeedTab, QuotesTab, PeopleTab, etc.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../fetcher';

/* ---------- Types ---------- */

export interface MocEntry {
  bioguideId: string;
  displayName: string;
  first: string;
  last: string;
  state: string;
  chamber: 'Senate' | 'House';
  district?: number | null;
  party: string;
  photoUrl?: string | null;
}

/* ---------- Party colors ---------- */

const PARTY_COLORS: Record<string, { bg: string; fg: string; accent: string }> = {
  D: { bg: '#1a3a6e', fg: '#ffffff', accent: '#3b82f6' },
  R: { bg: '#6e1a1a', fg: '#ffffff', accent: '#ef4444' },
  I: { bg: '#4a2e6e', fg: '#ffffff', accent: '#a855f7' },
  L: { bg: '#6e5a1a', fg: '#ffffff', accent: '#eab308' },
  G: { bg: '#1a6e2e', fg: '#ffffff', accent: '#22c55e' },
};

export function partyStyle(party: string): { bg: string; fg: string; accent: string } {
  return PARTY_COLORS[party] ?? { bg: '#333', fg: '#fff', accent: '#888' };
}

/* ---------- Input base style ---------- */

const INPUT_BASE: React.CSSProperties = {
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  background: 'var(--tk-input-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '6px 10px',
};

/* ---------- MocPicker ---------- */

export function MocPicker({
  value,
  onChange,
  placeholder,
}: {
  value: MocEntry | null;
  onChange: (entry: MocEntry | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MocEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync query text when value is set externally.
  useEffect(() => {
    if (value && query !== value.displayName) {
      setQuery(value.displayName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const search = useCallback((q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    get<{ results: MocEntry[] }>(`/api/name-search?q=${encodeURIComponent(q)}`)
      .then((r) => { setResults(r.results); setOpen(true); })
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, []);

  function handleInput(q: string) {
    setQuery(q);
    if (value) onChange(null);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(q), 200);
  }

  function select(entry: MocEntry) {
    onChange(entry);
    setQuery(entry.displayName);
    setOpen(false);
  }

  // Close dropdown on outside click.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const ps = value ? partyStyle(value.party) : null;

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 220 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        ...INPUT_BASE,
        background: ps ? ps.bg : INPUT_BASE.background,
        borderColor: ps ? ps.accent : (INPUT_BASE.border as string),
        padding: '4px 10px',
        transition: 'background 0.15s, border-color 0.15s',
      }}>
        {value?.photoUrl && (
          <img
            src={value.photoUrl}
            alt=""
            style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${ps?.accent ?? '#888'}` }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true); }}
          placeholder={placeholder ?? 'Search people...'}
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: ps ? ps.fg : 'var(--tk-fg)',
            fontFamily: 'var(--tk-font)',
            fontSize: 'var(--tk-fs-sm)',
            flex: 1,
            minWidth: 0,
          }}
        />
        {value && (
          <span style={{
            fontSize: 'var(--tk-fs-xs)',
            fontWeight: 700,
            padding: '1px 6px',
            background: ps?.accent ?? '#888',
            color: '#fff',
            borderRadius: 2,
            whiteSpace: 'nowrap',
          }}>
            {value.party} · {value.state}{value.chamber === 'House' && value.district ? `-${value.district}` : ''}
          </span>
        )}
        {loading && <span style={{ fontSize: 'var(--tk-fs-xs)', color: 'var(--tk-muted)' }}>...</span>}
        {value && (
          <button
            type="button"
            onClick={() => { onChange(null); setQuery(''); setResults([]); }}
            style={{ background: 'none', border: 'none', color: ps?.fg ?? 'var(--tk-muted)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
            title="Clear"
          >x</button>
        )}
      </div>

      {open && results.length > 0 && (
        <ul style={dropdownStyles.list}>
          {results.map((entry) => {
            const ep = partyStyle(entry.party);
            return (
              <li key={entry.bioguideId} style={dropdownStyles.item}>
                <button
                  type="button"
                  onClick={() => select(entry)}
                  style={{ ...dropdownStyles.btn, background: ep.bg }}
                >
                  {entry.photoUrl ? (
                    <img
                      src={entry.photoUrl}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${ep.accent}`, flexShrink: 0 }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', background: ep.accent,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, fontWeight: 700, color: '#fff', flexShrink: 0,
                    }}>
                      {entry.first[0]}{entry.last[0]}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: ep.fg, fontSize: 'var(--tk-fs-sm)' }}>
                      {entry.displayName}
                    </div>
                    <div style={{ fontSize: 'var(--tk-fs-xs)', color: 'rgba(255,255,255,0.7)' }}>
                      {entry.chamber === 'Senate' ? 'Senator' : `Rep.`} · {entry.state}
                      {entry.chamber === 'House' && entry.district ? `-${entry.district}` : ''}
                      {' · '}
                      <span style={{ color: ep.accent, fontWeight: 700 }}>{entry.party}</span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 'var(--tk-fs-xs)',
                    color: 'rgba(255,255,255,0.5)',
                    fontFamily: 'var(--tk-font-mono)',
                  }}>
                    {entry.bioguideId}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const dropdownStyles = {
  list: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 100,
    listStyle: 'none',
    margin: 0,
    padding: 0,
    maxHeight: 320,
    overflowY: 'auto' as const,
    border: '2px solid var(--tk-border-soft)',
    borderTop: 'none',
    background: 'var(--tk-bg)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  item: {
    margin: 0,
    padding: 0,
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    cursor: 'pointer',
    fontFamily: 'var(--tk-font)',
    textAlign: 'left' as const,
  },
};
