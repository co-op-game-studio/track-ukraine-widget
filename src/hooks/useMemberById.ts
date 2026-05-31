/**
 * useMemberById — fetch a single member profile by bioguide and project it
 * into a domain `Representative`, for the FR-60 direct-to-member deep link.
 *
 * The embed/admin profile preview mounts the widget with a `bioguide`
 * attribute; this hook turns that id into the seed `Representative` that
 * `RepDetail` enriches and renders — with no address lookup and no
 * name-search round-trip.
 *
 * Traces to: FR-60 AC-60.3, AC-60.4, AC-60.5.
 */
import { useEffect, useRef, useState } from 'react';
import type { Representative } from '../types/domain';
import { sanitizeUrl } from '../utils/sanitizeUrl';
import { stateNameToCode } from '../utils/fipsMap';

/** Canonical bioguide shape: one uppercase letter + six digits. */
const BIOGUIDE_RE = /^[A-Z][0-9]{6}$/;

export type MemberByIdStatus = 'idle' | 'loading' | 'success' | 'notfound' | 'error';

export interface UseMemberByIdResult {
  representative: Representative | null;
  status: MemberByIdStatus;
}

/** Shape returned by `/api/members/{bioguideId}` — see
 *  proxy/routes/api-members.ts `buildProfileFromUpstream`. Only the fields
 *  needed to seed a `Representative` are typed here. */
export interface MemberProfileResponse {
  bioguideId: string;
  first?: string;
  last?: string;
  officialName?: string;
  state?: string;
  district?: number | null;
  chamber?: 'House' | 'Senate';
  party?: string;
  photoUrl?: string | null;
  website?: string | null;
  yearEntered?: number;
}

function expandParty(p: string | undefined): string {
  if (p === 'D') return 'Democratic';
  if (p === 'R') return 'Republican';
  if (p === 'I') return 'Independent';
  return p ?? '';
}

/**
 * Normalize a state to the two-letter code. `/api/members/{id}` returns the
 * full Congress.gov state name (e.g. "Illinois"), but the Senate roster match
 * in useVotingRecord compares against the two-letter code carried on the cast
 * (e.g. "IL"). Without this, every Senator's votes silently fail to match.
 * Already-two-letter input passes through unchanged.
 */
function normalizeState(state: string | undefined): string {
  if (!state) return '';
  if (state.length === 2) return state.toUpperCase();
  return stateNameToCode(state) ?? state;
}

/** Exported for unit testing the projection (notably state normalization,
 *  FR-60 AC-60.3). */
export function profileToRepresentative(p: MemberProfileResponse): Representative {
  return {
    bioguideId: p.bioguideId,
    // "Last, First" — the canonical Congress.gov form. useVotingRecord parses
    // this for Senate roster matching (last+state); RepDetail renders it.
    name: `${p.last ?? ''}, ${p.first ?? ''}`.replace(/^, |, $/g, '').trim() || (p.officialName ?? p.bioguideId),
    party: expandParty(p.party),
    partyAbbreviation: p.party ?? '',
    state: normalizeState(p.state),
    district: p.district ?? null,
    chamber: (p.chamber ?? 'House').toLowerCase() as 'house' | 'senate',
    photoUrl: sanitizeUrl(p.photoUrl),
    isNonVoting: false,
    officialWebsiteUrl: sanitizeUrl(p.website),
    yearEntered: p.yearEntered,
  };
}

/**
 * Resolve `bioguide` → `Representative`. Returns `{ representative: null }`
 * for an absent/invalid id (idle) and on 404 / error (graceful degrade —
 * the caller falls back to the ordinary entry screen). A fetch in flight
 * for a superseded bioguide is ignored so a stale response can't overwrite
 * a newer selection (AC-60.4).
 */
export function useMemberById(bioguide: string | undefined, apiBase: string): UseMemberByIdResult {
  const [representative, setRepresentative] = useState<Representative | null>(null);
  const [status, setStatus] = useState<MemberByIdStatus>('idle');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();

    if (!bioguide || !BIOGUIDE_RE.test(bioguide)) {
      setRepresentative(null);
      setStatus('idle');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    setRepresentative(null);

    const base = apiBase.replace(/\/+$/, '');
    fetch(`${base}/api/members/${encodeURIComponent(bioguide)}`, { signal: controller.signal })
      .then(async (res) => {
        if (controller.signal.aborted) return;
        if (res.status === 404) {
          setStatus('notfound');
          return;
        }
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const profile = (await res.json()) as MemberProfileResponse;
        if (controller.signal.aborted) return;
        setRepresentative(profileToRepresentative(profile));
        setStatus('success');
      })
      .catch((e) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setStatus('error');
      });

    return () => controller.abort();
  }, [bioguide, apiBase]);

  return { representative, status };
}
