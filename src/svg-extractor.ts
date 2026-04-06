/**
 * SVG geometry extraction using SVG-native APIs.
 * This is a SEPARATE path from HTML extraction — SVG never uses getBoxQuads.
 */
import type { Point, Quad, Style, IRNode, Options } from "./types.js";
import { extractStyle } from "./traversal.js";

/** Number of sample points for path/circle/ellipse approximation. */
const PATH_SAMPLE_COUNT = 64;
const CIRCLE_SEGMENTS = 32;

/**
 * Extract geometry from an entire SVG subtree.
 * SVG DOM order defines paint order (z-index does not apply inside SVG).
 */
export function extractSVGSubtree(
  svgRoot: SVGSVGElement,
  baseZIndex: number,
  options: Options
): IRNode[] {
  const results: IRNode[] = [];
  let orderIndex = baseZIndex;

  walkSVGTree(svgRoot, results, () => orderIndex++, options);
  return results;
}

function walkSVGTree(
  el: Element,
  results: IRNode[],
  nextIndex: () => number,
  options: Options
): void {
  // Process this element if it's a renderable SVG shape
  if (el instanceof SVGGraphicsElement && el !== el.ownerSVGElement) {
    const nodes = extractSVGElement(el, nextIndex(), options);
    results.push(...nodes);
  }

  // Walk children (DOM order = paint order in SVG)
  for (const child of Array.from(el.children)) {
    walkSVGTree(child, results, nextIndex, options);
  }
}

/** Extract geometry from a single SVG element. */
function extractSVGElement(
  el: SVGGraphicsElement,
  zIndex: number,
  options: Options
): IRNode[] {
  const cs = getComputedStyle(el);
  const style = extractSVGStyle(cs, el);

  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "rect":
      return extractRect(el as SVGRectElement, style, zIndex);
    case "circle":
      return extractCircle(el as SVGCircleElement, style, zIndex);
    case "ellipse":
      return extractEllipse(el as SVGEllipseElement, style, zIndex);
    case "line":
      return extractLine(el as SVGLineElement, style, zIndex);
    case "polyline":
      return extractPolyline(el as SVGPolylineElement, style, zIndex, false);
    case "polygon":
      return extractPolyline(el as SVGPolygonElement, style, zIndex, true);
    case "path":
      return extractPath(el as SVGPathElement, style, zIndex);
    case "text":
      if (options.includeText !== false) {
        return extractText(el as SVGTextElement, style, zIndex);
      }
      return [];
    default:
      return [];
  }
}

/** Extract SVG-specific styles. */
function extractSVGStyle(cs: CSSStyleDeclaration, el: SVGGraphicsElement): Style {
  const base = extractStyle(cs);
  // SVG uses fill/stroke attributes directly
  const fill = cs.fill || el.getAttribute("fill") || undefined;
  const stroke = cs.stroke || el.getAttribute("stroke") || undefined;
  const strokeWidth = cs.strokeWidth || el.getAttribute("stroke-width") || undefined;
  return {
    ...base,
    fill: fill !== "none" ? fill : undefined,
    stroke: stroke !== "none" ? stroke : undefined,
    strokeWidth,
  };
}

/** Apply the CTM (current transformation matrix) to a point. */
function applyCtm(point: Point, ctm: DOMMatrix): Point {
  return {
    x: ctm.a * point.x + ctm.c * point.y + ctm.e,
    y: ctm.b * point.x + ctm.d * point.y + ctm.f,
  };
}

/** Get the CTM for an SVG element, falling back to identity. */
function getCtm(el: SVGGraphicsElement): DOMMatrix {
  try {
    const ctm = el.getCTM();
    if (ctm) return ctm;
  } catch {
    // Fallback
  }
  return new DOMMatrix();
}

/** Transform an array of points using CTM. */
function transformPoints(points: Point[], el: SVGGraphicsElement): Point[] {
  const ctm = getCtm(el);
  return points.map((p) => applyCtm(p, ctm));
}

/** Convert 4 corner points to a Quad. */
function rectToQuad(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function extractRect(el: SVGRectElement, style: Style, zIndex: number): IRNode[] {
  const x = el.x.baseVal.value;
  const y = el.y.baseVal.value;
  const w = el.width.baseVal.value;
  const h = el.height.baseVal.value;

  if (w === 0 || h === 0) return [];

  const rawQuad = rectToQuad(x, y, w, h);
  const transformed = transformPoints(rawQuad, el) as Quad;

  return [{ type: "polygon", points: transformed, style, zIndex }];
}

function extractCircle(el: SVGCircleElement, style: Style, zIndex: number): IRNode[] {
  const cx = el.cx.baseVal.value;
  const cy = el.cy.baseVal.value;
  const r = el.r.baseVal.value;

  if (r === 0) return [];

  const points: Point[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }

  const transformed = transformPoints(points, el);
  return [{ type: "polyline", points: transformed, closed: true, style, zIndex }];
}

function extractEllipse(el: SVGEllipseElement, style: Style, zIndex: number): IRNode[] {
  const cx = el.cx.baseVal.value;
  const cy = el.cy.baseVal.value;
  const rx = el.rx.baseVal.value;
  const ry = el.ry.baseVal.value;

  if (rx === 0 || ry === 0) return [];

  const points: Point[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }

  const transformed = transformPoints(points, el);
  return [{ type: "polyline", points: transformed, closed: true, style, zIndex }];
}

function extractLine(el: SVGLineElement, style: Style, zIndex: number): IRNode[] {
  const p1: Point = { x: el.x1.baseVal.value, y: el.y1.baseVal.value };
  const p2: Point = { x: el.x2.baseVal.value, y: el.y2.baseVal.value };

  const transformed = transformPoints([p1, p2], el);
  return [{ type: "polyline", points: transformed, closed: false, style, zIndex }];
}

function extractPolyline(
  el: SVGPolylineElement | SVGPolygonElement,
  style: Style,
  zIndex: number,
  closed: boolean
): IRNode[] {
  const points: Point[] = [];
  const numPoints = el.points.numberOfItems;

  for (let i = 0; i < numPoints; i++) {
    const pt = el.points.getItem(i);
    points.push({ x: pt.x, y: pt.y });
  }

  if (points.length === 0) return [];

  const transformed = transformPoints(points, el);
  return [{ type: "polyline", points: transformed, closed, style, zIndex }];
}

function extractPath(el: SVGPathElement, style: Style, zIndex: number): IRNode[] {
  // Try getPathData if available (modern API)
  if (typeof (el as any).getPathData === "function") {
    return extractPathFromPathData(el, style, zIndex);
  }

  // Fallback: sample via getPointAtLength
  return extractPathBySampling(el, style, zIndex);
}

function extractPathFromPathData(
  el: SVGPathElement,
  style: Style,
  zIndex: number
): IRNode[] {
  // getPathData returns normalized path segments
  // Still sample for consistent output
  return extractPathBySampling(el, style, zIndex);
}

function extractPathBySampling(
  el: SVGPathElement,
  style: Style,
  zIndex: number
): IRNode[] {
  let totalLength: number;
  try {
    totalLength = el.getTotalLength();
  } catch {
    return [];
  }

  if (totalLength === 0) return [];

  const points: Point[] = [];
  const sampleCount = Math.max(PATH_SAMPLE_COUNT, Math.ceil(totalLength / 2));

  for (let i = 0; i <= sampleCount; i++) {
    const len = (totalLength * i) / sampleCount;
    const pt = el.getPointAtLength(len);
    points.push({ x: pt.x, y: pt.y });
  }

  const transformed = transformPoints(points, el);
  return [{ type: "polyline", points: transformed, closed: false, style, zIndex }];
}

function extractText(el: SVGTextElement, style: Style, zIndex: number): IRNode[] {
  const bbox = el.getBBox();
  if (bbox.width === 0 && bbox.height === 0) return [];

  const rawQuad = rectToQuad(bbox.x, bbox.y, bbox.width, bbox.height);
  const transformed = transformPoints(rawQuad, el) as Quad;

  const text = el.textContent ?? "";

  return [{ type: "text", quad: transformed, text, style, zIndex }];
}
