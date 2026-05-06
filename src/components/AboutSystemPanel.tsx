/**
 * AboutSystemPanel — info surface explaining *why* the widget scores
 * representatives the way it does, plus a live browser of every curated
 * bill the system tracks.
 *
 * Traces to: FR-46.
 *
 * Content scope is strictly the scoring system and the tracked bill
 * roster. No mentions of CORS, proxies, rate limits, caching,
 * deployment, observability, or upstream API endpoints (AC-46.7).
 *
 * Valence tables are driven from `services/valence.ts` so they stay
 * in sync with the scoring code automatically.
 */
import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  VALENCE_LABEL,
  VALENCE_SIGN,
  VALENCE_AMPLIFIER,
  type Valence,
} from '../services/valence';
import ukraineBills from '../data/ukraineBills.json';
import type { CuratedBill, CuratedBillVote } from '../services/ukraineFilter';
import { computeValence, type MemberAction } from '../services/valence';
import { sanitizeUrl } from '../utils/sanitizeUrl';
import {
  useResearcherAuditPublic,
  type AuditPublicItem,
} from '../hooks/useResearcherAuditPublic';

const ALL_BILLS: CuratedBill[] = ukraineBills as CuratedBill[];

const VALENCE_ORDER: Valence[] = [
  'sponsor-pro',
  'voted-pro',
  'unstated',
  'voted-anti',
  'sponsor-anti',
];

const VALENCE_DESCRIPTIONS: Record<Valence, string> = {
  'sponsor-pro':
    'Sponsored or cosponsored a pro-Ukraine bill. Strongest positive signal — putting their name on the legislation.',
  'voted-pro':
    'Voted Aye on a pro-Ukraine bill (or Nay on an anti-Ukraine amendment that would have weakened it).',
  unstated:
    'Present/abstained, or the vote was ambiguous (motion-to-table, motion-to-reconsider). Contributes zero.',
  'voted-anti':
    'Voted Nay on a pro-Ukraine bill, or Aye on an anti-Ukraine amendment or procedural maneuver.',
  'sponsor-anti':
    'Sponsored or cosponsored an anti-Ukraine bill. Strongest negative signal.',
};

const WEIGHT_ROWS: Array<{ kind: string; weight: string; note: string }> = [
  { kind: 'Final passage',                  weight: '1.00', note: 'The decisive up/down vote on the bill.' },
  { kind: 'Resolving differences / concur', weight: '0.90', note: 'Vote on the final cross-chamber compromise text.' },
  { kind: 'Cloture',                        weight: '0.45', note: 'Vote to end debate and allow passage (Senate 60-vote threshold).' },
  { kind: 'Motion to proceed',              weight: '0.30', note: 'Vote to start debate — directional but not dispositive.' },
  { kind: 'Motion to recommit',             weight: '0.30', note: 'Directional procedural vote; direction may be inverted (Aye = against bill).' },
  { kind: 'Waive budget point of order',    weight: '0.30', note: 'Directional procedural on budget rules.' },
  { kind: 'Motion to table',                weight: '0.00', note: 'EXCLUDED — ambiguous direction (tabling can block either side).' },
  { kind: 'Motion to reconsider',           weight: '0.00', note: 'EXCLUDED — ambiguous direction.' },
];

const VOTE_KIND_LABEL: Record<string, string> = {
  passage: 'Final passage',
  concur: 'Resolving differences',
  cloture: 'Cloture',
  'motion-to-proceed': 'Motion to proceed',
  'motion-to-recommit': 'Motion to recommit',
  'waive-budget': 'Waive budget',
  'motion-to-table': 'Motion to table',
  'motion-to-reconsider': 'Motion to reconsider',
  'other-procedural': 'Procedural',
};
function labelForVoteKind(kind: string): string {
  return VOTE_KIND_LABEL[kind] ?? kind.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatBillSlug(type: string, number: string): string {
  const t = type.toUpperCase();
  if (t === 'S' || t === 'SRES' || t === 'SJRES' || t === 'SCONRES') {
    return `${t.replace('S', 'S.').replace('..', '.')} ${number}`;
  }
  return `${t} ${number}`;
}

type Direction = CuratedBill['direction'];

function groupByDirection(bills: CuratedBill[]): Record<Direction, CuratedBill[]> {
  const out: Record<Direction, CuratedBill[]> = {
    'pro-ukraine': [],
    'anti-ukraine': [],
    neutral: [],
  };
  for (const b of bills) out[b.direction].push(b);
  return out;
}

const DIRECTION_LABEL: Record<Direction, string> = {
  'pro-ukraine': 'Pro-Ukraine',
  'anti-ukraine': 'Anti-Ukraine',
  neutral: 'Neutral',
};

/** Shorter tab label used on narrow viewports so all tabs fit on one row. */
const DIRECTION_LABEL_SHORT: Record<Direction, string> = {
  'pro-ukraine': 'Pro',
  'anti-ukraine': 'Anti',
  neutral: 'Neutral',
};

/** Valence a `sponsored` action would carry if this were a member — purely
 *  for visual tinting of the bill row. Members don't factor in here. */
function billRowValence(direction: Direction): Valence {
  return computeValence(direction, 'sponsored' as MemberAction);
}

function BillsBrowser() {
  const grouped = useMemo(() => groupByDirection(ALL_BILLS), []);
  const availableTabs: Direction[] = (
    ['pro-ukraine', 'anti-ukraine', 'neutral'] as Direction[]
  ).filter((d) => grouped[d].length > 0);
  const [activeTab, setActiveTab] = useState<Direction>(availableTabs[0] ?? 'pro-ukraine');
  const [openBill, setOpenBill] = useState<string | null>(null);

  const visibleBills = grouped[activeTab] ?? [];

  return (
    <div className="viw-about-browser">
      <div className="viw-about-tabs" role="tablist" aria-label="Tracked bills by direction">
        {availableTabs.map((d) => {
          const count = grouped[d].length;
          const isActive = activeTab === d;
          // Tint each tab with the valence a bill of that direction would
          // carry — pro tabs show green, anti tabs red, neutral stays neutral.
          const tabValenceClass = `viw-about-tab-dir-${d}`;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`viw-about-tab ${tabValenceClass} ${isActive ? 'viw-about-tab-active' : ''}`}
              onClick={() => { setActiveTab(d); setOpenBill(null); }}
            >
              <span className="viw-about-tab-label-full">{DIRECTION_LABEL[d]}</span>
              <span className="viw-about-tab-label-short" aria-hidden="true">{DIRECTION_LABEL_SHORT[d]}</span>
              {' '}<span className="viw-about-tab-count">({count})</span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel" aria-label={`${DIRECTION_LABEL[activeTab]} bills`} className="viw-about-tabpanel">
        <table className="viw-about-bills-table">
          <thead>
            <tr>
              <th scope="col">Bill · Reason</th>
              <th scope="col" className="viw-num">Votes tracked</th>
              <th scope="col" className="viw-num">Became law?</th>
            </tr>
          </thead>
          <tbody>
            {visibleBills.map((b) => {
              const key = `${b.congress}-${b.type}-${b.number}`;
              const isOpen = openBill === key;
              const valence = billRowValence(b.direction);
              // Click anywhere on the bill card's non-interactive areas to
              // toggle. Interactive descendants (expand button, links)
              // stopPropagation on their own handlers.
              const handleBillAreaClick = (e: ReactMouseEvent<HTMLElement>) => {
                const t = e.target as HTMLElement;
                if (t.closest('button, a, input, [role="button"]')) return;
                setOpenBill(isOpen ? null : key);
              };
              return (
                <Fragment key={key}>
                  <tr className={`viw-valence-${valence}`} onClick={handleBillAreaClick}>
                    <th scope="row" className="viw-about-bill-cell">
                      <button
                        type="button"
                        className="viw-about-bill-toggle"
                        aria-expanded={isOpen}
                        aria-controls={`viw-about-votes-${key}`}
                        onClick={(e) => { e.stopPropagation(); setOpenBill(isOpen ? null : key); }}
                      >
                        <span className="viw-about-bill-slug">
                          {formatBillSlug(b.type, b.number)}
                          {b.featured && <span className="viw-about-featured" title="Featured">★</span>}
                        </span>
                        <span className="viw-about-bill-desc">{b.label}</span>
                        <span className="viw-about-bill-caption">
                          {b.direction.toUpperCase()} — {b.directionReason}
                        </span>
                        <span className="viw-about-bill-caret" aria-hidden="true">
                          {isOpen ? '▾' : '▸'}
                        </span>
                      </button>
                      {sanitizeUrl(b.congressGovUrl) && (
                        <a
                          href={sanitizeUrl(b.congressGovUrl)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="viw-about-bill-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Read on congress.gov ↗
                        </a>
                      )}
                    </th>
                    <td className="viw-num" data-col="Votes tracked">{b.votes.length}</td>
                    <td className="viw-num" data-col="Became law?">{b.becameLaw ? 'Yes' : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr onClick={handleBillAreaClick}>
                      <td colSpan={3} id={`viw-about-votes-${key}`} className="viw-about-votes-cell">
                        {b.votes.length === 0 ? (
                          <p className="viw-about-no-votes">No roll-call votes tracked for this bill yet.</p>
                        ) : (
                          <table className="viw-about-votes-table">
                            <thead>
                              <tr>
                                <th scope="col">Chamber</th>
                                <th scope="col" className="viw-num">Roll call</th>
                                <th scope="col">Kind</th>
                                <th scope="col" className="viw-num">Weight</th>
                                <th scope="col">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.votes.map((v: CuratedBillVote, idx) => (
                                <tr
                                  key={`${v.chamber}-${v.rollCall}-${idx}`}
                                  className={v.weight === 0 ? 'viw-about-weight-excluded' : ''}
                                >
                                  <td data-col="Chamber">{v.chamber}</td>
                                  <td className="viw-num" data-col="Roll call">{v.rollCall}</td>
                                  <td data-col="Kind">{labelForVoteKind(v.kind)}</td>
                                  <td className="viw-num" data-col="Weight">
                                    {v.weight === 0 ? 'excluded' : v.weight.toFixed(2)}
                                  </td>
                                  <td className="viw-about-vote-action" data-col="Action">
                                    {v.action}
                                    {sanitizeUrl(v.url) && (
                                      <>
                                        {' '}
                                        <a
                                          href={sanitizeUrl(v.url)!}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="viw-about-vote-link"
                                        >
                                          View vote ↗
                                        </a>
                                      </>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface AboutSystemPanelProps {
  /** API base for the embed Worker — used to fetch the public audit feed
   *  (FR-53 AC-53.4). Defaults to "" (same origin). */
  apiBase?: string;
}

/** FR-53 AC-53.4 — redacted public feed of recent researcher updates. */
function ResearcherUpdatesFeed({ items }: { items: AuditPublicItem[] }) {
  return (
    <section
      className="viw-about-updates"
      aria-label="Recent researcher updates"
    >
      <h3 className="viw-about-subheading">Recent researcher updates</h3>
      <p>
        The latest changes researchers have made to bill curation, vote
        weights, comments, statements, and quotes.
      </p>
      <ul className="viw-about-updates-list" role="list">
        {items.map((it) => (
          <li key={it.id} className="viw-about-updates-item">
            <span className="viw-about-updates-actor">{it.actorLocalPart}</span>
            <span className="viw-about-updates-action">{actionVerb(it.action, it.table)}</span>
            {it.rowTitle && (
              <span className="viw-about-updates-target">{truncate(it.rowTitle, 80)}</span>
            )}
            <span className="viw-about-updates-when">{relTime(it.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function actionVerb(action: string, table: string): string {
  const target = table.replace('_', ' ');
  if (action === 'create') return `added ${singular(target)}`;
  if (action === 'update') return `updated ${singular(target)}`;
  if (action === 'delete') return `removed ${singular(target)}`;
  return `${action} ${singular(target)}`;
}

function singular(noun: string): string {
  if (noun.endsWith('ies')) return noun.slice(0, -3) + 'y';
  if (noun.endsWith('es')) return noun.slice(0, -2);
  if (noun.endsWith('s')) return noun.slice(0, -1);
  return noun;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

export function AboutSystemPanel({ apiBase = '' }: AboutSystemPanelProps = {}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // FR-53 AC-53.4 — public researcher-updates feed (Tier B). Fetched only
  // when the panel is open; the hook tolerates missing endpoint as empty.
  const auditFeed = useResearcherAuditPublic(apiBase, 20);

  // AC-46.4: Escape closes the panel when focus is inside.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="viw-about">
      <button
        type="button"
        className="viw-about-trigger"
        aria-expanded={open}
        aria-controls="viw-about-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">ⓘ</span> About this system
      </button>
      {open && (
        <div
          id="viw-about-panel"
          ref={panelRef}
          className="viw-about-panel"
          role="region"
          aria-label="About this system"
          onKeyDown={onKeyDown}
          tabIndex={-1}
        >
          <h2 className="viw-about-heading">How the Ukraine Support Score works</h2>
          <p>
            Every member's score is a single number between <strong>−1</strong>{' '}
            (strongly opposed) and <strong>+1</strong> (strongly supportive),
            computed only from their public record on curated Ukraine-related
            bills.
          </p>

          {auditFeed.items.length > 0 && (
            <ResearcherUpdatesFeed items={auditFeed.items} />
          )}

          <h3 className="viw-about-subheading">Formula</h3>
          <p className="viw-about-formula">
            <code>score = Σ(sign × amp × weight) ÷ Σ(amp × weight)</code>
          </p>
          <p>
            Worked example: a member who cosponsors one pro-Ukraine bill
            (sign +1, amp 1.5, weight 1.0 → contribution +1.50) and votes Aye
            on cloture for another (sign +1, amp 1.0, weight 0.45 →
            contribution +0.45) scores{' '}
            <code>(+1.50 + +0.45) ÷ (1.50 + 0.45) = +1.00</code> — a full
            supporter.
          </p>

          <h3 className="viw-about-subheading">Valence (sign × amplifier)</h3>
          <table className="viw-about-table">
            <thead>
              <tr>
                <th scope="col">Valence</th>
                <th scope="col" className="viw-num">Sign</th>
                <th scope="col" className="viw-num">Amp</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {VALENCE_ORDER.map((v) => (
                <tr key={v} className={`viw-valence-${v}`}>
                  <th scope="row">{VALENCE_LABEL[v]}</th>
                  <td className="viw-num" data-col="Sign">{VALENCE_SIGN[v] > 0 ? '+1' : VALENCE_SIGN[v] < 0 ? '−1' : '0'}</td>
                  <td className="viw-num" data-col="Amp">{VALENCE_AMPLIFIER[v].toFixed(1)}×</td>
                  <td data-col="Meaning">{VALENCE_DESCRIPTIONS[v]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="viw-about-subheading">Vote weights</h3>
          <table className="viw-about-table">
            <thead>
              <tr>
                <th scope="col">Vote kind</th>
                <th scope="col" className="viw-num">Weight</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {WEIGHT_ROWS.map((w) => (
                <tr key={w.kind} className={w.weight === '0.00' ? 'viw-about-weight-excluded' : ''}>
                  <th scope="row">{w.kind}</th>
                  <td className="viw-num" data-col="Weight">{w.weight}</td>
                  <td data-col="Why">{w.note}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="viw-about-subheading">Confidence</h3>
          <p>
            Members with fewer than <strong>3</strong> counted actions are
            labeled <em>"Limited record"</em> and cannot reach the "Strong
            supporter" or "Strongly opposed" bands. The badge's color
            saturation grows from ~20% (one action) to 100% (eight or more),
            so a first-term member and a long-serving one look visually
            distinct even at the same score.
          </p>

          <h3 className="viw-about-subheading">Tracked bills</h3>
          <p>
            The full list of bills the system scores. Every entry is
            hand-classified — pick a direction tab, then click a bill to see
            the specific roll-call votes counted and their weights.
          </p>
          <BillsBrowser />

        </div>
      )}
    </div>
  );
}
