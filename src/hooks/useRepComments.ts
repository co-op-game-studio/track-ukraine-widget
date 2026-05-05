/**
 * useRepComments — fetch researcher comments for a set of bills (the bills
 * that appear in the rep's voting record + sponsored/cosponsored lists).
 *
 * Used by VoteList to render the inline expand affordance per AC-53.1.
 * 404 from the read route is treated as "no comments for this bill" — never
 * an error banner per AC-53.5.
 *
 * Traces to FR-51 AC-51.4, FR-53 AC-53.1, AC-53.5.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResearcherComment {
  id: string;
  bodyMarkdown: string;
  /** AC-52.43 — replaced legacy `scoreAdjustment ∈ [-1,+1]`. */
  weight: number;
  direction: number;
  attachedToRollCallId: string | null;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRecord {
  billId: string;
  comments: ResearcherComment[];
  generatedAt: string;
  schemaVersion: number;
}

export type CommentsByBill = Map<string, ResearcherComment[]>;

export interface UseRepCommentsResult {
  /** Map of bill_id → comments. Empty map until loads complete. */
  commentsByBill: CommentsByBill;
  /** Has at least one bill's fetch completed (success or 404). */
  ready: boolean;
}

/**
 * Build the `attached_to_roll_call_id` key VoteList uses to match a comment
 * to a specific row. Format: `{chamber}:{congress}:{session}:{rollCall}`.
 */
export function rollCallKey(
  chamber: string,
  congress: number,
  session: number,
  rollCall: number,
): string {
  return `${chamber.toLowerCase()}:${congress}:${session}:${rollCall}`;
}

/**
 * Fan out one fetch per billId. 404 → empty list (no comments). Anything
 * else (network error, 5xx) is logged and treated as empty so the embed
 * never bricks on a missing publish-pipeline run.
 */
export function useRepComments(
  billIds: readonly string[],
  apiBase: string,
): UseRepCommentsResult {
  const [commentsByBill, setComments] = useState<CommentsByBill>(new Map());
  const [ready, setReady] = useState(false);
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    if (billIds.length === 0) {
      setComments(new Map());
      setReady(true);
      return;
    }
    const thisReq = ++reqIdRef.current;
    setReady(false);
    const base = apiBase.replace(/\/+$/, '');
    const next = new Map<string, ResearcherComment[]>();
    await Promise.all(
      billIds.map(async (billId) => {
        try {
          const res = await fetch(`${base}/api/comments/${encodeURIComponent(billId)}`);
          if (res.status === 404) {
            next.set(billId, []);
            return;
          }
          if (!res.ok) {
            // 4xx/5xx other than 404 — treat as empty per AC-53.5.
            next.set(billId, []);
            return;
          }
          const json = (await res.json()) as CommentRecord;
          next.set(billId, json.comments ?? []);
        } catch {
          next.set(billId, []);
        }
      }),
    );
    if (thisReq !== reqIdRef.current) return;
    setComments(next);
    setReady(true);
  }, [billIds, apiBase]);

  // Re-load when the bill set changes. We compare via a stable string so
  // a parent passing a new array reference each render doesn't churn.
  const billIdsKey = billIds.slice().sort().join('|');
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billIdsKey, apiBase]);

  return { commentsByBill, ready };
}

/**
 * Match a row to its eligible comments: bill_id matches AND the comment is
 * either un-scoped (`attached_to_roll_call_id === null`) or scoped to the
 * exact roll call.
 */
export function commentsForRow(
  commentsByBill: CommentsByBill,
  billId: string,
  rollCallId: string,
): ResearcherComment[] {
  const all = commentsByBill.get(billId);
  if (!all || all.length === 0) return [];
  return all.filter(
    (c) => c.attachedToRollCallId === null || c.attachedToRollCallId === rollCallId,
  );
}
