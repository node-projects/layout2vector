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
  const ctm = getCtm(el);
  const style = extractSVGStyle(cs, el, ctm);

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

/** Extract SVG-specific styles, scaling stroke width by the CTM. */
function extractSVGStyle(cs: CSSStyleDeclaration, el: SVGGraphicsElement, ctm: DOMMatrix): Style {
  const base = extractStyle(cs);
  // SVG uses fill/stroke attributes directly
  let fill = cs.fill || el.getAttribute("fill") || undefined;
  const stroke = cs.stroke || el.getAttribute("stroke") || undefined;
  let strokeWidth = cs.strokeWidth || el.getAttribute("stroke-width") || undefined;

  // Scale stroke width by the CTM's average scale factor.
  // The CSS/attribute strokeWidth is in the element's local coordinate space,
  // but extracted points are in screen coordinates after CTM transformation.
  if (strokeWidth) {
    const sw = parseFloat(strokeWidth);
    if (!isNaN(sw) && sw > 0) {
      // Geometric mean of the CTM's x and y scale factors
      const sx = Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b);
      const sy = Math.sqrt(ctm.c * ctm.c + ctm.d * ctm.d);
      const scale = Math.sqrt(sx * sy);
      strokeWidth = `${sw * scale}px`;
    }
  }

  // Resolve url(#id) gradient references to a solid color
  if (fill && fill.startsWith("url(")) {
    fill = resolveGradientColor(fill, el) ?? fill;
  }

  return {
    ...base,
    fill: fill !== "none" ? fill : undefined,
    stroke: stroke !== "none" ? stroke : undefined,
    strokeWidth,
  };
}

/** Resolve a url(#id) gradient reference to its first stop color. */
function resolveGradientColor(urlRef: string, el: SVGGraphicsElement): string | undefined {
  const match = urlRef.match(/url\(["']?#([^"')]+)["']?\)/);
  if (!match) return undefined;
  const id = match[1];
  const ownerSvg = el.ownerSVGElement;
  if (!ownerSvg) return undefined;
  const gradEl = ownerSvg.querySelector(`#${id}`);
  if (!gradEl) return undefined;
  // Get stop colors from the gradient
  const stops = gradEl.querySelectorAll("stop");
  if (stops.length === 0) return undefined;
  // Use the first stop's color as a representative solid color
  const stopColor = (stops[0] as SVGStopElement).getAttribute("stop-color")
    ?? getComputedStyle(stops[0]).stopColor;
  return stopColor || undefined;
}

/** Apply the CTM (current transformation matrix) to a point. */
function applyCtm(point: Point, ctm: DOMMatrix): Point {
  return {
    x: ctm.a * point.x + ctm.c * point.y + ctm.e,
    y: ctm.b * point.x + ctm.d * point.y + ctm.f,
  };
}

/** Get the screen CTM for an SVG element (maps to page coordinates), falling back to identity. */
function getCtm(el: SVGGraphicsElement): DOMMatrix {
  try {
    // getScreenCTM maps from element coords to page/screen coords
    const ctm = el.getScreenCTM();
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
  const results: IRNode[] = [{ type: "polyline", points: transformed, closed: false, style, zIndex }];
  results.push(...extractMarkers(el, transformed, style, zIndex));
  return results;
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
  const results: IRNode[] = [{ type: "polyline", points: transformed, closed, style, zIndex }];
  results.push(...extractMarkers(el, transformed, style, zIndex));
  return results;
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
  const results: IRNode[] = [{ type: "polyline", points: transformed, closed: false, style, zIndex }];
  results.push(...extractMarkers(el, transformed, style, zIndex));
  return results;
}

/**
 * Extract SVG marker geometry and place it at the appropriate position/rotation.
 * Handles marker-start, marker-mid, and marker-end.
 */
function extractMarkers(
  el: SVGGraphicsElement,
  points: Point[],
  style: Style,
  zIndex: number
): IRNode[] {
  if (points.length < 2) return [];

  const cs = getComputedStyle(el);
  const markerStart = cs.getPropertyValue("marker-start").trim() || el.getAttribute("marker-start") || "";
  const markerMid = cs.getPropertyValue("marker-mid").trim() || el.getAttribute("marker-mid") || "";
  const markerEnd = cs.getPropertyValue("marker-end").trim() || el.getAttribute("marker-end") || "";

  const results: IRNode[] = [];
  const ownerSvg = (el as any).ownerSVGElement as SVGSVGElement | null;
  if (!ownerSvg) return [];

  function resolveMarker(ref: string): SVGMarkerElement | null {
    if (!ref || ref === "none") return null;
    const m = ref.match(/url\(["']?#([^"')]+)["']?\)/);
    if (!m) return null;
    return ownerSvg!.querySelector(`#${m[1]}`) as SVGMarkerElement | null;
  }

  function placeMarker(marker: SVGMarkerElement, pos: Point, angle: number): void {
    // Parse marker attributes
    const vb = marker.viewBox.baseVal;
    const mw = marker.markerWidth.baseVal.value || 3;
    const mh = marker.markerHeight.baseVal.value || 3;
    const refX = marker.refX.baseVal.value;
    const refY = marker.refY.baseVal.value;

    // Compute scale from viewBox to marker size
    const vbW = vb?.width || mw;
    const vbH = vb?.height || mh;
    const scaleX = mw / vbW;
    const scaleY = mh / vbH;

    // Get stroke width for markerUnits="strokeWidth" (default)
    const sw = parseFloat(cs.strokeWidth) || 1;

    // Build transform: translate to position, rotate, scale by strokeWidth and viewBox ratio
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const s = sw; // markerUnits="strokeWidth" multiplier

    // Extract shapes from marker children
    for (const child of Array.from(marker.children)) {
      if (child instanceof SVGPathElement) {
        let totalLength: number;
        try { totalLength = child.getTotalLength(); } catch { continue; }
        if (totalLength === 0) continue;

        const rawPts: Point[] = [];
        const sampleCount = Math.max(32, Math.ceil(totalLength / 2));
        for (let i = 0; i <= sampleCount; i++) {
          const pt = child.getPointAtLength((totalLength * i) / sampleCount);
          rawPts.push({ x: pt.x, y: pt.y });
        }

        // Transform: shift by -refX/-refY, scale, rotate, translate to position
        const transformed = rawPts.map(p => {
          const lx = (p.x - refX) * scaleX * s;
          const ly = (p.y - refY) * scaleY * s;
          return {
            x: pos.x + lx * cosA - ly * sinA,
            y: pos.y + lx * sinA + ly * cosA,
          };
        });

        // Get marker shape's fill
        const childCs = getComputedStyle(child);
        const childFill = childCs.fill || child.getAttribute("fill") || undefined;
        const childStroke = childCs.stroke || child.getAttribute("stroke") || undefined;
        const markerStyle: Style = {
          ...style,
          fill: childFill !== "none" ? childFill : undefined,
          stroke: childStroke !== "none" ? childStroke : undefined,
        };

        results.push({ type: "polyline", points: transformed, closed: true, style: markerStyle, zIndex });
      } else if (child instanceof SVGPolygonElement || child instanceof SVGPolylineElement) {
        const rawPts: Point[] = [];
        for (let i = 0; i < child.points.numberOfItems; i++) {
          const pt = child.points.getItem(i);
          rawPts.push({ x: pt.x, y: pt.y });
        }
        const transformed = rawPts.map(p => {
          const lx = (p.x - refX) * scaleX * s;
          const ly = (p.y - refY) * scaleY * s;
          return {
            x: pos.x + lx * cosA - ly * sinA,
            y: pos.y + lx * sinA + ly * cosA,
          };
        });
        const childCs = getComputedStyle(child);
        const childFill = childCs.fill || child.getAttribute("fill") || undefined;
        const markerStyle: Style = { ...style, fill: childFill !== "none" ? childFill : undefined };
        results.push({ type: "polyline", points: transformed, closed: child instanceof SVGPolygonElement, style: markerStyle, zIndex });
      }
    }
  }

  // marker-start: place at first point, angle from first segment
  const startMarker = resolveMarker(markerStart);
  if (startMarker) {
    const angle = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
    placeMarker(startMarker, points[0], angle);
  }

  // marker-end: place at last point, angle from last segment
  const endMarker = resolveMarker(markerEnd);
  if (endMarker && points.length >= 2) {
    const n = points.length;
    const angle = Math.atan2(points[n - 1].y - points[n - 2].y, points[n - 1].x - points[n - 2].x);
    placeMarker(endMarker, points[n - 1], angle);
  }

  // marker-mid: place at all middle points
  const midMarker = resolveMarker(markerMid);
  if (midMarker) {
    for (let i = 1; i < points.length - 1; i++) {
      const angle = Math.atan2(points[i + 1].y - points[i - 1].y, points[i + 1].x - points[i - 1].x);
      placeMarker(midMarker, points[i], angle);
    }
  }

  return results;
}

function extractText(el: SVGTextElement, style: Style, zIndex: number): IRNode[] {
  const bbox = el.getBBox();
  if (bbox.width === 0 && bbox.height === 0) return [];

  const rawQuad = rectToQuad(bbox.x, bbox.y, bbox.width, bbox.height);
  const transformed = transformPoints(rawQuad, el) as Quad;

  const text = el.textContent ?? "";

  return [{ type: "text", quad: transformed, text, style, zIndex }];
}
