/**
 * TransitionEdge Component
 *
 * Renders a transition arrow between two states using pre-computed
 * SVG path data from GraphViz. All edge geometry (splines, arrowhead
 * position, label placement) is computed by GraphViz's layout engine.
 */

import type { EdgeOverlay } from '../engine/preview';

type TransitionEdgeProp = {
  /** SVG path d attribute (cubic bezier spline from GraphViz) */
  pathData: string;

  /**
   * Symbols on this edge. Multiple entries means the edge is a
   * consolidated rendering of N transitions sharing the same
   * `(from, to)` — render as `a, b, ε`. `null` is ε.
   */
  symbols: ReadonlyArray<string | null>;

  /** Position of the arrowhead tip */
  arrowheadPosition: { x: number; y: number };

  /** Arrowhead angle in radians (direction the arrow points) */
  arrowheadAngle: number;

  /** GraphViz-computed label position */
  labelPosition: { x: number; y: number };

  /** Whether this transition is the active highlight target of a notification */
  isHighlighted?: boolean | undefined;

  /**
   * Whether this transition fired on the most recent simulation step.
   * Triggers a one-shot blue pulse animation. The parent should change
   * the React key when the fire event changes (typically the step
   * index) so the animation re-runs on each step.
   */
  justFired?: boolean | undefined;

  /**
   * If this edge is part of the in-progress transition edit preview, the
   * kind of change it represents. Drives color and pulse:
   *   - 'add'    → blue:   a new edge being introduced
   *   - 'modify' → purple: an existing edge whose source / dest / symbol changed
   *   - 'delete' → red:    an edge that will be removed on commit
   */
  previewKind?: EdgeOverlay['kind'] | undefined;

  /**
   * For modify previews where the symbol itself changed, the previous symbol.
   * Triggers the split-label render: old symbol struck-through in red,
   * new symbol in blue.
   */
  previewOldSymbol?: string | undefined;

  /** Called when the user clicks this edge (loads it into the creator form). */
  onEdgeClick?: (() => void) | undefined;
};

const STROKE_WIDTH = 2;
const ARROWHEAD_SIZE = 8;

// Preview palette. Kept in one place so the canvas, the action button, and
// any future UI elements share a single source of truth for the add/modify/
// delete color theme.
const PREVIEW_COLOR = {
  add: '#2563eb',     // blue-600
  modify: '#7c3aed',  // violet-600
  delete: '#dc2626',  // red-600
} as const;

export function TransitionEdge(props: TransitionEdgeProp) {
  const {
    pathData,
    symbols,
    arrowheadPosition,
    arrowheadAngle,
    labelPosition,
    isHighlighted = false,
    justFired = false,
    previewKind,
    previewOldSymbol,
    onEdgeClick,
  } = props;

  // Render the (possibly multi-symbol) label as `a, b, ε` — same
  // convention as the DOT label generator. Single symbol is just
  // itself (no comma).
  const displayLabel = symbols
    .map((symbol) => (symbol === null ? 'ε' : symbol))
    .sort((a, b) => {
      // ε always last; otherwise alphabetical.
      if (a === 'ε') return 1;
      if (b === 'ε') return -1;
      return a.localeCompare(b);
    })
    .join(', ');

  // Color priority: notification highlight (red) > active preview > just-fired
  // > default. The notification system can only highlight one edge at a time
  // and is user-driven (clicking an alphabet badge etc.), so it should never
  // collide with an in-progress preview in practice — but if it ever did, we
  // want the click-driven highlight to win so the user sees what they asked
  // for.
  let edgeColor = '#334155'; // --text-body
  let edgeStrokeWidth = STROKE_WIDTH;
  let highlightClass: string | undefined = undefined;

  if (previewKind !== undefined) {
    edgeColor = PREVIEW_COLOR[previewKind];
    edgeStrokeWidth = 3;
    highlightClass = `pulse-canvas pulse-canvas-${previewKind}`;
  }
  // Just-fired styling for the most recent simulation step — the "trail"
  // that shows where the automaton just came from. Steady-state coloring
  // persists between steps; the `edge-just-fired` class adds a one-shot
  // pulse animation, re-triggered each step via the parent's key change.
  // Layered after previewKind because preview edges only exist in EDIT mode
  // and fired edges only exist in SIMULATE mode — they shouldn't both apply,
  // but if they did the simulation visual is more time-sensitive.
  if (justFired) {
    edgeColor = '#2563eb'; // blue-600
    edgeStrokeWidth = 3;
    highlightClass = 'edge-just-fired';
  }
  if (isHighlighted) {
    edgeColor = '#dc2626'; // --error-stroke
    edgeStrokeWidth = 3;
    highlightClass = 'pulse-canvas pulse-canvas-error';
  }

  // Calculate arrowhead triangle points from angle
  const arrowheadAngle1 = arrowheadAngle + Math.PI - Math.PI / 6;
  const arrowheadAngle2 = arrowheadAngle + Math.PI + Math.PI / 6;

  const arrowheadPoint1X = arrowheadPosition.x + ARROWHEAD_SIZE * Math.cos(arrowheadAngle1);
  const arrowheadPoint1Y = arrowheadPosition.y + ARROWHEAD_SIZE * Math.sin(arrowheadAngle1);
  const arrowheadPoint2X = arrowheadPosition.x + ARROWHEAD_SIZE * Math.cos(arrowheadAngle2);
  const arrowheadPoint2Y = arrowheadPosition.y + ARROWHEAD_SIZE * Math.sin(arrowheadAngle2);

  const groupClass = onEdgeClick ? 'transition-edge-clickable' : undefined;

  // For symbol-only modify previews (single underlying symbol changing
  // its name), render the label as old struck-red + new blue tspans.
  // Doesn't apply to consolidated edges with multiple symbols — those
  // use the plain joined label instead.
  const showSymbolDiff =
    previewKind === 'modify' &&
    previewOldSymbol !== undefined &&
    symbols.length === 1 &&
    symbols[0] !== null;

  return (
    <g
      className={groupClass}
      onClick={onEdgeClick}
      style={onEdgeClick ? { cursor: 'pointer' } : undefined}
    >
      {/* Edge spline path. The visible stroke is the colored one;
       * a wider transparent stroke beneath it gives a generous click
       * target on thin edges. Round linecap so the spline endpoints
       * (where the click target tapers off) stay grabbable, not
       * sliced off square. Width chosen to roughly match a node's
       * radius — wider was tested but starts to overlap adjacent
       * edges in dense graphs. */}
      {onEdgeClick && (
        <path
          d={pathData}
          fill="none"
          stroke="transparent"
          strokeWidth={22}
          strokeLinecap="round"
        />
      )}
      <path
        d={pathData}
        fill="none"
        stroke={edgeColor}
        strokeWidth={edgeStrokeWidth}
        className={highlightClass}
      />

      {/* Arrowhead */}
      <polygon
        points={`${arrowheadPosition.x},${arrowheadPosition.y} ${arrowheadPoint1X},${arrowheadPoint1Y} ${arrowheadPoint2X},${arrowheadPoint2Y}`}
        fill={edgeColor}
      />

      {/* Symbol label. For symbol-changing modifies, show old (struck red)
       * then new (blue); otherwise a single colored symbol. */}
      <text
        x={labelPosition.x}
        y={labelPosition.y}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="14px"
        fontWeight={justFired ? 'bold' : 'normal'}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      >
        {showSymbolDiff ? (
          <>
            <tspan
              fill={PREVIEW_COLOR.delete}
              textDecoration="line-through"
            >
              {previewOldSymbol}
            </tspan>
            <tspan dx="4" fill={PREVIEW_COLOR.add}>
              {displayLabel}
            </tspan>
          </>
        ) : (
          <tspan fill={edgeColor}>{displayLabel}</tspan>
        )}
      </text>
    </g>
  );
}
