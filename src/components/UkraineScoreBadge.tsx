/**
 * UkraineScoreBadge — the red→yellow→green score badge.
 *
 * Traces to: FR-16, FR-23, FR-43.
 *
 * v2.6.x UAT:
 *   - Header is a single row on tablet+ (≥640px):
 *       [ title ] [ label / justification (right-aligned) ] [ value ]
 *     On phones it collapses to two stacked rows.
 *   - Clicking the header expands a compact breakdown panel that lists
 *     THIS MEMBER's actual contributing actions (curated bills + sponsor
 *     relationships) and each one's effect on the score, plus the Σ/Σ
 *     reduction that produces the final number.
 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { UkraineScore } from '../services/ukraineScore';
import { scoreToCssColor } from '../services/ukraineScore';
import {
  VALENCE_SIGN,
  VALENCE_AMPLIFIER,
  VALENCE_LABEL,
  type Valence,
} from '../services/valence';
import type { VotingRecordData, MemberVoteRow } from '../hooks/useVotingRecord';
import type { SponsoredBillsData, UkraineBill } from '../hooks/useSponsoredBills';

export interface UkraineScoreBadgeProps {
  score: UkraineScore | null;
  /** Full voting record — used to render the per-action breakdown panel. */
  voting?: VotingRecordData | null;
  /** Sponsored / cosponsored Ukraine bills — used to render the breakdown. */
  bills?: SponsoredBillsData | null;
  /** Total obstruction events (procedural anti-UA + anti-UA sponsorships). */
  obstructionCount?: number;
  /** FR-23 AC-23.5: abstentions on primary-weight pro-UA votes. */
  primaryAbstentionCount?: number;
  loading?: boolean;
}

const ABSTENTION_DISPLAY_THRESHOLD = 3;

function scoreLabel(value: number, lowConfidence: boolean): string {
  if (lowConfidence) {
    if (value > 0.25) return 'Limited record — leans supportive';
    if (value < -0.25) return 'Limited record — leans opposed';
    return 'Limited record';
  }
  if (value >= 0.75) return 'Strong supporter';
  if (value >= 0.35) return 'Supporter';
  if (value >= 0.1) return 'Leaning supportive';
  if (value > -0.1) return 'Mixed';
  if (value > -0.35) return 'Leaning opposed';
  if (value > -0.75) return 'Opposed';
  return 'Strongly opposed';
}

function saturationFilterFor(confidence: number): string {
  const x = 0.2 + 0.8 * Math.max(0, Math.min(1, confidence));
  return `saturate(${Math.round(x * 100) / 100})`;
}

function fmtSigned(n: number): string {
  if (n === 0) return '0';
  return (n > 0 ? '+' : '') + n.toFixed(2);
}

/** Why an action doesn't contribute. Mirrors computeUkraineScore's excluders. */
function skipReason(valence: Valence, weight: number, memberVote?: MemberVoteRow['memberVote']): string | null {
  if (valence === 'unstated') {
    if (memberVote === 'Present') return 'Present';
    if (memberVote === 'Not Voting') return 'Abstained';
    return 'Unstated';
  }
  if (VALENCE_SIGN[valence] === 0) return 'Neutral';
  if (VALENCE_AMPLIFIER[valence] === 0) return 'Neutral';
  if (weight <= 0) return 'Procedural';
  return null;
}

type BreakdownRow = {
  key: string;
  /** Short, uppercase bill identifier rendered as the row's headline. */
  slug: string;
  /** One-sentence description of the bill (curator-authored). */
  description: string;
  /** The specific action the member took on this bill ("Final passage — Voted Aye",
   *  "Cloture — Voted Nay", "Cosponsored"). Drives the caption line under the
   *  description. */
  action: string;
  /** Longer machine/clerk action text from the curator vote payload. Shown when
   *  the row is expanded. Empty for sponsorships. */
  actionDetail: string;
  valence: Valence;
  weight: number;
  memberVote?: MemberVoteRow['memberVote'];
};

/** Normalize a curator bill type + number into a display slug: "HR 815", "S. 1241". */
function formatBillSlug(type: string, number: string): string {
  const t = type.toUpperCase();
  // Senate bills conventionally render with a period after "S"; House doesn't.
  if (t === 'S' || t === 'SRES' || t === 'SJRES' || t === 'SCONRES') {
    return `${t.replace('S', 'S.').replace('..', '.')} ${number}`;
  }
  return `${t} ${number}`;
}

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

function rowsFromVoting(voting: VotingRecordData | null | undefined): BreakdownRow[] {
  if (!voting) return [];
  return voting.flat.map((v, i) => ({
    key: `v-${v.bill.congress}-${v.bill.type}-${v.bill.number}-${v.vote.rollCall}-${i}`,
    slug: formatBillSlug(v.bill.type, v.bill.number),
    description: v.bill.label,
    action: `${labelForVoteKind(v.vote.kind)} — Voted ${v.memberVote}`,
    actionDetail: v.vote.action ?? '',
    valence: v.valence,
    weight: v.vote.weight,
    memberVote: v.memberVote,
  }));
}

function rowsFromBills(bills: SponsoredBillsData | null | undefined): BreakdownRow[] {
  if (!bills) return [];
  const mk = (b: UkraineBill): BreakdownRow => ({
    key: `${b.relationship}-${b.number}`,
    slug: b.number,
    description: b.title,
    action: b.relationship === 'sponsored' ? 'Sponsored' : 'Cosponsored',
    actionDetail: '',
    valence: b.valence,
    weight: 1.0,
  });
  return [...bills.sponsored.map(mk), ...bills.cosponsored.map(mk)];
}

/** Bill/vote labels come verbatim from the curator and can run several
 *  hundred chars. Truncate to this many chars by default; the row is
 *  click-to-expand. */
const BILL_LABEL_TRUNCATE_CHARS = 72;

function ScoreBreakdown({
  voting,
  bills,
  score,
}: {
  voting: VotingRecordData | null | undefined;
  bills: SponsoredBillsData | null | undefined;
  score: UkraineScore | null;
}) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const toggleRow = (key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const rows = [...rowsFromBills(bills), ...rowsFromVoting(voting)];

  let sumSigned = 0;
  let sumMag = 0;
  for (const r of rows) {
    const sign = VALENCE_SIGN[r.valence];
    const amp = VALENCE_AMPLIFIER[r.valence];
    if (sign === 0 || amp === 0) continue;
    if (r.weight <= 0) continue;
    const mag = amp * r.weight;
    sumSigned += sign * mag;
    sumMag += mag;
  }

  return (
    <div
      className="viw-score-breakdown"
      role="region"
      aria-label="How this score is calculated"
    >
      <p className="viw-score-breakdown-intro">
        Score = Σ(sign × amp × weight) ÷ Σ(amp × weight). Each of this
        member's curated Ukraine actions is listed below with its contribution.
      </p>

      {rows.length === 0 ? (
        <p className="viw-score-breakdown-note">No curated actions found for this member.</p>
      ) : (
        <div className="viw-score-breakdown-tablewrap">
          <table className="viw-score-breakdown-table">
            <thead>
              <tr>
                <th scope="col">Bill · Action</th>
                <th scope="col" className="viw-num">Sign</th>
                <th scope="col" className="viw-num">Amp × Weight</th>
                <th scope="col" className="viw-num">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sign = VALENCE_SIGN[r.valence];
                const amp = VALENCE_AMPLIFIER[r.valence];
                const skip = skipReason(r.valence, r.weight, r.memberVote);
                const mag = amp * r.weight;
                const contribution = sign * mag;
                const rowClasses = [
                  skip ? 'viw-score-row-skipped' : '',
                  `viw-valence-${r.valence}`,
                ].filter(Boolean).join(' ');
                const isOpen = expandedRows.has(r.key);
                const hasLongDescription = r.description.length > BILL_LABEL_TRUNCATE_CHARS;
                const hasActionDetail = r.actionDetail.length > 0;
                const expandable = hasLongDescription || hasActionDetail;
                const shortDescription =
                  hasLongDescription && !isOpen
                    ? r.description.slice(0, BILL_LABEL_TRUNCATE_CHARS).trimEnd() + '…'
                    : r.description;
                return (
                  <tr key={r.key} className={rowClasses}>
                    <th scope="row" className="viw-score-row-bill">
                      {expandable ? (
                        <button
                          type="button"
                          className="viw-score-row-bill-toggle"
                          aria-expanded={isOpen}
                          onClick={(e) => { e.stopPropagation(); toggleRow(r.key); }}
                          title={isOpen ? 'Collapse' : 'Show full detail'}
                        >
                          <span className="viw-score-row-bill-slug">{r.slug}</span>
                          <span className="viw-score-row-bill-desc">{shortDescription}</span>
                          <span className="viw-score-row-bill-action">{r.action}</span>
                          {isOpen && hasActionDetail && (
                            <span className="viw-score-row-bill-detail">{r.actionDetail}</span>
                          )}
                          <span className="viw-score-row-bill-caret" aria-hidden="true">
                            {isOpen ? '▾' : '▸'}
                          </span>
                        </button>
                      ) : (
                        <>
                          <span className="viw-score-row-bill-slug">{r.slug}</span>
                          <span className="viw-score-row-bill-desc">{r.description}</span>
                          <span className="viw-score-row-bill-action">{r.action}</span>
                        </>
                      )}
                    </th>
                    <td className="viw-num">{sign === 0 ? '0' : sign > 0 ? '+1' : '−1'}</td>
                    <td className="viw-num">
                      {skip ? '—' : `${amp.toFixed(1)} × ${r.weight.toFixed(2)}`}
                    </td>
                    <td className="viw-num">
                      {skip ? (
                        <span className="viw-score-skip" title={VALENCE_LABEL[r.valence]}>
                          skip ({skip})
                        </span>
                      ) : (
                        fmtSigned(contribution)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="viw-score-row-total">
                  Totals
                </th>
                <td className="viw-num">{sumMag.toFixed(2)}</td>
                <td className="viw-num">{fmtSigned(sumSigned)}</td>
              </tr>
              <tr>
                <th scope="row" colSpan={3} className="viw-score-row-total">
                  Score = {fmtSigned(sumSigned)} ÷ {sumMag.toFixed(2)}
                </th>
                <td className="viw-num viw-score-row-final">
                  {score?.score == null ? 'N/A' : fmtSigned(score.score)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="viw-score-breakdown-note">
        Sponsorships amplify 1.5×, floor votes 1.0×. Weight is 1.0 for final
        passage, 0.30–0.45 for directional procedurals, 0 for ambiguous ones
        (motion-to-table). Skipped rows (present, abstained, procedural,
        neutral) don't move the number but are shown here for transparency.
        Members with fewer than 3 counted actions are flagged "Limited
        record"; the badge color fully saturates at 8 counted actions.
      </p>
    </div>
  );
}

export function UkraineScoreBadge({
  score,
  voting,
  bills,
  obstructionCount = 0,
  primaryAbstentionCount = 0,
  loading = false,
}: UkraineScoreBadgeProps) {
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    // Loading state: same row structure as loaded state so there's no
    // reflow when the real score arrives. Shimmer bar + "LOADING…" label
    // signal live activity. The label is kept short so it never crowds
    // the value column on narrow widths.
    return (
      <div className="viw-score viw-score-loading" aria-busy="true" aria-live="polite">
        <div className="viw-score-header-row">
          <span className="viw-score-title viw-score-title-lg">
            <span className="viw-title-full">Ukraine Support Score</span>
            <span className="viw-title-short" aria-hidden="true">Score</span>
          </span>
          <div className="viw-score-context-stack">
            <span className="viw-score-label viw-score-loading-label">Loading…</span>
            <span className="viw-score-justification viw-score-loading-justification">
              Fetching voting record
            </span>
          </div>
          <span className="viw-score-value viw-score-value-loading" aria-hidden="true">
            <span className="viw-score-value-skeleton" />
          </span>
        </div>
        <div className="viw-score-bar" role="progressbar" aria-label="Loading Ukraine support score">
          <div className="viw-score-bar-track viw-score-bar-track-loading">
            <div className="viw-score-bar-shimmer" />
          </div>
          <div className="viw-score-bar-scale">
            <span>Opposed</span>
            <span>Mixed</span>
            <span>Supportive</span>
          </div>
        </div>
      </div>
    );
  }

  const headerRight = renderRight();

  function renderRight() {
    if (!score || score.score === null) {
      return (
        <>
          <div className="viw-score-context-stack">
            <span className="viw-score-label">No record</span>
            <span className="viw-score-justification">
              No curated Ukraine votes or sponsorships found for this member yet.
            </span>
          </div>
          <span className="viw-score-value viw-score-value-na">N/A</span>
        </>
      );
    }
    const color = scoreToCssColor(score.score);
    const label = scoreLabel(score.score, score.lowConfidence);
    const signed = (score.score >= 0 ? '+' : '') + score.score.toFixed(2);
    const saturation = saturationFilterFor(score.confidence);
    const excluded = score.total - score.contributing;
    const justification = (
      <>
        <span className="viw-justification-full">
          Based on {score.contributing} counted action
          {score.contributing === 1 ? '' : 's'}
          {excluded > 0 && ` (${excluded} excluded: unstated, procedural, or neutral)`}
        </span>
        <span className="viw-justification-short" aria-hidden="true">
          {score.contributing} action{score.contributing === 1 ? '' : 's'}
          {excluded > 0 && ` (${excluded} exc)`}
        </span>
      </>
    );
    return (
      <>
        <div className="viw-score-context-stack">
          <span className="viw-score-label">{label}</span>
          <span className="viw-score-justification">{justification}</span>
        </div>
        <span
          className="viw-score-value"
          style={{ color, filter: saturation }}
          title={label}
        >
          {signed}
        </span>
      </>
    );
  }

  // Click anywhere on the grey score band or the white breakdown panel to
  // toggle the breakdown. Descendant buttons (header, bar, per-row expand)
  // each stop propagation on their own click, so their logic is
  // authoritative — this handler only sees clicks on true whitespace.
  const handleContainerClick = () => {
    setExpanded((v) => !v);
  };

  const toggleExpanded = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  };

  const header = (
    <button
      type="button"
      className="viw-score-header-row viw-score-header-toggle"
      aria-expanded={expanded}
      aria-controls="viw-score-breakdown-panel"
      onClick={toggleExpanded}
    >
      <span className="viw-score-title viw-score-title-lg">
        <span className="viw-title-full">Ukraine Support Score</span>
        <span className="viw-title-short" aria-hidden="true">Score</span>
      </span>
      {headerRight}
      <span className="viw-score-header-caret" aria-hidden="true">
        {expanded ? '▾' : '▸'}
      </span>
    </button>
  );

  if (!score || score.score === null) {
    return (
      <div className="viw-score viw-score-na" onClick={handleContainerClick}>
        {header}
        {expanded && (
          <div id="viw-score-breakdown-panel">
            <ScoreBreakdown voting={voting} bills={bills} score={score} />
          </div>
        )}
      </div>
    );
  }

  const pct = ((score.score + 1) / 2) * 100;
  const color = scoreToCssColor(score.score);
  const label = scoreLabel(score.score, score.lowConfidence);

  return (
    <div className="viw-score" onClick={handleContainerClick}>
      {header}
      <button
        type="button"
        className="viw-score-bar-toggle"
        aria-expanded={expanded}
        aria-controls="viw-score-breakdown-panel"
        aria-label={`${label}. ${expanded ? 'Hide' : 'Show'} score breakdown.`}
        onClick={toggleExpanded}
      >
        <div
          className="viw-score-bar"
          role="progressbar"
          aria-valuenow={Math.round(score.score * 100)}
          aria-valuemin={-100}
          aria-valuemax={100}
        >
          <div className="viw-score-bar-track">
            <div
              className="viw-score-bar-marker"
              style={{ left: `${pct}%`, background: color }}
            />
          </div>
          <div className="viw-score-bar-scale">
            <span>Opposed</span>
            <span>Mixed</span>
            <span>Supportive</span>
          </div>
        </div>
        {obstructionCount >= 2 && (
          <div className="viw-score-obstruction-note" role="note">
            Includes <strong>{obstructionCount}</strong> obstruction events —
            procedural anti-Ukraine votes or anti-Ukraine sponsorships.
          </div>
        )}
        {primaryAbstentionCount >= ABSTENTION_DISPLAY_THRESHOLD && (
          <div className="viw-score-abstention-note" role="note">
            Abstained on <strong>{primaryAbstentionCount}</strong> primary-weight
            Ukraine vote{primaryAbstentionCount === 1 ? '' : 's'} — the member was
            in office for {primaryAbstentionCount === 1 ? 'this vote' : 'these votes'}{' '}
            but cast no ballot.
          </div>
        )}
      </button>
      {expanded && (
        <div id="viw-score-breakdown-panel">
          <ScoreBreakdown voting={voting} bills={bills} score={score} />
        </div>
      )}
    </div>
  );
}
