/**
 * MathML element extraction.
 * Detects MathML-specific visual features rendered by the browser
 * (fraction bars, radical overlines) that are not exposed as DOM text.
 */
import type { IRNode, Options, Style, Quad } from "./types.js";

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

  // Radical overlines from <msqrt> / <mroot>
  const radicals = mathRoot.querySelectorAll("msqrt, mroot");
  for (const rad of Array.from(radicals)) {
    const line = extractRadicalOverline(rad, style, idx);
    if (line) { nodes.push(line); idx++; }
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
 * Extract the overline from a <msqrt> or <mroot> element.
 * The browser draws a horizontal bar across the top of the radicand.
 */
function extractRadicalOverline(
  radical: Element,
  parentStyle: Style,
  zIndex: number
): IRNode | null {
  const rect = radical.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const cs = getComputedStyle(radical);
  const color = cs.color || parentStyle.color || "rgb(0, 0, 0)";

  // The overline is at the top of the element, starting after the radical glyph.
  // The radical glyph occupies roughly the left portion of the element.
  // We approximate: the first child is the radicand content.
  const firstChild = radical.children[0];
  let lineLeft = rect.left;
  if (firstChild) {
    const childRect = firstChild.getBoundingClientRect();
    // The radical glyph is to the left of the content;
    // draw the overline from content left to content right
    lineLeft = childRect.left;
  }

  return {
    type: "polyline",
    points: [
      { x: lineLeft, y: rect.top },
      { x: rect.right, y: rect.top },
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
