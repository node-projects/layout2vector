/**
 * DOM traversal with stacking context awareness.
 */
import type { Style } from "./types.js";

/** Represents a node in the stacking context tree. */
export interface StackingNode {
  element: Element;
  style: CSSStyleDeclaration;
  extractedStyle: Style;
  createsStackingContext: boolean;
  children: StackingNode[];
  textNodes: Text[];
  zIndex: number;
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
  let fill: string | undefined = cs.backgroundColor || cs.fill || undefined;
  const bgImage = cs.backgroundImage || undefined;

  // If backgroundColor is transparent but there's a gradient, extract its first color
  if ((!fill || fill === "rgba(0, 0, 0, 0)" || fill === "transparent") && bgImage && bgImage !== "none") {
    const gradientColor = extractGradientColor(bgImage);
    if (gradientColor) fill = gradientColor;
  }

  return {
    fill,
    stroke: cs.borderColor || cs.stroke || undefined,
    strokeWidth: cs.borderWidth || cs.strokeWidth || undefined,

    fontSize: cs.fontSize || undefined,
    fontFamily: cs.fontFamily || undefined,
    fontWeight: cs.fontWeight || undefined,
    fontStyle: cs.fontStyle || undefined,
    color: cs.color || undefined,
    textDecoration: cs.textDecoration || undefined,
    textAlign: cs.textAlign || undefined,
    textTransform: cs.textTransform || undefined,
    lineHeight: cs.lineHeight || undefined,

    opacity: cs.opacity ? parseFloat(cs.opacity) : undefined,
    zIndex: cs.zIndex && cs.zIndex !== "auto" ? parseInt(cs.zIndex, 10) : undefined,

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
    backgroundImage: cs.backgroundImage || undefined,
    boxShadow: cs.boxShadow || undefined,
    transform: cs.transform || undefined,
  };
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
  includeInvisible = false
): StackingNode {
  return buildStackingNode(root, includeInvisible);
}

function buildStackingNode(
  element: Element,
  includeInvisible: boolean
): StackingNode {
  const cs = getComputedStyle(element);
  const extractedStyleVal = extractStyle(cs);
  const isCtx = createsStackingContext(cs);

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
  };

  // Determine which root to traverse children from
  const childRoot = (element.shadowRoot as ShadowRoot | null) ?? element;

  for (const child of Array.from(childRoot.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child as Text;
      if (text.textContent && text.textContent.trim().length > 0) {
        node.textNodes.push(text);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;
      const childCs = getComputedStyle(childEl);

      if (!includeInvisible && !isVisible(childCs)) {
        continue;
      }

      node.children.push(buildStackingNode(childEl, includeInvisible));
    }
  }

  return node;
}

/**
 * Flatten the stacking context tree into paint order.
 * Within each stacking context:
 *   1. Negative z-index children
 *   2. Non-positioned / z-index:auto / z-index:0 (in DOM order)
 *   3. Positive z-index children
 */
export function flattenStackingOrder(root: StackingNode): StackingNode[] {
  const result: StackingNode[] = [];
  collectInOrder(root, result);
  return result;
}

function collectInOrder(node: StackingNode, result: StackingNode[]): void {
  // Separate children into groups
  const negativeZ: StackingNode[] = [];
  const zeroZ: StackingNode[] = [];
  const positiveZ: StackingNode[] = [];

  for (const child of node.children) {
    if (child.createsStackingContext) {
      if (child.zIndex < 0) {
        negativeZ.push(child);
      } else if (child.zIndex > 0) {
        positiveZ.push(child);
      } else {
        zeroZ.push(child);
      }
    } else {
      zeroZ.push(child);
    }
  }

  // Sort negative and positive by z-index (stable within same z)
  negativeZ.sort((a, b) => a.zIndex - b.zIndex);
  positiveZ.sort((a, b) => a.zIndex - b.zIndex);

  // 1. Negative z-index children
  for (const child of negativeZ) {
    collectInOrder(child, result);
  }

  // 2. The node itself
  result.push(node);

  // 3. Zero / auto z-index children (DOM order preserved)
  for (const child of zeroZ) {
    collectInOrder(child, result);
  }

  // 4. Positive z-index children
  for (const child of positiveZ) {
    collectInOrder(child, result);
  }
}
