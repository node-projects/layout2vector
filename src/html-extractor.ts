/**
 * HTML geometry extraction using browser layout APIs.
 */
import type { Point, Quad, Style, IRNode, Options } from "./types.js";
import type { StackingNode } from "./traversal.js";
import { isSVGElement } from "./traversal.js";
import { getElementQuads, getElementQuad } from "./geometry.js";

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

  // Extract element box quads (always via getBoxQuads for consistency)
  const boxType = options.boxType ?? "border";
  const quads = getElementQuads(el, boxType) as Quad[];

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
      const textIR = extractTextNode(textNode, el, node.extractedStyle, globalIndex);
      results.push(...textIR);
    }
  }

  return results;
}

/**
 * Extract text node geometry using getBoxQuads via a temporary inline wrapper.
 *
 * For single-line text, we wrap the text node in a temporary <span> and call
 * getBoxQuads() on it — this produces the exact rotated quad including all
 * ancestor CSS transforms.
 *
 * For multi-line text, we first use Range.getClientRects() to detect line
 * breaks, then subdivide the full quad proportionally per line.
 */
function extractTextNode(
  textNode: Text,
  parentEl: Element,
  parentStyle: Style,
  globalIndex: number
): IRNode[] {
  const results: IRNode[] = [];
  const fullText = textNode.textContent ?? "";
  if (!fullText.trim()) return results;

  // Detect line count using Range.getClientRects() (non-destructive)
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 || r.height > 0
  );
  if (rects.length === 0) return results;

  // Get the text quad by wrapping in a temporary span and using getBoxQuads
  const textQuad = getTextNodeQuad(textNode);
  if (!textQuad) return results;

  // Split text into per-line segments
  const lineTexts =
    rects.length === 1
      ? [fullText]
      : splitTextByLines(textNode, rects.length);

  if (rects.length === 1) {
    // Single line: use the span quad directly
    let text = lineTexts[0].trim();
    if (!text) return results;

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
      quad: textQuad,
      text,
      style: parentStyle,
      zIndex: globalIndex,
    });
  } else {
    // Multi-line: subdivide the full quad proportionally per line
    const N = rects.length;
    for (let i = 0; i < N; i++) {
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

      const fTop = i / N;
      const fBot = (i + 1) / N;
      const lineQuad: Quad = [
        lerpPt(textQuad[0], textQuad[3], fTop),
        lerpPt(textQuad[1], textQuad[2], fTop),
        lerpPt(textQuad[1], textQuad[2], fBot),
        lerpPt(textQuad[0], textQuad[3], fBot),
      ];

      results.push({
        type: "text",
        quad: lineQuad,
        text,
        style: parentStyle,
        zIndex: globalIndex,
      });
    }
  }

  return results;
}

/**
 * Get the quad for a text node by wrapping it in a temporary inline <span>
 * and calling getBoxQuads() on the span. This correctly handles CSS transforms.
 */
function getTextNodeQuad(textNode: Text): Quad | null {
  const parent = textNode.parentNode;
  if (!parent) return null;

  // Detect if text is slotted into shadow DOM.
  // The getBoxQuads polyfill returns wrong positions for slotted content,
  // so we fall back to getBoundingClientRect in that case.
  const parentEl = parent instanceof Element ? parent : null;
  const isSlottedInShadowDOM = parentEl?.shadowRoot != null;

  const span = document.createElement("span");
  parent.insertBefore(span, textNode);
  span.appendChild(textNode);

  let quad: Quad | null;
  if (isSlottedInShadowDOM) {
    const r = span.getBoundingClientRect();
    quad = (r.width === 0 && r.height === 0) ? null : [
      { x: r.left, y: r.top },
      { x: r.right, y: r.top },
      { x: r.right, y: r.bottom },
      { x: r.left, y: r.bottom },
    ];
  } else {
    quad = getElementQuad(span);
  }

  // Restore original DOM structure
  parent.insertBefore(textNode, span);
  parent.removeChild(span);

  return quad;
}

/** Linear interpolation between two points. */
function lerpPt(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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
