/**
 * useRepStatements — fetch curated social posts for a representative.
 * Consumed by the Statements tab (FR-53 AC-53.2).
 *
 * 404 → empty list (AC-53.5). Other errors are also treated as empty;
 * the hook never bricks the embed on missing publish data.
 *
 * Traces to FR-51 AC-51.5, FR-53 AC-53.2.
 */
import { useEffect, useState } from 'react';
import { fetchRepBundle } from '../services/repBundle';

export interface SocialPost {
  id: string;
  platform: string;
  url: string;
  postedAt: string | null;
  bodyText: string;
  /** AC-52.43 — replaces legacy `scoreAdjustment ∈ [-1,+1]`. */
  weight: number;
  direction: number;
  comment: string | null;
  authorEmail: string;
  createdAt: string;
}

export interface SocialPostsRecord {
  bioguideId: string;
  posts: SocialPost[];
  generatedAt: string;
  schemaVersion: number;
}

export interface UseRepStatementsResult {
  posts: SocialPost[];
  status: 'idle' | 'loading' | 'success' | 'empty' | 'error';
}

export function useRepStatements(
  bioguideId: string | null,
  apiBase: string,
): UseRepStatementsResult {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [status, setStatus] = useState<UseRepStatementsResult['status']>('idle');

  useEffect(() => {
    if (!bioguideId) {
      setPosts([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetchRepBundle(apiBase, bioguideId)
      .then((bundle) => {
        if (cancelled) return;
        const record = bundle?.socialPosts as SocialPostsRecord | null;
        const posts = record?.posts ?? [];
        setPosts(posts);
        setStatus(posts.length > 0 ? 'success' : 'empty');
      })
      .catch(() => {
        if (cancelled) return;
        setPosts([]);
        setStatus('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [bioguideId, apiBase]);

  return { posts, status };
}
