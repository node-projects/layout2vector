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

/**
 * Extract text node geometry using Range.getClientRects() for per-line splitting.
 * Range.getClientRects() returns one rect per visual line, which lets us correctly
 * assign text substrings to each line. getBoxQuads() on text nodes may return a single
 * bounding quad for the entire text, which loses line-break information.
 */
function extractTextNode(
  textNode: Text,
  parentStyle: Style,
  globalIndex: number
): IRNode[] {
  const results: IRNode[] = [];
  const fullText = textNode.textContent ?? "";
  if (!fullText.trim()) return results;

  // Use Range.getClientRects() which reliably returns one rect per visual line
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rects = range.getClientRects();
  const quads: Quad[] = [];
  for (const rect of Array.from(rects)) {
    if (rect.width === 0 && rect.height === 0) continue;
    quads.push([
      { x: rect.left, y: rect.top },
      { x: rect.right, y: rect.top },
      { x: rect.right, y: rect.bottom },
      { x: rect.left, y: rect.bottom },
    ]);
  }

  if (quads.length === 0) return results;

  // Split text into per-line segments using character-level Range API
  const lineTexts = quads.length === 1
    ? [fullText]
    : splitTextByLines(textNode, quads.length);

  for (let i = 0; i < quads.length; i++) {
    let text = (i < lineTexts.length ? lineTexts[i] : "").trim();
    if (!text) continue;

    if (parentStyle.textTransform) {
      switch (parentStyle.textTransform) {
        case "uppercase": text = text.toUpperCase(); break;
        case "lowercase": text = text.toLowerCase(); break;
        case "capitalize":
          text = text.replace(/\b\w/g, (c) => c.toUpperCase());
          break;
      }
    }

    results.push({
      type: "text",
      quad: quads[i],
      text,
      style: parentStyle,
      zIndex: globalIndex,
    });
  }

  return results;
}

/**
 * Split a text node's content into per-line strings by detecting
 * line breaks via character-level Range.getClientRects().
 * Returns one string per visual line.
 */
function splitTextByLines(textNode: Text, expectedLines: number): string[] {
  const text = textNode.textContent ?? "";
  if (!text) return [];

  const range = document.createRange();
  const lines: string[] = [];
  let lineStart = 0;
  let prevTop: number | null = null;
  let prevHeight = 0;

  for (let i = 0; i < text.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const rects = range.getClientRects();
    if (rects.length === 0) continue;
    const r = rects[0];
    if (r.width === 0 && r.height === 0) continue;

    if (prevTop !== null && Math.abs(r.top - prevTop) > prevHeight * 0.5) {
      // Line break detected — save previous line
      lines.push(text.substring(lineStart, i));
      lineStart = i;
    }
    prevTop = r.top;
    prevHeight = r.height;
  }

  // Push last line
  lines.push(text.substring(lineStart));

  return lines;
}
