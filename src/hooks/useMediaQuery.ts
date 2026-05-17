/**
 * useMediaQuery
 *
 * Subscribes a React component to a CSS media query and re-renders when
 * the match state changes. The most common use is for layout-level
 * branching:
 *
 *     const isMobile = useMediaQuery('(max-width: 640px)');
 *     return isMobile ? <MobileLayout /> : <DesktopLayout />;
 *
 * SSR-safe: the first render returns `false` when `window` is undefined
 * (e.g. during static generation). The hook then settles on the real
 * value during hydration via the effect. For client-only apps like ours
 * this means the initial render on a mobile device briefly assumes
 * desktop — but the effect runs synchronously after mount, so the
 * transition is invisible in practice.
 *
 * Returns the live match state. Updates are batched through React, so
 * a sequence of rapid media-query flips (e.g. devtools dragging the
 * viewport edge) only renders the consumer once per resolved state.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mediaQueryList = window.matchMedia(query);
    // Set the initial value defensively — between useState init and
    // useEffect mount, the viewport might have changed (unlikely but
    // possible in fast resize). Reading once on mount also covers SSR
    // where the initial value was forced to false.
    setMatches(mediaQueryList.matches);
    function handleChange(event: MediaQueryListEvent) {
      setMatches(event.matches);
    }
    // addEventListener over the deprecated addListener — modern API
    // since Safari 14 / Chrome 39, well within our target range.
    mediaQueryList.addEventListener('change', handleChange);
    return () => mediaQueryList.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

/**
 * Convenience wrapper: matches when the viewport is narrow enough to
 * use the mobile layout. The breakpoint matches the `@media` rule in
 * mobile.css so layout TS-side and CSS-side stay in lockstep.
 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 640px)');
}
