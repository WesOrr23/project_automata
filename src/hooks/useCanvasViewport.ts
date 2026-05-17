/**
 * useCanvasViewport
 *
 * Owns the canvas zoom + pan state for the AutomatonCanvas SVG. The hook
 * exposes:
 *
 *  - A `transform` string suitable for an SVG `<g>` wrapping the canvas
 *    content (state nodes, edges, start arrow). The transform is
 *    `translate(panX, panY) scale(scale)` — translate-then-scale matches
 *    "anchor the world at the current pan offset, then zoom" semantics.
 *  - Pointer / wheel handlers to attach to the SVG element. Wheel does
 *    pan-by-delta (or zoom-toward-cursor when `ctrlKey` is set, which
 *    captures both Cmd+wheel and trackpad pinch). Drag does pan, but
 *    skips drags that originated on a state node or transition edge so
 *    those gestures stay free for clicks.
 *  - Programmatic `zoomIn`, `zoomOut`, `reset`, `fitToContent` controls
 *    for buttons / keyboard shortcuts. These keep the viewport center
 *    stable so the user doesn't lose their place when zooming.
 *
 * State shape is `{ scale, panX, panY }` — three plain numbers, fully
 * derivable from the wheel/pointer input stream. No imperative SVG
 * matrix manipulation; React owns the values, the SVG just renders them.
 *
 * Scale is clamped to [0.25, 4.0]. Pan is clamped via the
 * "centered slack" policy: when the scaled content is smaller than the
 * viewport on an axis, it's centered and pan-locked on that axis; when
 * larger, the content always covers the viewport (no edge can recede
 * past the corresponding viewport edge). See `clampViewport` for the
 * full policy.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4.0;
const ZOOM_STEP = 1.25;
const PAN_STEP = 10;
const PAN_STEP_LARGE = 50;
const FIT_PADDING = 40;
/** Padding used by the DISPLAY-percent reference (`fitScale`). Larger
 * than FIT_PADDING so 100% reads as a relaxed view rather than the
 * tight "fills the visible region" fit. Wes's calibration: what used
 * to display as ~70% in COLLAPSED should now display as 100%, which
 * lands around 180px of padding on each axis at typical viewport
 * sizes. The fit-to-view ACTION still uses FIT_PADDING + the visible
 * region — only the displayed number is rebased here. */
const DISPLAY_FIT_PADDING = 180;
/** Duration the `isAnimating` flag stays true after a button-driven
 * action, so the consumer can apply a CSS / Framer transition for the
 * resulting transform change. Wheel/pinch/drag are NOT button-driven —
 * they keep the flag false so each input sample renders instantly. */
const BUTTON_ANIMATION_MS = 300;

export type CanvasViewport = {
  scale: number;
  panX: number;
  panY: number;
};

const DEFAULT_VIEWPORT: CanvasViewport = { scale: 1, panX: 0, panY: 0 };

export type ViewportInset = {
  /** Pixels of overlay chrome covering the LEFT edge of the SVG (e.g.
   *  the tool menu's right edge). Centering math treats this region
   *  as not-visible: content is centered in (svgWidth - left - right). */
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const ZERO_INSET: ViewportInset = { left: 0, right: 0, top: 0, bottom: 0 };

export type UseCanvasViewportArgs = {
  /**
   * The natural-content size of the SVG (i.e. the un-zoomed bounding
   * box used by AutomatonCanvas's base viewBox). Needed for
   * `fitToContent` and pan clamping.
   */
  contentBoundingBox: { width: number; height: number } | null;
  /**
   * Where the content's TOP-LEFT sits in unscaled coordinates relative
   * to the transform origin (panX, panY). AutomatonCanvas wraps its
   * content in `<g transform="translate(-70 0)">` to make room for the
   * start arrow that extends LEFT of state q0; that means the visible
   * content's leftmost edge is at world x = -70, not 0. Centering math
   * needs to know this so 'centered' actually centers the visual
   * bounding box, not the unshifted origin. Defaults to {x:0, y:0}.
   */
  contentOrigin?: { x: number; y: number } | undefined;
  /**
   * The visible CSS-pixel size of the SVG element. Needed for
   * `fitToContent` and zoom-toward-center math.
   */
  viewportSize: { width: number; height: number } | null;
  /**
   * Optional: pixels of overlay chrome (tool menu, command bar, etc.)
   * that visually occlude part of the SVG. Centering operations
   * (initial-center, reset, fitToContent) target the user-visible
   * region — viewport minus inset — instead of the geometric SVG
   * center. Zoom-toward-cursor and pan-clamp continue to use the full
   * SVG box (those gestures want the cursor's true screen position).
   */
  viewportInset?: ViewportInset;
  /**
   * Extra unscaled-pixel space the FIT calculation should reserve
   * around the contentBoundingBox. The CENTERING math ignores this —
   * the bbox center stays the visual target. Used so the start arrow
   * (which extends 62px left of the cluster bbox) is guaranteed room
   * at fit-scale without dragging the centroid leftward. Defaults to
   * zero on every side.
   */
  contentReserve?: { left: number; right: number; top: number; bottom: number } | undefined;
};

export type UseCanvasViewportResult = {
  viewport: CanvasViewport;
  /** SVG transform string for the wrapping content `<g>`. */
  transform: string;
  handlers: {
    onWheel: (event: React.WheelEvent<SVGSVGElement>) => void;
    onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
  };
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  fitToContent: () => void;
  /**
   * Translate the FA so its bbox center aligns with the visible
   * region's center, WITHOUT changing scale. Drives the first stage
   * of the two-stage middle zoom button: when the FA is off-center,
   * one click recenters it; the next click (when isCentered becomes
   * true) fits to view.
   */
  centerToContent: () => void;
  /**
   * True when the current pan places the FA's bbox center at the
   * visible region's center (at the current scale). Used by the
   * middle zoom button to swap between the "recenter" and "fit"
   * affordances. Half-pixel tolerance — sub-pixel drift from
   * floating-point math shouldn't toggle the button.
   */
  isCentered: boolean;
  panBy: (deltaX: number, deltaY: number) => void;
  /** True when zoomIn is a no-op (already at MAX_SCALE). */
  atMaxScale: boolean;
  /** True when zoomOut is a no-op (already at MIN_SCALE). */
  atMinScale: boolean;
  /**
   * True for ~300ms after a button-driven action (zoomIn, zoomOut,
   * reset, fitToContent, or keyboard equivalents). Consumer should
   * apply a transform transition while this is true so the view eases
   * to its new state instead of snapping. Wheel/pinch/drag don't set
   * this — they're already smooth from the user's input cadence.
   */
  isAnimating: boolean;
  /**
   * The scale that displays as "100%" — a relaxed reference fit using
   * the full viewport (not the inset-adjusted visible region) and a
   * generous padding. Stable across tool-menu state changes since
   * `inset` is excluded; the displayed percent only moves when the
   * content or the actual viewport size changes. The fit-to-view
   * action lands at this same scale, so a Fit click always reads as
   * 100%. Null when sizes aren't yet measurable.
   */
  fitScale: number | null;
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Clamp viewport ("centroid in viewport" policy): the geometric center
 * of the scaled content's bounding box must stay within the visible
 * viewport. That gives the user:
 *
 *  - Generous freedom to pan (range = viewport size on each axis at
 *    any scale; predictable feel regardless of how zoomed).
 *  - A guarantee that the FA can't be lost: at minimum, the half of
 *    the bounding box opposite the pan direction is always visible.
 *  - Room to inspect corners at high zoom: content edges may extend
 *    arbitrarily beyond the viewport so long as the centroid stays in.
 *
 * Math: with scaledWidth W and viewport width V, the centroid x-pos
 * on screen is `panX + W/2`. Constraint `0 ≤ panX + W/2 ≤ V` gives
 * `panX ∈ [-W/2, V - W/2]`. Symmetric for Y.
 *
 * Returns the input unchanged when already in policy (caller can use
 * reference equality to skip re-renders).
 *
 * History: an earlier attempt ("centered slack") locked pan to center
 * whenever scaled content was smaller than viewport — which broke
 * drag-pan at default zoom for any small/medium FA. Centroid policy
 * fixes that while still preventing "where did it go" accidents.
 */
export function clampViewport(
  viewport: CanvasViewport,
  contentBoundingBox: { width: number; height: number } | null,
  viewportSize: { width: number; height: number } | null
): CanvasViewport {
  if (contentBoundingBox === null || viewportSize === null) return viewport;
  if (contentBoundingBox.width <= 0 || contentBoundingBox.height <= 0) return viewport;
  if (viewportSize.width <= 0 || viewportSize.height <= 0) return viewport;

  const { scale, panX, panY } = viewport;
  const halfScaledWidth = (contentBoundingBox.width * scale) / 2;
  const halfScaledHeight = (contentBoundingBox.height * scale) / 2;

  const minPanX = -halfScaledWidth;
  const maxPanX = viewportSize.width - halfScaledWidth;
  const minPanY = -halfScaledHeight;
  const maxPanY = viewportSize.height - halfScaledHeight;

  const nextPanX = clamp(panX, minPanX, maxPanX);
  const nextPanY = clamp(panY, minPanY, maxPanY);

  if (nextPanX === panX && nextPanY === panY) return viewport;
  return { scale, panX: nextPanX, panY: nextPanY };
}

export function useCanvasViewport(
  args: UseCanvasViewportArgs
): UseCanvasViewportResult {
  const { contentBoundingBox, viewportSize, viewportInset, contentOrigin, contentReserve } = args;
  const inset: ViewportInset = viewportInset ?? ZERO_INSET;
  const origin = contentOrigin ?? { x: 0, y: 0 };
  const reserve = contentReserve ?? { left: 0, right: 0, top: 0, bottom: 0 };
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_VIEWPORT);
  const [isAnimating, setIsAnimating] = useState(false);

  // Active pointers indexed by pointerId. With one entry → pan
  // (delta-based). With two entries → pinch-zoom + translation around the
  // gesture midpoint. Three or more entries are ignored beyond pan/pinch
  // semantics (we still track them so removing one doesn't cause a jump).
  //
  // Coordinates are stored in CSS pixels RELATIVE TO THE SVG element so
  // they line up with the zoom-anchor math used elsewhere in the hook
  // (which works in SVG-relative coordinates). Translation from
  // window-relative clientX/Y happens at the gesture boundary.
  type PointerSample = { x: number; y: number };
  const pointersRef = useRef<Map<number, PointerSample>>(new Map());

  // Refs for the latest sizes so callbacks captured by event listeners
  // always read fresh values without re-binding handlers every render.
  const contentBoxRef = useRef(contentBoundingBox);
  contentBoxRef.current = contentBoundingBox;
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const insetRef = useRef(inset);
  insetRef.current = inset;
  const originRef = useRef(origin);
  originRef.current = origin;
  const reserveRef = useRef(reserve);
  reserveRef.current = reserve;

  // Track whether we've performed the initial-center pass. Without
  // this, the very first render ships the user a content-at-top-left
  // viewport (because DEFAULT_VIEWPORT is panX/Y = 0). The first time
  // sizes are measurable, we shift to "scale 1, content centered" so
  // the page lands looking like a `1:1` reset rather than slammed
  // against the corner.
  const didInitialCenterRef = useRef(false);

  // Track the inset value from the previous render so we can detect
  // when overlay chrome (menu, command bar) has shifted, and slide the
  // pan to preserve the FA's RELATIVE position in the visible region.
  // Initialized below in the effect so the very first render doesn't
  // see a phantom "delta" against an empty default.
  const prevInsetRef = useRef<ViewportInset | null>(null);

  // Mutable timer ref so successive button presses extend (rather than
  // stack) the animation window.
  const animationTimerRef = useRef<number | null>(null);
  const triggerAnimation = useCallback(() => {
    setIsAnimating(true);
    if (animationTimerRef.current !== null) {
      window.clearTimeout(animationTimerRef.current);
    }
    animationTimerRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      animationTimerRef.current = null;
    }, BUTTON_ANIMATION_MS);
  }, []);
  // Clean up on unmount so the timer doesn't try to setState on a dead
  // component.
  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  // Center content within the user-VISIBLE region (SVG box minus the
  // overlay chrome inset), not the geometric SVG center. With the menu
  // floating over the left edge, geometric center = "behind the menu";
  // the user expects "centered" to mean centered in what they can see.
  //
  // `origin` accounts for an inner SVG transform (e.g.
  // `translate(-70 0)` for the start-arrow reserve): the visible
  // content's left edge sits at `panX + origin.x * scale` rather than
  // at panX, so we subtract that offset before centering.
  function centerInVisibleRegion(
    content: { width: number; height: number },
    view: { width: number; height: number },
    insetArg: ViewportInset,
    originArg: { x: number; y: number },
    scale: number
  ): { panX: number; panY: number } {
    const visibleW = Math.max(view.width - insetArg.left - insetArg.right, 1);
    const visibleH = Math.max(view.height - insetArg.top - insetArg.bottom, 1);
    const scaledW = content.width * scale;
    const scaledH = content.height * scale;
    return {
      panX: insetArg.left + (visibleW - scaledW) / 2 - originArg.x * scale,
      panY: insetArg.top + (visibleH - scaledH) / 2 - originArg.y * scale,
    };
  }

  // First time both sizes are measurable, FIT the content into the
  // visible region. Runs at most once — after this initial fit the
  // user owns the viewport state. This makes the app launch at "100%"
  // (= fit-scale, per the redefined zoom semantics) regardless of the
  // FA's natural pixel size.
  useEffect(() => {
    if (didInitialCenterRef.current) return;
    if (contentBoundingBox === null || viewportSize === null) return;
    if (
      contentBoundingBox.width <= 0 ||
      contentBoundingBox.height <= 0 ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0
    ) {
      return;
    }
    didInitialCenterRef.current = true;
    // Initial scale uses the DISPLAY fit reference (full viewport +
    // DISPLAY_FIT_PADDING) so the app launches at exactly "100%" on
    // the displayed scale chip, not at the tighter visible-region
    // fit. Centering still uses the visible region (so the FA isn't
    // sliding behind the menu).
    const availableW = Math.max(viewportSize.width - DISPLAY_FIT_PADDING * 2, 1);
    const availableH = Math.max(viewportSize.height - DISPLAY_FIT_PADDING * 2, 1);
    const fitW = contentBoundingBox.width + reserve.left + reserve.right;
    const fitH = contentBoundingBox.height + reserve.top + reserve.bottom;
    const initialScale = clamp(
      Math.min(availableW / fitW, availableH / fitH),
      MIN_SCALE,
      MAX_SCALE
    );
    const { panX, panY } = centerInVisibleRegion(contentBoundingBox, viewportSize, inset, origin, initialScale);
    setViewport({ scale: initialScale, panX, panY });
    prevInsetRef.current = inset;
  // Initial-center should only depend on FIRST availability of sizes.
  // Inset changes after initial-center are handled by the inset-shift
  // effect below (which preserves the FA's relative position rather
  // than re-centering it from scratch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentBoundingBox, viewportSize]);

  // Whenever the visible region shifts (overlay chrome resizes — menu
  // expanded/collapsed/opened, command bar grew, etc.), slide the pan
  // by the same delta to PRESERVE the FA's relative position in the
  // visible region. If after the shift the FA would extend past the
  // new visible region (i.e. menu now obstructs part of the FA), we
  // additionally re-fit so auto operations NEVER hand back an
  // obstructed canvas. User-initiated pans and zooms remain free.
  //
  // The pan shift is instant (state set), but canvas-content-animating
  // is triggered for ~300ms so the transform interpolates and stays
  // roughly synced with the menu's CSS animation.
  useEffect(() => {
    if (prevInsetRef.current === null) {
      prevInsetRef.current = inset;
      return;
    }
    const prev = prevInsetRef.current;
    const dx = inset.left - prev.left;
    const dy = inset.top - prev.top;
    const dxRight = inset.right - prev.right;
    const dyBottom = inset.bottom - prev.bottom;
    if (dx === 0 && dy === 0 && dxRight === 0 && dyBottom === 0) return;
    prevInsetRef.current = inset;
    triggerAnimation();
    setViewport((current) => {
      const content = contentBoxRef.current;
      const view = viewportSizeRef.current;
      if (!content || !view) return current;

      // Step 1: shift pan by the change in visible-region center.
      // Δcenter_x = (Δleft - Δright) / 2 (see derivation above).
      const centerShiftX = (dx - dxRight) / 2;
      const centerShiftY = (dy - dyBottom) / 2;
      const shifted: CanvasViewport = {
        scale: current.scale,
        panX: current.panX + centerShiftX,
        panY: current.panY + centerShiftY,
      };

      // Step 2: would the FA fit in the new visible region at the
      // current scale? If yes, ship the shifted viewport. If no,
      // auto-fit (scale down + recenter). "Fit" here matches
      // fitToContent's math.
      const visibleW = Math.max(view.width - inset.left - inset.right, 1);
      const visibleH = Math.max(view.height - inset.top - inset.bottom, 1);
      const scaledW = content.width * shifted.scale;
      const scaledH = content.height * shifted.scale;
      if (scaledW <= visibleW && scaledH <= visibleH) {
        return clampViewport(shifted, content, view);
      }

      // Auto-fit: pick a scale where the FA fits with FIT_PADDING
      // breathing room, then center it in the visible region. The
      // fit dimensions include contentReserve so the start arrow has
      // room (it's not part of the centering bbox).
      const availableW = Math.max(visibleW - FIT_PADDING * 2, 1);
      const availableH = Math.max(visibleH - FIT_PADDING * 2, 1);
      const r = reserveRef.current;
      const fitW = content.width + r.left + r.right;
      const fitH = content.height + r.top + r.bottom;
      const targetScale = clamp(
        Math.min(availableW / fitW, availableH / fitH),
        MIN_SCALE,
        MAX_SCALE
      );
      const fitted = centerInVisibleRegion(content, view, inset, originRef.current, targetScale);
      return { scale: targetScale, panX: fitted.panX, panY: fitted.panY };
    });
  }, [inset, triggerAnimation]);

  const panBy = useCallback((deltaX: number, deltaY: number) => {
    setViewport((current) => {
      const requested: CanvasViewport = {
        scale: current.scale,
        panX: current.panX + deltaX,
        panY: current.panY + deltaY,
      };
      const clamped = clampViewport(
        requested,
        contentBoxRef.current,
        viewportSizeRef.current
      );
      if (clamped.panX === current.panX && clamped.panY === current.panY) {
        return current;
      }
      return clamped;
    });
  }, []);

  // Zoom anchor = visible region center. Anchoring at the SVG's
  // geometric center would put the anchor *behind the menu* on the
  // left, dragging the FA right when zooming. Anchoring at the
  // visible region's center means: if the FA is already centered
  // (its bbox center sits at the visible center), zoom is a pure
  // scale change with no translation drift.
  function visibleCenterAnchor(): { x: number; y: number } {
    const size = viewportSizeRef.current;
    const i = insetRef.current;
    if (!size) return { x: 0, y: 0 };
    return {
      x: i.left + (size.width - i.left - i.right) / 2,
      y: i.top + (size.height - i.top - i.bottom) / 2,
    };
  }

  const zoomIn = useCallback(() => {
    triggerAnimation();
    const { x: anchorX, y: anchorY } = visibleCenterAnchor();
    setViewport((current) => {
      const newScale = clamp(current.scale * ZOOM_STEP, MIN_SCALE, MAX_SCALE);
      if (newScale === current.scale) return current;
      const worldX = (anchorX - current.panX) / current.scale;
      const worldY = (anchorY - current.panY) / current.scale;
      const newPanX = anchorX - worldX * newScale;
      const newPanY = anchorY - worldY * newScale;
      return clampViewport(
        { scale: newScale, panX: newPanX, panY: newPanY },
        contentBoxRef.current,
        viewportSizeRef.current
      );
    });
  }, [triggerAnimation]);

  const zoomOut = useCallback(() => {
    triggerAnimation();
    const { x: anchorX, y: anchorY } = visibleCenterAnchor();
    setViewport((current) => {
      const newScale = clamp(current.scale / ZOOM_STEP, MIN_SCALE, MAX_SCALE);
      if (newScale === current.scale) return current;
      const worldX = (anchorX - current.panX) / current.scale;
      const worldY = (anchorY - current.panY) / current.scale;
      const newPanX = anchorX - worldX * newScale;
      const newPanY = anchorY - worldY * newScale;
      return clampViewport(
        { scale: newScale, panX: newPanX, panY: newPanY },
        contentBoxRef.current,
        viewportSizeRef.current
      );
    });
  }, [triggerAnimation]);

  const reset = useCallback(() => {
    triggerAnimation();
    // "1:1" semantically means "100% scale, content where it should
    // be" — centered in the visible region. Same centering as
    // fitToContent, just without the scale-to-fit step.
    const content = contentBoxRef.current;
    const view = viewportSizeRef.current;
    if (content === null || view === null) {
      setViewport(DEFAULT_VIEWPORT);
      return;
    }
    const { panX, panY } = centerInVisibleRegion(content, view, insetRef.current, originRef.current, 1);
    setViewport({ scale: 1, panX, panY });
  }, [triggerAnimation]);

  /**
   * Fit the content bounding box inside the visible region with a small
   * padding. Picks the smaller of the two axis-fit ratios so the entire
   * content is visible (no cropping). Then centers the result in the
   * visible region (excluding inset chrome).
   */
  const centerToContent = useCallback(() => {
    triggerAnimation();
    const content = contentBoxRef.current;
    const view = viewportSizeRef.current;
    if (content === null || view === null) return;
    setViewport((current) => {
      const { panX, panY } = centerInVisibleRegion(
        content, view, insetRef.current, originRef.current, current.scale
      );
      if (panX === current.panX && panY === current.panY) return current;
      return { scale: current.scale, panX, panY };
    });
  }, [triggerAnimation]);

  const fitToContent = useCallback(() => {
    triggerAnimation();
    const content = contentBoxRef.current;
    const view = viewportSizeRef.current;
    const insetVal = insetRef.current;
    if (content === null || view === null) return;
    if (content.width <= 0 || content.height <= 0) return;
    if (view.width <= 0 || view.height <= 0) return;
    // Scale = the same DISPLAY-percent reference used by the chip, so
    // a Fit click always lands exactly at "100%". Reads as "go back
    // to the relaxed reference view." Centering still uses the
    // visible region so the FA lands in the un-occluded space.
    const availableWidth = Math.max(view.width - DISPLAY_FIT_PADDING * 2, 1);
    const availableHeight = Math.max(view.height - DISPLAY_FIT_PADDING * 2, 1);
    const r = reserveRef.current;
    const scaleX = availableWidth / (content.width + r.left + r.right);
    const scaleY = availableHeight / (content.height + r.top + r.bottom);
    const targetScale = clamp(
      Math.min(scaleX, scaleY),
      MIN_SCALE,
      MAX_SCALE
    );
    const { panX, panY } = centerInVisibleRegion(content, view, insetVal, originRef.current, targetScale);
    setViewport({ scale: targetScale, panX, panY });
  }, [triggerAnimation]);

  /**
   * Wheel handler. The browser sets `ctrlKey` for trackpad pinch as
   * well as Ctrl/Cmd+wheel — that's the cross-browser convention for
   * "this is a zoom gesture, not a scroll gesture." Otherwise it's a
   * two-axis pan (deltaX/deltaY).
   */
  const onWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      // preventDefault keeps the page from scrolling under us. We can
      // call it freely here since the SVG isn't a scroll container.
      event.preventDefault();
      const svg = event.currentTarget;
      const rect = svg.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      if (event.ctrlKey) {
        // Pinch / Cmd+wheel: zoom toward cursor. Use exponential
        // scaling on deltaY so the gesture feels uniform regardless
        // of speed; small delta = small zoom, large delta = large.
        const zoomFactor = Math.exp(-event.deltaY / 100);
        setViewport((current) => {
          const newScale = clamp(current.scale * zoomFactor, MIN_SCALE, MAX_SCALE);
          if (newScale === current.scale) return current;
          const worldX = (cursorX - current.panX) / current.scale;
          const worldY = (cursorY - current.panY) / current.scale;
          const newPanX = cursorX - worldX * newScale;
          const newPanY = cursorY - worldY * newScale;
          return clampViewport(
            { scale: newScale, panX: newPanX, panY: newPanY },
            contentBoxRef.current,
            viewportSizeRef.current
          );
        });
      } else {
        // Two-finger scroll = pan. Negate so the content moves with
        // the gesture (drag your fingers right → content slides
        // right, matching native scroll feel).
        panBy(-event.deltaX, -event.deltaY);
      }
    },
    [panBy]
  );

  /**
   * Pointer-down: register the pointer in the active set. Drags that
   * originate on a state node or transition edge are SKIPPED so those
   * gestures stay free for clicks (a touch on a state shouldn't also
   * pan or pinch the canvas).
   *
   * Note: `event.button !== 0` filters non-primary MOUSE buttons. Touch
   * and pen pointers report `button === 0` for primary contact, so this
   * doesn't accidentally exclude them.
   */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = event.target as Element | null;
      if (target !== null) {
        // Walk up from the click target looking for an interactive
        // group. If we find one, this isn't an empty-canvas drag —
        // bail and let the node/edge handle the click.
        if (target.closest('[data-state-id]')) return;
        if (target.closest('.transition-edge-clickable')) return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      pointersRef.current.set(event.pointerId, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      // setPointerCapture so we keep getting events even if the finger
      // / cursor leaves the SVG mid-gesture. Wrapped: synthetic /
      // already-detached pointers throw InvalidStateError here, which
      // is harmless — we still track the pointer in our map, we just
      // don't get the cross-element capture benefit.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No active pointer with this ID — fine, continue without capture.
      }
    },
    []
  );

  /**
   * Pointer-move: update the moving pointer's tracked position and
   * apply the resulting transformation.
   *
   *  - 1 active pointer: pan by the position delta.
   *  - 2 active pointers: combined pinch + translation. The previous
   *    midpoint maps to the next midpoint, and the previous distance
   *    maps to the next distance. That's a similarity transformation
   *    (we drop rotation); decomposed it's a scale anchored at the
   *    previous midpoint plus a translation by (next - previous)
   *    midpoint delta.
   *  - 3+ active pointers: extra fingers are tracked but don't change
   *    the math — we still treat the gesture as 2-finger pinch using
   *    the two pointers with the lowest IDs (= first to land).
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const pointers = pointersRef.current;
      const prev = pointers.get(event.pointerId);
      if (!prev) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const next: PointerSample = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      if (pointers.size === 1) {
        // Single-pointer pan.
        const deltaX = next.x - prev.x;
        const deltaY = next.y - prev.y;
        pointers.set(event.pointerId, next);
        panBy(deltaX, deltaY);
        return;
      }

      // Multi-pointer: pick the two oldest (lowest IDs by insertion
      // order — Map iteration is insertion-ordered in JS). One of them
      // is the moving pointer; the other is the anchor "other finger."
      const ids = Array.from(pointers.keys()).slice(0, 2);
      if (!ids.includes(event.pointerId)) {
        // Moving pointer is a third+ finger that doesn't influence the
        // gesture. Still update its tracked position so a later removal
        // doesn't reorder the primary pair, but don't transform.
        pointers.set(event.pointerId, next);
        return;
      }
      const otherId = ids.find((id) => id !== event.pointerId);
      if (otherId === undefined) {
        pointers.set(event.pointerId, next);
        return;
      }
      const other = pointers.get(otherId);
      if (!other) {
        pointers.set(event.pointerId, next);
        return;
      }

      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const nextDist = Math.hypot(next.x - other.x, next.y - other.y);
      const prevMid = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const nextMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };

      // Update tracked position before the state update so a synchronous
      // re-entry sees the latest sample.
      pointers.set(event.pointerId, next);

      // Distances below 1px are usually noise from a finger pivoting
      // rather than actual pinch motion — skip the scale step to avoid
      // wild ratios but still apply the midpoint translation.
      if (prevDist < 1 || nextDist < 1) {
        const dxMid = nextMid.x - prevMid.x;
        const dyMid = nextMid.y - prevMid.y;
        if (dxMid !== 0 || dyMid !== 0) panBy(dxMid, dyMid);
        return;
      }

      const scaleFactor = nextDist / prevDist;
      setViewport((current) => {
        const newScale = clamp(current.scale * scaleFactor, MIN_SCALE, MAX_SCALE);
        // World point under the previous midpoint stays under the next
        // midpoint after the transform. That folds the scale-anchor +
        // midpoint-translation into a single pan formula.
        const worldX = (prevMid.x - current.panX) / current.scale;
        const worldY = (prevMid.y - current.panY) / current.scale;
        const newPanX = nextMid.x - worldX * newScale;
        const newPanY = nextMid.y - worldY * newScale;
        return clampViewport(
          { scale: newScale, panX: newPanX, panY: newPanY },
          contentBoxRef.current,
          viewportSizeRef.current
        );
      });
    },
    [panBy]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const pointers = pointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Already released (e.g. element unmounted) — nothing to do.
      }
    },
    []
  );

  // SVG-attribute transform syntax (bare numbers, spaces). We use the
  // `transform` ATTRIBUTE on the <g>, NOT CSS `style.transform`. CSS
  // transforms on SVG elements have long-standing Safari bugs around
  // nested transforms and getBoundingClientRect (WebKit #183237 et
  // al.) — even with `transform-box: view-box` set explicitly, Safari
  // disagrees with Chromium by tens of pixels for non-trivial pan +
  // scale combos. SVG-attribute transforms are unambiguously
  // interpreted across all browsers. CSS `transition: transform` on
  // the same element still animates SVG-attribute changes in modern
  // browsers (treated as the same CSS property).
  const transform = `translate(${viewport.panX} ${viewport.panY}) scale(${viewport.scale})`;

  // The reference scale that displays as "100%". DELIBERATELY ignores
  // `inset` (and uses DISPLAY_FIT_PADDING instead of FIT_PADDING) so
  // the percentage doesn't lurch every time the tool menu expands or
  // collapses. This reference floats only with content + viewport
  // size; it stays put when the user's just toggling chrome.
  //
  // The fit-to-view action lands on the same scale (also using the
  // full viewport + DISPLAY_FIT_PADDING), so a Fit click always
  // displays as exactly 100%. Centering still uses the visible region
  // so the FA lands in un-occluded space.
  let fitScale: number | null = null;
  if (
    contentBoundingBox && viewportSize &&
    contentBoundingBox.width > 0 && contentBoundingBox.height > 0 &&
    viewportSize.width > 0 && viewportSize.height > 0
  ) {
    const availableW = Math.max(viewportSize.width - DISPLAY_FIT_PADDING * 2, 1);
    const availableH = Math.max(viewportSize.height - DISPLAY_FIT_PADDING * 2, 1);
    const fitW = contentBoundingBox.width + reserve.left + reserve.right;
    const fitH = contentBoundingBox.height + reserve.top + reserve.bottom;
    fitScale = clamp(
      Math.min(availableW / fitW, availableH / fitH),
      MIN_SCALE,
      MAX_SCALE
    );
  }

  // Compare current pan against the centered pan at current scale.
  // If they match within half a pixel, we treat the FA as centered.
  let isCentered = false;
  if (
    contentBoundingBox && viewportSize &&
    contentBoundingBox.width > 0 && contentBoundingBox.height > 0
  ) {
    const target = centerInVisibleRegion(
      contentBoundingBox, viewportSize, inset, origin, viewport.scale
    );
    isCentered =
      Math.abs(target.panX - viewport.panX) < 0.5 &&
      Math.abs(target.panY - viewport.panY) < 0.5;
  }

  return {
    viewport,
    transform,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp },
    zoomIn,
    zoomOut,
    reset,
    fitToContent,
    centerToContent,
    isCentered,
    panBy,
    atMaxScale: viewport.scale >= MAX_SCALE,
    atMinScale: viewport.scale <= MIN_SCALE,
    isAnimating,
    fitScale,
  };
}

/** Exposed for tests + keyboard shortcut handler. */
export const VIEWPORT_PAN_STEP = PAN_STEP;
export const VIEWPORT_PAN_STEP_LARGE = PAN_STEP_LARGE;
