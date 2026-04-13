/**
 * MathML element extraction.
 * Detects MathML-specific visual features rendered by the browser
 * (fraction bars, radical overlines, stretchy operators) that are not exposed as DOM text.
 */
import type { IRNode, Options, Style, Quad } from "../types.js";

/** Characters that the browser stretches vertically in MathML. */
const STRETCHY_CHARS = new Set([
  "[", "]", "(", ")", "{", "}", "|", "‖",
  "⟨", "⟩", "⌈", "⌉", "⌊", "⌋", "⟦", "⟧",
]);

/** Check if an element is a MathML root (<math>). */
export function isMathMLRoot(el: Element): boolean {
  return el.tagName.toLowerCase() === "math";
}

/** Check if an element is inside a MathML subtree. */
export function isMathMLElement(el: Element): boolean {
  return el.namespaceURI === "http://www.w3.org/1998/Math/MathML" ||
    el.closest?.("math") !== null;
}

/**
 * Extract MathML-specific visual features from a <math> subtree.
 * Walks the MathML DOM looking for elements that produce visible
 * decorations (fraction bars, radical overlines) and emits polyline
 * IR nodes for them.
 */
export function extractMathMLFeatures(
  mathRoot: Element,
  style: Style,
  baseIndex: number,
  _options: Options
): IRNode[] {
  const nodes: IRNode[] = [];
  let idx = baseIndex;

  // Fraction bars from <mfrac>
  const fracs = mathRoot.querySelectorAll("mfrac");
  for (const frac of Array.from(fracs)) {
    const bar = extractFractionBar(frac, style, idx);
    if (bar) { nodes.push(bar); idx++; }
  }

  // Radical signs from <msqrt> / <mroot>
  const radicals = mathRoot.querySelectorAll("msqrt, mroot");
  for (const rad of Array.from(radicals)) {
    const radicalNodes = extractRadicalSign(rad, style, idx);
    nodes.push(...radicalNodes);
    idx += radicalNodes.length;
  }

  // Stretchy operators from <mo> — adjust text quads to match visual size
  const mos = mathRoot.querySelectorAll("mo");
  for (const mo of Array.from(mos)) {
    const textContent = (mo.textContent ?? "").trim();
    if (STRETCHY_CHARS.has(textContent)) {
      const stretchyNode = extractStretchyOperator(mo, style, idx);
      if (stretchyNode) { nodes.push(stretchyNode); idx++; }
    }
  }

  return nodes;
}

/**
 * Extract the horizontal fraction bar from an <mfrac> element.
 * The bar sits between the numerator (first child) and denominator (second child).
 */
function extractFractionBar(
  frac: Element,
  parentStyle: Style,
  zIndex: number
): IRNode | null {
  const children = frac.children;
  if (children.length < 2) return null;

  const fracRect = frac.getBoundingClientRect();
  if (fracRect.width === 0 || fracRect.height === 0) return null;

  const numRect = children[0].getBoundingClientRect();
  const denRect = children[1].getBoundingClientRect();

  // The bar Y is midway between the numerator bottom and denominator top
  const barY = (numRect.bottom + denRect.top) / 2;

  const cs = getComputedStyle(frac);
  const color = cs.color || parentStyle.color || "rgb(0, 0, 0)";

  return {
    type: "polyline",
    points: [
      { x: fracRect.left, y: barY },
      { x: fracRect.right, y: barY },
    ],
    closed: false,
    style: {
      stroke: color,
      strokeWidth: "1px",
      color,
      opacity: parentStyle.opacity,
    },
    zIndex,
  };
}

/**
 * Extract the full radical sign from a <msqrt> or <mroot> element.
 * The browser draws:
 * 1. A diagonal line rising from lower-left to the overline
 * 2. A horizontal overline across the top of the radicand
 * Returns both lines as polyline IR nodes.
 */
function extractRadicalSign(
  radical: Element,
  parentStyle: Style,
  zIndex: number
): IRNode[] {
  const rect = radical.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return [];

  const cs = getComputedStyle(radical);
  const color = cs.color || parentStyle.color || "rgb(0, 0, 0)";
  const fontSize = parseFloat(cs.fontSize) || 16;
  // Radical line thickness scales with font size, typically about 5-8% of fontSize
  const lineWidth = Math.max(1, fontSize * 0.06);
  const strokeStyle: Style = {
    stroke: color,
    strokeWidth: `${lineWidth}px`,
    color,
    opacity: parentStyle.opacity,
  };
  const results: IRNode[] = [];

  // The overline is at the top of the element, starting after the radical glyph.
  const firstChild = radical.children[0];
  let contentLeft = rect.left;
  if (firstChild) {
    const childRect = firstChild.getBoundingClientRect();
    contentLeft = childRect.left;
  }

  // 1. Horizontal overline across the top
  results.push({
    type: "polyline",
    points: [
      { x: contentLeft, y: rect.top },
      { x: rect.right, y: rect.top },
    ],
    closed: false,
    style: strokeStyle,
    zIndex,
  });

  // 2. Diagonal line of the radical sign (from lower-left up to the overline start)
  // The radical glyph occupies the space from rect.left to contentLeft.
  // It has a small hook, then a diagonal rising to the overline.
  const glyphWidth = contentLeft - rect.left;
  if (glyphWidth > 2) {
    const hookX = rect.left + glyphWidth * 0.15;
    const hookY = rect.top + rect.height * 0.55;
    const bottomX = rect.left + glyphWidth * 0.4;
    const bottomY = rect.bottom;

    // Small hook at the start, then diagonal up to overline
    results.push({
      type: "polyline",
      points: [
        { x: hookX, y: hookY },
        { x: bottomX, y: bottomY },
        { x: contentLeft, y: rect.top },
      ],
      closed: false,
      style: strokeStyle,
      zIndex: zIndex + 1,
    });
  }

  return results;
}

/**
/**
 * Extract a stretchy operator (<mo>) as a polyline or text node with the
 * element's actual visual dimensions. The browser stretches delimiters like
 * [ ] ( ) to match their context, but text extraction may report the
 * unstretched size.
 *
 * Bracket-like operators ([ ] ( ) { }) are converted to polyline shapes
 * for precise positioning. Other stretchy operators use text nodes.
 */
function extractStretchyOperator(
  mo: Element,
  parentStyle: Style,
  zIndex: number
): IRNode | null {
  const rect = mo.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const text = (mo.textContent ?? "").trim();
  if (!text) return null;

  // Only emit a stretched version if the element is significantly taller
  // than would be expected for the font size (i.e., the browser stretched it)
  const cs = getComputedStyle(mo);
  const fontSize = parseFloat(cs.fontSize) || 16;
  if (rect.height <= fontSize * 1.5) return null; // Not stretched, normal extraction is fine

  const color = cs.color || parentStyle.color || "rgb(0, 0, 0)";
  const lineWidth = Math.max(1, fontSize * 0.06);

  // For bracket characters, draw as polylines for precise sizing/positioning
  if (text === "[" || text === "]") {
    const isLeft = text === "[";
    const anchor = isLeft ? rect.left : rect.right;
    const far = isLeft ? rect.left + rect.width * 0.5 : rect.right - rect.width * 0.5;
    return {
      type: "polyline",
      points: [
        { x: far, y: rect.top },
        { x: anchor, y: rect.top },
        { x: anchor, y: rect.bottom },
        { x: far, y: rect.bottom },
      ],
      closed: false,
      style: { stroke: color, strokeWidth: `${lineWidth}px`, opacity: parentStyle.opacity },
      zIndex,
    };
  }

  if (text === "(" || text === ")") {
    const isLeft = text === "(";
    const anchor = isLeft ? rect.left + rect.width * 0.15 : rect.right - rect.width * 0.15;
    const far = isLeft ? rect.right - rect.width * 0.1 : rect.left + rect.width * 0.1;
    const midX = (anchor + far) / 2;
    const h = rect.bottom - rect.top;
    return {
      type: "polyline",
      points: [
        { x: far, y: rect.top },
        { x: midX, y: rect.top + h * 0.15 },
        { x: anchor, y: rect.top + h * 0.35 },
        { x: anchor, y: rect.top + h * 0.65 },
        { x: midX, y: rect.top + h * 0.85 },
        { x: far, y: rect.bottom },
      ],
      closed: false,
      style: { stroke: color, strokeWidth: `${lineWidth}px`, opacity: parentStyle.opacity },
      zIndex,
    };
  }

  if (text === "{" || text === "}") {
    const isLeft = text === "{";
    const far = isLeft ? rect.right - rect.width * 0.1 : rect.left + rect.width * 0.1;
    const mid = isLeft ? rect.left + rect.width * 0.15 : rect.right - rect.width * 0.15;
    const tip = isLeft ? rect.left : rect.right;
    const h = rect.bottom - rect.top;
    return {
      type: "polyline",
      points: [
        { x: far, y: rect.top },
        { x: mid, y: rect.top + h * 0.05 },
        { x: mid, y: rect.top + h * 0.45 },
        { x: tip, y: rect.top + h * 0.5 },
        { x: mid, y: rect.top + h * 0.55 },
        { x: mid, y: rect.top + h * 0.95 },
        { x: far, y: rect.bottom },
      ],
      closed: false,
      style: { stroke: color, strokeWidth: `${lineWidth}px`, opacity: parentStyle.opacity },
      zIndex,
    };
  }

  if (text === "|") {
    const cx = (rect.left + rect.right) / 2;
    return {
      type: "polyline",
      points: [
        { x: cx, y: rect.top },
        { x: cx, y: rect.bottom },
      ],
      closed: false,
      style: { stroke: color, strokeWidth: `${lineWidth}px`, opacity: parentStyle.opacity },
      zIndex,
    };
  }

  // Fallback: emit as text with adjusted font size
  const quad: Quad = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];

  return {
    type: "text",
    quad,
    text,
    style: {
      fontSize: `${rect.height}px`,
      fontFamily: cs.fontFamily || parentStyle.fontFamily,
      fontWeight: cs.fontWeight || parentStyle.fontWeight,
      fontStyle: cs.fontStyle || parentStyle.fontStyle,
      color,
      opacity: parentStyle.opacity,
    },
    zIndex,
  };
}
