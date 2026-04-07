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

    // Get the SVG root's position via getScreenCTM (maps SVG (0,0) to screen)
    const svgRoot = el.ownerSVGElement;
    if (!svgRoot) return screenCtm;

    const rootScreenCtm = svgRoot.getScreenCTM();
    if (!rootScreenCtm) return screenCtm;

    // Where getScreenCTM places the SVG root's origin
    const screenOrigin = { x: rootScreenCtm.e, y: rootScreenCtm.f };

    // Where getBoxQuads places the SVG root's origin
    const boxOrigin = getElementOrigin(svgRoot);

    // Compute the offset between the two coordinate systems
    const dx = boxOrigin.x - screenOrigin.x;
    const dy = boxOrigin.y - screenOrigin.y;

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
