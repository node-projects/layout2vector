/**
 * HTML geometry extraction using browser layout APIs.
 */
import type { Point, Quad, Style, IRNode, Options } from "../types.js";
import type { StackingNode } from "../traversal.js";
import { isSVGElement } from "../traversal.js";
import { getBoxQuadsOptions, getElementQuad, getElementQuads, getNodeQuads, quadSize } from "../geometry.js";
import { extractFormControlGeometry, shouldSkipFormControlDescendant } from "./form-controls.js";
import { extractMaskedElementImage } from "./image-extractor.js";
import { normalizeWhitespaceAwareText, preservesWhitespace } from "../shared/text-whitespace.js";

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

function shouldExtractMaskedLeafImage(node: StackingNode, options: Options): boolean {
  if (!options.includeImages) return false;
  if (!(node.element instanceof HTMLElement)) return false;
  if (!node.extractedStyle.mask || node.extractedStyle.mask === "none") return false;
  if (node.element.children.length > 0) return false;
  if (node.textNodes.some((textNode) => (textNode.textContent ?? "").trim().length > 0)) return false;
  return !node.children.some((child) => child.textOnly && child.textNodes.some((textNode) => (textNode.textContent ?? "").trim().length > 0));
}

function isVisiblePaint(value: string | undefined): boolean {
  if (!value) return false;

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "transparent") return false;
  if (/^rgba\((?:[^)]*,){3}\s*0(?:\.0+)?\s*\)$/.test(normalized)) return false;
  if (/^hsla\((?:[^)]*,){3}\s*0(?:\.0+)?\s*\)$/.test(normalized)) return false;

  return true;
}

function hasVisibleBorder(style: Style): boolean {
  const sides: Array<[string | undefined, string | undefined, string | undefined]> = [
    [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
    [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
    [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
    [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
  ];

  return sides.some(([width, borderStyle, color]) => {
    if (!width || parseFloat(width) <= 0) return false;
    if (!borderStyle || borderStyle === "none" || borderStyle === "hidden") return false;
    return isVisiblePaint(color);
  });
}

function hasVisibleOutline(style: Style): boolean {
  if (!style.outlineWidth || parseFloat(style.outlineWidth) <= 0) return false;
  if (!style.outlineStyle || style.outlineStyle === "none" || style.outlineStyle === "hidden") return false;
  return isVisiblePaint(style.outlineColor);
}

function shouldExtractElementBox(style: Style): boolean {
  if (isVisiblePaint(style.fill)) return true;
  if (style.backgroundImage && style.backgroundImage !== "none") return true;
  if (hasVisibleBorder(style)) return true;
  if (hasVisibleOutline(style)) return true;
  if (style.boxShadow && style.boxShadow !== "none") return true;
  if (style.filter && style.filter !== "none") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  return false;
}

/**
 * Extract geometry from an HTML element using getBoxQuads.
 * Returns IR nodes for the element's box and its text nodes.
 */
export async function extractHTMLGeometry(
  node: StackingNode,
  globalIndex: number,
  options: Options
): Promise<IRNode[]> {
  const el = node.element;
  const results: IRNode[] = [];
  const isTextOnly = node.textOnly === true;
  const isRootSvg = isSVGElement(el) && el.tagName.toLowerCase() === "svg";

  if (shouldSkipFormControlDescendant(el, options)) return results;

  if (!isTextOnly) {
  const formControlNodes = extractFormControlGeometry(node, globalIndex, options);
  if (formControlNodes !== null) return formControlNodes;

  // Skip non-root SVG elements — they're handled by SVG subtree extraction.
  // SVG roots are kept because they participate in HTML layout (background, borders).
  if (isSVGElement(el) && el.tagName.toLowerCase() !== 'svg') return results;

  if (shouldExtractMaskedLeafImage(node, options)) {
    const maskedNodes = await extractMaskedElementImage(el, node.extractedStyle, globalIndex, options);
    if (maskedNodes.length > 0) return maskedNodes;
  }

  if (isRootSvg || shouldExtractElementBox(node.extractedStyle)) {
    // Extract element box quads only for visibly painted boxes.
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
  }
  }

  // Extract text node geometry
  if (options.includeText !== false) {
    for (const textNode of node.textNodes) {
      // Skip text inside stretched MathML <mo> operators — these are already
      // handled by the MathML extractor with correct stretched dimensions.
      if (isStretchedMathOperator(el)) continue;

      const textIR = await extractTextNode(textNode, el, node.extractedStyle, globalIndex, options);
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
  globalIndex: number,
  options: Options,
): IRNode[] | Promise<IRNode[]> {
  const results: IRNode[] = [];
  const fullText = textNode.textContent ?? "";
  const boundaryWhitespace = getCollapsedBoundaryWhitespace(textNode, parentStyle);
  if (preservesWhitespace(parentStyle)) {
    if (fullText.length === 0) return results;
  } else if (!fullText.trim() && !boundaryWhitespace.leading && !boundaryWhitespace.trailing) {
    return results;
  }

  const measurementMode = resolveTextMeasurementMode(parentStyle, options);
  const requiresNativeWritingModeQuads = !!parentStyle.writingMode && parentStyle.writingMode !== "horizontal-tb";
  const nativeTextQuads = (measurementMode === "pretext" || requiresNativeWritingModeQuads)
    ? getNativeTextNodeQuads(textNode, parentStyle)
    : [];
  const renderedTextProgression = shouldOrientQuadFromRenderedText(parentStyle)
    ? getRenderedTextProgression(textNode)
    : null;
  const measuredTextStyle = measurementMode === "pretext" ? getPrelaidTextStyle(parentStyle) : parentStyle;
  if (measurementMode === "pretext" && nativeTextQuads.length !== 1) {
    return extractTextNodeWithPretext(textNode, parentEl, parentStyle, globalIndex);
  }

  // Get all quads (one per line fragment) using getBoxQuads.
  // This correctly handles CSS transforms — each quad is properly rotated.
  const allQuads = nativeTextQuads.length === 1 ? nativeTextQuads : getTextNodeQuads(textNode);
  if (allQuads.length === 0) return results;

  const lineClamp = getLineClampConfig(parentEl);
  const hasLineClamp = lineClamp.lines > 0 && parentStyle.overflow === "hidden";
  const isMultilineClamp = hasLineClamp && lineClamp.lines > 1;

  // For overflow:hidden containers, treat as a single line unless the browser is
  // exposing a multi-line clamp via -webkit-line-clamp.
  const isOverflowHidden = parentStyle.overflow === "hidden";
  const effectiveLineCount = isOverflowHidden && !hasLineClamp ? 1 : allQuads.length;

  // Split text into per-line segments
  const lineTexts =
    effectiveLineCount === 1
      ? [fullText]
      : splitTextByLines(textNode, allQuads.length);

  if (effectiveLineCount === 1) {
    // Single line: use the first quad directly
    const normalized = normalizeCollapsedTextFragment(
      lineTexts[0],
      parentStyle,
      boundaryWhitespace.leading,
      boundaryWhitespace.trailing,
    );
    let text = normalized.text;
    if (text.length === 0) return results;

    text = applyTextTransform(text, parentStyle.textTransform);

    // Handle text overflow clipping
    let finalQuad = allQuads[0];
    if (parentStyle.overflow === "hidden") {
      const clipped = clipTextToParent(
        textNode,
        text,
        parentEl,
        allQuads[0],
        parentStyle,
        hasLineClamp ? lineClamp.marker : undefined,
      );
      if (!clipped) return results;
      text = clipped.text;
      finalQuad = clipped.quad;
    }

    results.push({
      type: "text",
      quad: orientQuadToRenderedTextProgression(finalQuad, renderedTextProgression),
      text,
      style: normalized.style ?? measuredTextStyle,
      zIndex: globalIndex,
    });
  } else {
    // Multi-line: use per-line quads from getBoxQuads (transform-aware)
    const visibleLineCount = isMultilineClamp ? Math.min(lineClamp.lines, allQuads.length, lineTexts.length) : allQuads.length;
    const hasHiddenClampedLines = isMultilineClamp
      && (
        Math.max(allQuads.length, lineTexts.length) > visibleLineCount
        || hasHiddenVerticalOverflow(parentEl)
      );

    for (let i = 0; i < visibleLineCount; i++) {
      const normalized = normalizeCollapsedTextFragment(
        i < lineTexts.length ? lineTexts[i] : "",
        parentStyle,
        i === 0 && boundaryWhitespace.leading,
        i === visibleLineCount - 1 && boundaryWhitespace.trailing,
      );
      let text = normalized.text.replace(/[\r\n]+$/g, "");
      if (text.length === 0) continue;

      text = applyTextTransform(text, parentStyle.textTransform);

      let quad = allQuads[i];
      const lineStyle: Style = {
        ...(normalized.style ?? parentStyle),
        textAlign: getMultilineTextAlign(parentStyle.textAlign, i, visibleLineCount),
        textIndent: undefined,
        whiteSpace: preservesWhitespace(parentStyle) ? "pre" : "nowrap",
      };

      if (normalized.style?.whiteSpace === "pre") {
        lineStyle.whiteSpace = "pre";
      }

      if (hasHiddenClampedLines && i === visibleLineCount - 1) {
        const clipped = clipTextToWidth(text, parentEl, quad, lineStyle, getQuadWidth(quad), "force", lineClamp.marker);
        if (!clipped) continue;
        text = clipped.text;
        quad = clipped.quad;
      }

      results.push({
        type: "text",
        quad,
        text,
        style: lineStyle,
        zIndex: globalIndex,
      });
    }
  }

  return results;
}

function getMultilineTextAlign(textAlign: string | undefined, lineIndex: number, lineCount: number): string | undefined {
  if (textAlign !== "justify") return undefined;
  return lineIndex < lineCount - 1 ? textAlign : undefined;
}

/**
 * Get all quads for a text node via getBoxQuads() called directly on the
 * Text node. Returns one quad per line fragment.
 * This correctly handles CSS transforms — each quad is properly rotated.
 */
function getTextNodeQuads(textNode: Text): Quad[] {
  return getNodeQuads(textNode, "border");
}

function getPrelaidTextStyle(style: Style): Style {
  return {
    ...style,
    direction: undefined,
    writingMode: undefined,
    textAlign: undefined,
    textIndent: undefined,
    whiteSpace: "pre",
  };
}

function getNativeTextNodeQuads(textNode: Text, style: Style): Quad[] {
  if (!("getBoxQuads" in textNode) || typeof (textNode as any).getBoxQuads !== "function") {
    return [];
  }

  try {
    const rawQuads: DOMQuad[] = (textNode as any).getBoxQuads(getBoxQuadsOptions(textNode, "border"));
    return rawQuads
      .map((quad) => orientNativeTextQuad([
        { x: quad.p1.x, y: quad.p1.y },
        { x: quad.p2.x, y: quad.p2.y },
        { x: quad.p3.x, y: quad.p3.y },
        { x: quad.p4.x, y: quad.p4.y },
      ] as Quad, style.writingMode))
      .filter(hasQuadArea);
  } catch {
    return [];
  }
}

function orientNativeTextQuad(quad: Quad, writingMode: string | undefined): Quad {
  if (writingMode === "sideways-lr") {
    // sideways-lr glyphs are counter-clockwise relative to horizontal text;
    // keep point order aligned with inline flow to avoid 180deg flips.
    return [quad[1], quad[2], quad[3], quad[0]];
  }

  switch (writingMode) {
    case "vertical-rl":
    case "vertical-lr":
    case "sideways-rl":
    {
      const candidates: Quad[] = [
        quad,
        [quad[1], quad[2], quad[3], quad[0]],
        [quad[3], quad[0], quad[1], quad[2]],
      ];

      let best = candidates[0];
      let bestScore = -Infinity;

      for (const candidate of candidates) {
        const dx = candidate[1].x - candidate[0].x;
        const dy = candidate[1].y - candidate[0].y;
        const verticality = Math.abs(dy) - Math.abs(dx);
        const score = verticality;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      return best;
    }
    default:
      return quad;
  }
}

function hasQuadArea(quad: Quad): boolean {
  const x1 = quad[1].x - quad[0].x;
  const y1 = quad[1].y - quad[0].y;
  const x2 = quad[3].x - quad[0].x;
  const y2 = quad[3].y - quad[0].y;
  return Math.abs(x1 * y2 - y1 * x2) > 0.01;
}

function shouldOrientQuadFromRenderedText(style: Style): boolean {
  const writingMode = style.writingMode?.trim().toLowerCase();
  return !!writingMode && writingMode !== "horizontal-tb";
}

function getRenderableCharacterCenters(textNode: Text): Point[] {
  const text = textNode.textContent ?? "";
  if (!text) return [];

  const centers: Point[] = [];
  const range = document.createRange();

  for (let index = 0; index < text.length; index++) {
    try {
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
    } catch {
      continue;
    }

    const rects = range.getClientRects();
    for (let rectIndex = 0; rectIndex < rects.length; rectIndex++) {
      const rect = rects[rectIndex];
      if (rect.width * rect.height <= 0.01) continue;
      centers.push({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      break;
    }
  }

  return centers;
}

function getRenderedTextProgression(textNode: Text): { dx: number; dy: number } | null {
  const centers = getRenderableCharacterCenters(textNode);
  if (centers.length < 2) return null;

  const first = centers[0];
  const last = centers[centers.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (Math.abs(dx) <= 0.01 && Math.abs(dy) <= 0.01) return null;

  return { dx, dy };
}

function orientQuadToRenderedTextProgression(
  quad: Quad,
  progression: { dx: number; dy: number } | null,
): Quad {
  if (!progression) return quad;

  const progressionLength = Math.hypot(progression.dx, progression.dy);
  if (progressionLength <= 0.01) return quad;

  const candidates: Quad[] = [
    quad,
    [quad[1], quad[2], quad[3], quad[0]],
    [quad[2], quad[3], quad[0], quad[1]],
    [quad[3], quad[0], quad[1], quad[2]],
  ];

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const dx = candidate[1].x - candidate[0].x;
    const dy = candidate[1].y - candidate[0].y;
    const edgeLength = Math.hypot(dx, dy);
    if (edgeLength <= 0.01) continue;

    const score = (dx * progression.dx + dy * progression.dy) / (edgeLength * progressionLength);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function getCollapsedBoundaryWhitespace(
  textNode: Text,
  style: Style,
): { leading: boolean; trailing: boolean } {
  if (preservesWhitespace(style)) {
    return { leading: false, trailing: false };
  }

  const text = textNode.textContent ?? "";
  const hasLeadingBoundary = /^\s/.test(text) && hasInlineBoundarySibling(textNode.previousSibling, "previous");
  const hasTrailingBoundary = /\s$/.test(text) && hasInlineBoundarySibling(textNode.nextSibling, "next");
  const renderedBoundaryWhitespace = getRenderedCollapsedBoundaryWhitespace(
    textNode,
    hasLeadingBoundary,
    hasTrailingBoundary,
  );

  return {
    leading: hasLeadingBoundary && renderedBoundaryWhitespace.leading,
    trailing: hasTrailingBoundary && renderedBoundaryWhitespace.trailing,
  };
}

function getRenderedCollapsedBoundaryWhitespace(
  textNode: Text,
  checkLeading: boolean,
  checkTrailing: boolean,
): { leading: boolean; trailing: boolean } {
  const text = textNode.textContent ?? "";
  if (!text || (!checkLeading && !checkTrailing)) {
    return { leading: false, trailing: false };
  }

  const range = document.createRange();
  let leading = false;
  let trailing = false;

  if (checkLeading) {
    for (let i = 0; i < text.length && /\s/.test(text[i]); i++) {
      if (hasRenderableCharacterRect(range, textNode, i)) {
        leading = true;
        break;
      }
    }
  }

  if (checkTrailing) {
    for (let i = text.length - 1; i >= 0 && /\s/.test(text[i]); i--) {
      if (hasRenderableCharacterRect(range, textNode, i)) {
        trailing = true;
        break;
      }
    }
  }

  return { leading, trailing };
}

function hasRenderableCharacterRect(range: Range, textNode: Text, index: number): boolean {
  try {
    range.setStart(textNode, index);
    range.setEnd(textNode, index + 1);
  } catch {
    return false;
  }

  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (rect.width * rect.height > 0.01) {
      return true;
    }
  }

  return false;
}

function hasInlineBoundarySibling(node: Node | null, direction: "previous" | "next"): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.COMMENT_NODE) {
      current = direction === "previous" ? current.previousSibling : current.nextSibling;
      continue;
    }

    if (current.nodeType === Node.TEXT_NODE) {
      if ((current.textContent ?? "").trim().length === 0) {
        current = direction === "previous" ? current.previousSibling : current.nextSibling;
        continue;
      }
      return true;
    }

    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;
      if (element.tagName === "BR") return false;

      const display = getComputedStyle(element).display;
      if (display === "none") {
        current = direction === "previous" ? current.previousSibling : current.nextSibling;
        continue;
      }

      return isInlineLevelDisplay(display);
    }

    current = direction === "previous" ? current.previousSibling : current.nextSibling;
  }

  return false;
}

function isInlineLevelDisplay(display: string): boolean {
  return display === "inline"
    || display === "inline-block"
    || display === "inline-flex"
    || display === "inline-grid"
    || display === "inline-table"
    || display === "contents"
    || display === "ruby"
    || display === "ruby-base"
    || display === "ruby-text";
}

function normalizeCollapsedTextFragment(
  text: string,
  style: Style,
  preserveLeadingSpace: boolean,
  preserveTrailingSpace: boolean,
): { text: string; style?: Style } {
  if (preservesWhitespace(style)) {
    return { text: normalizeWhitespaceAwareText(text, style) };
  }

  let normalized = text.replace(/\s+/g, " ");
  if (!preserveLeadingSpace) normalized = normalized.replace(/^ /, "");
  if (!preserveTrailingSpace) normalized = normalized.replace(/ $/, "");
  if (!normalized) return { text: "" };

  if (normalized.startsWith(" ") || normalized.endsWith(" ")) {
    return {
      text: normalized,
      style: { ...style, whiteSpace: "pre" },
    };
  }

  return { text: normalized };
}

// --- Pretext-based text measurement ---

let _pretextModule: { prepareWithSegments: any; layoutWithLines: any } | null = null;

async function loadPretextModule(): Promise<{ prepareWithSegments: any; layoutWithLines: any }> {
  if (_pretextModule) return _pretextModule;
  if (typeof globalThis !== 'undefined' && (globalThis as any).__pretext) {
    _pretextModule = (globalThis as any).__pretext;
    return _pretextModule!;
  }
  try {
    _pretextModule = await import('@chenglou/pretext');
    return _pretextModule!;
  } catch {
    throw new Error(
      'textMeasurement "pretext" requires @chenglou/pretext. Install it: npm install @chenglou/pretext'
    );
  }
}

function buildCanvasFontString(cs: CSSStyleDeclaration): string {
  const parts: string[] = [];
  if (cs.fontStyle && cs.fontStyle !== 'normal') parts.push(cs.fontStyle);
  if (cs.fontWeight && cs.fontWeight !== '400' && cs.fontWeight !== 'normal') parts.push(cs.fontWeight);
  parts.push(cs.fontSize || '16px');
  parts.push(cs.fontFamily || 'sans-serif');
  return parts.join(' ');
}

async function extractTextNodeWithPretext(
  textNode: Text,
  parentEl: Element,
  parentStyle: Style,
  globalIndex: number,
): Promise<IRNode[]> {
  const fullText = textNode.textContent ?? "";
  const boundaryWhitespace = getCollapsedBoundaryWhitespace(textNode, parentStyle);
  const normalized = normalizeCollapsedTextFragment(
    fullText,
    parentStyle,
    boundaryWhitespace.leading,
    boundaryWhitespace.trailing,
  );
  const normalizedText = normalized.text;
  if (!normalizedText) return [];

  const text = applyTextTransform(normalizedText, parentStyle.textTransform);
  if (!text) return [];

  const cs = getComputedStyle(parentEl);
  const contentTransform = getElementContentTransform(parentEl, cs);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lhVal = parseFloat(cs.lineHeight);
  const lineHeight = isNaN(lhVal) ? fontSize * 1.2 : lhVal;
  const font = buildCanvasFontString(cs);
  const writingMode = cs.writingMode || 'horizontal-tb';
  const direction = cs.direction || 'ltr';

  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const fallbackRect = parentEl.getBoundingClientRect();
  const cx = contentTransform ? 0 : fallbackRect.left + padL;
  const cy = contentTransform ? 0 : fallbackRect.top + padT;
  const cw = contentTransform ? contentTransform.contentWidth : fallbackRect.width - padL - padR;
  const ch = contentTransform ? contentTransform.contentHeight : fallbackRect.height - padT - padB;

  const outputStyle = normalized.style
    ? { ...getPrelaidTextStyle(parentStyle), whiteSpace: normalized.style.whiteSpace }
    : getPrelaidTextStyle(parentStyle);

  const { prepareWithSegments, layoutWithLines } = await loadPretextModule();
  const whiteSpaceOpt = preservesWhitespace(parentStyle) ? { whiteSpace: 'pre-wrap' as const } : undefined;
  const results: IRNode[] = [];
  const shouldOrientFromRenderedText = shouldOrientQuadFromRenderedText(parentStyle);

  if (writingMode === 'horizontal-tb') {
    const prepared = prepareWithSegments(text, font, whiteSpaceOpt);
    const { lines } = layoutWithLines(prepared, cw, lineHeight);

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].text;
      if (!lineText.trim()) continue;

      const y = cy + i * lineHeight;
      let x = cx;
      const lw = lines[i].width;
      const align = cs.textAlign;

      if (direction === 'rtl') {
        if (!align || align === 'start' || align === 'right') x += cw - lw;
        else if (align === 'center') x += (cw - lw) / 2;
      } else {
        if (align === 'right' || align === 'end') x += cw - lw;
        else if (align === 'center') x += (cw - lw) / 2;
      }
      if (i === 0) x += parseFloat(cs.textIndent) || 0;

      const quad: Quad = [
        { x, y },
        { x: x + lw, y },
        { x: x + lw, y: y + lineHeight },
        { x, y: y + lineHeight },
      ];
      results.push({ type: "text", quad: mapPretextQuad(quad, contentTransform), text: lineText, style: outputStyle, zIndex: globalIndex });
    }
    return results;
  }

  // For vertical and sideways modes, use the container height as the inline dimension.
  // Pretext measures text horizontally; we use the measured width as the inline extent
  // and swap axes when positioning.
  const prepared = prepareWithSegments(text, font, whiteSpaceOpt);
  const { lines } = layoutWithLines(prepared, ch, lineHeight);
  const renderedTextProgression = shouldOrientFromRenderedText && lines.length === 1
    ? getRenderedTextProgression(textNode)
    : null;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].text;
    if (!lineText.trim()) continue;
    const lw = lines[i].width;

    if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr' || writingMode === 'sideways-rl') {
      // CW rotation (+90°): Latin characters rotated 90° clockwise, inline flows top→bottom
      // vertical-rl / sideways-rl: columns flow right→left
      // vertical-lr: columns flow left→right
      const colX = writingMode === 'vertical-lr'
        ? cx + i * lineHeight
        : cx + cw - (i + 1) * lineHeight;

      // LTR: text starts at top (inline-start); RTL: text bottom-aligned (inline-start at bottom)
      const colY = direction === 'rtl' ? cy + ch - lw : cy;

      const quad: Quad = [
        { x: colX + lineHeight, y: colY },
        { x: colX + lineHeight, y: colY + lw },
        { x: colX, y: colY + lw },
        { x: colX, y: colY },
      ];
      results.push({
        type: "text",
        quad: orientQuadToRenderedTextProgression(mapPretextQuad(quad, contentTransform), renderedTextProgression),
        text: lineText,
        style: outputStyle,
        zIndex: globalIndex,
      });

    } else if (writingMode === 'sideways-lr') {
      // CCW rotation (-90°): characters rotated 90° counter-clockwise, inline flows bottom→top
      // Columns flow left→right
      const colX = cx + i * lineHeight;

      let quad: Quad;
      if (direction === 'rtl') {
        // RTL reverses inline direction: text block top-aligned
        quad = [
          { x: colX, y: cy + lw },
          { x: colX, y: cy },
          { x: colX + lineHeight, y: cy },
          { x: colX + lineHeight, y: cy + lw },
        ];
      } else {
        // LTR: text block bottom-aligned
        quad = [
          { x: colX, y: cy + ch },
          { x: colX, y: cy + ch - lw },
          { x: colX + lineHeight, y: cy + ch - lw },
          { x: colX + lineHeight, y: cy + ch },
        ];
      }
      results.push({
        type: "text",
        quad: orientQuadToRenderedTextProgression(mapPretextQuad(quad, contentTransform), renderedTextProgression),
        text: lineText,
        style: outputStyle,
        zIndex: globalIndex,
      });
    }
  }

  return results;
}

type ElementContentTransform = {
  origin: Point;
  xAxis: Point;
  yAxis: Point;
  contentWidth: number;
  contentHeight: number;
};

function getElementContentTransform(el: Element, cs: CSSStyleDeclaration): ElementContentTransform | null {
  const borderQuad = getElementQuad(el, "border");
  if (!borderQuad) return null;
  const contentQuad = getElementQuad(el, "content");

  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderRight = parseFloat(cs.borderRightWidth) || 0;
  const borderTop = parseFloat(cs.borderTopWidth) || 0;
  const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;

  const htmlEl = el as Element & { clientWidth?: number; clientHeight?: number; };
  const clientWidth = typeof htmlEl.clientWidth === "number" && htmlEl.clientWidth > 0 ? htmlEl.clientWidth : null;
  const clientHeight = typeof htmlEl.clientHeight === "number" && htmlEl.clientHeight > 0 ? htmlEl.clientHeight : null;
  const borderSize = quadSize(borderQuad);
  const contentSize = contentQuad ? quadSize(contentQuad) : null;
  const contentWidth = getContentBoxDimension(cs.width, cs.boxSizing, borderLeft, borderRight, padL, padR)
    ?? (clientWidth !== null ? Math.max(0, clientWidth - padL - padR) : contentSize?.width ?? Math.max(0, borderSize.width - borderLeft - borderRight - padL - padR));
  const contentHeight = getContentBoxDimension(cs.height, cs.boxSizing, borderTop, borderBottom, padT, padB)
    ?? (clientHeight !== null ? Math.max(0, clientHeight - padT - padB) : contentSize?.height ?? Math.max(0, borderSize.height - borderTop - borderBottom - padT - padB));
  const borderBoxWidth = contentWidth + padL + padR + borderLeft + borderRight;
  const borderBoxHeight = contentHeight + padT + padB + borderTop + borderBottom;

  if (borderBoxWidth <= 0 || borderBoxHeight <= 0) return null;

  const xAxis = {
    x: (borderQuad[1].x - borderQuad[0].x) / borderBoxWidth,
    y: (borderQuad[1].y - borderQuad[0].y) / borderBoxWidth,
  };
  const yAxis = {
    x: (borderQuad[3].x - borderQuad[0].x) / borderBoxHeight,
    y: (borderQuad[3].y - borderQuad[0].y) / borderBoxHeight,
  };
  const originOffsetX = borderLeft + padL;
  const originOffsetY = borderTop + padT;

  return {
    origin: contentQuad?.[0] ?? {
      x: borderQuad[0].x + xAxis.x * originOffsetX + yAxis.x * originOffsetY,
      y: borderQuad[0].y + xAxis.y * originOffsetX + yAxis.y * originOffsetY,
    },
    xAxis,
    yAxis,
    contentWidth,
    contentHeight,
  };
}

function getContentBoxDimension(
  size: string,
  boxSizing: string,
  borderStart: number,
  borderEnd: number,
  paddingStart: number,
  paddingEnd: number,
): number | null {
  const parsed = parseFloat(size);
  if (!Number.isFinite(parsed)) return null;

  if (boxSizing === "border-box") {
    return Math.max(0, parsed - borderStart - borderEnd - paddingStart - paddingEnd);
  }

  return Math.max(0, parsed);
}

function mapPretextPoint(point: Point, transform: ElementContentTransform | null): Point {
  if (!transform) return point;
  return {
    x: transform.origin.x + transform.xAxis.x * point.x + transform.yAxis.x * point.y,
    y: transform.origin.y + transform.xAxis.y * point.x + transform.yAxis.y * point.y,
  };
}

function mapPretextQuad(quad: Quad, transform: ElementContentTransform | null): Quad {
  if (!transform) return quad;
  return [
    mapPretextPoint(quad[0], transform),
    mapPretextPoint(quad[1], transform),
    mapPretextPoint(quad[2], transform),
    mapPretextPoint(quad[3], transform),
  ];
}

function resolveTextMeasurementMode(style: Style, options: Options): "line" | "pretext" {
  const mode = options.textMeasurement ?? "line";
  if (mode === "pretext") return "pretext";
  if (mode === "auto" && needsPretextMeasurement(style)) return "pretext";
  return "line";
}

function needsPretextMeasurement(style: Style): boolean {
  const direction = style.direction?.trim().toLowerCase();
  if (direction && direction !== "ltr") return true;

  const writingMode = style.writingMode?.trim().toLowerCase();
  return !!writingMode && writingMode !== "horizontal-tb";
}

function applyTextTransform(text: string, textTransform: string | undefined): string {
  switch (textTransform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/(^|\s)\S/g, (char) => char.toUpperCase());
    default:
      return text;
  }
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
  overflowMarker?: string,
): { text: string; quad: Quad } | null {
  // Measure parent's inner content width (available space for text)
  const parentRect = parentEl.getBoundingClientRect();
  const cs = getComputedStyle(parentEl);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const availableWidth = parentRect.width - padL - padR;
  if (availableWidth <= 0) return null;

  const marker = overflowMarker ?? (parentStyle.textOverflow === "ellipsis" ? "…" : "");

  return clipTextToWidth(
    text,
    parentEl,
    textQuad,
    parentStyle,
    availableWidth,
    marker.length > 0 ? "overflow" : "none",
    marker,
  );
}

function clipTextToWidth(
  text: string,
  parentEl: Element,
  textQuad: Quad,
  parentStyle: Style,
  availableWidth: number,
  ellipsisMode: "none" | "overflow" | "force",
  overflowMarker = "…",
): { text: string; quad: Quad } | null {
  if (availableWidth <= 0) return null;
  const cs = getComputedStyle(parentEl);

  // Measure the full text width using a hidden measuring span
  const measSpan = document.createElement("span");
  measSpan.style.cssText = "visibility:hidden;position:absolute;overflow:visible;pointer-events:none";
  measSpan.style.whiteSpace = preservesWhitespace(parentStyle) ? "pre" : "nowrap";
  // Copy font styles
  measSpan.style.fontSize = cs.fontSize;
  measSpan.style.fontFamily = cs.fontFamily;
  measSpan.style.fontWeight = cs.fontWeight;
  measSpan.style.fontStyle = cs.fontStyle;
  measSpan.style.letterSpacing = cs.letterSpacing;
  measSpan.textContent = text;
  document.body.appendChild(measSpan);
  const fullTextWidth = measSpan.getBoundingClientRect().width;

  if (ellipsisMode !== "force" && fullTextWidth <= availableWidth + 0.5) {
    // Text fits — no clipping needed
    document.body.removeChild(measSpan);
    return { text, quad: textQuad };
  }

  // Text overflows or must show a clamp ellipsis — find how many characters fit.
  let fitChars = text.length;
  const addEllipsis = ellipsisMode !== "none" && overflowMarker.length > 0;
  let clippedText = addEllipsis ? `${text.trimEnd()}${overflowMarker}` : text;
  measSpan.textContent = clippedText;

  if (measSpan.getBoundingClientRect().width > availableWidth) {
    for (let i = text.length - 1; i >= 0; i--) {
      const candidate = addEllipsis ? text.substring(0, i).trimEnd() + overflowMarker : text.substring(0, i);
      measSpan.textContent = candidate;
      if (measSpan.getBoundingClientRect().width <= availableWidth) {
        fitChars = i;
        clippedText = candidate;
        break;
      }
    }
  }

  const clippedWidth = measSpan.getBoundingClientRect().width;
  document.body.removeChild(measSpan);

  if (fitChars <= 0 && !addEllipsis) return null;

  if (fitChars <= 0 && addEllipsis) {
    clippedText = overflowMarker;
  }

  // Adjust the quad width proportionally
  if (fullTextWidth <= 0) return { text: clippedText, quad: textQuad };

  const fraction = Math.min(1, clippedWidth / fullTextWidth);
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

  const sourceLines = splitPreformattedTextBySourceLines(textNode, expectedLines);
  if (sourceLines) return sourceLines;

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

type LineClampConfig = {
  lines: number;
  marker: string;
};

function hasHiddenVerticalOverflow(el: Element): boolean {
  const block = el as HTMLElement;
  return block.scrollHeight > block.clientHeight + 0.5;
}

function getLineClamp(el: Element): number {
  return getLineClampConfig(el).lines;
}

function getLineClampConfig(el: Element): LineClampConfig {
  const cs = getComputedStyle(el);
  const legacyClampValue = cs.getPropertyValue("-webkit-line-clamp").trim();
  if (legacyClampValue) {
    const parsed = parseInt(legacyClampValue, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? { lines: parsed, marker: "…" }
      : { lines: 0, marker: "…" };
  }

  const clampValue = cs.getPropertyValue("line-clamp").trim();
  if (!clampValue || clampValue === "none") return { lines: 0, marker: "…" };

  const lineMatch = clampValue.match(/\b(\d+)\b/);
  const lines = lineMatch ? parseInt(lineMatch[1], 10) : 0;
  if (!Number.isFinite(lines) || lines <= 0) return { lines: 0, marker: "…" };

  if (/\bno-ellipsis\b/i.test(clampValue)) {
    return { lines, marker: "" };
  }

  const customMarker = clampValue.match(/(["'])(.*?)\1/);
  return {
    lines,
    marker: customMarker ? decodeCssStringLiteral(customMarker[2]) : "…",
  };
}

function decodeCssStringLiteral(value: string): string {
  return value
    .replace(/\\([\\"'])/g, "$1")
    .replace(/\\a\s?/gi, "\n");
}

function getQuadWidth(quad: Quad): number {
  const dx = quad[1].x - quad[0].x;
  const dy = quad[1].y - quad[0].y;
  return Math.sqrt(dx * dx + dy * dy);
}

function splitPreformattedTextBySourceLines(textNode: Text, expectedLines: number): string[] | null {
  const parentElement = textNode.parentElement;
  if (!parentElement) return null;

  const parentStyle = getComputedStyle(parentElement);
  if (parentStyle.whiteSpace !== "pre" && parentStyle.whiteSpace !== "pre-wrap" && parentStyle.whiteSpace !== "break-spaces") {
    return null;
  }

  const sourceLines = (textNode.textContent ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);

  return sourceLines.length === expectedLines ? sourceLines : null;
}
