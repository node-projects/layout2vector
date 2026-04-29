/**
 * DOM traversal with stacking context awareness.
 */
import type { ClipQuad, Quad, Style } from "./types.js";
import { getElementQuad } from "./geometry.js";

type CoordinateTransform = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY_TRANSFORM: CoordinateTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function createsOverflowClip(overflow: string | undefined): boolean {
  return overflow === "hidden"
    || overflow === "clip"
    || overflow === "scroll"
    || overflow === "auto"
    || overflow === "overlay";
}

/** Represents a node in the stacking context tree. */
export interface StackingNode {
  element: Element;
  style: CSSStyleDeclaration;
  extractedStyle: Style;
  createsStackingContext: boolean;
  children: StackingNode[];
  textNodes: Text[];
  zIndex: number;
  /** Accumulated outer-page transform for nested browsing contexts. */
  coordinateTransform: CoordinateTransform;
  /** Clip quads inherited from iframe viewports. */
  clipQuads?: ClipQuad[];
  /** Clip boundary from an ancestor with overflow:hidden + border-radius. */
  clipBounds?: { x: number; y: number; w: number; h: number; radius: number };
  /** Clip boundary that applies to this node's children and pseudo-elements. */
  childClipBounds?: { x: number; y: number; w: number; h: number; radius: number };
}

/**
 * Extract the first color stop from a CSS gradient string.
 * e.g. "linear-gradient(135deg, rgb(26, 35, 126), rgb(57, 73, 171))" → "rgb(26, 35, 126)"
 */
function extractGradientColor(bgImage: string): string | undefined {
  // Match rgb/rgba color values in the gradient
  const colorMatch = bgImage.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/);
  if (colorMatch) return colorMatch[0];
  // Match hex colors
  const hexMatch = bgImage.match(/#[0-9a-fA-F]{3,8}/);
  if (hexMatch) return hexMatch[0];
  return undefined;
}

/** Extract a subset of computed styles relevant to rendering. */
export function extractStyle(cs: CSSStyleDeclaration): Style {
  // Determine fill: prefer backgroundColor, fall back to gradient first color stop
  const bgColor = cs.backgroundColor;
  let fill: string | undefined = bgColor && bgColor !== "rgba(0, 0, 0, 0)" && bgColor !== "transparent"
    ? bgColor
    : undefined;
  const bgImage = cs.backgroundImage;
  const bgImageVal = bgImage || undefined;
  const maskVal = cs.getPropertyValue("mask")
    || cs.getPropertyValue("-webkit-mask")
    || cs.getPropertyValue("mask-image")
    || cs.getPropertyValue("-webkit-mask-image")
    || undefined;

  // If backgroundColor is transparent but there's a gradient, extract its first color
  if ((!fill || fill === "rgba(0, 0, 0, 0)" || fill === "transparent") && bgImageVal && bgImageVal !== "none") {
    const gradientColor = extractGradientColor(bgImageVal);
    if (gradientColor) fill = gradientColor;
  }

  // Read opacity once
  const opacityStr = cs.opacity;
  const opacity = opacityStr ? parseFloat(opacityStr) : undefined;

  // Read z-index once
  const zIndexStr = cs.zIndex;
  const zIndex = zIndexStr && zIndexStr !== "auto" ? parseInt(zIndexStr, 10) : undefined;

  const result: Style = {
    fill,
    stroke: cs.borderColor || undefined,
    strokeWidth: cs.borderWidth || undefined,

    fontSize: cs.fontSize || undefined,
    fontFamily: cs.fontFamily || undefined,
    fontWeight: cs.fontWeight || undefined,
    fontStyle: cs.fontStyle || undefined,
    color: cs.color || undefined,
    textDecoration: cs.textDecoration || undefined,
    textAlign: cs.textAlign || undefined,
    textTransform: cs.textTransform || undefined,
    textShadow: cs.textShadow || undefined,
    lineHeight: cs.lineHeight || undefined,
    letterSpacing: cs.letterSpacing || undefined,
    wordSpacing: cs.wordSpacing || undefined,
    textIndent: cs.textIndent || undefined,
    whiteSpace: cs.whiteSpace || undefined,
    wordBreak: cs.wordBreak || undefined,
    overflowWrap: cs.overflowWrap || undefined,

    direction: cs.direction || undefined,
    writingMode: cs.writingMode || undefined,

    outlineColor: cs.outlineColor || undefined,
    outlineWidth: cs.outlineWidth || undefined,
    outlineStyle: cs.outlineStyle || undefined,
    outlineOffset: cs.outlineOffset || undefined,
    filter: cs.filter && cs.filter !== "none" ? cs.filter : undefined,
    mixBlendMode: cs.mixBlendMode && cs.mixBlendMode !== "normal" ? cs.mixBlendMode : undefined,
    mask: maskVal && maskVal !== "none" ? maskVal : undefined,

    opacity,
    zIndex,

    borderTopColor: cs.borderTopColor || undefined,
    borderRightColor: cs.borderRightColor || undefined,
    borderBottomColor: cs.borderBottomColor || undefined,
    borderLeftColor: cs.borderLeftColor || undefined,
    borderTopWidth: cs.borderTopWidth || undefined,
    borderRightWidth: cs.borderRightWidth || undefined,
    borderBottomWidth: cs.borderBottomWidth || undefined,
    borderLeftWidth: cs.borderLeftWidth || undefined,
    borderTopStyle: cs.borderTopStyle || undefined,
    borderRightStyle: cs.borderRightStyle || undefined,
    borderBottomStyle: cs.borderBottomStyle || undefined,
    borderLeftStyle: cs.borderLeftStyle || undefined,

    borderRadius: cs.borderRadius || undefined,
    backgroundImage: bgImageVal,
    boxShadow: cs.boxShadow || undefined,
    transform: cs.transform || undefined,
    overflow: cs.overflowX || undefined,
    textOverflow: cs.textOverflow || undefined,
    imageRendering: cs.imageRendering || undefined,
    clipPath: cs.clipPath && cs.clipPath !== "none" ? cs.clipPath : undefined,
  };

  // Read corner-shape per-corner values if supported
  const csTL = cs.getPropertyValue("corner-top-left-shape");
  const csTR = cs.getPropertyValue("corner-top-right-shape");
  const csBR = cs.getPropertyValue("corner-bottom-right-shape");
  const csBL = cs.getPropertyValue("corner-bottom-left-shape");
  if (csTL || csTR || csBR || csBL) {
    const shapes: [number, number, number, number] = [
      parseCornerShapeValue(csTL),
      parseCornerShapeValue(csTR),
      parseCornerShapeValue(csBR),
      parseCornerShapeValue(csBL),
    ];
    if (shapes.some(k => k !== 1)) {
      result.cornerShapes = shapes;
    }
  }

  return result;
}

/** Parse a single computed corner-shape value (e.g. "superellipse(2)") to its K number. */
function parseCornerShapeValue(v: string): number {
  if (!v) return 1;
  const trimmed = v.trim();
  if (!trimmed || trimmed === "round") return 1;
  const m = trimmed.match(/superellipse\(([^)]+)\)/);
  if (m) {
    const val = m[1].trim();
    if (val === "infinity") return Infinity;
    if (val === "-infinity") return -Infinity;
    const n = parseFloat(val);
    return isNaN(n) ? 1 : n;
  }
  switch (trimmed) {
    case "bevel": return 0;
    case "scoop": return -1;
    case "notch": return -Infinity;
    case "square": return Infinity;
    case "squircle": return 2;
    default: return 1;
  }
}

/** Check if an element is visible. */
export function isVisible(cs: CSSStyleDeclaration): boolean {
  if (cs.display === "none") return false;
  if (cs.visibility === "hidden") return false;
  if (cs.opacity === "0") return false;
  return true;
}

/** Determine if an element creates a new stacking context. */
export function createsStackingContext(cs: CSSStyleDeclaration): boolean {
  const position = cs.position;
  const zIndex = cs.zIndex;

  // position != static AND z-index != auto
  if (position !== "static" && zIndex !== "auto") return true;

  // opacity < 1
  if (cs.opacity && parseFloat(cs.opacity) < 1) return true;

  // transform != none
  if (cs.transform && cs.transform !== "none") return true;

  // filter != none
  if (cs.filter && cs.filter !== "none") return true;

  // perspective != none
  if (cs.perspective && cs.perspective !== "none") return true;

  // mix-blend-mode != normal
  if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return true;

  // will-change includes compositing properties
  if (cs.willChange) {
    const compositing = ["transform", "opacity", "filter", "perspective"];
    if (compositing.some((p) => cs.willChange.includes(p))) return true;
  }

  // contain: paint
  if (cs.contain && cs.contain.includes("paint")) return true;

  // isolation: isolate
  if (cs.isolation === "isolate") return true;

  return false;
}

/** Check if an element is an SVG element (not the root <svg> container in HTML context). */
export function isSVGElement(el: Element): boolean {
  return el.namespaceURI === "http://www.w3.org/2000/svg";
}

/** Check if an element is an SVG root (<svg> embedded in HTML). */
export function isSVGRoot(el: Element): boolean {
  return el.tagName.toLowerCase() === "svg" && el.namespaceURI === "http://www.w3.org/2000/svg";
}

/**
 * Traverse the DOM tree starting from a root element, building a stacking context tree.
 * Handles Shadow DOM (open roots) and skips invisible elements.
 */
export function traverseDOM(
  root: Element,
  includeInvisible = false,
  walkIframes = false
): StackingNode {
  return buildStackingNode(root, includeInvisible, 1, undefined, undefined, IDENTITY_TRANSFORM, walkIframes, undefined);
}

function buildStackingNode(
  element: Element,
  includeInvisible: boolean,
  parentOpacity: number,
  parentClipBounds: StackingNode["clipBounds"],
  parentClipPath: string | undefined,
  coordinateTransform: CoordinateTransform,
  walkIframes: boolean,
  parentClipQuads: ClipQuad[] | undefined
): StackingNode {
  const cs = getComputedStyle(element);
  const extractedStyleVal = extractStyle(cs);
  if (!extractedStyleVal.clipPath && parentClipPath) {
    extractedStyleVal.clipPath = parentClipPath;
  }
  const isCtx = createsStackingContext(cs);

  // Compute effective opacity by multiplying with parent's accumulated opacity
  const ownOpacity = extractedStyleVal.opacity ?? 1;
  const effectiveOpacity = parentOpacity * ownOpacity;
  extractedStyleVal.opacity = effectiveOpacity;

  const zVal =
    cs.zIndex && cs.zIndex !== "auto" ? parseInt(cs.zIndex, 10) : 0;

  const node: StackingNode = {
    element,
    style: cs,
    extractedStyle: extractedStyleVal,
    createsStackingContext: isCtx,
    children: [],
    textNodes: [],
    zIndex: zVal,
    coordinateTransform,
    clipQuads: parentClipQuads,
    clipBounds: parentClipBounds,
  };

  // Determine clip bounds for children: if this element has clipped or scrollable
  // overflow, children should be clipped to the visible scrollport boundary.
  let childClipBounds = parentClipBounds;
  const overflowX = cs.overflowX || cs.overflow;
  const overflowY = cs.overflowY || cs.overflow;
  if (createsOverflowClip(overflowX) || createsOverflowClip(overflowY)) {
    let rect = element.getBoundingClientRect();
    // Firefox returns height:0 for iframe body with overflow:hidden and only
    // absolutely-positioned children. Use the viewport dimensions instead.
    if ((rect.width === 0 || rect.height === 0) && element === element.ownerDocument.body) {
      const vw = element.ownerDocument.documentElement.clientWidth;
      const vh = element.ownerDocument.documentElement.clientHeight;
      rect = new DOMRect(rect.x, rect.y, vw, vh);
    }
    const bounds = getTransformedRectBounds(rect, coordinateTransform);
    const ownClipBounds = {
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      radius: parseBorderRadius(cs),
    };
    childClipBounds = childClipBounds
      ? intersectClipBounds(childClipBounds, ownClipBounds)
      : ownClipBounds;
  }
  node.childClipBounds = childClipBounds;
  const childClipPath = extractedStyleVal.clipPath ?? parentClipPath;

  // Determine which root to traverse children from
  const childRoot = (element.shadowRoot as ShadowRoot | null) ?? element;

  // Collect child nodes; for <slot> elements, use assigned nodes (slotted light DOM)
  let childNodes: Node[];
  if (element.tagName === 'SLOT' && (element as HTMLSlotElement).assignedNodes) {
    const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
    childNodes = assigned.length > 0 ? Array.from(assigned) : Array.from(childRoot.childNodes);
  } else {
    childNodes = Array.from(childRoot.childNodes);
  }

  for (const child of childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child as Text;
      if (text.textContent && text.textContent.trim().length > 0) {
        node.textNodes.push(text);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      const childCs = getComputedStyle(childEl);

      // display:none removes element and all descendants from layout — skip subtree.
      // opacity:0 makes the compositing layer fully transparent — skip subtree.
      // visibility:hidden hides the element but children can override with
      // visibility:visible, so the subtree must still be walked.
      if (!includeInvisible && (childCs.display === "none" || childCs.opacity === "0")) {
        continue;
      }

      node.children.push(buildStackingNode(childEl, includeInvisible, effectiveOpacity, childClipBounds, childClipPath, coordinateTransform, walkIframes, parentClipQuads));
    }
  }

  if (walkIframes && isHTMLIFrameElement(element)) {
    const iframeRoot = getIframeTraversalRoot(element);
    const iframeViewport = getIframeViewport(element, cs, coordinateTransform);
    if (iframeRoot && iframeViewport) {
      const iframeRootStyle = getComputedStyle(iframeRoot);
      if (includeInvisible || isVisible(iframeRootStyle)) {
        const iframeClipQuads = parentClipQuads
          ? [...parentClipQuads, iframeViewport.clipQuad]
          : [iframeViewport.clipQuad];
        node.children.push(
          buildStackingNode(
            iframeRoot,
            includeInvisible,
            effectiveOpacity,
            intersectClipBounds(childClipBounds, iframeViewport.clipBounds),
            childClipPath,
            iframeViewport.transform,
            walkIframes,
            iframeClipQuads,
          )
        );
      }
    }
  }

  return node;
}

function parseBorderRadius(cs: CSSStyleDeclaration): number {
  const borderRadius = cs.borderRadius;
  if (!borderRadius || borderRadius === "0px") return 0;

  const value = parseFloat(borderRadius);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isHTMLIFrameElement(element: Element): element is HTMLIFrameElement {
  return element.tagName.toLowerCase() === "iframe";
}

function getIframeTraversalRoot(element: HTMLIFrameElement): Element | null {
  try {
    const doc = element.contentDocument;
    if (!doc) return null;
    return doc.body ?? doc.documentElement;
  } catch {
    return null;
  }
}

function getIframeViewport(
  element: HTMLIFrameElement,
  cs: CSSStyleDeclaration,
  coordinateTransform: CoordinateTransform
): { transform: CoordinateTransform; clipBounds?: NonNullable<StackingNode["clipBounds"]>; clipQuad: ClipQuad } | null {
  const contentQuad = getElementQuad(element, "content");
  const radius = parseBorderRadius(cs);

  let transform: CoordinateTransform;
  let transformedQuad: Quad;

  if (contentQuad) {
    const viewportWidth = element.clientWidth;
    const viewportHeight = element.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return null;

    transformedQuad = transformQuad(contentQuad, coordinateTransform);
    transform = {
      a: (transformedQuad[1].x - transformedQuad[0].x) / viewportWidth,
      b: (transformedQuad[1].y - transformedQuad[0].y) / viewportWidth,
      c: (transformedQuad[3].x - transformedQuad[0].x) / viewportHeight,
      d: (transformedQuad[3].y - transformedQuad[0].y) / viewportHeight,
      e: transformedQuad[0].x,
      f: transformedQuad[0].y,
    };
  } else {
    const rect = element.getBoundingClientRect();
    const viewportWidth = element.clientWidth;
    const viewportHeight = element.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return null;

    const viewportQuad = rectToQuad(
      rect.left + element.clientLeft,
      rect.top + element.clientTop,
      viewportWidth,
      viewportHeight,
    );
    transformedQuad = transformQuad(viewportQuad, coordinateTransform);

    transform = composeCoordinateTransforms(coordinateTransform, {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: rect.left + element.clientLeft,
      f: rect.top + element.clientTop,
    });
  }

  const clipBounds = isAxisAlignedQuad(transformedQuad)
    ? {
        ...getBoundsFromPoints(transformedQuad),
        radius,
      }
    : undefined;

  return {
    transform,
    clipQuad: { points: transformedQuad, radius },
    clipBounds,
  };
}

function rectToQuad(x: number, y: number, width: number, height: number): Quad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function transformQuad(quad: Quad, coordinateTransform: CoordinateTransform): Quad {
  return quad.map((point) => applyCoordinateTransform(point, coordinateTransform)) as Quad;
}

function isAxisAlignedQuad(quad: Quad): boolean {
  const epsilon = 0.01;
  return (
    Math.abs(quad[0].y - quad[1].y) < epsilon &&
    Math.abs(quad[1].x - quad[2].x) < epsilon &&
    Math.abs(quad[2].y - quad[3].y) < epsilon &&
    Math.abs(quad[3].x - quad[0].x) < epsilon
  );
}

function intersectClipBounds(
  parent: StackingNode["clipBounds"],
  child: StackingNode["clipBounds"],
): StackingNode["clipBounds"] {
  if (!parent) return child;
  if (!child) return parent;

  const x = Math.max(parent.x, child.x);
  const y = Math.max(parent.y, child.y);
  const right = Math.min(parent.x + parent.w, child.x + child.w);
  const bottom = Math.min(parent.y + parent.h, child.y + child.h);
  const w = Math.max(0, right - x);
  const h = Math.max(0, bottom - y);

  if (w <= 0 || h <= 0) {
    return { x, y, w, h, radius: 0 };
  }

  const epsilon = 0.01;
  const matchesParent =
    Math.abs(parent.x - x) < epsilon &&
    Math.abs(parent.y - y) < epsilon &&
    Math.abs(parent.w - w) < epsilon &&
    Math.abs(parent.h - h) < epsilon;
  const matchesChild =
    Math.abs(child.x - x) < epsilon &&
    Math.abs(child.y - y) < epsilon &&
    Math.abs(child.w - w) < epsilon &&
    Math.abs(child.h - h) < epsilon;

  let radius = 0;
  if (matchesParent && matchesChild) {
    radius = Math.max(parent.radius, child.radius);
  } else if (matchesChild) {
    radius = child.radius;
  } else if (matchesParent) {
    radius = parent.radius;
  }

  return {
    x,
    y,
    w,
    h,
    radius,
  };
}

function composeCoordinateTransforms(
  outer: CoordinateTransform,
  inner: CoordinateTransform
): CoordinateTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

function applyCoordinateTransform(
  point: { x: number; y: number },
  transform: CoordinateTransform
): { x: number; y: number } {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  };
}

function getTransformedRectBounds(
  rect: DOMRect,
  coordinateTransform: CoordinateTransform
): { x: number; y: number; w: number; h: number } {
  return getBoundsFromPoints([
    applyCoordinateTransform({ x: rect.left, y: rect.top }, coordinateTransform),
    applyCoordinateTransform({ x: rect.right, y: rect.top }, coordinateTransform),
    applyCoordinateTransform({ x: rect.right, y: rect.bottom }, coordinateTransform),
    applyCoordinateTransform({ x: rect.left, y: rect.bottom }, coordinateTransform),
  ]);
}

function getBoundsFromPoints(points: Array<{ x: number; y: number }>): { x: number; y: number; w: number; h: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
  };
}

/**
 * Flatten the stacking context tree into paint order.
 * Within each stacking context:
 *   1. Negative z-index children
 *   2. In-flow non-positioned children (in DOM order)
 *   3. Positioned / z-index:auto / z-index:0 / stacking-context children
 *      in the auto/zero layer (in DOM order)
 *   4. Positive z-index children
 */
export function flattenStackingOrder(root: StackingNode): StackingNode[] {
  const result: StackingNode[] = [];
  collectInOrder(root, result);
  return result;
}

function paintsInAutoOrZeroLayer(node: StackingNode): boolean {
  return node.createsStackingContext || node.style.position !== "static";
}

function collectInOrder(node: StackingNode, result: StackingNode[]): void {
  // Fast path: no children (leaf node) — just add self
  if (node.children.length === 0) {
    result.push(node);
    return;
  }

  // Check if any children need stacking-layer grouping
  let hasNegZ = false;
  let hasAutoOrZeroLayer = false;
  let hasPosZ = false;
  for (const child of node.children) {
    if (child.createsStackingContext) {
      if (child.zIndex < 0) hasNegZ = true;
      else if (child.zIndex > 0) hasPosZ = true;
    }
    if (paintsInAutoOrZeroLayer(child)) hasAutoOrZeroLayer = true;
  }

  // Fast path: no children require special paint-phase grouping.
  if (!hasNegZ && !hasAutoOrZeroLayer && !hasPosZ) {
    result.push(node);
    for (const child of node.children) {
      collectInOrder(child, result);
    }
    return;
  }

  // Full path: separate by paint phase and z-index group.
  const negativeZ: StackingNode[] = [];
  const inFlow: StackingNode[] = [];
  const autoOrZeroLayer: StackingNode[] = [];
  const positiveZ: StackingNode[] = [];

  for (const child of node.children) {
    if (child.createsStackingContext) {
      if (child.zIndex < 0) {
        negativeZ.push(child);
      } else if (child.zIndex > 0) {
        positiveZ.push(child);
      } else {
        autoOrZeroLayer.push(child);
      }
    } else if (paintsInAutoOrZeroLayer(child)) {
      autoOrZeroLayer.push(child);
    } else {
      inFlow.push(child);
    }
  }

  negativeZ.sort((a, b) => a.zIndex - b.zIndex);
  positiveZ.sort((a, b) => a.zIndex - b.zIndex);

  for (const child of negativeZ) {
    collectInOrder(child, result);
  }

  result.push(node);

  for (const child of inFlow) {
    collectInOrder(child, result);
  }

  for (const child of autoOrZeroLayer) {
    collectInOrder(child, result);
  }

  for (const child of positiveZ) {
    collectInOrder(child, result);
  }
}
