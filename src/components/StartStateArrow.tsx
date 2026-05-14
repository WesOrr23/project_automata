/**
 * StartStateArrow Component
 *
 * Renders the start-arrow as a GraphViz-routed spline. The geometry
 * (path + arrowhead position + arrowhead angle) comes from a phantom
 * edge GraphViz lays out as part of the regular automaton DOT — see
 * `automatonToDot` and `parseGraphvizJson` in `ui-state/utils.ts`.
 *
 * Why the spline (and not a fixed pixel-offset arrow):
 *   - GraphViz computes the path as a real edge during layout, which
 *     means OTHER edges' splines actually avoid this lane during their
 *     own routing. Before the refactor, q2 → q0 splines could route
 *     through the same area we manually drew the start arrow on top
 *     of, producing visual collisions on dense layouts.
 *   - The spline naturally adjusts to the start state's position, so
 *     no inner-group translate or `contentReserve.left` is needed in
 *     AutomatonCanvas.
 *
 * Visual: same stroke + arrowhead as the engine's other transitions
 * (matches `TransitionEdge`'s STROKE_WIDTH=2 and ARROWHEAD_SIZE=8) so
 * the start arrow reads as part of the same vocabulary, not a special
 * mark.
 */

import { START_ARROW_HEAD_SIZE } from '../ui-state/constants';
import type { StartArrowUI } from '../ui-state/types';

type StartStateArrowProp = {
  /** Pre-computed spline + arrowhead from GraphViz. */
  geometry: StartArrowUI;

  /**
   * When true, the arrow renders in the same blue as a just-fired edge and
   * suspends its idle breathing. Used in SIMULATE mode to mark "the
   * automaton is at the start, ready to consume the first symbol."
   */
  isHighlighted?: boolean | undefined;
};

const STROKE_WIDTH = 2;
const HIGHLIGHT_COLOR = '#2563eb'; // --blue-600, matches justFired edges

export function StartStateArrow({ geometry, isHighlighted = false }: StartStateArrowProp) {
  const { pathData, arrowheadPosition, arrowheadAngle } = geometry;

  // Arrowhead triangle from the angle, mirroring the math used in
  // TransitionEdge.tsx so the two arrowheads look identical.
  const angle1 = arrowheadAngle + Math.PI - Math.PI / 6;
  const angle2 = arrowheadAngle + Math.PI + Math.PI / 6;
  const arrowheadPoint1X =
    arrowheadPosition.x + START_ARROW_HEAD_SIZE * Math.cos(angle1);
  const arrowheadPoint1Y =
    arrowheadPosition.y + START_ARROW_HEAD_SIZE * Math.sin(angle1);
  const arrowheadPoint2X =
    arrowheadPosition.x + START_ARROW_HEAD_SIZE * Math.cos(angle2);
  const arrowheadPoint2Y =
    arrowheadPosition.y + START_ARROW_HEAD_SIZE * Math.sin(angle2);

  const color = isHighlighted ? HIGHLIGHT_COLOR : 'black';
  const strokeWidth = isHighlighted ? STROKE_WIDTH + 1 : STROKE_WIDTH;

  return (
    // The `start-arrow-breath` class drives a subtle opacity breathing
    // (0.85 ↔ 1.0 over 2s) at idle — see animations.css. Applied to the
    // group so both the line and arrowhead breathe together as one mark.
    // Suspended while highlighted so the highlight isn't competing with
    // the opacity wobble.
    <g className={isHighlighted ? undefined : 'start-arrow-breath'}>
      <path
        d={pathData}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <polygon
        points={`${arrowheadPosition.x},${arrowheadPosition.y} ${arrowheadPoint1X},${arrowheadPoint1Y} ${arrowheadPoint2X},${arrowheadPoint2Y}`}
        fill={color}
      />
    </g>
  );
}
