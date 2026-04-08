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

  // Skip non-root SVG elements — they're handled by SVG subtree extraction.
  // SVG roots are kept because they participate in HTML layout (background, borders).
  if (isSVGElement(el) && el.tagName.toLowerCase() !== 'svg') return results;

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

  // For overflow:hidden containers, treat as a single line (the text is clipped)
  const isOverflowHidden = parentStyle.overflow === "hidden";
  const effectiveLineCount = isOverflowHidden ? 1 : rects.length;

  // Split text into per-line segments
  const lineTexts =
    effectiveLineCount === 1
      ? [fullText]
      : splitTextByLines(textNode, rects.length);

  if (effectiveLineCount === 1) {
    // Single line: use the span quad directly
    let text = lineTexts[0].replace(/\s+/g, ' ').trim();
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

    // Handle text overflow clipping
    let finalQuad = textQuad;
    if (parentStyle.overflow === "hidden") {
      const clipped = clipTextToParent(textNode, text, parentEl, textQuad, parentStyle);
      if (!clipped) return results;
      text = clipped.text;
      finalQuad = clipped.quad;
    }

    results.push({
      type: "text",
      quad: finalQuad,
      text,
      style: parentStyle,
      zIndex: globalIndex,
    });
  } else {
    // Multi-line: use the actual per-line rects from getClientRects()
    // instead of subdividing the textQuad (which may only cover the first fragment).
    const N = rects.length;
    for (let i = 0; i < N; i++) {
      let text = (i < lineTexts.length ? lineTexts[i] : "").replace(/\s+/g, ' ').trim();
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

      const r = rects[i];
      const lineQuad: Quad = [
        { x: r.left, y: r.top },
        { x: r.right, y: r.top },
        { x: r.right, y: r.bottom },
        { x: r.left, y: r.bottom },
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

/**
 * Clip text to the parent element's visible bounds when overflow:hidden.
 * If text-overflow:ellipsis is set, truncate and append "…".
 *
 * When overflow:hidden is active, the browser clips the text visually but
 * the text node still contains the full string.  getBoxQuads on the wrapper
 * span may return the already-clipped rect, so we cannot rely on comparing
 * the text quad to the parent rect.  Instead we measure the full text width
 * via a temporary off-clip span and compare to the parent's available width.
 */
function clipTextToParent(
  textNode: Text,
  text: string,
  parentEl: Element,
  textQuad: Quad,
  parentStyle: Style,
): { text: string; quad: Quad } | null {
  // Measure parent's inner content width (available space for text)
  const parentRect = parentEl.getBoundingClientRect();
  const cs = getComputedStyle(parentEl);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const availableWidth = parentRect.width - padL - padR;
  if (availableWidth <= 0) return null;

  // Measure the full text width using a hidden measuring span
  const measSpan = document.createElement("span");
  measSpan.style.cssText = "visibility:hidden;position:absolute;white-space:nowrap;overflow:visible;pointer-events:none";
  // Copy font styles
  measSpan.style.fontSize = cs.fontSize;
  measSpan.style.fontFamily = cs.fontFamily;
  measSpan.style.fontWeight = cs.fontWeight;
  measSpan.style.fontStyle = cs.fontStyle;
  measSpan.style.letterSpacing = cs.letterSpacing;
  measSpan.textContent = text;
  document.body.appendChild(measSpan);
  const fullTextWidth = measSpan.getBoundingClientRect().width;

  if (fullTextWidth <= availableWidth) {
    // Text fits — no clipping needed
    document.body.removeChild(measSpan);
    return { text, quad: textQuad };
  }

  // Text overflows — find how many characters fit
  const addEllipsis = parentStyle.textOverflow === "ellipsis";
  let fitChars = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    const candidate = addEllipsis ? text.substring(0, i).trimEnd() + "…" : text.substring(0, i);
    measSpan.textContent = candidate;
    if (measSpan.getBoundingClientRect().width <= availableWidth) {
      fitChars = i;
      break;
    }
  }
  document.body.removeChild(measSpan);

  if (fitChars <= 0 && !addEllipsis) return null;

  let clippedText: string;
  if (addEllipsis) {
    clippedText = fitChars > 0
      ? text.substring(0, fitChars).trimEnd() + "…"
      : "…";
  } else {
    clippedText = text.substring(0, fitChars);
  }

  // Adjust the quad width proportionally
  const fraction = Math.min(1, availableWidth / fullTextWidth);
  const clippedQuad: Quad = [
    textQuad[0],
    lerpPt(textQuad[0], textQuad[1], fraction),
    lerpPt(textQuad[3], textQuad[2], fraction),
    textQuad[3],
  ];

  return { text: clippedText, quad: clippedQuad };
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
