/**
 * HTML geometry extraction using browser layout APIs.
 */
import type { Point, Quad, Style, IRNode, Options } from "./types.js";
import type { StackingNode } from "./traversal.js";
import { isSVGElement } from "./traversal.js";

/**
 * Extract geometry from an HTML element using getBoxQuads.
 * Returns IR nodes for the element's box and its text nodes.
 */
export function extractHTMLGeometry(
  node: StackingNode,
  globalIndex: number,
  options: Options
): IRNode[] {
  const el = node.element;
  const results: IRNode[] = [];

  // Skip SVG elements — they're handled separately
  if (isSVGElement(el)) return results;

  // Extract element box quads
  const boxType = options.boxType ?? "border";
  const quads = getElementQuads(el, boxType);

  for (const quad of quads) {
    results.push({
      type: "polygon",
      points: quad,
      style: node.extractedStyle,
      zIndex: globalIndex,
    });
  }

  // Extract text node geometry
  if (options.includeText !== false) {
    for (const textNode of node.textNodes) {
      const textIR = extractTextNode(textNode, node.extractedStyle, globalIndex);
      results.push(...textIR);
    }
  }

  return results;
}

/**
 * Get quads for an element using getBoxQuads (with getBoundingClientRect fallback).
 */
function getElementQuads(el: Element, boxType: "border" | "content"): Quad[] {
  // Try getBoxQuads first (modern API)
  if ("getBoxQuads" in el && typeof (el as any).getBoxQuads === "function") {
    try {
      const rawQuads: any[] = (el as any).getBoxQuads({ box: boxType });
      return rawQuads.map(domQuadToQuad);
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: use getBoundingClientRect
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return [];

  const quad: Quad = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];

  return [quad];
}

/** Convert a DOMQuad to our Quad type. */
function domQuadToQuad(dq: DOMQuad): Quad {
  return [
    { x: dq.p1.x, y: dq.p1.y },
    { x: dq.p2.x, y: dq.p2.y },
    { x: dq.p3.x, y: dq.p3.y },
    { x: dq.p4.x, y: dq.p4.y },
  ];
}

/** Extract text node geometry using Range.getClientRects. */
function extractTextNode(
  textNode: Text,
  parentStyle: Style,
  globalIndex: number
): IRNode[] {
  const results: IRNode[] = [];
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rects = range.getClientRects();

  for (const rect of Array.from(rects)) {
    if (rect.width === 0 && rect.height === 0) continue;

    const quad: Quad = [
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ];

    results.push({
      type: "text",
      quad,
      text: textNode.textContent ?? "",
      style: parentStyle,
      zIndex: globalIndex,
    });
  }

  return results;
}
