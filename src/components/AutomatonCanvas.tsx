/**
 * AutomatonCanvas Component
 *
 * Main container that orchestrates the rendering of the entire automaton.
 * Takes the engine Automaton and UI metadata (including pre-computed edge
 * paths from GraphViz), and renders all child components.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { Automaton } from '../engine/types';
import { AutomatonUI } from '../ui-state/types';
import { STATE_RADIUS } from '../ui-state/constants';
import { StateNode } from './StateNode';
import { TransitionEdge } from './TransitionEdge';
import { StartStateArrow } from './StartStateArrow';
import { CanvasZoomControls } from './CanvasZoomControls';
import type { EdgeOverlay } from '../engine/preview';
import type { ViewportInset } from '../hooks/useCanvasViewport';
import {
  useCanvasViewport,
  VIEWPORT_PAN_STEP,
  VIEWPORT_PAN_STEP_LARGE,
} from '../hooks/useCanvasViewport';
import { useKeyboardScope } from '../hooks/useKeyboardScope';

type AutomatonCanvasProp = {
  /** The automaton data from the engine layer */
  automaton: Automaton;

  /** UI metadata (positions, labels, edge paths) for visual rendering */
  automatonUI: AutomatonUI;

  /** State IDs currently active during simulation */
  activeStateIds?: Set<number> | undefined;

  /** Result status for highlighting the final state after simulation */
  resultStatus?: 'accepted' | 'rejected' | null | undefined;

  /** State IDs whose branches died on the most recent step — pulse red. */
  dyingStateIds?: ReadonlySet<number> | undefined;

  /**
   * Transitions that fired on the most recent step (symbol-driven and
   * ε-closure). Drives a one-shot per-step pulse on the matching edges.
   */
  firedTransitions?: ReadonlyArray<{
    from: number;
    to: number;
    symbol: string | null;
  }> | undefined;

  /**
   * Current simulation step index. Threaded into edge keys so the
   * just-fired animation re-runs on every step rather than getting
   * stuck on the first fire.
   */
  simulationStepIndex?: number | undefined;

  /** State ID currently highlighted by an active notification target */
  highlightedStateId?: number | null | undefined;

  /** Transition currently highlighted by an active notification target */
  highlightedTransition?: { from: number; to: number; symbol: string | null } | null | undefined;

  /**
   * When set to 'state', state nodes become clickable for picking
   * (used by TransitionCreator while filling source/destination slots).
   */
  pickMode?: 'state' | null | undefined;

  /** Called when the user clicks a state node while pickMode === 'state'. */
  onPickState?: ((stateId: number) => void) | undefined;

  /**
   * Called when the user clicks a state node while NOT in pick mode
   * (typically: edit-mode state actions popover).
   */
  onStateClick?: ((stateId: number, anchorEl: SVGGElement) => void) | undefined;

  /**
   * Optional extra elements to render at the bottom-right of the
   * viewport, beneath (visually below) the zoom controls. When App
   * passes the canvas-tip in here, the column-reverse stack puts the
   * tip at the bottom edge and pushes the zoom controls above it; when
   * App passes nothing, the zoom controls drop to the bottom edge on
   * their own. No JS coordination required.
   */
  bottomRightExtras?: ReactNode;

  /**
   * If provided, a small "?" help button is rendered ABOVE the zoom
   * controls in the bottom-right stack. Click invokes the callback —
   * App wires this to re-show the onboarding tour. Surfaces the tour
   * as a discoverable, always-visible affordance instead of burying
   * it in the CommandBar's ⋯ overflow.
   */
  onShowTour?: () => void;

  /**
   * When true, render the centering-debug visualization (red dot at
   * the visible region's center, blue ring at the FA cluster's
   * centroid). Off by default; toggled via ⌘⇧D — see useDebugOverlay.
   */
  debugOverlay?: boolean;

  /**
   * Reports the live <svg> element ref to App so the image-export
   * action can serialize it. App stores via callback ref. Called once
   * on mount with the element, once with null on unmount.
   */
  onSvgRefChange?: (svg: SVGSVGElement | null) => void;

  /**
   * Incrementing counter; when it changes the canvas runs
   * fitToContent. Used by the global F-key shortcut so App can
   * trigger fit without holding a ref to the viewport hook's
   * imperative methods.
   */
  fitSignal?: number;

  /**
   * Pixels of overlay chrome (tool menu, command bar) covering the SVG.
   * Centering operations target the un-occluded region rather than the
   * geometric center, so "centered" reads as "centered in what the
   * user can actually see." Pan-clamp / zoom-toward-cursor remain
   * full-SVG.
   */
  viewportInset?: ViewportInset;

  /**
   * Called when the user clicks an existing transition edge on the canvas.
   * Loads it into the creator form for editing/deletion. For consolidated
   * edges (multiple symbols sharing the same from→to), the entire group
   * is loaded — `symbols` carries every symbol on the rendered edge.
   */
  onEdgeClick?: ((transition: {
    from: number;
    to: number;
    symbols: ReadonlyArray<string | null>;
  }) => void) | undefined;

  /**
   * Per-edge highlights for the in-progress transition edit. Each entry
   * recolors and pulses the matching transition (blue for additions,
   * purple for modifications, red for deletions). The canvas matches by
   * (from, to, symbol). For modifications with a symbol change, the entry
   * also carries the original symbol so the label renders both.
   */
  edgePreviews?: ReadonlyArray<EdgeOverlay> | undefined;

  /**
   * State IDs currently selected as the source / destination of the
   * in-progress transition edit. The canvas draws a pulsing halo of
   * `creationStateKind` color around them — the same blue/purple language
   * used for the edge preview, so the user sees "these are the states in
   * play."
   */
  creationSourceId?: number | null | undefined;
  creationDestinationId?: number | null | undefined;
  creationStateKind?: 'add' | 'modify' | null | undefined;

  /**
   * Highlight the start-state arrow. True while the user is on SIMULATE
   * and the automaton is "at the start" — either no simulation has been
   * initialised yet, or the simulation is at step 0 and not finished.
   * After the first step (or once a finished sim is parked), the arrow
   * returns to its idle (black + breathing) style.
   */
  startArrowHighlighted?: boolean | undefined;
};

export function AutomatonCanvas({
  automaton,
  automatonUI,
  activeStateIds,
  resultStatus,
  dyingStateIds,
  firedTransitions,
  simulationStepIndex,
  highlightedStateId,
  highlightedTransition,
  pickMode,
  onPickState,
  onStateClick,
  onEdgeClick,
  edgePreviews,
  creationSourceId,
  creationDestinationId,
  creationStateKind,
  startArrowHighlighted,
  bottomRightExtras,
  onShowTour,
  debugOverlay = false,
  onSvgRefChange,
  fitSignal,
  viewportInset,
}: AutomatonCanvasProp) {
  // The start-state arrow is now a real GraphViz-routed spline (see
  // automatonToDot in ui-state/utils.ts). Its geometry comes back
  // inside `automatonUI.startArrow` and its leftward extent is already
  // included in GraphViz's bounding box — no inner-group translate, no
  // hand-rolled reserve. The fit-to-content reserve below DOES still
  // grow to encompass the start arrow's bbox so it stays on-screen at
  // fit zoom, but centering targets the cluster only.

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(
    null
  );
  // Measured bounding box of the state cluster (in inner-group coord
  // space, which is now the same as GraphViz's coord space — no
  // intermediate translate). Used for centering. The start arrow's
  // bbox is added separately via contentReserve so fit-to-content
  // still encompasses it without dragging the centering target.
  const [contentBBox, setContentBBox] = useState<{
    x: number; y: number; width: number; height: number;
  } | null>(null);

  // Lift svg + bbox to App so the image-export action can frame the
  // SVG without re-measuring. Effects (not refs) so the parent gets
  // notified on remount and on bbox changes.
  useEffect(() => {
    if (onSvgRefChange) onSvgRefChange(svgRef.current);
    return () => {
      if (onSvgRefChange) onSvgRefChange(null);
    };
  }, [onSvgRefChange]);

  // ResizeObserver keeps viewportSize in sync with the SVG's CSS box.
  // useLayoutEffect to read sizes synchronously after paint, avoiding
  // a one-frame stale read on initial mount.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      setViewportSize((current) => {
        if (current && current.width === rect.width && current.height === rect.height) {
          return current;
        }
        return { width: rect.width, height: rect.height };
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // Bbox for CENTERING: state circles only. The bbox center is what
  // 'centered FA' means visually — the cluster of states. The start
  // arrow extends LEFT of this bbox but is accounted for as a
  // FIT-ONLY reserve (passed to the hook below) so it has room at
  // fit-scale without dragging the centering target leftward away
  // from the cluster center.
  useLayoutEffect(() => {
    const positions = Array.from(automatonUI.states.values()).map((s) => s.position);
    if (positions.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions) {
      if (p.x - STATE_RADIUS < minX) minX = p.x - STATE_RADIUS;
      if (p.x + STATE_RADIUS > maxX) maxX = p.x + STATE_RADIUS;
      if (p.y - STATE_RADIUS < minY) minY = p.y - STATE_RADIUS;
      if (p.y + STATE_RADIUS > maxY) maxY = p.y + STATE_RADIUS;
    }
    const next = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    setContentBBox((current) => {
      if (
        current &&
        current.x === next.x &&
        current.y === next.y &&
        current.width === next.width &&
        current.height === next.height
      ) {
        return current;
      }
      return next;
    });
  }, [automaton, automatonUI]);

  // Effective content size + origin for the viewport hook.
  //
  // We pass `null` until the layout effect has measured the actual
  // state-cluster bbox. Earlier we used GraphViz's
  // `automatonUI.boundingBox` as a fallback; that ran the initial-
  // center effect with WRONG sizes (GraphViz's bbox doesn't match
  // the state-cluster bbox) and locked in a slightly-off pan that
  // the later measurement couldn't correct (`didInitialCenterRef`
  // had already flipped). Waiting for the real measurement adds at
  // most one render's delay before the FA appears at scale 1, but
  // makes centering exact instead of approximate.
  const measured = contentBBox;
  const effectiveContent = measured
    ? { width: measured.width, height: measured.height }
    : null;
  const effectiveOrigin = measured
    ? { x: measured.x, y: measured.y }
    : { x: 0, y: 0 };

  // Fit-to-content reserve, derived from the start arrow's actual
  // bbox. We compute "how far left/up/right/down the start arrow
  // protrudes BEYOND the cluster bbox" and pass that as the reserve
  // — fit math will widen its window by these amounts without
  // moving the centering target. Defaults to all-zeros when no
  // start arrow geometry is present yet (layout debounce).
  const startArrowReserve = (() => {
    const startArrow = automatonUI.startArrow;
    if (!startArrow || !measured) {
      return { left: 0, right: 0, top: 0, bottom: 0 };
    }
    const arrow = startArrow.boundingBox;
    return {
      left: Math.max(0, measured.x - arrow.x),
      right: Math.max(0, arrow.x + arrow.width - (measured.x + measured.width)),
      top: Math.max(0, measured.y - arrow.y),
      bottom: Math.max(0, arrow.y + arrow.height - (measured.y + measured.height)),
    };
  })();

  const {
    transform,
    viewport,
    handlers,
    zoomIn,
    zoomOut,
    fitToContent,
    centerToContent,
    isCentered,
    panBy,
    atMaxScale,
    atMinScale,
    isAnimating,
    fitScale,
  } = useCanvasViewport({
    contentBoundingBox: effectiveContent,
    viewportSize,
    // Spread-conditional: viewportInset is omit-only on both ends
    // (per optional-prop-policy), so don't pass an explicit
    // undefined when the caller didn't provide one.
    ...(viewportInset !== undefined ? { viewportInset } : {}),
    contentOrigin: effectiveOrigin,
    contentReserve: startArrowReserve,
  });

  // Imperative fit trigger from App's global F-key shortcut. The
  // signal is an incrementing counter; each new value runs fit once.
  // Uses a ref to track the last seen value so the very first render
  // (signal === undefined or 0) doesn't trigger an unwanted fit.
  const lastFitSignalRef = useRef<number | undefined>(fitSignal);
  useEffect(() => {
    if (fitSignal === undefined) return;
    if (lastFitSignalRef.current === fitSignal) return;
    lastFitSignalRef.current = fitSignal;
    fitToContent();
  }, [fitSignal, fitToContent]);

  // Native (non-React) wheel handler — React's onWheel synthetic events
  // bubble as `passive: true` listeners by default, which means
  // preventDefault() is silently ignored and the page scrolls behind
  // the canvas. Attaching the listener directly with passive:false
  // restores control.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    // Why a native listener instead of React's onWheel: React attaches
    // wheel listeners as `passive: true` and disallows preventDefault().
    // We need preventDefault() to suppress the browser's default
    // pinch-to-zoom (which would zoom the *page*, not our viewport).
    // The attached listener manufactures a React-shaped event and
    // forwards into the hook's onWheel handler — useCanvasViewport
    // only reads a small subset of fields, so a structural shim is
    // sufficient. The `as unknown as React.WheelEvent<...>` cast is
    // safe at this boundary because the consumer's contract is
    // narrower than the React event type.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      handlers.onWheel({
        ...event,
        currentTarget: svg,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ctrlKey: event.ctrlKey,
        preventDefault: () => event.preventDefault(),
      } as unknown as React.WheelEvent<SVGSVGElement>);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [handlers]);

  // Keyboard shortcuts for zoom + pan. Transparent scope so it
  // coexists with everything else in the stack. The scope manager
  // already filters out keystrokes inside text inputs.
  useKeyboardScope({
    id: 'canvas-zoom',
    active: true,
    capture: false,
    onKey: (event) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (isModifier) {
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          zoomIn();
          return true;
        }
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          zoomOut();
          return true;
        }
        // Cmd+0 used to reset zoom (the now-removed 1:1 button).
        // Reuse it for Fit since that's the closest user intent.
        if (event.key === '0') {
          event.preventDefault();
          fitToContent();
          return true;
        }
        return false;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        fitToContent();
        return true;
      }
      const step = event.shiftKey ? VIEWPORT_PAN_STEP_LARGE : VIEWPORT_PAN_STEP;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        panBy(0, step);
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        panBy(0, -step);
        return true;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        panBy(step, 0);
        return true;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        panBy(-step, 0);
        return true;
      }
      return false;
    },
  });

  return (
    <>
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      style={{ display: 'block', touchAction: 'none', cursor: 'grab' }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerUp}
    >
      {/* The user's pan/zoom transform. style.transform (vs the SVG
          attribute) so CSS transitions can animate it. transform-origin
          is set to top-left so scale grows the world from origin
          consistently with the engine's coordinate system. The
          `canvas-content-animating` class adds a 0.3s transition; it's
          only applied during button-driven actions so wheel/pinch/drag
          stay snappy. */}
      {/* SVG attribute `transform` (NOT CSS style.transform) for
          cross-browser parity. Safari has long-standing bugs around
          CSS transforms on SVG elements (WebKit #183237 and related);
          the SVG attribute is unambiguously interpreted. CSS
          `transition: transform` on the canvas-content-animating
          class still eases SVG-attribute changes in modern browsers. */}
      <g
        transform={transform}
        className={isAnimating ? 'canvas-content-animating' : undefined}
      >
        {/* No inner-group translate — GraphViz now lays out the
            start-arrow spline as a real edge, so its leftward extent
            is already inside the cluster's coordinate space. The
            empty group is preserved as a structural anchor for the
            existing nested-render below; collapsing it would shift
            test selectors. */}
        <g>
      {/* Layer 1: Transition edges (background) */}
      {automatonUI.transitions.map((transition, index) => {
        const isHighlighted =
          highlightedTransition !== null
          && highlightedTransition !== undefined
          && transition.fromStateId === highlightedTransition.from
          && transition.toStateId === highlightedTransition.to
          && transition.symbols.some((s) => s === highlightedTransition.symbol);

        // Match against active edge previews. With consolidation, a
        // preview entry can match an edge that contains its symbol
        // among many. If multiple previews match (e.g. consolidated
        // edge with two symbols both being modified), pick the first;
        // they should agree on kind in practice.
        const matchingPreview = edgePreviews?.find(
          (preview) =>
            preview.from === transition.fromStateId &&
            preview.to === transition.toStateId &&
            transition.symbols.some((s) => s === preview.symbol)
        ) ?? null;

        // Did any of this consolidated edge's symbols just fire on
        // the most recent simulation step?
        const justFired = firedTransitions?.some(
          (fired) =>
            fired.from === transition.fromStateId &&
            fired.to === transition.toStateId &&
            transition.symbols.some((s) => s === fired.symbol)
        ) ?? false;

        // When fired, include the step index in the React key so the
        // element remounts on every step that fires it — that's what
        // restarts the CSS animation. Non-fired edges keep stable
        // keys so they don't churn.
        const edgeKey = justFired
          ? `transition-${index}-step-${simulationStepIndex ?? 0}`
          : `transition-${index}`;

        return (
          <TransitionEdge
            key={edgeKey}
            pathData={transition.pathData}
            symbols={transition.symbols}
            arrowheadPosition={transition.arrowheadPosition}
            arrowheadAngle={transition.arrowheadAngle}
            labelPosition={transition.labelPosition}
            isHighlighted={isHighlighted}
            justFired={justFired}
            previewKind={matchingPreview?.kind}
            previewOldSymbol={matchingPreview?.oldSymbol}
            onEdgeClick={
              onEdgeClick
                ? () =>
                    onEdgeClick({
                      from: transition.fromStateId,
                      to: transition.toStateId,
                      symbols: transition.symbols,
                    })
                : undefined
            }
          />
        );
      })}

      {/* Layer 2: State nodes (foreground) */}
      {Array.from(automatonUI.states.values()).map((stateUI) => {
        const isAccept = automaton.acceptStates.has(stateUI.id);
        const isActive = activeStateIds?.has(stateUI.id) ?? false;
        // For accepted results, only the branches that actually landed
        // in an accept state get the green coloring — that's the answer
        // to "why did this accept?". Other still-active branches stay
        // blue (alive but not why we accepted). Rejected colors every
        // surviving branch red.
        const stateResultStatus = !isActive
          ? null
          : resultStatus === 'accepted' && !isAccept
            ? null
            : resultStatus ?? null;

        const isHighlighted = stateUI.id === highlightedStateId;
        const isDying = dyingStateIds?.has(stateUI.id) ?? false;
        const isCreationParticipant =
          (creationSourceId !== null && creationSourceId !== undefined && stateUI.id === creationSourceId) ||
          (creationDestinationId !== null && creationDestinationId !== undefined && stateUI.id === creationDestinationId);
        const stateCreationKind =
          isCreationParticipant && creationStateKind ? creationStateKind : null;
        const isPickMode = pickMode === 'state';
        // Pick mode wins; otherwise fall back to onStateClick (state actions).
        const interactive = isPickMode
          ? Boolean(onPickState)
          : Boolean(onStateClick);
        const interactionStyle = isPickMode ? 'pick' : 'select';
        const handleClick = isPickMode
          ? onPickState
            ? () => onPickState(stateUI.id)
            : undefined
          : onStateClick
            ? (anchorEl: SVGGElement) => onStateClick(stateUI.id, anchorEl)
            : undefined;

        return (
          <StateNode
            key={`state-${stateUI.id}`}
            stateId={stateUI.id}
            label={stateUI.label}
            x={stateUI.position.x}
            y={stateUI.position.y}
            isAccept={isAccept}
            isActive={isActive}
            resultStatus={stateResultStatus}
            isHighlighted={isHighlighted}
            isDying={isDying}
            creationKind={stateCreationKind}
            isInteractive={interactive}
            interactionStyle={interactionStyle}
            onClick={handleClick}
          />
        );
      })}

      {/* Layer 3: Start state arrow (foreground). Geometry comes
          from GraphViz via automatonUI.startArrow — null only on the
          brief layout-debounce frames before the first computeLayout
          resolves; render nothing in that window. */}
      {automatonUI.startArrow !== null && (
        <StartStateArrow
          geometry={automatonUI.startArrow}
          isHighlighted={startArrowHighlighted ?? false}
        />
      )}
          {/* DEBUG (gated by debugOverlay): blue ring at the FA's
              center (state-cluster centroid in inner-g local coords).
              Lives inside the transformed content so it pans/scales
              with the FA. Toggleable via ⌘⇧D. */}
          {debugOverlay && contentBBox && (
            <circle
              data-debug-overlay="cluster-center"
              cx={contentBBox.x + contentBBox.width / 2}
              cy={contentBBox.y + contentBBox.height / 2}
              r={10}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
        </g>
      </g>
      {/* DEBUG (gated by debugOverlay): red filled dot at the visible
          region's center (raw SVG coords, pinned to screen regardless
          of pan/zoom). When perfectly centered, sits inside the blue
          ring above. Toggleable via ⌘⇧D. */}
      {debugOverlay && viewportSize && (
        <circle
          data-debug-overlay="visible-region-center"
          cx={(viewportInset?.left ?? 0) + (viewportSize.width - (viewportInset?.left ?? 0) - (viewportInset?.right ?? 0)) / 2}
          cy={(viewportInset?.top ?? 0) + (viewportSize.height - (viewportInset?.top ?? 0) - (viewportInset?.bottom ?? 0)) / 2}
          r={4}
          fill="#ef4444"
          pointerEvents="none"
        />
      )}
    </svg>
    {/* Bottom-right widget stack. column-reverse so the FIRST DOM child
        sits at the bottom edge; siblings stack upward. The extras slot
        is rendered first → bottommost. Zoom controls are last → topmost.
        When extras (canvas-tip) mount, the zoom controls naturally rise
        above; when they unmount, zoom controls settle at the bottom.
        No JS coordination, no hardcoded `bottom: Npx`. */}
    <div className="canvas-bottom-right-stack">
      {bottomRightExtras}
      <CanvasZoomControls
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        fitToContent={fitToContent}
        centerToContent={centerToContent}
        isCentered={isCentered}
        scale={viewport.scale}
        fitScale={fitScale}
        atMaxScale={atMaxScale}
        atMinScale={atMinScale}
      />
      {onShowTour && (
        // Lives in the same column-reverse stack — DOM-after the zoom
        // controls means it stacks visually ABOVE them. Wrapped in the
        // same .canvas-zoom-controls pill so the visual vocabulary
        // matches (background, blur, border, shadow). Single-button
        // pill is intentional — keeps the help affordance distinct
        // from the zoom cluster while sharing the chrome.
        <div className="canvas-zoom-controls" aria-label="Help">
          <button
            type="button"
            className="canvas-zoom-button"
            onClick={onShowTour}
            aria-label="Show tour"
            title="Show tour"
          >
            <HelpCircle size={16} />
          </button>
        </div>
      )}
    </div>
    </>
  );
}
