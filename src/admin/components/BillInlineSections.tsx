/**
 * Inline editors for the votes and comments attached to a bill — rendered
 * directly under the Bill editor's field groups so researchers add and edit
 * everything in one place. Traces to AC-52.16 + AC-52.23 (which supersedes
 * the earlier "+ Add (T-133)" placeholder language).
 *
 * Posture: AS SIMPLE AS POSSIBLE.
 *  - One inline form per existing row + one "new" form at the bottom.
 *  - Per-row change-notes input is required for Save (mirror of AC-50.8 +
 *    the bill-editor's AC-52.18 client-side gate). Creates don't require
 *    change-notes; deletes prompt for one.
 *  - Save / Delete refetches the section's rows so the editor reflects the
 *    canonical state without manual reloads.
 */
import { useEffect, useState } from 'react';
import { get, post, patch, del, resolveApiBase, type FetchError } from '../fetcher';
import { sanitizeUrl } from '../../utils/sanitizeUrl';
import type { VoteRow, CommentRow } from '../types';

interface VotesResponse {
  items: VoteRow[];
}
interface CommentsResponse {
  items: CommentRow[];
}

/* -------------------------------------------------------------------------- */
/*                                Votes section                               */
/* -------------------------------------------------------------------------- */

interface VoteDraft {
  chamber: string;
  congress: number;
  session: number;
  roll_call: number | '';
  date: string;
  weight: number | '';
  direction_multiplier: number;
  kind: string;
  weight_reason: string;
  url: string;
}

function voteRowToDraft(v: VoteRow): VoteDraft {
  return {
    chamber: v.chamber,
    congress: v.congress,
    session: v.session,
    roll_call: v.roll_call,
    date: v.date,
    weight: v.weight,
    direction_multiplier: v.direction_multiplier,
    kind: v.kind,
    weight_reason: v.weight_reason ?? '',
    url: v.url ?? '',
  };
}

function blankVoteDraft(): VoteDraft {
  return {
    chamber: 'House',
    congress: 119,
    session: 1,
    roll_call: '',
    date: '',
    weight: 1,
    direction_multiplier: 1,
    kind: 'passage',
    weight_reason: '',
    url: '',
  };
}

/** AC-63.7 — bill direction context. Per FR-63 each vote now carries its OWN
 *  direction (pro/anti/neutral); the bill's direction only drives sponsorship
 *  scoring. No inversion language. Set a vote's direction in Admin › Vote review. */
function DirectionStrip({ direction }: { direction?: string }) {
  if (!direction) return null;
  let gloss: React.ReactNode = null;
  if (direction === 'pro-ukraine' || direction === 'anti-ukraine') {
    gloss = (
      <>
        {' — '}drives <strong>sponsorship</strong> scoring. Each roll-call vote sets its{' '}
        <strong>own direction</strong> (pro / anti / neutral) in{' '}
        <strong>Vote review</strong>.
      </>
    );
  }
  return (
    <div data-testid="bill-direction-strip" style={styles.directionStrip}>
      Bill direction: <strong>{direction}</strong>
      {gloss}
    </div>
  );
}

export function BillVotesSection({
  billId,
  billDirection,
}: {
  billId: string;
  billDirection?: string;
}) {
  const [items, setItems] = useState<VoteRow[]>([]);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!billId) return;
    let cancel = false;
    get<VotesResponse>(`/api/admin/votes?billId=${encodeURIComponent(billId)}`)
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
  }, [billId, reload]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <Section
      title="Roll-call votes"
      count={items.length}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <DirectionStrip direction={billDirection} />
      {error && <div style={styles.error}>Error loading votes: {error}</div>}
      {items.map((v) => (
        <VoteEditor key={v.id} billId={billId} vote={v} onSaved={refresh} />
      ))}
      {/* AC-52.46+ — votes come from the bill-onboarding import (Phase 4),
       *  never typed manually. Researchers annotate weight + direction +
       *  rationale on otherwise-immutable rows from Congress.gov. */}
      <div style={styles.importHint}>
        Roll-call votes are imported from Congress.gov when the bill is added.
        To attach more votes, re-run the bill import (Phase 4 — coming soon).
      </div>
    </Section>
  );
}

interface VoteEditorProps {
  billId: string;
  vote: VoteRow | null;
  onSaved: () => void;
}

function VoteEditor({ billId, vote, onSaved }: VoteEditorProps) {
  const isNew = vote === null;
  const [draft, setDraft] = useState<VoteDraft>(
    () => (vote ? voteRowToDraft(vote) : blankVoteDraft()),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  // AC-52.68 — when Save is clicked on an existing row with an empty
  // change-notes input, flash the input red so the researcher sees why
  // nothing happened. Auto-clears after 800ms.
  const [flashReason, setFlashReason] = useState(false);

  // Re-sync draft when the underlying row changes (e.g. after a save refetch).
  useEffect(() => {
    if (vote) setDraft(voteRowToDraft(vote));
  }, [vote]);

  // Save is enabled — early-return on empty change-notes triggers the flash
  // (so the researcher gets feedback) instead of silently doing nothing.
  const saveDisabled = busy;

  function update<K extends keyof VoteDraft>(k: K, v: VoteDraft[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // AC-52.68 — gate update flows on non-empty change-notes; flash on miss.
    if (!isNew && reason.trim().length === 0) {
      setFlashReason(true);
      window.setTimeout(() => setFlashReason(false), 800);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        bill_id: billId,
        chamber: draft.chamber,
        congress: Number(draft.congress),
        session: Number(draft.session),
        roll_call: Number(draft.roll_call),
        date: draft.date,
        weight: Number(draft.weight),
        direction_multiplier: Number(draft.direction_multiplier),
        kind: draft.kind,
        weight_reason: draft.weight_reason || null,
        url: draft.url || null,
      };
      if (isNew) {
        await post(`/api/admin/votes`, payload);
        setDraft(blankVoteDraft());
      } else {
        payload['_reason'] = reason.trim();
        await patch(`/api/admin/votes/${vote.id}`, payload);
        setReason('');
      }
      onSaved();
    } catch (e) {
      const fe = e as FetchError;
      setErr(fe.detail ?? fe.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!vote) return;
    if (!deleteReason.trim()) { setErr('A reason is required to delete.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await del(`/api/admin/votes/${vote.id}?reason=${encodeURIComponent(deleteReason.trim())}`);
      onSaved();
    } catch (e) {
      const fe = e as FetchError;
      setErr(fe.detail ?? fe.error);
    } finally {
      setBusy(false);
    }
  }

  // Editable on existing rows: weight, direction_multiplier, weight_reason, url.
  // Static identifiers (chamber/congress/session/roll_call/date/kind) come from the
  // upstream API and are read-only per AC-52.27 + AC-54.1 (only weight + direction
  // are researcher-editable). New rows expose them as inputs since that's the only
  // path to attach a vote to a bill.
  return (
    <form
      data-row={isNew ? 'vote-new' : 'vote'}
      style={styles.editorForm}
      onSubmit={onSubmit}
    >
      {!isNew && vote && (
        <div style={styles.staticHeader}>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Chamber:</span> {vote.chamber}
          </span>
          <span style={styles.staticDivider}>·</span>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Congress:</span> {vote.congress}
          </span>
          <span style={styles.staticDivider}>·</span>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Session:</span> {vote.session}
          </span>
          <span style={styles.staticDivider}>·</span>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Roll-call:</span> {vote.roll_call}
          </span>
          <span style={styles.staticDivider}>·</span>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Date:</span> {vote.date}
          </span>
          <span style={styles.staticDivider}>·</span>
          <span style={styles.staticItem}>
            <span style={styles.staticKey}>Kind:</span> {vote.kind}
          </span>
        </div>
      )}

      {/* AC-52.61 — existing rows: weight + direction + URL ↗ + weight
          rationale all on one flex-wrap row. */}
      {!isNew && vote && (() => {
        const linkUrl = vote.chamber === 'Senate'
          ? senateHumanUrl(vote.congress, vote.session, vote.roll_call, vote.url)
          : vote.url;
        const safe = sanitizeUrl(linkUrl);
        return (
          <div style={styles.editRow}>
            <FieldLabel text="Weight">
              <input
                type="number"
                step="0.05"
                min={0}
                max={5}
                value={draft.weight}
                onChange={(e) => update('weight', e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="0–5"
                style={styles.inputShort}
              />
            </FieldLabel>
            <FieldLabel text="Direction">
              <select
                value={draft.direction_multiplier}
                onChange={(e) => update('direction_multiplier', Number(e.target.value))}
                style={styles.input}
              >
                <option value={1}>+1 with bill direction</option>
                <option value={0}>0 neutral</option>
                <option value={-1}>−1 against bill direction</option>
              </select>
            </FieldLabel>
            <FieldLabel text="URL">
              {safe ? (
                <a
                  href={safe}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.openLink}
                >
                  ↗ Open
                </a>
              ) : (
                <span style={styles.staticUrlText}>(none)</span>
              )}
            </FieldLabel>
            <FieldLabel text="Weight rationale" wrapperStyle={styles.editRowFlexCell}>
              <input
                type="text"
                value={draft.weight_reason}
                onChange={(e) => update('weight_reason', e.target.value)}
                placeholder="standing rationale (optional)"
                style={styles.editRowInput}
              />
            </FieldLabel>
            <FieldLabel text="Change notes" wrapperStyle={styles.editRowFlexCell}>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="required to save"
                style={{
                  ...styles.editRowInput,
                  ...(flashReason ? styles.editRowInputFlash : {}),
                }}
                aria-invalid={flashReason}
              />
            </FieldLabel>
          </div>
        );
      })()}

      {/* AC-52.34 — Add row: single horizontal strip, all inputs labeled and
       *  sized to content. Designed to stack 12–14 rows without visual fatigue. */}
      {isNew && (
        <div style={styles.addStrip}>
          <FieldLabel text="Chamber">
            <select
              value={draft.chamber}
              onChange={(e) => update('chamber', e.target.value)}
              style={styles.inputChamber}
            >
              <option value="House">House</option>
              <option value="Senate">Senate</option>
            </select>
          </FieldLabel>
          <FieldLabel text="Congress">
            <input
              type="number"
              value={draft.congress}
              onChange={(e) => update('congress', Number(e.target.value))}
              style={styles.inputTiny}
            />
          </FieldLabel>
          <FieldLabel text="Session">
            <input
              type="number"
              value={draft.session}
              onChange={(e) => update('session', Number(e.target.value))}
              style={styles.inputTiny}
            />
          </FieldLabel>
          <FieldLabel text="Roll #">
            <input
              type="number"
              value={draft.roll_call}
              onChange={(e) => update('roll_call', e.target.value === '' ? '' : Number(e.target.value))}
              style={styles.inputTiny}
              placeholder="—"
            />
          </FieldLabel>
          <FieldLabel text="Date">
            <input
              type="text"
              value={draft.date}
              onChange={(e) => update('date', e.target.value)}
              placeholder="YYYY-MM-DD"
              style={styles.inputDate}
            />
          </FieldLabel>
          <FieldLabel text="Kind">
            <input
              type="text"
              value={draft.kind}
              onChange={(e) => update('kind', e.target.value)}
              placeholder="passage / concur / …"
              style={styles.inputKind}
            />
          </FieldLabel>
          <FieldLabel text="Weight">
            <input
              type="number"
              step="0.05"
              min={0}
              max={5}
              value={draft.weight}
              onChange={(e) => update('weight', e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="0–5"
              style={styles.inputTiny}
            />
          </FieldLabel>
          <FieldLabel text="Direction">
            <select
              value={draft.direction_multiplier}
              onChange={(e) => update('direction_multiplier', Number(e.target.value))}
              style={styles.inputDirection}
            >
              <option value={1}>+1</option>
              <option value={0}>0</option>
              <option value={-1}>−1</option>
            </select>
          </FieldLabel>
        </div>
      )}

      {/* AC-52.61 — existing-row URL is now part of the editable row above.
          The Add-row keeps a separate URL field since identifiers + URL are
          all editable on import. */}
      {isNew && (
        <FieldLabel text="Vote URL">
          <div style={styles.urlRow}>
            <input
              type="text"
              value={draft.url}
              onChange={(e) => update('url', e.target.value)}
              placeholder="https://clerk.house.gov/Votes/… or https://senate.gov/…"
              style={styles.urlInput}
            />
            {(() => {
              const safe = sanitizeUrl(draft.url);
              if (!safe) return null;
              return (
                <a
                  href={safe}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.openLink}
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗ Open
                </a>
              );
            })()}
          </div>
        </FieldLabel>
      )}

      {/* AC-52.61 — weight rationale lives inside the editRow on existing
          rows. Keep it as its own line on the Add-row only. */}
      {isNew && (
        <FieldLabel text="Weight rationale" inputStyle={styles.weightReasonInput}>
          <input
            type="text"
            value={draft.weight_reason}
            onChange={(e) => update('weight_reason', e.target.value)}
            placeholder="standing rationale for this weight (optional)"
            style={styles.weightReasonInput}
          />
        </FieldLabel>
      )}

      {!isNew && vote && (
        <>
          <VoteContextDisclosure
            chamber={vote.chamber}
            congress={vote.congress}
            session={vote.session}
            rollCall={vote.roll_call}
            fallbackUrl={vote.url}
          />
          <VoteRelatedReferences
            billId={vote.bill_id}
            chamber={vote.chamber}
            rollCall={vote.roll_call}
          />
        </>
      )}

      {/* On existing rows the Change notes field is part of the editRow above.
          On Add (new) rows it's still here so the Add strip stays compact. */}
      <div style={styles.actionRow}>
        {isNew && (
          <FieldLabel text="Change notes">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="change-notes (optional on add)"
              style={styles.editRowInput}
            />
          </FieldLabel>
        )}
        {!isNew && pendingDelete ? (
          <>
            <input
              type="text"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Reason for delete (required)"
              autoFocus
              style={{ ...styles.reasonInput, flex: 1 }}
            />
            <button type="button" onClick={onDelete} disabled={busy} style={styles.deleteBtn}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button type="button" onClick={() => { setPendingDelete(false); setDeleteReason(''); setErr(null); }} style={styles.saveBtn}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="submit" disabled={saveDisabled} style={styles.saveBtn}>
              {isNew ? 'Add' : 'Save'}
            </button>
            {!isNew && (
              <button type="button" onClick={() => { setPendingDelete(true); setErr(null); }} disabled={busy} style={styles.deleteBtn}>
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {err && <div style={styles.error}>{err}</div>}
    </form>
  );
}

/**
 * Tiny labeled-input helper. The label wraps the input so RTL's
 * `getByLabelText` works without needing unique htmlFor IDs. The visible label
 * text sits above the input; AC-52.27(b) requires every editable input to
 * carry a visible label.
 */
function FieldLabel({
  text,
  children,
  inputStyle,
  wrapperStyle,
}: {
  text: string;
  children: React.ReactNode;
  /** Legacy: extra styles spread onto the label wrapper. Prefer `wrapperStyle`. */
  inputStyle?: React.CSSProperties;
  /** Flex sizing on the label cell — needed when this FieldLabel is itself
   *  a flex item in a row layout (e.g. the vote-row editRow). */
  wrapperStyle?: React.CSSProperties;
}) {
  return (
    <label style={{ ...styles.fieldLabel, ...(inputStyle ?? {}), ...(wrapperStyle ?? {}) }}>
      <span style={styles.fieldLabelText}>{text}</span>
      {children}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Comments section                              */
/* -------------------------------------------------------------------------- */

interface CommentDraft {
  attached_to_roll_call_id: string;
  body_markdown: string;
  weight: number;
  direction: number;
}

function commentRowToDraft(c: CommentRow): CommentDraft {
  return {
    attached_to_roll_call_id: c.attached_to_roll_call_id ?? '',
    body_markdown: c.body_markdown,
    weight: c.weight,
    direction: c.direction,
  };
}

function blankCommentDraft(): CommentDraft {
  return { attached_to_roll_call_id: '', body_markdown: '', weight: 0, direction: 0 };
}

export function BillCommentsSection({ billId }: { billId: string }) {
  const [items, setItems] = useState<CommentRow[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!billId) return;
    let cancel = false;
    get<CommentsResponse>(`/api/admin/comments?billId=${encodeURIComponent(billId)}`)
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
  }, [billId, reload]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <Section
      title="Comments"
      count={items.length}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {error && <div style={styles.error}>Error loading comments: {error}</div>}
      {items.map((c) => (
        <CommentEditor key={c.id} billId={billId} comment={c} onSaved={refresh} />
      ))}
      <CommentEditor billId={billId} comment={null} onSaved={refresh} />
    </Section>
  );
}

interface CommentEditorProps {
  billId: string;
  comment: CommentRow | null;
  onSaved: () => void;
}

function CommentEditor({ billId, comment, onSaved }: CommentEditorProps) {
  const isNew = comment === null;
  const [draft, setDraft] = useState<CommentDraft>(
    () => (comment ? commentRowToDraft(comment) : blankCommentDraft()),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');
  // AC-52.68 — flash the change-notes input when Save is clicked with empty
  // reason on update flow.
  const [flashReason, setFlashReason] = useState(false);

  useEffect(() => {
    if (comment) setDraft(commentRowToDraft(comment));
  }, [comment]);

  // Save stays enabled; empty-change-notes triggers a visible flash instead
  // of a silently-disabled button.
  const saveDisabled = busy;

  function update<K extends keyof CommentDraft>(k: K, v: CommentDraft[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isNew && reason.trim().length === 0) {
      setFlashReason(true);
      window.setTimeout(() => setFlashReason(false), 800);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        bill_id: billId,
        attached_to_roll_call_id: draft.attached_to_roll_call_id || null,
        body_markdown: draft.body_markdown,
        weight: Number(draft.weight),
        direction: Number(draft.direction),
      };
      if (isNew) {
        await post(`/api/admin/comments`, payload);
        setDraft(blankCommentDraft());
      } else {
        payload['_reason'] = reason.trim();
        await patch(`/api/admin/comments/${comment.id}`, payload);
        setReason('');
      }
      onSaved();
    } catch (e) {
      const fe = e as FetchError;
      setErr(fe.detail ?? fe.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!comment) return;
    if (!deleteReason.trim()) { setErr('A reason is required to delete.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await del(`/api/admin/comments/${comment.id}?reason=${encodeURIComponent(deleteReason.trim())}`);
      onSaved();
    } catch (e) {
      const fe = e as FetchError;
      setErr(fe.detail ?? fe.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-row={isNew ? 'comment-new' : 'comment'}
      style={styles.editorForm}
      onSubmit={onSubmit}
    >
      <div style={styles.commentGrid}>
        {/* Comments are bill-level. Roll-call attachment isn't a researcher
            concern — annotations there belong on the vote row itself. */}
        <textarea
          value={draft.body_markdown}
          onChange={(e) => update('body_markdown', e.target.value)}
          aria-label="Comment body"
          placeholder="What's notable about this bill? (markdown)"
          rows={3}
          style={styles.textarea}
        />
        {/* AC-52.41 — weight + direction + a big right-aligned contribution. */}
        <div style={styles.commentControls}>
          <FieldLabel text="Weight">
            <input
              type="number"
              step="0.05"
              min={0}
              max={5}
              value={draft.weight}
              onChange={(e) => update('weight', e.target.value === '' ? 0 : Number(e.target.value))}
              placeholder="0–5"
              style={styles.inputShort}
            />
          </FieldLabel>
          <FieldLabel text="Direction">
            <select
              value={draft.direction}
              onChange={(e) => update('direction', Number(e.target.value))}
              style={styles.inputDirectionWide}
            >
              <option value={1}>+1 pro-Ukraine</option>
              <option value={0}>0 unstated</option>
              <option value={-1}>−1 anti-Ukraine</option>
            </select>
          </FieldLabel>
          <span style={styles.contributionReadoutLg} aria-label="Score contribution">
            <span style={styles.contributionLabel}>Contribution</span>
            <strong style={styles.contributionValue}>
              {draft.direction * draft.weight >= 0 ? '+' : ''}
              {(draft.direction * draft.weight).toFixed(2)}
            </strong>
          </span>
        </div>
      </div>
      <div style={styles.actionRow}>
        {!isNew && !pendingDelete && (
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="change-notes (required to save)"
            aria-label="Change notes"
            style={{
              ...styles.reasonInput,
              ...(flashReason ? styles.editRowInputFlash : {}),
            }}
            aria-invalid={flashReason}
          />
        )}
        {!isNew && pendingDelete ? (
          <>
            <input
              type="text"
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Reason for delete (required)"
              autoFocus
              style={{ ...styles.reasonInput, flex: 1 }}
            />
            <button type="button" onClick={onDelete} disabled={busy} style={styles.deleteBtn}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button type="button" onClick={() => { setPendingDelete(false); setDeleteReason(''); setErr(null); }} style={styles.saveBtn}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="submit" disabled={saveDisabled} style={styles.saveBtn}>
              {isNew ? 'Add' : 'Save'}
            </button>
            {!isNew && (
              <button type="button" onClick={() => { setPendingDelete(true); setErr(null); }} disabled={busy} style={styles.deleteBtn}>
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {err && <div style={styles.error}>{err}</div>}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Inline vote-context (AC-52.26)                    */
/* -------------------------------------------------------------------------- */

interface VoteContextProps {
  chamber: string;
  congress: number;
  session: number;
  rollCall: number;
  fallbackUrl: string | null;
}

/** AC-52.60 — pick a human-readable Senate vote URL.
 *  Congress.gov stores the XML votes file (vote_C_S_RC.xml) in `votes.url`,
 *  which renders as raw XML in a browser. We prefer (in order):
 *    1. `votes.url` if it ends in `.htm` or has no extension (already human).
 *    2. The derived `roll_call_vote_cfm.cfm` page on senate.gov, which
 *       renders as a real HTML vote-detail page.
 *    3. The raw row URL last resort.
 *  Returns null if nothing safe survives. */
export function senateHumanUrl(
  congress: number,
  session: number,
  rollCall: number,
  rowUrl: string | null,
): string | null {
  if (rowUrl) {
    const lower = rowUrl.toLowerCase();
    if (!lower.endsWith('.xml')) {
      // Already not the XML file → trust it.
      return rowUrl;
    }
  }
  // Senate's CFM page expects a 5-digit zero-padded vote number.
  const voteParam = String(rollCall).padStart(5, '0');
  return `https://www.senate.gov/legislative/LIS/roll_call_lists/roll_call_vote_cfm.cfm?congress=${congress}&session=${session}&vote=${voteParam}`;
}

export interface NormalizedContext {
  question: string;
  result: string;
  totals: { yea: number; nay: number; present: number; notVoting: number };
}

interface RawHouseDetail {
  houseRollCallVote?: {
    voteQuestion?: string;
    result?: string;
    votePartyTotal?: Array<{
      yeaTotal?: number;
      nayTotal?: number;
      presentTotal?: number;
      notVotingTotal?: number;
    }>;
  };
}

function normalizeHouseDetail(raw: RawHouseDetail): NormalizedContext {
  const v = raw.houseRollCallVote ?? {};
  const totals = (v.votePartyTotal ?? []).reduce(
    (acc, p) => ({
      yea: acc.yea + (p.yeaTotal ?? 0),
      nay: acc.nay + (p.nayTotal ?? 0),
      present: acc.present + (p.presentTotal ?? 0),
      notVoting: acc.notVoting + (p.notVotingTotal ?? 0),
    }),
    { yea: 0, nay: 0, present: 0, notVoting: 0 },
  );
  return {
    question: v.voteQuestion ?? '(no question recorded)',
    result: v.result ?? '(no result recorded)',
    totals,
  };
}

/** AC-52.63 — vote-row inline references. Pulls bill_actions, finds the action
 *  whose `recorded_chamber + recorded_roll_call` matches THIS vote, surfaces:
 *    - the action text (what the vote was on, in human language),
 *    - any Congressional Record link the action carries,
 *    - the bill's Congress.gov page (so researchers can drill to the text). */
interface VoteRelatedRefsProps {
  billId: string;
  chamber: string;
  rollCall: number;
}
interface ActionLite {
  id: string;
  action_text: string | null;
  congressional_record_url: string | null;
  congressional_record_citation: string | null;
  recorded_chamber: string | null;
  recorded_roll_call: number | null;
}
interface ActionsResp {
  items: ActionLite[];
}

function VoteRelatedReferences(props: VoteRelatedRefsProps) {
  const [matched, setMatched] = useState<ActionLite | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!props.billId) return;
    let cancel = false;
    get<ActionsResp>(
      `/api/admin/actions?billId=${encodeURIComponent(props.billId)}`,
    )
      .then((r) => {
        if (cancel) return;
        const m = (r.items ?? []).find(
          (a) =>
            a.recorded_chamber === props.chamber &&
            a.recorded_roll_call === props.rollCall,
        );
        setMatched(m ?? null);
      })
      .catch((e: FetchError) => {
        if (cancel) return;
        setErr(e.detail ?? e.error);
      });
    return () => {
      cancel = true;
    };
  }, [props.billId, props.chamber, props.rollCall]);

  if (err) return <div style={styles.contextLineErr}>Could not load references: {err}</div>;
  if (!matched) {
    // No matching action recorded yet (likely pre-backfill). Quiet — don't
    // clutter the row with "(none)" noise; researchers backfill via re-import.
    return null;
  }
  const safeCr = sanitizeUrl(matched.congressional_record_url);
  return (
    <div style={styles.refsRow}>
      <span style={styles.refsKey}>Action:</span>
      <span style={styles.refsAction}>{matched.action_text}</span>
      {safeCr && (
        <a
          href={safeCr}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.openLink}
        >
          ↗ Congressional Record
          {matched.congressional_record_citation
            ? ` (${matched.congressional_record_citation})`
            : ''}
        </a>
      )}
    </div>
  );
}

/** AC-52.64 — extract a normalized vote context out of a Senate XML body. */
export function parseSenateVoteContextXml(xml: string): NormalizedContext {
  const scalar = (tag: string): string | null => {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
    return m?.[1]?.trim() ?? null;
  };
  const num = (tag: string): number => Number(scalar(tag) ?? 0) || 0;
  const question = scalar('vote_question_text') ?? scalar('question') ?? '(no question recorded)';
  const result = scalar('vote_result_text') ?? scalar('result') ?? '(no result recorded)';
  // Senate <count> wraps the totals.
  const countBlock = xml.match(/<count\b[^>]*>([\s\S]*?)<\/count>/)?.[1] ?? '';
  const sub = (tag: string): number => {
    const m = countBlock.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
    return Number(m?.[1]?.trim() ?? 0) || 0;
  };
  return {
    question,
    result,
    totals: {
      yea: sub('yeas') || num('yeas'),
      nay: sub('nays') || num('nays'),
      present: sub('present') || num('present'),
      notVoting: sub('absent') || num('not_voting'),
    },
  };
}

function VoteContextDisclosure(props: VoteContextProps) {
  // AC-52.62 + AC-52.64 — pre-expanded inline context. House goes through the
  // Congress.gov v3 JSON; Senate fetches the canonical XML on senate.gov via
  // the /api/senate proxy and parses it inline.
  const [data, setData] = useState<NormalizedContext | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isHouse = props.chamber === 'House';
  const isSenate = props.chamber === 'Senate';

  useEffect(() => {
    if ((!isHouse && !isSenate) || data || err || loading) return;
    setLoading(true);
    const base = resolveApiBase();
    const url = isHouse
      ? `${base}/api/congress/v3/house-vote/${props.congress}/${props.session}/${props.rollCall}`
      : `${base}/api/senate/legislative/LIS/roll_call_votes/vote${props.congress}${props.session}/vote_${props.congress}_${props.session}_${String(props.rollCall).padStart(5, '0')}.xml`;
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `http_${r.status}`;
          try {
            const j = (await r.json()) as { detail?: string; error?: string };
            detail = j.detail ?? j.error ?? detail;
          } catch { /* not JSON; XML 5xx falls through */ }
          throw new Error(detail);
        }
        return isHouse ? r.json() : r.text();
      })
      .then((raw) => {
        if (isHouse) setData(normalizeHouseDetail(raw as RawHouseDetail));
        else setData(parseSenateVoteContextXml(raw as string));
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [isHouse, isSenate, data, err, loading, props.congress, props.session, props.rollCall]);

  return (
    <div style={styles.contextInline}>
      {loading && <span style={styles.contextLineMuted}>Loading vote context…</span>}
      {err && (() => {
        // On error, surface a fallback link to the human-readable source so the
        // researcher can still drill in.
        const human = isSenate
          ? sanitizeUrl(senateHumanUrl(props.congress, props.session, props.rollCall, props.fallbackUrl))
          : sanitizeUrl(props.fallbackUrl);
        return (
          <span style={styles.contextLineErr}>
            Could not load vote context: {err}
            {human && (
              <>
                {' — '}
                <a href={human} target="_blank" rel="noopener noreferrer" style={styles.openLink}>
                  open source ↗
                </a>
              </>
            )}
          </span>
        );
      })()}
      {data && (
        <span style={styles.contextLine}>
          <strong>Q:</strong> {data.question}
          {' · '}
          <strong>Result:</strong> {data.result}
          {' · '}
          <strong>Totals:</strong> Y {data.totals.yea} · N {data.totals.nay} · P {data.totals.present} · NV {data.totals.notVoting}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Section                                   */
/* -------------------------------------------------------------------------- */

interface SectionProps {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ title, count, open, onToggle, children }: SectionProps) {
  return (
    <fieldset style={styles.fieldset}>
      <legend style={styles.legend}>
        <button
          type="button"
          onClick={onToggle}
          style={styles.legendBtn}
          aria-expanded={open}
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
          {title} ({count})
        </button>
      </legend>
      {open && <div style={styles.body}>{children}</div>}
    </fieldset>
  );
}

/* AC-52.28..30 + AC-52.34 — token-driven, flat, condensed vote-row layout. */
const INPUT_BASE: React.CSSProperties = {
  background: 'var(--tk-bg)',
  color: 'var(--tk-fg)',
  border: '2px solid var(--tk-border-soft)',
  borderRadius: 0,
  padding: '4px 6px',
  fontFamily: 'var(--tk-font)',
  fontSize: 'var(--tk-fs-sm)',
  minWidth: 0,
};

const styles: Record<string, React.CSSProperties> = {
  fieldset: {
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
    padding: '4px 12px 10px 12px',
    margin: 0,
  },
  legend: {
    padding: '0 6px',
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  legendBtn: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    padding: 0,
    textTransform: 'inherit',
    letterSpacing: 'inherit',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    paddingTop: 4,
  },
  error: {
    color: 'var(--tk-danger)',
    fontSize: 'var(--tk-fs-sm)',
  },
  editorForm: {
    background: 'var(--tk-bg)',
    borderLeft: '3px solid var(--tk-accent)',
    border: '2px solid var(--tk-border-soft)',
    borderLeftWidth: 3,
    borderRadius: 0,
    padding: '6px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  editorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
    gap: 6,
  },
  commentGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  input: { ...INPUT_BASE },
  inputShort: { ...INPUT_BASE, width: 90 },
  inputWide: { ...INPUT_BASE, gridColumn: '1 / -1' },
  textarea: {
    ...INPUT_BASE,
    padding: '6px 8px',
    fontFamily: 'var(--tk-font-mono)',
    resize: 'vertical',
  },
  scoreLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
  },
  slider: { flex: 1 },
  scoreReadout: {
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--tk-fg)',
    minWidth: 44,
    textAlign: 'right',
  },
  actionRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'end',
    marginTop: 2,
  },
  reasonInput: { ...INPUT_BASE, flex: 1 },
  saveBtn: {
    background: 'var(--tk-accent)',
    color: 'var(--tk-accent-fg)',
    border: '2px solid var(--tk-border)',
    borderRadius: 0,
    padding: '4px 12px',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 'var(--tk-fw-bold)' as unknown as number,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
    marginLeft: 'auto',
  },
  deleteBtn: {
    background: 'transparent',
    color: 'var(--tk-danger)',
    border: '2px solid var(--tk-danger)',
    borderRadius: 0,
    padding: '4px 10px',
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 'var(--tk-fw-bold)' as unknown as number,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    cursor: 'pointer',
  },
  directionStrip: {
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    padding: '6px 8px',
    background: 'var(--tk-surface)',
    border: '2px solid var(--tk-border-soft)',
    borderRadius: 0,
  },
  urlRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  staticUrlRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    padding: '2px 0',
    flexWrap: 'wrap',
  },
  staticUrlText: {
    fontFamily: 'var(--tk-font-mono)',
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-fg)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '60ch',
  },
  urlInput: { ...INPUT_BASE, flex: 1 },
  openLink: {
    fontFamily: 'var(--tk-font)',
    fontSize: 'var(--tk-fs-sm)',
    fontWeight: 'var(--tk-fw-bold)' as unknown as number,
    color: 'var(--tk-fg)',
    textDecoration: 'underline',
    whiteSpace: 'nowrap',
  },
  contextInline: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    padding: '4px 8px',
    background: 'var(--tk-surface)',
    borderLeft: '2px solid var(--tk-border-soft)',
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    lineHeight: 1.4,
  },
  contextLine: {
    display: 'inline',
  },
  contextLineMuted: {
    color: 'var(--tk-muted)',
    fontStyle: 'italic',
  },
  contextLineErr: {
    color: 'var(--tk-danger)',
  },
  refsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'baseline',
    padding: '4px 8px',
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    borderLeft: '2px solid var(--tk-border-soft)',
  },
  refsKey: {
    color: 'var(--tk-muted)',
    fontSize: 'var(--tk-fs-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  refsAction: {
    flex: '1 1 200px',
  },
  staticHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'baseline',
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    padding: '2px 8px',
    background: 'transparent',
    borderLeft: '2px solid var(--tk-accent)',
    lineHeight: 1.4,
  },
  staticItem: {
    whiteSpace: 'nowrap',
  },
  staticKey: {
    color: 'var(--tk-muted)',
    fontSize: 'var(--tk-fs-xs)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginRight: 3,
  },
  staticDivider: {
    color: 'var(--tk-muted)',
    opacity: 0.5,
  },
  editableGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(80px, 8ch) minmax(180px, 24ch) minmax(200px, 1fr)',
    gap: 8,
    rowGap: 4,
    alignItems: 'end',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    minWidth: 0,
  },
  fieldLabelText: {
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  // AC-52.61 — single-line edit row (Weight | Direction | URL | rationale | change-notes).
  editRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'flex-end',
  },
  // AC-52.61 — flex sizing for the label CELL, not the input. Putting flex
  // on the input itself made it stretch vertically (the label's column-flex
  // direction inherited the flex grow). This wraps the label so it's the
  // flex item in editRow, sized 1fr-ish with a 60ch max.
  editRowFlexCell: {
    flex: '1 1 180px',
    minWidth: 120,
    maxWidth: '60ch',
  },
  // The input fills its label cell — single line, normal height.
  editRowInput: {
    ...INPUT_BASE,
    width: '100%',
    boxSizing: 'border-box',
  },
  // AC-52.68 — flashed when Save was clicked with empty change-notes.
  // Applied for ~800ms via React state, then peeled off.
  editRowInputFlash: {
    border: '2px solid var(--tk-danger)',
    background: 'rgba(185, 28, 28, 0.06)',
    animation: 'tk-flash 0.8s ease-out',
  },
  weightReasonInput: { ...INPUT_BASE, maxWidth: '60ch', width: '100%', boxSizing: 'border-box' },
  changeNotesInput: { ...INPUT_BASE, flex: 1, maxWidth: '60ch', width: '100%', boxSizing: 'border-box' },
  // AC-52.34 — single-line stackable Add strip: tight labeled inputs sized to content.
  addStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    rowGap: 4,
    alignItems: 'end',
  },
  inputTiny: { ...INPUT_BASE, width: 70 },
  inputDate: { ...INPUT_BASE, width: 110 },
  inputKind: { ...INPUT_BASE, width: 130 },
  inputChamber: { ...INPUT_BASE, width: 90 },
  inputDirection: { ...INPUT_BASE, width: 70 },
  inputDirectionWide: { ...INPUT_BASE, minWidth: 160 },
  contributionReadout: {
    alignSelf: 'center',
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-fg)',
    fontVariantNumeric: 'tabular-nums',
  },
  commentControls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'flex-end',
  },
  contributionReadoutLg: {
    marginLeft: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    fontVariantNumeric: 'tabular-nums',
  },
  contributionLabel: {
    fontSize: 'var(--tk-fs-xs)',
    color: 'var(--tk-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  contributionValue: {
    fontSize: 'var(--tk-fs-xl)',
    fontWeight: 'var(--tk-fw-black)' as unknown as number,
    color: 'var(--tk-fg)',
    lineHeight: 1.1,
  },
  importHint: {
    fontSize: 'var(--tk-fs-sm)',
    color: 'var(--tk-muted)',
    fontStyle: 'italic',
    padding: '6px 8px',
    borderLeft: '2px solid var(--tk-border-soft)',
    marginTop: 4,
  },
};
