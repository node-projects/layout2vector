/**
 * Shared geometry utilities.
 * All coordinate extraction goes through getBoxQuads for consistency —
 * if the polyfill has a systematic offset, using it everywhere ensures
 * relative positions between elements remain correct.
 */
import type { Point, Quad } from "./types.js";

/**
 * Get an element's border-box quad via getBoxQuads.
 * Returns null if the element has zero area.
 */
export function getElementQuad(el: Element, box: "border" | "content" = "border"): Quad | null {
  if ("getBoxQuads" in el && typeof (el as any).getBoxQuads === "function") {
    try {
      const rawQuads: DOMQuad[] = (el as any).getBoxQuads({ box });
      if (rawQuads.length > 0) {
        const q = rawQuads[0];
        const quad: Quad = [
          { x: q.p1.x, y: q.p1.y },
          { x: q.p2.x, y: q.p2.y },
          { x: q.p3.x, y: q.p3.y },
          { x: q.p4.x, y: q.p4.y },
        ];
        if (!hasArea(quad)) return null;
        return quad;
      }
    } catch { /* fall through */ }
  }
  // Fallback (should not happen when polyfill is loaded)
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return [
    { x: r.left, y: r.top },
    { x: r.right, y: r.top },
    { x: r.right, y: r.bottom },
    { x: r.left, y: r.bottom },
  ];
}

/**
 * Get all quads for an element (multi-fragment elements may return several).
 */
export function getElementQuads(el: Element, box: "border" | "content" = "border"): Quad[] {
  if ("getBoxQuads" in el && typeof (el as any).getBoxQuads === "function") {
    try {
      const rawQuads: DOMQuad[] = (el as any).getBoxQuads({ box });
      return rawQuads.map(domQuadToQuad).filter(hasArea);
    } catch { /* fall through */ }
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return [];
  return [[
    { x: r.left, y: r.top },
    { x: r.right, y: r.top },
    { x: r.right, y: r.bottom },
    { x: r.left, y: r.bottom },
  ]];
}

/**
 * Get all quads for any DOM node (Element, Text, or Range) via getBoxQuads.
 * Text nodes and Ranges support getBoxQuads natively.
 */
export function getNodeQuads(node: Element | Text | Range, box: "border" | "content" = "border"): Quad[] {
  if ("getBoxQuads" in node && typeof (node as any).getBoxQuads === "function") {
    try {
      const rawQuads: DOMQuad[] = (node as any).getBoxQuads({ box });
      return rawQuads.map(domQuadToQuad).filter(hasArea);
    } catch { /* fall through */ }
  }
  // Fallback for Text nodes: use Range.getClientRects()
  if ("nodeType" in node && node.nodeType === 3 /* Node.TEXT_NODE */) {
    const textNode = node as Text;
    const range = (textNode.ownerDocument ?? document).createRange();
    range.selectNodeContents(textNode);
    return rectsToQuads(range.getClientRects());
  }
  // Fallback for Range
  if (!("nodeType" in node)) {
    return rectsToQuads((node as Range).getClientRects());
  }
  const r = (node as Element).getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return [];
  return [[
    { x: r.left, y: r.top },
    { x: r.right, y: r.top },
    { x: r.right, y: r.bottom },
    { x: r.left, y: r.bottom },
  ]];
}

function rectsToQuads(rects: DOMRectList): Quad[] {
  const quads: Quad[] = [];
  for (const r of rects) {
    if (r.width === 0 && r.height === 0) continue;
    quads.push([
      { x: r.left, y: r.top },
      { x: r.right, y: r.top },
      { x: r.right, y: r.bottom },
      { x: r.left, y: r.bottom },
    ]);
  }
  return quads;
}

/** Get the top-left corner of an element's border box via getBoxQuads. */
export function getElementOrigin(el: Element): Point {
  const q = getElementQuad(el);
  return q ? q[0] : { x: 0, y: 0 };
}

/** Width and height derived from a quad (distance between corners). */
export function quadSize(q: Quad): { width: number; height: number } {
  const w = Math.sqrt((q[1].x - q[0].x) ** 2 + (q[1].y - q[0].y) ** 2);
  const h = Math.sqrt((q[3].x - q[0].x) ** 2 + (q[3].y - q[0].y) ** 2);
  return { width: w, height: h };
}

/**
 * Build an SVG CTM that maps from SVG user units to screen coordinates,
 * anchored to the SVG root's getBoxQuads position instead of getScreenCTM.
 * This ensures SVG content aligns with HTML content from getBoxQuads.
 */
export function getSvgScreenCtm(el: SVGGraphicsElement): DOMMatrix {
  try {
    const screenCtm = el.getScreenCTM();
    if (!screenCtm) return new DOMMatrix();

    // Get the SVG root element
    const svgRoot = el.ownerSVGElement;
    if (!svgRoot) return screenCtm;

    // Compare the SVG root's position from getBoundingClientRect (screen coords)
    // with getBoxQuads (which may come from a polyfill and differ).
    // We use BCR — not rootScreenCtm.e/f — because the root's getScreenCTM()
    // includes viewBox/preserveAspectRatio offsets which are NOT the element's
    // visual top-left corner.
    const bcr = svgRoot.getBoundingClientRect();
    const boxOrigin = getElementOrigin(svgRoot);

    // Only apply adjustment if boxQuads and BCR agree (polyfill is reliable).
    // If they disagree (polyfill bug, e.g. body margin offset), trust screenCtm.
    if (Math.abs(boxOrigin.x - bcr.left) > 1 || Math.abs(boxOrigin.y - bcr.top) > 1) {
      return screenCtm;
    }

    const dx = boxOrigin.x - bcr.left;
    const dy = boxOrigin.y - bcr.top;

    // If there's no difference, skip the adjustment
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return screenCtm;

    // Shift the CTM's translation to align with getBoxQuads
    const adjusted = new DOMMatrix([
      screenCtm.a, screenCtm.b,
      screenCtm.c, screenCtm.d,
      screenCtm.e + dx, screenCtm.f + dy,
    ]);
    return adjusted;
  } catch {
    return new DOMMatrix();
  }
}

/** Check if a quad has non-zero area. */
function hasArea(q: Quad): boolean {
  const ax = q[1].x - q[0].x, ay = q[1].y - q[0].y;
  const bx = q[3].x - q[0].x, by = q[3].y - q[0].y;
  return Math.abs(ax * by - ay * bx) > 0.01;
}

function domQuadToQuad(dq: DOMQuad): Quad {
  return [
    { x: dq.p1.x, y: dq.p1.y },
    { x: dq.p2.x, y: dq.p2.y },
    { x: dq.p3.x, y: dq.p3.y },
    { x: dq.p4.x, y: dq.p4.y },
  ];
}

/**
 * Compute rounded corner points for a quad polygon.
 * Each corner is replaced by arc-approximation points (quadratic Bezier control points).
 * Returns an array of {type, x, y} segments for building SVG/Canvas/PDF paths.
 *
 * Segment types: 'M' (moveTo), 'L' (lineTo), 'Q' (quadratic bezier: cx, cy, then endX, endY)
 */
export type PathSegment =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "Q"; cx: number; cy: number; x: number; y: number };

export function roundedQuadPath(points: Quad, radius: number): PathSegment[] {
  const N = 4;
  const segments: PathSegment[] = [];

  // Pre-compute clamped radius per corner (cannot exceed half of shortest adjacent edge)
  const radii: number[] = [];
  for (let i = 0; i < N; i++) {
    const prev = points[(i + N - 1) % N];
    const curr = points[i];
    const next = points[(i + 1) % N];
    const toPrevLen = Math.sqrt((prev.x - curr.x) ** 2 + (prev.y - curr.y) ** 2);
    const toNextLen = Math.sqrt((next.x - curr.x) ** 2 + (next.y - curr.y) ** 2);
    radii.push(Math.min(radius, toPrevLen / 2, toNextLen / 2));
  }

  for (let i = 0; i < N; i++) {
    const prev = points[(i + N - 1) % N];
    const curr = points[i];
    const next = points[(i + 1) % N];
    const r = radii[i];

    const toPrevLen = Math.sqrt((prev.x - curr.x) ** 2 + (prev.y - curr.y) ** 2);
    const toNextLen = Math.sqrt((next.x - curr.x) ** 2 + (next.y - curr.y) ** 2);

    // Point where the arc starts (on the edge from prev to curr, near curr)
    const arcStartX = curr.x + (prev.x - curr.x) / toPrevLen * r;
    const arcStartY = curr.y + (prev.y - curr.y) / toPrevLen * r;
    // Point where the arc ends (on the edge from curr to next, near curr)
    const arcEndX = curr.x + (next.x - curr.x) / toNextLen * r;
    const arcEndY = curr.y + (next.y - curr.y) / toNextLen * r;

    if (i === 0) {
      segments.push({ type: "M", x: arcStartX, y: arcStartY });
    } else {
      segments.push({ type: "L", x: arcStartX, y: arcStartY });
    }
    // Quadratic bezier through the original corner point
    segments.push({ type: "Q", cx: curr.x, cy: curr.y, x: arcEndX, y: arcEndY });
  }

  return segments;
}
