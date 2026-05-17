/**
 * @vitest-environment jsdom
 *
 * Unit tests for useCanvasViewport. Focused on the value contracts —
 * scale clamping, anchor-stable zoom math, fit-to-content arithmetic,
 * and pan gesture state. The DOM event handlers are exercised via
 * synthetic React-event shapes (we only depend on a few fields each).
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useCanvasViewport,
  clampViewport,
  MIN_SCALE,
  MAX_SCALE,
} from '../useCanvasViewport';

const STANDARD_BOX = { width: 800, height: 600 };
const STANDARD_VIEWPORT = { width: 1000, height: 800 };

function setupHook(args?: {
  contentBoundingBox?: { width: number; height: number } | null;
  viewportSize?: { width: number; height: number } | null;
}) {
  // Default sizes to null so tests start at the untouched default
  // viewport ({ scale: 1, panX: 0, panY: 0 }) — providing sizes from
  // render 0 triggers the hook's initial-center pass and shifts the
  // pan to whatever centers the content. Tests that exercise
  // size-dependent behavior (fitToContent, wheel-toward-cursor,
  // pan clamping) opt in by passing STANDARD_BOX / STANDARD_VIEWPORT
  // explicitly.
  const contentBoundingBox =
    args && 'contentBoundingBox' in args ? args.contentBoundingBox ?? null : null;
  const viewportSize =
    args && 'viewportSize' in args ? args.viewportSize ?? null : null;
  return renderHook(() =>
    useCanvasViewport({ contentBoundingBox, viewportSize })
  );
}

describe('useCanvasViewport', () => {
  it('with both sizes available from render 0, auto-FITS content (so 100% display = fit)', () => {
    // contentBox 800x600 in viewport 1000x800.
    // Auto-fit uses DISPLAY_FIT_PADDING=180 (intentionally relaxed
    // so "100% display" is a comfortable view, not a tight crop —
    // see useCanvasViewport.ts header comment about FIT_PADDING vs
    // DISPLAY_FIT_PADDING).
    //   available = (1000-360) x (800-360) = 640x440.
    //   fitScale = min(640/800, 440/600) = min(0.8, 0.7333) = 0.7333.
    // Centered: panX = (1000 - 800*0.7333)/2 ≈ 206.67;
    //           panY = (800 - 600*0.7333)/2 = 180.
    const { result } = setupHook({
      contentBoundingBox: STANDARD_BOX,
      viewportSize: STANDARD_VIEWPORT,
    });
    expect(result.current.viewport.scale).toBeCloseTo(0.7333, 3);
    expect(result.current.viewport.panX).toBeCloseTo(206.67, 1);
    expect(result.current.viewport.panY).toBeCloseTo(180, 1);
  });

  it('starts at scale=1 / pan=0,0 when sizes are unknown', () => {
    const { result } = setupHook();
    expect(result.current.viewport).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(result.current.atMaxScale).toBe(false);
    expect(result.current.atMinScale).toBe(false);
  });

  it('zoomIn multiplies scale by 1.25 and stays clamped at MAX_SCALE', () => {
    const { result } = setupHook();
    act(() => result.current.zoomIn());
    expect(result.current.viewport.scale).toBeCloseTo(1.25);

    // Hammer it well past the cap.
    for (let i = 0; i < 30; i++) {
      act(() => result.current.zoomIn());
    }
    expect(result.current.viewport.scale).toBe(MAX_SCALE);
    expect(result.current.atMaxScale).toBe(true);
  });

  it('zoomOut divides scale by 1.25 and stays clamped at MIN_SCALE', () => {
    const { result } = setupHook();
    act(() => result.current.zoomOut());
    expect(result.current.viewport.scale).toBeCloseTo(0.8);

    for (let i = 0; i < 30; i++) {
      act(() => result.current.zoomOut());
    }
    expect(result.current.viewport.scale).toBe(MIN_SCALE);
    expect(result.current.atMinScale).toBe(true);
  });

  it('reset returns to defaults after any change', () => {
    const { result } = setupHook();
    act(() => result.current.zoomIn());
    act(() => result.current.panBy(50, 50));
    expect(result.current.viewport.scale).not.toBe(1);
    act(() => result.current.reset());
    expect(result.current.viewport).toEqual({ scale: 1, panX: 0, panY: 0 });
  });

  it('zoomIn keeps the viewport center stable (anchor invariant)', () => {
    const { result } = setupHook({ contentBoundingBox: STANDARD_BOX, viewportSize: STANDARD_VIEWPORT });
    const centerX = STANDARD_VIEWPORT.width / 2;
    const centerY = STANDARD_VIEWPORT.height / 2;

    // World point under the center before zoom.
    const before = result.current.viewport;
    const worldXBefore = (centerX - before.panX) / before.scale;
    const worldYBefore = (centerY - before.panY) / before.scale;

    act(() => result.current.zoomIn());

    // After zoom, the same world point should still sit under the center.
    const after = result.current.viewport;
    const worldXAfter = (centerX - after.panX) / after.scale;
    const worldYAfter = (centerY - after.panY) / after.scale;

    expect(worldXAfter).toBeCloseTo(worldXBefore, 5);
    expect(worldYAfter).toBeCloseTo(worldYBefore, 5);
  });

  it('wheel with ctrlKey zooms toward the cursor (anchor stable at cursor)', () => {
    const { result } = setupHook();
    const cursorX = 200;
    const cursorY = 150;

    const worldXBefore = (cursorX - result.current.viewport.panX) / result.current.viewport.scale;
    const worldYBefore = (cursorY - result.current.viewport.panY) / result.current.viewport.scale;

    // Build a fake SVG element + bounding rect so the handler's
    // getBoundingClientRect call returns a known origin.
    const svg = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }),
    };
    act(() => {
      result.current.handlers.onWheel({
        currentTarget: svg as unknown as SVGSVGElement,
        clientX: cursorX,
        clientY: cursorY,
        deltaX: 0,
        deltaY: -100, // negative deltaY = zoom in (exp(1) ≈ 2.718x)
        ctrlKey: true,
        preventDefault: () => {},
      } as unknown as React.WheelEvent<SVGSVGElement>);
    });

    expect(result.current.viewport.scale).toBeGreaterThan(1);
    const worldXAfter = (cursorX - result.current.viewport.panX) / result.current.viewport.scale;
    const worldYAfter = (cursorY - result.current.viewport.panY) / result.current.viewport.scale;
    expect(worldXAfter).toBeCloseTo(worldXBefore, 5);
    expect(worldYAfter).toBeCloseTo(worldYBefore, 5);
  });

  it('wheel without ctrlKey pans by negated deltas', () => {
    const { result } = setupHook();
    const svg = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }) };
    act(() => {
      result.current.handlers.onWheel({
        currentTarget: svg as unknown as SVGSVGElement,
        clientX: 0,
        clientY: 0,
        deltaX: 30,
        deltaY: 20,
        ctrlKey: false,
        preventDefault: () => {},
      } as unknown as React.WheelEvent<SVGSVGElement>);
    });
    // Pan handler negates deltas (gesture-aligned direction).
    expect(result.current.viewport.panX).toBe(-30);
    expect(result.current.viewport.panY).toBe(-20);
    expect(result.current.viewport.scale).toBe(1);
  });

  it('pointer drag on a non-interactive target pans by the cursor delta', () => {
    const { result } = setupHook();
    // A plain element, not nested under a [data-state-id] or
    // .transition-edge-clickable group → drag should engage.
    const target = document.createElement('div');
    document.body.appendChild(target);
    const svg = {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      // The hook now reads the SVG's bounding rect on every
      // pointerdown/move so it can store pointer positions in
      // SVG-relative coordinates (needed for the pinch-anchor math).
      // Tests run against {left: 0, top: 0} so client coordinates pass
      // through unchanged — pan deltas are unaffected.
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };

    act(() => {
      result.current.handlers.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        target,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });

    act(() => {
      result.current.handlers.onPointerMove({
        pointerId: 1,
        clientX: 140,
        clientY: 125,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });

    expect(result.current.viewport.panX).toBe(40);
    expect(result.current.viewport.panY).toBe(25);

    act(() => {
      result.current.handlers.onPointerUp({
        pointerId: 1,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
  });

  it('pointer down on a state-node target does NOT start a drag', () => {
    const { result } = setupHook();
    const node = document.createElement('div');
    node.setAttribute('data-state-id', '0');
    const inner = document.createElement('span');
    node.appendChild(inner);
    document.body.appendChild(node);
    const svg = {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      // The hook now reads the SVG's bounding rect on every
      // pointerdown/move so it can store pointer positions in
      // SVG-relative coordinates (needed for the pinch-anchor math).
      // Tests run against {left: 0, top: 0} so client coordinates pass
      // through unchanged — pan deltas are unaffected.
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };

    act(() => {
      result.current.handlers.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        target: inner,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
    // Subsequent move should NOT pan because the drag never engaged.
    act(() => {
      result.current.handlers.onPointerMove({
        pointerId: 1,
        clientX: 200,
        clientY: 200,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
    expect(result.current.viewport).toEqual({ scale: 1, panX: 0, panY: 0 });
  });

  it('two-pointer pinch scales around the gesture midpoint', () => {
    // Pointers down at (100, 100) and (200, 100) → midpoint (150, 100),
    // distance 100. Then pointer 2 moves to (250, 100) → distance 150
    // (scale factor 1.5) and midpoint (175, 100). The world point that
    // was under (150, 100) should still be under (175, 100) after the
    // transform — that's the anchor-at-prev-midpoint + translate-to-
    // next-midpoint formulation.
    const { result } = setupHook();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const svg = {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
    act(() => {
      result.current.handlers.onPointerDown({
        button: 0, pointerId: 1, clientX: 100, clientY: 100,
        target, currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
    act(() => {
      result.current.handlers.onPointerDown({
        button: 0, pointerId: 2, clientX: 200, clientY: 100,
        target, currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
    act(() => {
      result.current.handlers.onPointerMove({
        pointerId: 2, clientX: 250, clientY: 100,
        currentTarget: svg as unknown as SVGSVGElement,
      } as unknown as React.PointerEvent<SVGSVGElement>);
    });
    // worldX at prev-mid (150, 100), scale 1, pan 0 → world = (150, 100).
    // newScale = 1.5; newPanX = nextMid.x - world.x * newScale
    //          = 175 - 150 * 1.5 = -50; newPanY = 100 - 100 * 1.5 = -50.
    expect(result.current.viewport.scale).toBeCloseTo(1.5, 5);
    expect(result.current.viewport.panX).toBeCloseTo(-50, 5);
    expect(result.current.viewport.panY).toBeCloseTo(-50, 5);
  });

  it('fitToContent scales content to fit viewport with padding and centers it', () => {
    // Content 800x600 in a 1000x800 viewport. fitToContent uses
    // DISPLAY_FIT_PADDING=180 (relaxed) so a Fit click lands on the
    // same scale the % chip displays as 100%.
    //   available = 640x440; fitScale = min(0.8, 0.7333) = 0.7333.
    //   panX = (1000 - 586.67)/2 ≈ 206.67; panY = (800 - 440)/2 = 180.
    const { result } = setupHook({ contentBoundingBox: STANDARD_BOX, viewportSize: STANDARD_VIEWPORT });
    act(() => result.current.fitToContent());
    expect(result.current.viewport.scale).toBeCloseTo(0.7333, 3);
    expect(result.current.viewport.panX).toBeCloseTo(206.67, 1);
    expect(result.current.viewport.panY).toBeCloseTo(180, 1);
  });

  it('fitToContent is a no-op if content or viewport is unknown', () => {
    const { result } = setupHook({ contentBoundingBox: null });
    act(() => result.current.fitToContent());
    expect(result.current.viewport).toEqual({ scale: 1, panX: 0, panY: 0 });
  });
});

describe('clampViewport (centroid-in-viewport policy)', () => {
  const SMALL_BOX = { width: 400, height: 300 };
  const BIG_BOX = { width: 2000, height: 1500 };
  const VIEW = { width: 1000, height: 800 };

  it('returns the viewport unchanged when content or viewport is null', () => {
    const v = { scale: 1, panX: 50, panY: 50 };
    expect(clampViewport(v, null, VIEW)).toBe(v);
    expect(clampViewport(v, SMALL_BOX, null)).toBe(v);
  });

  it('returns the viewport unchanged when content has zero size', () => {
    const v = { scale: 1, panX: 50, panY: 50 };
    expect(clampViewport(v, { width: 0, height: 0 }, VIEW)).toBe(v);
  });

  it('allows free pan within the centroid-in-viewport range for small content', () => {
    // 400x300 content in 1000x800 viewport at scale 1.
    // Centroid x = panX + 200; constraint 0 ≤ centroid ≤ 1000 → panX ∈ [-200, 800]
    // Centroid y = panY + 150; constraint 0 ≤ centroid ≤ 800  → panY ∈ [-150, 650]
    // Mid-range pan stays untouched.
    const v = { scale: 1, panX: 100, panY: 100 };
    expect(clampViewport(v, SMALL_BOX, VIEW)).toBe(v);
  });

  it('clamps pan to the centroid bounds when out of range', () => {
    // SMALL_BOX in VIEW: panX ∈ [-200, 800], panY ∈ [-150, 650]
    expect(clampViewport({ scale: 1, panX: 9999, panY: -9999 }, SMALL_BOX, VIEW)).toEqual({
      scale: 1, panX: 800, panY: -150,
    });
    expect(clampViewport({ scale: 1, panX: -9999, panY: 9999 }, SMALL_BOX, VIEW)).toEqual({
      scale: 1, panX: -200, panY: 650,
    });
  });

  it('large content: same centroid-in-viewport rule, content edges may extend off-screen', () => {
    // 2000x1500 content in 1000x800: centroid x = panX + 1000 ∈ [0, 1000]
    // → panX ∈ [-1000, 0]. Similarly panY ∈ [-750, 50].
    expect(clampViewport({ scale: 1, panX: 500, panY: 500 }, BIG_BOX, VIEW)).toEqual({
      scale: 1, panX: 0, panY: 50,
    });
    expect(clampViewport({ scale: 1, panX: -2000, panY: -2000 }, BIG_BOX, VIEW)).toEqual({
      scale: 1, panX: -1000, panY: -750,
    });
    // In-range stays put.
    expect(clampViewport({ scale: 1, panX: -300, panY: -200 }, BIG_BOX, VIEW)).toEqual({
      scale: 1, panX: -300, panY: -200,
    });
  });

  it('returns the same reference when no change is needed (no-op short-circuit)', () => {
    const v = { scale: 1, panX: -300, panY: -200 };
    const out = clampViewport(v, BIG_BOX, VIEW);
    expect(out).toBe(v);
  });

  it('respects the active scale when computing scaled extents', () => {
    // 400x300 content at scale 4 → 1600x1200.
    // Centroid x = panX + 800; panX ∈ [-800, 200]. Centroid y = panY + 600; panY ∈ [-600, 200].
    const out = clampViewport({ scale: 4, panX: 9999, panY: 9999 }, SMALL_BOX, VIEW);
    expect(out.scale).toBe(4);
    expect(out.panX).toBe(200);
    expect(out.panY).toBe(200);
  });

  it('regression: small content does NOT snap to center when pan is mid-range', () => {
    // The prior 'centered slack' policy would forcibly recenter here,
    // breaking drag-pan. Verify the centroid policy lets it through.
    const v = { scale: 1, panX: 50, panY: -50 };
    expect(clampViewport(v, SMALL_BOX, VIEW)).toBe(v);
  });
});
