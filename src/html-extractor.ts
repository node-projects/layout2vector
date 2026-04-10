/**
 * HTML geometry extraction using browser layout APIs.
 */
import type { Point, Quad, Style, IRNode, Options } from "./types.js";
import type { StackingNode } from "./traversal.js";
import { isSVGElement } from "./traversal.js";
import { getElementQuads } from "./geometry.js";

/** Characters that MathML stretches vertically. */
const STRETCHY_MO_CHARS = new Set([
  "[", "]", "(", ")", "{", "}", "|", "‖",
  "⟨", "⟩", "⌈", "⌉", "⌊", "⌋", "⟦", "⟧",
]);

/**
 * Returns true when `el` is a MathML `<mo>` that the browser has visually
 * stretched (its rendered height exceeds the expected font-size). These
 * operators are already extracted by the MathML extractor at their
 * correct stretched dimensions, so the HTML extractor should skip their text.
 */
function isStretchedMathOperator(el: Element): boolean {
  if (el.tagName.toLowerCase() !== "mo") return false;
  if (!el.closest?.("math")) return false;
  const text = (el.textContent ?? "").trim();
  if (!STRETCHY_MO_CHARS.has(text)) return false;
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  return rect.height > fontSize * 1.5;
}

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
      // Skip text inside stretched MathML <mo> operators — these are already
      // handled by the MathML extractor with correct stretched dimensions.
      if (isStretchedMathOperator(el)) continue;

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

  // Get all quads (one per line fragment) using getBoxQuads.
  // This correctly handles CSS transforms — each quad is properly rotated.
  const allQuads = getTextNodeQuads(textNode);
  if (allQuads.length === 0) return results;

  // For overflow:hidden containers, treat as a single line (the text is clipped)
  const isOverflowHidden = parentStyle.overflow === "hidden";
  const effectiveLineCount = isOverflowHidden ? 1 : allQuads.length;

  // Split text into per-line segments
  const lineTexts =
    effectiveLineCount === 1
      ? [fullText]
      : splitTextByLines(textNode, allQuads.length);

  if (effectiveLineCount === 1) {
    // Single line: use the first quad directly
    let text = lineTexts[0].replace(/\s+/g, ' ').trim();
    if (!text) return results;

    if (parentStyle.textTransform) {
      switch (parentStyle.textTransform) {
        case "uppercase": text = text.toUpperCase(); break;
        case "lowercase": text = text.toLowerCase(); break;
        case "capitalize":
          text = text.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
          break;
      }
    }

    // Handle text overflow clipping
    let finalQuad = allQuads[0];
    if (parentStyle.overflow === "hidden") {
      const clipped = clipTextToParent(textNode, text, parentEl, allQuads[0], parentStyle);
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
    // Multi-line: use per-line quads from getBoxQuads (transform-aware)
    const N = allQuads.length;
    for (let i = 0; i < N; i++) {
      let text = (i < lineTexts.length ? lineTexts[i] : "").replace(/\s+/g, ' ').trim();
      if (!text) continue;

      if (parentStyle.textTransform) {
        switch (parentStyle.textTransform) {
          case "uppercase": text = text.toUpperCase(); break;
          case "lowercase": text = text.toLowerCase(); break;
          case "capitalize":
            text = text.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
            break;
        }
      }

      results.push({
        type: "text",
        quad: allQuads[i],
        text,
        style: parentStyle,
        zIndex: globalIndex,
      });
    }
  }

  return results;
}

/**
 * Get all quads for a text node by wrapping it in a temporary inline <span>
 * and calling getBoxQuads() on the span. Returns one quad per line fragment.
 * This correctly handles CSS transforms — each quad is properly rotated.
 */
function getTextNodeQuads(textNode: Text): Quad[] {
  const parent = textNode.parentNode;
  if (!parent) return [];

  const parentEl = parent instanceof Element ? parent : null;
  const isSlottedInShadowDOM = parentEl?.shadowRoot != null;

  const span = document.createElement("span");
  parent.insertBefore(span, textNode);
  span.appendChild(textNode);

  let quads: Quad[];
  if (isSlottedInShadowDOM) {
    const r = span.getBoundingClientRect();
    quads = (r.width === 0 && r.height === 0) ? [] : [[
      { x: r.left, y: r.top },
      { x: r.right, y: r.top },
      { x: r.right, y: r.bottom },
      { x: r.left, y: r.bottom },
    ]];
  } else {
    quads = getElementQuads(span, "border");
  }

  // Restore original DOM structure
  parent.insertBefore(textNode, span);
  parent.removeChild(span);

  return quads;
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
 * line breaks via Range.getClientRects().
 * Uses a coarse-then-fine approach: first checks every Nth character,
 * then narrows down to find exact line break positions via binary search.
 * Returns one string per visual line.
 */
function splitTextByLines(textNode: Text, expectedLines: number): string[] {
  const text = textNode.textContent ?? "";
  if (!text) return [];

  const range = document.createRange();

  /** Get the top position of a character at index i, or null if no rect. */
  function charTop(i: number): { top: number; height: number } | null {
    range.setStart(textNode, i);
    range.setEnd(textNode, Math.min(i + 1, text.length));
    const rects = range.getClientRects();
    if (rects.length === 0) return null;
    const r = rects[0];
    if (r.width === 0 && r.height === 0) return null;
    return { top: r.top, height: r.height };
  }

  // For short text (< 80 chars) or few expected lines, use simple linear scan
  if (text.length < 80 || expectedLines <= 2) {
    return splitTextByLinesLinear(textNode, text, range);
  }

  // Coarse pass: sample every STEP characters to find approximate break regions
  const STEP = Math.max(4, Math.floor(text.length / (expectedLines * 8)));
  const lines: string[] = [];
  let lineStart = 0;
  let prevInfo: { top: number; height: number } | null = null;

  // Find the first valid position to get initial top
  for (let i = 0; i < text.length && !prevInfo; i++) {
    prevInfo = charTop(i);
  }
  if (!prevInfo) return [text];

  // Scan with coarse step to find regions where line breaks occur
  const breakIndices: number[] = [];
  let lastTop = prevInfo.top;
  let lastHeight = prevInfo.height;

  for (let i = STEP; i < text.length; i += STEP) {
    const info = charTop(i);
    if (!info) continue;
    if (Math.abs(info.top - lastTop) > lastHeight * 0.5) {
      // Line break somewhere between (i - STEP) and i — binary search for exact position
      let lo = Math.max(0, i - STEP);
      let hi = i;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const midInfo = charTop(mid);
        if (!midInfo) { lo = mid + 1; continue; }
        if (Math.abs(midInfo.top - lastTop) > lastHeight * 0.5) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      breakIndices.push(lo);
      lines.push(text.substring(lineStart, lo));
      lineStart = lo;
      // Update reference position from the new line
      const newInfo = charTop(lo);
      if (newInfo) { lastTop = newInfo.top; lastHeight = newInfo.height; }
    } else {
      lastTop = info.top;
      lastHeight = info.height;
    }
  }

  // Check the last segment for any remaining breaks (between last coarse sample and end)
  // Only needed if last coarse sample was far from end
  const lastSample = Math.floor((text.length - 1) / STEP) * STEP;
  if (text.length - lastSample > STEP / 2) {
    const endInfo = charTop(text.length - 1);
    if (endInfo && Math.abs(endInfo.top - lastTop) > lastHeight * 0.5) {
      let lo = lastSample;
      let hi = text.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const midInfo = charTop(mid);
        if (!midInfo) { lo = mid + 1; continue; }
        if (Math.abs(midInfo.top - lastTop) > lastHeight * 0.5) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      lines.push(text.substring(lineStart, lo));
      lineStart = lo;
    }
  }

  // Push last line
  lines.push(text.substring(lineStart));

  return lines;
}

/** Simple linear character-by-character line splitting for short text. */
function splitTextByLinesLinear(textNode: Text, text: string, range: Range): string[] {
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
      lines.push(text.substring(lineStart, i));
      lineStart = i;
    }
    prevTop = r.top;
    prevHeight = r.height;
  }

  lines.push(text.substring(lineStart));
  return lines;
}
