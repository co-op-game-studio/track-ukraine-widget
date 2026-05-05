/**
 * Social Posts CRUD tab. FR-52 + FR-51 AC-51.5.
 *
 * Curated social posts attached to a representative; render in the embed's
 * Statements tab.
 */
import { ResourceTab, type FieldSchema } from './ResourceTab';
import type { SocialPostRow } from '../types';

const schema: FieldSchema<SocialPostRow>[] = [
  // ─── target ────────────────────────────────────────────────────────────
  { group: 'Target', key: 'bioguide_id', label: 'Bioguide ID', kind: 'text', width: 'medium', required: true,
    help: 'e.g. D000563 — must be a current rep, but no FK enforcement at the row level.' },
  {
    group: 'Target',
    key: 'platform',
    label: 'Platform',
    kind: 'select',
    width: 'medium',
    required: true,
    options: [
      { value: 'x', label: 'X / Twitter' },
      { value: 'facebook', label: 'Facebook' },
      { value: 'youtube', label: 'YouTube' },
      { value: 'instagram', label: 'Instagram' },
      { value: 'other', label: 'Other' },
    ],
  },

  // ─── source ────────────────────────────────────────────────────────────
  { group: 'Source', key: 'url', label: 'Post URL', kind: 'url', width: 'full', required: true },
  { group: 'Source', key: 'posted_at', label: 'Posted at (ISO-8601)', kind: 'text', width: 'medium' },

  // ─── content ───────────────────────────────────────────────────────────
  { group: 'Content', key: 'body_text', label: 'Post text', kind: 'textarea', width: 'long', required: true },
  // AC-52.41 — weight + direction.
  {
    group: 'Content', key: 'weight', label: 'Weight', kind: 'number',
    width: 'short', min: 0, max: 5, step: 0.05,
    help: '0–5. Score contribution magnitude (matches vote weight).',
  },
  {
    group: 'Content', key: 'direction', label: 'Direction', kind: 'select',
    width: 'medium',
    options: [
      { value: 1, label: '+1 pro-Ukraine' },
      { value: 0, label: '0 unstated' },
      { value: -1, label: '-1 anti-Ukraine' },
    ],
  },
  { group: 'Content', key: 'comment', label: 'Researcher note (visible in embed)', kind: 'textarea', width: 'long' },
];

export function SocialPostsTab() {
  return (
    <ResourceTab<SocialPostRow>
      resource="social-posts"
      schema={schema}
      listLabel={(p) => `${p.bioguide_id} · ${p.platform} · ${p.body_text.slice(0, 60)}`}
      blank={() => ({
        bioguide_id: '',
        platform: 'x',
        url: '',
        posted_at: null,
        body_text: '',
        weight: 0,
        direction: 0,
        comment: null,
      })}
    />
  );
}
