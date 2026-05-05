/**
 * Shared layout primitives for Help articles.
 * All content is static — no API calls, no state.
 */

export function HelpArticle({ children }: { children: React.ReactNode }) {
  return <div style={S.article}>{children}</div>;
}

export function H1({ children }: { children: React.ReactNode }) {
  return <h1 style={S.h1}>{children}</h1>;
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={S.h2}>{children}</h2>;
}

export function H3({ children }: { children: React.ReactNode }) {
  return <h3 style={S.h3}>{children}</h3>;
}

export function P({ children }: { children: React.ReactNode }) {
  return <p style={S.p}>{children}</p>;
}

export function Ul({ children }: { children: React.ReactNode }) {
  return <ul style={S.ul}>{children}</ul>;
}

export function Li({ children }: { children: React.ReactNode }) {
  return <li style={S.li}>{children}</li>;
}

export function Callout({ kind, children }: { kind?: 'info' | 'warn' | 'tip'; children: React.ReactNode }) {
  const icon = kind === 'warn' ? '⚠' : kind === 'tip' ? '💡' : 'ℹ';
  return (
    <div style={{ ...S.callout, ...(kind === 'warn' ? S.calloutWarn : kind === 'tip' ? S.calloutTip : {}) }}>
      <span style={S.calloutIcon}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd style={S.kbd}>{children}</kbd>;
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code style={S.code}>{children}</code>;
}

export function Divider() {
  return <hr style={S.hr} />;
}

export function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ ...S.badge, background: color }}>{children}</span>
  );
}

const S: Record<string, React.CSSProperties> = {
  article: {
    maxWidth: 760,
    lineHeight: 1.65,
    color: 'var(--tk-fg)',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
  },
  h1: {
    fontSize: 22,
    fontWeight: 900,
    letterSpacing: '0.02em',
    marginBottom: 8,
    marginTop: 0,
    borderBottom: '2px solid var(--tk-accent)',
    paddingBottom: 8,
    color: 'var(--tk-fg)',
  },
  h2: {
    fontSize: 15,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginTop: 28,
    marginBottom: 6,
    color: 'var(--tk-fg)',
  },
  h3: {
    fontSize: 13,
    fontWeight: 700,
    marginTop: 18,
    marginBottom: 4,
    color: 'var(--tk-fg)',
  },
  p: {
    margin: '0 0 12px 0',
    color: 'var(--tk-fg)',
  },
  ul: {
    margin: '0 0 12px 0',
    paddingLeft: 20,
  },
  li: {
    marginBottom: 4,
  },
  callout: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 14px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    marginBottom: 14,
    fontSize: 'var(--tk-fs-sm)',
  },
  calloutWarn: {
    borderColor: '#e5a000',
    background: 'rgba(229,160,0,0.08)',
  },
  calloutTip: {
    borderColor: 'var(--tk-accent)',
    background: 'rgba(var(--tk-accent-rgb,30,100,220),0.06)',
  },
  calloutIcon: {
    fontSize: 15,
    flexShrink: 0,
    marginTop: 1,
  },
  kbd: {
    display: 'inline-block',
    padding: '1px 6px',
    background: 'var(--tk-surface)',
    border: '1px solid var(--tk-border-soft)',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: 700,
  },
  code: {
    display: 'inline-block',
    padding: '0 4px',
    background: 'var(--tk-surface)',
    border: '1px solid var(--tk-border-soft)',
    borderRadius: 2,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  hr: {
    border: 'none',
    borderTop: '1px solid var(--tk-border-soft)',
    margin: '24px 0',
  },
  badge: {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: '#fff',
    marginRight: 4,
  },
};
