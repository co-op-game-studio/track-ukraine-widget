/**
 * useMediaQuery — subscribe to a CSS media query and re-render on change.
 *
 * The admin SPA styles inline (no stylesheet, no @media blocks), so responsive
 * layout decisions are made in JS. This hook mirrors the matchMedia pattern in
 * useTheme.ts. SSR-safe: returns `false` when `window`/`matchMedia` is absent.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
