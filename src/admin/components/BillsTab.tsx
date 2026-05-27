/**
 * Bills CRUD tab. FR-52 + FR-49.
 *
 * AC-52.12 — bill_id is auto-derived from congress / type / number and
 *           rendered read-only.
 * AC-52.13 — title / label labels reflect editorial intent.
 * AC-52.15 — fields render in semantic groups (identity / naming / classification / external).
 * AC-52.16 — inline Roll-call votes / Comments sections beneath the editor,
 *           filtered by the currently-edited bill_id.
 * AC-52.17 — Congress.gov URL renders with an "↗ Open" external link.
 */
import { useState } from 'react';
import { ResourceTab, type FieldSchema } from './ResourceTab';
import type { BillRow } from '../types';
import { BillVotesSection, BillCommentsSection } from './BillInlineSections';
import { BillImportPanel } from './BillImportPanel';
import { BillStatePills, BillSummaryDisclosure, BillLastActionInline } from './BillContextSections';
import { BillSponsorshipSection, BillActionsSection } from './BillSponsorshipSections';

/** Pure derive — same shape as `billKey()` in scripts/seed-d1-from-json.ts. */
function deriveBillId(row: Partial<BillRow>): string {
  const congress = row.congress ?? '';
  const type = (row.type ?? '').toString().toUpperCase();
  const number = row.number ?? '';
  return `${congress}-${type}-${number}`;
}

const schema: FieldSchema<BillRow>[] = [
  // ─── identity ──────────────────────────────────────────────────────────
  // AC-52.36 + UI-fix — all four on one flex row; help slug sits under Bill ID
  // only (the other three keep an empty placeholder so labels line up).
  {
    group: 'Identity',
    key: 'bill_id',
    label: 'Bill ID',
    kind: 'text',
    width: 'long',
    required: true,
    help: 'Auto-derived from Congress + Type + Number alongside.',
  },
  { group: 'Identity', key: 'congress', label: 'Congress', kind: 'number', width: 'short', required: true },
  { group: 'Identity', key: 'type', label: 'Type', kind: 'text', width: 'short', required: true,
    help: 'HR / S / HJRES / SJRES / …' },
  { group: 'Identity', key: 'number', label: 'Number', kind: 'text', width: 'short', required: true },

  // ─── naming ────────────────────────────────────────────────────────────
  // AC-52.31 — `long` (60ch cap) replaces `full` for free-prose fields.
  // Both fields full-width-stacked: a single-line title above a short
  // textarea reads as one column instead of two unequal-height boxes.
  // AC-52.57 — researcher-curated short blurb shown in the list and embed.
  { group: 'Naming', key: 'display_title', label: 'Display title (short blurb for the list)',
    kind: 'text', width: 'full',
    placeholder: 'e.g. "$95B Supp. Apr 2024 $61B+REPO" — falls back to official title if empty' },
  { group: 'Naming', key: 'title', label: 'Official title (from Congress.gov)',
    kind: 'text', width: 'full', required: true },
  { group: 'Naming', key: 'label', label: 'Curator description / what this bill does',
    kind: 'textarea', width: 'full' },

  // ─── classification ────────────────────────────────────────────────────
  // AC-52.36 — single inline row: Direction, Featured, Became law, rationale.
  // AC-52.37 — display labels Pro / Neutral / Anti (wire values unchanged).
  {
    group: 'Classification',
    key: 'direction',
    label: 'Direction',
    kind: 'select',
    width: 'medium',
    required: true,
    options: [
      { value: 'pro-ukraine', label: 'Pro' },
      { value: 'ambiguous', label: 'Neutral' },
      { value: 'anti-ukraine', label: 'Anti' },
    ],
  },
  { group: 'Classification', key: 'featured', label: 'Featured', kind: 'checkbox', width: 'short' },
  { group: 'Classification', key: 'became_law', label: 'Became law', kind: 'checkbox', width: 'short' },
  { group: 'Classification', key: 'direction_reason',
    label: 'Direction rationale', kind: 'text', width: 'long',
    placeholder: 'Why this bill is pro/anti — visible to other researchers' },

  // ─── external metadata — read-only, sourced from Congress.gov ──────────
  { group: 'External', key: 'congress_gov_url', label: 'Congress.gov URL', kind: 'static-url', width: 'full' },
  { group: 'External', key: 'latest_action_date', label: 'Latest action date', kind: 'static-text', width: 'medium' },
  { group: 'External', key: 'latest_action', label: 'Latest action', kind: 'static-text', width: 'long' },
];

export function BillsTab() {
  // AC-52.46 — `+ New` opens BillImportPanel; the panel posts to
  // /api/admin/import-bill and returns the new bill_id, which the
  // ResourceTab uses to select the freshly-imported row.
  const [pendingResolve, setPendingResolve] = useState<((v: string | null) => void) | null>(null);
  const onNewClick = () =>
    new Promise<string | null>((resolve) => {
      setPendingResolve(() => resolve);
    });

  return (
    <>
      {pendingResolve && (
        <BillImportPanel
          onResolve={(billId) => {
            const r = pendingResolve;
            setPendingResolve(null);
            r(billId);
          }}
        />
      )}
    <ResourceTab<BillRow>
      resource="bills"
      schema={schema}
      listLabel={(b) =>
        `${b.bill_id} — ${(b.display_title ?? b.title ?? '').slice(0, 60)}`
      }
      blank={() => ({
        bill_id: '',
        congress: 119,
        type: 'HR',
        number: '',
        title: '',
        direction: 'pro-ukraine',
        featured: 0,
        became_law: 0,
      })}
      derive={(row) => ({ bill_id: deriveBillId(row) }) as Partial<BillRow>}
      // AC-52.32 — Identity + naming fields come from Congress.gov and are
      // immutable on existing rows. Researchers annotate (direction, label,
      // featured, …) but never override the upstream facts (title, congress,
      // type, number, bill_id).
      isReadOnly={(key, isNew) => {
        if (key === 'bill_id') return true; // always derived
        if (!isNew && (key === 'congress' || key === 'type' || key === 'number' || key === 'title')) {
          return true;
        }
        return false;
      }}
      renderBelow={(editing) => {
        const billId = editing.bill_id ?? '';
        if (!billId || billId.endsWith('-')) return null;
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <BillStatePills bill={editing} />
              <BillLastActionInline bill={editing} />
            </div>
            <BillSponsorshipSection billId={billId} bill={editing} />
            {editing.congress && editing.type && editing.number && (
              <BillSummaryDisclosure
                congress={editing.congress as number}
                type={editing.type as string}
                number={editing.number as string}
                congressGovUrl={editing.congress_gov_url ?? null}
              />
            )}
            <BillActionsSection billId={billId} />
            <BillVotesSection billId={billId} billDirection={editing.direction} />
            <BillCommentsSection billId={billId} />
          </>
        );
      }}
      onNewClick={onNewClick}
      matchBusinessKey={(row, key) => row.bill_id === key}
    />
    </>
  );
}
