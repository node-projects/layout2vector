/**
 * Extraction of ::before, ::after, and ::marker pseudo-element geometry.
 *
 * Strategy: for each pseudo-element with generated content we
 *  1.  Read the raw content from getComputedStyle(el, pseudo).
 *  2.  Resolve counter(), counters(), attr(), and open/close-quote tokens
 *      into their actual text values by walking the DOM.
 *  3.  Suppress the real pseudo-element via an injected stylesheet rule.
 *  4.  Insert a replacement <hc-pseudo> element that carries the same
 *      computed styles so it occupies identical layout space.
 *  5.  Measure it with getBoxQuads (handles CSS transforms correctly).
 *  6.  Generate polygon + text IR nodes.
 *  7.  Restore the original DOM immediately.
 */
import type { Quad, Style, IRNode, Options } from "../types.js";
import { extractStyle } from "../traversal.js";
import { getElementQuads } from "../geometry.js";
import { extractBackgroundImage, extractMaskedElementImage, hasBackgroundImage } from "./image-extractor.js";

/**
 * Computed-style properties copied to the replacement element so that
 * it occupies the same space as the pseudo-element it replaces.
 */
const COPY_PROPERTIES = [
  "display", "position", "float", "clear",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "box-sizing", "vertical-align",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-top-width", "border-top-style", "border-top-color",
  "border-right-width", "border-right-style", "border-right-color",
  "border-bottom-width", "border-bottom-style", "border-bottom-color",
  "border-left-width", "border-left-style", "border-left-color",
  "border-radius",
  "font-size", "font-family", "font-weight", "font-style",
  "line-height", "letter-spacing", "word-spacing",
  "text-decoration", "text-transform", "white-space",
  "color", "background-color", "background-image",
  "opacity", "transform",
  "overflow", "text-overflow",
  "top", "right", "bottom", "left",
  "inset-inline-start", "inset-inline-end",
];

// ─── public API ──────────────────────────────────────────────

/**
 * Extract IR nodes for the ::before and ::after pseudo-elements of
 * the given element.  Returns an empty array when there is nothing
 * to extract.
 */
export function extractPseudoElements(
  el: Element,
  parentStyle: Style,
  globalIndex: number,
  options: Options,
): IRNode[] {
  const results: IRNode[] = [];
  for (const pseudo of ["::before", "::after"] as const) {
    const nodes = extractOnePseudo(el, pseudo, parentStyle, globalIndex + results.length, options);
    results.push(...nodes);
  }
  const markerNodes = extractMarkerPseudo(el, parentStyle, globalIndex + results.length, options);
  results.push(...markerNodes);
  return results;
}

const DEFAULT_LIST_MARKER_TEXT: Record<string, string> = {
  disc: "\u2022",
  circle: "\u25e6",
  square: "\u25aa",
  "disclosure-open": "\u25be",
  "disclosure-closed": "\u25b8",
};

const MARKER_TEXT_PROPERTIES = [
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "white-space",
  "color",
] as const;

// ─── content token types ─────────────────────────────────────

type ContentToken =
  | { type: "string"; value: string }
  | { type: "counter"; name: string; listStyle?: string }
  | { type: "counters"; name: string; separator: string; listStyle?: string }
  | { type: "attr"; name: string }
  | { type: "open-quote" }
  | { type: "close-quote" };

// ─── content parsing ─────────────────────────────────────────

/**
 * Parse a CSS `content` computed value into display text.
 * Resolves counter(), counters(), attr(), and quote keywords against
 * the generating element.
 *
 * Returns the resolved text string (may be empty for `content: ""`),
 * or `null` when the value is `none`, `normal`, or non-textual (url()).
 */
export function parseCSSContentValue(content: string, el?: Element): string | null {
  if (!content || content === "none" || content === "normal") return null;
  if (/\burl\s*\(/.test(content)) return null;

  const tokens = tokenizeContent(content);
  if (tokens.length === 0) return null;

  // Check if all tokens are simple strings (fast path)
  const allStrings = tokens.every(t => t.type === "string");
  if (allStrings) {
    const result = tokens.map(t => (t as { value: string }).value).join("");
    return result.length > 0 || tokens.length > 0 ? result : null;
  }

  // Need element context for counter/attr/quote resolution
  if (!el) return tokens.filter(t => t.type === "string").map(t => (t as { value: string }).value).join("") || null;

  let result = "";
  for (const token of tokens) {
    switch (token.type) {
      case "string":
        result += token.value;
        break;
      case "counter":
        result += formatCounter(resolveCounter(el, token.name), token.listStyle);
        break;
      case "counters":
        result += resolveCountersValue(el, token.name, token.separator, token.listStyle);
        break;
      case "attr":
        result += el.getAttribute(token.name) ?? "";
        break;
      case "open-quote":
        result += resolveQuote(el, true);
        break;
      case "close-quote":
        result += resolveQuote(el, false);
        break;
    }
  }

  return result.length > 0 || tokens.length > 0 ? result : null;
}

// ─── tokenizer ───────────────────────────────────────────────

function tokenizeContent(content: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    while (i < len && content[i] === " ") i++;
    if (i >= len) break;

    if (content[i] === '"' || content[i] === "'") {
      const q = content[i++];
      let s = "";
      while (i < len && content[i] !== q) {
        if (content[i] === "\\" && i + 1 < len) { i++; s += content[i++]; }
        else { s += content[i++]; }
      }
      if (i < len) i++;
      tokens.push({ type: "string", value: s });
    } else if (content.startsWith("counter(", i)) {
      const inner = extractParenContent(content, i + 8);
      if (inner !== null) {
        const args = inner.text.split(",").map(s => s.trim());
        tokens.push({ type: "counter", name: args[0], listStyle: args[1] });
        i = inner.end;
      } else { i++; }
    } else if (content.startsWith("counters(", i)) {
      const inner = extractParenContent(content, i + 9);
      if (inner !== null) {
        const args = splitCSVRespectingQuotes(inner.text);
        tokens.push({
          type: "counters",
          name: args[0]?.trim() ?? "",
          separator: stripQuotes(args[1]?.trim() ?? '""'),
          listStyle: args[2]?.trim(),
        });
        i = inner.end;
      } else { i++; }
    } else if (content.startsWith("attr(", i)) {
      const inner = extractParenContent(content, i + 5);
      if (inner !== null) {
        tokens.push({ type: "attr", name: inner.text.trim() });
        i = inner.end;
      } else { i++; }
    } else if (content.startsWith("open-quote", i)) {
      tokens.push({ type: "open-quote" });
      i += 10;
    } else if (content.startsWith("close-quote", i)) {
      tokens.push({ type: "close-quote" });
      i += 11;
    } else {
      i++;
    }
  }
  return tokens;
}

function extractParenContent(s: string, start: number): { text: string; end: number } | null {
  let depth = 1;
  let j = start;
  while (j < s.length && depth > 0) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") depth--;
    j++;
  }
  if (depth !== 0) return null;
  return { text: s.slice(start, j - 1), end: j };
}

function splitCSVRespectingQuotes(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQ = false;
  let qc = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { cur += ch; if (ch === qc) inQ = false; }
    else if (ch === '"' || ch === "'") { inQ = true; qc = ch; cur += ch; }
    else if (ch === ",") { parts.push(cur); cur = ""; }
    else { cur += ch; }
  }
  parts.push(cur);
  return parts;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1).replace(/\\(.)/g, "$1");
  return s;
}

// ─── counter resolution ─────────────────────────────────────

/**
 * Parse a `counter-reset` or `counter-increment` CSS value into a map
 * of counter-name → numeric value.
 * Default value for `counter-reset` is 0, for `counter-increment` is 1.
 */
function parseCounterProp(value: string | null | undefined, defaultVal: number): Record<string, number> | null {
  if (!value || value === "none" || value === "initial") return null;
  const result: Record<string, number> = {};
  const parts = value.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length) {
    const name = parts[i];
    if (name === "none" || name === "initial" || name === "inherit") { i++; continue; }
    i++;
    if (i < parts.length && /^-?\d+$/.test(parts[i])) {
      result[name] = parseInt(parts[i], 10);
      i++;
    } else {
      result[name] = defaultVal;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Resolve the value of `counter(name)` for a given element.
 * Uses TreeWalker to correctly skip over nested counter-reset subtrees
 * that don't contain the target element.
 */
function resolveCounter(el: Element, name: string): number {
  // Find the innermost ancestor (or self) with counter-reset for `name`
  let resetEl: Element | null = null;
  let resetValue = 0;
  let cur: Element | null = el;
  while (cur) {
    const cr = getComputedStyle(cur).getPropertyValue("counter-reset");
    const parsed = parseCounterProp(cr, 0);
    if (parsed && name in parsed) {
      resetEl = cur;
      resetValue = parsed[name];
      break;
    }
    cur = cur.parentElement;
  }
  if (!resetEl) {
    resetEl = el.ownerDocument!.documentElement;
    resetValue = 0;
  }

  return walkCounterScope(resetEl, el, name, resetValue);
}

/**
 * Walk a counter scope from `scopeEl` to `targetEl` in tree order,
 * summing counter-increment values while correctly skipping nested
 * counter-reset subtrees that don't lead to `targetEl`.
 */
function walkCounterScope(scopeEl: Element, targetEl: Element, name: string, startValue: number): number {
  let value = startValue;
  const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_ELEMENT);
  let node: Element | null = walker.firstChild() as Element | null;

  while (node) {
    // Check for nested counter-reset
    const cr = getComputedStyle(node).getPropertyValue("counter-reset");
    const crP = parseCounterProp(cr, 0);
    if (crP && name in crP) {
      if (node === targetEl || node.contains(targetEl)) {
        // Target is inside this nested scope — recurse
        return walkCounterScope(node, targetEl, name, crP[name]);
      }
      // Target is NOT in this subtree — skip it entirely
      node = skipSubtree(walker);
      continue;
    }

    // Count increment
    const ci = getComputedStyle(node).getPropertyValue("counter-increment");
    const ciP = parseCounterProp(ci, 1);
    if (ciP && name in ciP) value += ciP[name];

    if (node === targetEl) break;
    node = walker.nextNode() as Element | null;
  }
  return value;
}

/** Advance a TreeWalker past the current node's entire subtree. */
function skipSubtree(walker: TreeWalker): Element | null {
  let node = walker.nextSibling() as Element | null;
  if (node) return node;
  // No sibling at this level — walk up until we find one
  while (walker.parentNode()) {
    node = walker.nextSibling() as Element | null;
    if (node) return node;
  }
  return null;
}

/**
 * Resolve `counters(name, separator)` — all nested counter instances
 * joined with the separator string.
 */
function resolveCountersValue(el: Element, name: string, separator: string, listStyle?: string): string {
  // Collect ALL counter-reset ancestors for `name` from root to el
  const scopes: { resetEl: Element; resetValue: number }[] = [];
  let cur: Element | null = el;
  while (cur) {
    const cr = getComputedStyle(cur).getPropertyValue("counter-reset");
    const parsed = parseCounterProp(cr, 0);
    if (parsed && name in parsed) {
      scopes.unshift({ resetEl: cur, resetValue: parsed[name] });
    }
    cur = cur.parentElement;
  }
  if (scopes.length === 0) return formatCounter(0, listStyle);

  const values: number[] = [];
  for (let si = 0; si < scopes.length; si++) {
    const scope = scopes[si];
    let value = scope.resetValue;

    // Walk scope's subtree, but skip nested counter-reset subtrees for `name`
    // UNLESS they are an ancestor of (or equal to) el.
    const walker = document.createTreeWalker(scope.resetEl, NodeFilter.SHOW_ELEMENT);
    let node: Element | null = walker.firstChild() as Element | null;

    while (node) {
      // Is this a nested counter-reset?
      const cr = getComputedStyle(node).getPropertyValue("counter-reset");
      const crP = parseCounterProp(cr, 0);
      if (crP && name in crP) {
        if (node === el || node.contains(el)) {
          // Target is inside this nested scope — stop the current scope here
          break;
        }
        // Target not inside — skip this subtree
        node = skipSubtree(walker);
        continue;
      }

      // Count increment
      const ci = getComputedStyle(node).getPropertyValue("counter-increment");
      const ciP = parseCounterProp(ci, 1);
      if (ciP && name in ciP) value += ciP[name];

      if (node === el) break;
      node = walker.nextNode() as Element | null;
    }
    values.push(value);
  }

  return values.map(v => formatCounter(v, listStyle)).join(separator);
}

/**
 * Format a counter integer according to a CSS list-style-type.
 * Supports decimal (default), lower-alpha, upper-alpha, lower-roman, upper-roman.
 */
function formatCounter(value: number, listStyle?: string): string {
  switch (listStyle) {
    case "lower-alpha":
    case "lower-latin":
      return value >= 1 && value <= 26 ? String.fromCharCode(96 + value) : String(value);
    case "upper-alpha":
    case "upper-latin":
      return value >= 1 && value <= 26 ? String.fromCharCode(64 + value) : String(value);
    case "lower-roman":
      return toRoman(value).toLowerCase();
    case "upper-roman":
      return toRoman(value);
    default:
      return String(value);
  }
}

function toRoman(n: number): string {
  if (n <= 0 || n > 3999) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let result = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

function resolveDefaultMarkerText(el: Element, listStyleType: string): string | null {
  if (!listStyleType || listStyleType === "none") return null;
  if (listStyleType in DEFAULT_LIST_MARKER_TEXT) {
    return DEFAULT_LIST_MARKER_TEXT[listStyleType];
  }

  const listItemValue = resolveCounter(el, "list-item");
  switch (listStyleType) {
    case "decimal":
      return `${listItemValue}.`;
    case "decimal-leading-zero":
      return `${String(listItemValue).padStart(2, "0")}.`;
    case "lower-alpha":
    case "lower-latin":
    case "upper-alpha":
    case "upper-latin":
    case "lower-roman":
    case "upper-roman":
      return `${formatCounter(listItemValue, listStyleType)}.`;
    default:
      return null;
  }
}

function firstContentRect(el: Element): DOMRect | null {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  return rects[0] ?? null;
}

function translateQuad(quad: Quad, dx: number, dy: number): Quad {
  return quad.map((point) => ({ x: point.x + dx, y: point.y + dy })) as Quad;
}

function resolveMarkerText(el: Element, markerCs: CSSStyleDeclaration): string | null {
  const rawContent = markerCs.content;
  if (rawContent && rawContent !== "normal" && rawContent !== "none") {
    return parseCSSContentValue(rawContent, el);
  }

  const listStyleType = getComputedStyle(el).listStyleType;
  return resolveDefaultMarkerText(el, listStyleType);
}

function extractMarkerPseudo(
  el: Element,
  parentStyle: Style,
  globalIndex: number,
  options: Options,
): IRNode[] {
  const elStyle = getComputedStyle(el);
  if (elStyle.display !== "list-item") return [];

  const markerCs = getComputedStyle(el, "::marker");
  if (markerCs.display === "none") return [];
  if (markerCs.visibility === "hidden") return [];
  if (markerCs.opacity === "0") return [];

  const text = resolveMarkerText(el, markerCs);
  if (!text) return [];

  const temp = document.createElement("hc-marker");
  temp.textContent = text;
  temp.style.position = "fixed";
  temp.style.left = "0";
  temp.style.top = "0";
  temp.style.visibility = "hidden";
  temp.style.pointerEvents = "none";
  temp.style.display = "inline-block";
  for (const prop of MARKER_TEXT_PROPERTIES) {
    const value = markerCs.getPropertyValue(prop);
    if (value && value !== "initial" && value !== "") {
      temp.style.setProperty(prop, value);
    }
  }

  document.body.appendChild(temp);
  const measuredQuad = getElementQuads(temp, options.boxType ?? "border")[0];
  temp.remove();
  if (!measuredQuad) return [];

  const liRect = el.getBoundingClientRect();
  const firstRect = firstContentRect(el);
  const markerHeight = parseFloat(markerCs.lineHeight || markerCs.fontSize) || (firstRect?.height ?? liRect.height);
  const markerLaneWidth = el.parentElement
    ? parseFloat(getComputedStyle(el.parentElement).paddingInlineStart) || (parseFloat(markerCs.fontSize) || 14) * 2
    : (parseFloat(markerCs.fontSize) || 14) * 2;

  const currentCenterX = (measuredQuad[0].x + measuredQuad[1].x) / 2;
  const currentCenterY = (measuredQuad[0].y + measuredQuad[3].y) / 2;
  const desiredCenterX = elStyle.listStylePosition === "inside"
    ? liRect.left + markerLaneWidth / 2
    : liRect.left - markerLaneWidth / 2;
  const desiredCenterY = (firstRect?.top ?? liRect.top) + markerHeight / 2;
  const quad = translateQuad(measuredQuad, desiredCenterX - currentCenterX, desiredCenterY - currentCenterY);

  const markerStyle = extractStyle(markerCs);
  markerStyle.opacity = parentStyle.opacity;
  if (parentStyle.clipBounds) markerStyle.clipBounds = parentStyle.clipBounds;
  if (parentStyle.clipQuads) markerStyle.clipQuads = parentStyle.clipQuads;

  return [{
    type: "text",
    quad,
    text,
    style: markerStyle,
    zIndex: globalIndex,
  }];
}

// ─── quote resolution ────────────────────────────────────────

function resolveQuote(el: Element, isOpen: boolean): string {
  const cs = getComputedStyle(el);
  const quotesVal = cs.quotes;
  if (!quotesVal || quotesVal === "none" || quotesVal === "auto") {
    return isOpen ? "\u201C" : "\u201D"; // "" default
  }
  // Parse quotes pairs:  "«" "»" "‹" "›"
  const pairs: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(quotesVal)) !== null) {
    pairs.push((m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1"));
  }
  // Nesting depth is 0 for outermost, use first pair
  if (pairs.length >= 2) {
    return isOpen ? pairs[0] : pairs[1];
  }
  return isOpen ? "\u201C" : "\u201D";
}

// ─── single pseudo extraction ────────────────────────────────

function extractOnePseudo(
  el: Element,
  pseudo: "::before" | "::after",
  parentStyle: Style,
  globalIndex: number,
  options: Options,
): IRNode[] {
  const pseudoCs = getComputedStyle(el, pseudo);

  // Skip when pseudo-element isn't generated
  if (pseudoCs.display === "none") return [];
  if (pseudoCs.visibility === "hidden") return [];
  if (pseudoCs.opacity === "0") return [];
  const rawContent = pseudoCs.content;
  if (!rawContent || rawContent === "none" || rawContent === "normal") return [];

  // Parse content into display text, resolving counter/attr/quote tokens
  const text = parseCSSContentValue(rawContent, el);
  if (text === null) return [];            // non-text or unresolvable
  const hasText = text.length > 0;

  // Build the IR style from the pseudo's computed style
  const pseudoStyle = extractStyle(pseudoCs);
  pseudoStyle.opacity = parentStyle.opacity; // inherit accumulated opacity

  // Propagate clip bounds from the parent if present
  if (parentStyle.clipBounds) pseudoStyle.clipBounds = parentStyle.clipBounds;
  if (parentStyle.clipQuads)  pseudoStyle.clipQuads  = parentStyle.clipQuads;

  // ── Temporarily replace the pseudo with a real element ───────

  // Unique attribute used by the suppress rule so it targets only this element
  const attr = "data-hcps-" + ((Math.random() * 0x100000000) >>> 0).toString(36);
  el.setAttribute(attr, "");

  const suppressSheet = document.createElement("style");
  suppressSheet.textContent = `[${attr}]${pseudo}{content:none!important}`;
  document.head.appendChild(suppressSheet);

  const temp = document.createElement("hc-pseudo");
  for (const prop of COPY_PROPERTIES) {
    const v = pseudoCs.getPropertyValue(prop);
    if (v && v !== "initial" && v !== "") {
      temp.style.setProperty(prop, v);
    }
  }
  if (hasText) temp.textContent = text;

  if (pseudo === "::before") {
    el.insertBefore(temp, el.firstChild);
  } else {
    el.appendChild(temp);
  }

  try {
    const boxType = options.boxType ?? "border";
    const quads = getElementQuads(temp, boxType) as Quad[];

    if (!hasText && options.includeImages) {
      if (pseudoStyle.mask && pseudoStyle.mask !== "none") {
        const maskedNodes = extractMaskedElementImage(temp, pseudoStyle, globalIndex, options);
        if (maskedNodes.length > 0) return maskedNodes;
      }

      if (hasBackgroundImage(pseudoStyle)) {
        const backgroundNodes = extractBackgroundImage(temp, pseudoStyle, globalIndex, options);
        if (backgroundNodes.length > 0) return backgroundNodes;
      }
    }

    const results: IRNode[] = [];

    for (const quad of quads) {
      results.push({
        type: "polygon",
        points: quad,
        style: pseudoStyle,
        zIndex: globalIndex,
      });
    }

    if (hasText && quads.length > 0) {
      results.push({
        type: "text",
        quad: quads[0],
        text,
        style: pseudoStyle,
        zIndex: globalIndex,
      });
    }

    return results;
  } finally {
    temp.remove();
    suppressSheet.remove();
    el.removeAttribute(attr);
  }
}
