import type { IRNode, Options, Point, Quad, Style } from "../types.js";
import type { StackingNode } from "../traversal.js";
import { getElementQuad, quadSize } from "../geometry.js";

const DEFAULT_ACCENT_COLOR = "rgb(0, 117, 255)";
const DEFAULT_BORDER_COLOR = "rgb(118, 118, 118)";
const DEFAULT_SURFACE_COLOR = "rgb(255, 255, 255)";
const DEFAULT_BUTTON_COLOR = "rgb(239, 239, 239)";
const DEFAULT_PROGRESS_TRACK = "rgb(232, 232, 232)";
const DEFAULT_ICON_COLOR = "rgb(80, 80, 80)";

const TEXT_LIKE_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "password",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);

type LocalRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

let measureContext: CanvasRenderingContext2D | null | undefined;

export function shouldSkipFormControlDescendant(el: Element, options: Options): boolean {
  if (!options.convertFormControls) return false;
  const selectAncestor = el.closest("select");
  return selectAncestor !== null && selectAncestor !== el;
}

export function extractFormControlGeometry(
  node: StackingNode,
  globalIndex: number,
  options: Options
): IRNode[] | null {
  if (!options.convertFormControls) return null;

  const el = node.element;
  if (!(el instanceof HTMLElement)) return null;
  if (shouldSkipFormControlDescendant(el, options)) return [];

  if (el instanceof HTMLTextAreaElement) {
    return extractTextAreaGeometry(el, node, globalIndex);
  }
  if (el instanceof HTMLSelectElement) {
    return extractSelectGeometry(el, node, globalIndex);
  }
  if (el instanceof HTMLProgressElement) {
    return extractProgressGeometry(el, node, globalIndex);
  }
  if (el instanceof HTMLInputElement) {
    return extractInputGeometry(el, node, globalIndex);
  }

  return null;
}

function extractInputGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] | null {
  const type = input.type.toLowerCase();

  if (type === "checkbox") {
    return extractCheckboxGeometry(input, node, globalIndex);
  }
  if (type === "radio") {
    return extractRadioGeometry(input, node, globalIndex);
  }
  if (BUTTON_INPUT_TYPES.has(type)) {
    return extractButtonInputGeometry(input, node, globalIndex, defaultButtonLabel(type));
  }
  if (TEXT_LIKE_INPUT_TYPES.has(type) || type === "") {
    return extractSingleLineControlGeometry(input, node, globalIndex, getInputDisplayValue(input), "left", DEFAULT_SURFACE_COLOR);
  }

  return null;
}

function extractCheckboxGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(input);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(input);
  const accentColor = getAccentColor(cs, node.extractedStyle.color);
  const side = Math.min(localWidth, localHeight);
  const offsetX = Math.max(0, (localWidth - side) / 2);
  const offsetY = Math.max(0, (localHeight - side) / 2);
  const boxQuad = localRectToQuad(quad, offsetX, offsetY, side, side, localWidth, localHeight);

  const nodes: IRNode[] = [];
  const checked = input.checked;
  const indeterminate = input.indeterminate;
  const boxStyle = {
    ...node.extractedStyle,
    fill: checked || indeterminate ? accentColor : DEFAULT_SURFACE_COLOR,
    stroke: checked || indeterminate ? accentColor : DEFAULT_BORDER_COLOR,
    strokeWidth: normalizeStrokeWidth(node.extractedStyle.strokeWidth, 1.5),
    borderRadius: hasMeaningfulRadius(node.extractedStyle.borderRadius) ? node.extractedStyle.borderRadius : "3px",
  } satisfies Style;

  nodes.push({
    type: "polygon",
    points: boxQuad,
    style: boxStyle,
    zIndex: globalIndex,
  });

  if (checked) {
    nodes.push({
      type: "polyline",
      points: [
        mapLocalPoint(quad, offsetX + side * 0.22, offsetY + side * 0.54, localWidth, localHeight),
        mapLocalPoint(quad, offsetX + side * 0.42, offsetY + side * 0.74, localWidth, localHeight),
        mapLocalPoint(quad, offsetX + side * 0.78, offsetY + side * 0.3, localWidth, localHeight),
      ],
      closed: false,
      style: {
        color: "rgb(255, 255, 255)",
        stroke: "rgb(255, 255, 255)",
        strokeWidth: `${Math.max(1.25, side * 0.14)}px`,
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 1,
    });
  } else if (indeterminate) {
    const barQuad = localRectToQuad(
      quad,
      offsetX + side * 0.2,
      offsetY + side * 0.43,
      side * 0.6,
      Math.max(2, side * 0.14),
      localWidth,
      localHeight
    );
    nodes.push({
      type: "polygon",
      points: barQuad,
      style: {
        fill: "rgb(255, 255, 255)",
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 1,
    });
  }

  return nodes;
}

function extractRadioGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(input);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(input);
  const accentColor = getAccentColor(cs, node.extractedStyle.color);
  const size = Math.min(localWidth, localHeight);
  const radius = size / 2;
  const centerX = localWidth / 2;
  const centerY = localHeight / 2;

  const nodes: IRNode[] = [];
  nodes.push({
    type: "polyline",
    points: approximateEllipsePoints(quad, centerX, centerY, radius, radius, localWidth, localHeight, 28),
    closed: true,
    style: {
      fill: DEFAULT_SURFACE_COLOR,
      stroke: input.checked ? accentColor : DEFAULT_BORDER_COLOR,
      strokeWidth: normalizeStrokeWidth(node.extractedStyle.strokeWidth, 1.5),
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex,
  });

  if (input.checked) {
    nodes.push({
      type: "polyline",
      points: approximateEllipsePoints(quad, centerX, centerY, radius * 0.42, radius * 0.42, localWidth, localHeight, 24),
      closed: true,
      style: {
        fill: accentColor,
        stroke: accentColor,
        strokeWidth: "1px",
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 1,
    });
  }

  return nodes;
}

function extractButtonInputGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number,
  fallbackLabel: string
): IRNode[] {
  const value = input.value || fallbackLabel;
  return extractSingleLineControlGeometry(input, node, globalIndex, value, "center", DEFAULT_BUTTON_COLOR);
}

function extractSingleLineControlGeometry(
  el: HTMLElement,
  node: StackingNode,
  globalIndex: number,
  rawText: string,
  align: "left" | "center",
  fillFallback: string
): IRNode[] {
  const geometry = getControlGeometry(el);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(el);
  const boxStyle = getControlBoxStyle(node.extractedStyle, fillFallback, DEFAULT_BORDER_COLOR, 4);
  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.min(getLineHeight(node.extractedStyle, cs, fontSize), localHeight);
  const paddingX = Math.max(parsePx(cs.paddingLeft), align === "center" ? 8 : 6);
  const paddingY = Math.max(parsePx(cs.paddingTop), 4);
  const contentBox = insetRect(localWidth, localHeight, paddingX, paddingY, Math.max(parsePx(cs.paddingRight), paddingX), Math.max(parsePx(cs.paddingBottom), paddingY));

  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: boxStyle,
    zIndex: globalIndex,
  }];

  const text = rawText.trim();
  if (!text) return nodes;

  const textNode = createSingleLineTextNode(text, quad, localWidth, localHeight, contentBox, node.extractedStyle, cs, globalIndex + 1, align, lineHeight);
  if (textNode) nodes.push(textNode);
  return nodes;
}

function extractTextAreaGeometry(
  textarea: HTMLTextAreaElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(textarea);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(textarea);
  const boxStyle = getControlBoxStyle(node.extractedStyle, DEFAULT_SURFACE_COLOR, DEFAULT_BORDER_COLOR, 4);
  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.max(1, getLineHeight(node.extractedStyle, cs, fontSize));
  const paddingLeft = Math.max(parsePx(cs.paddingLeft), 6);
  const paddingTop = Math.max(parsePx(cs.paddingTop), 4);
  const paddingRight = Math.max(parsePx(cs.paddingRight), paddingLeft);
  const paddingBottom = Math.max(parsePx(cs.paddingBottom), paddingTop);
  const contentBox = insetRect(localWidth, localHeight, paddingLeft, paddingTop, paddingRight, paddingBottom);

  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: boxStyle,
    zIndex: globalIndex,
  }];

  const rawValue = textarea.value.replace(/\r\n?/g, "\n");
  if (!rawValue.trim()) return nodes;

  const lines = textarea.wrap === "off"
    ? rawValue.split("\n")
    : wrapText(rawValue, Math.max(1, contentBox.width), node.extractedStyle, cs);
  const maxLines = Math.max(1, Math.floor(contentBox.height / lineHeight));

  let zIndex = globalIndex + 1;
  for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
    const text = lines[index].trim();
    if (!text) continue;
    const top = contentBox.top + index * lineHeight;
    const availableHeight = Math.min(lineHeight, Math.max(1, contentBox.top + contentBox.height - top));
    const lineBox: LocalRect = {
      left: contentBox.left,
      top,
      width: contentBox.width,
      height: availableHeight,
    };
    const textNode = createSingleLineTextNode(text, quad, localWidth, localHeight, lineBox, node.extractedStyle, cs, zIndex++, "left", Math.min(lineHeight, availableHeight));
    if (textNode) nodes.push(textNode);
  }

  return nodes;
}

function extractSelectGeometry(
  select: HTMLSelectElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(select);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(select);
  const boxStyle = getControlBoxStyle(
    shouldUseFallbackControlFill(cs) ? { ...node.extractedStyle, fill: undefined } : node.extractedStyle,
    DEFAULT_SURFACE_COLOR,
    DEFAULT_BORDER_COLOR,
    4
  );
  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: boxStyle,
    zIndex: globalIndex,
  }];

  const isListBox = select.multiple || select.size > 1;
  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.max(1, getLineHeight(node.extractedStyle, cs, fontSize));
  const paddingLeft = Math.max(parsePx(cs.paddingLeft), 6);
  const paddingTop = Math.max(parsePx(cs.paddingTop), 4);
  const paddingBottom = Math.max(parsePx(cs.paddingBottom), paddingTop);
  const arrowSlotWidth = isListBox ? 0 : Math.max(18, Math.min(24, localHeight * 0.35));
  const contentBox = insetRect(localWidth, localHeight, paddingLeft, paddingTop, Math.max(parsePx(cs.paddingRight), 6) + arrowSlotWidth, paddingBottom);

  if (isListBox) {
    const selectedTexts = Array.from(select.selectedOptions).map((option) => option.textContent?.trim() ?? "").filter(Boolean);
    let zIndex = globalIndex + 1;
    for (const [index, text] of selectedTexts.entries()) {
      const top = contentBox.top + index * lineHeight;
      const availableHeight = Math.min(lineHeight, Math.max(1, contentBox.top + contentBox.height - top));
      if (availableHeight <= 0) break;
      const lineBox: LocalRect = {
        left: contentBox.left,
        top,
        width: contentBox.width,
        height: availableHeight,
      };
      const textNode = createSingleLineTextNode(text, quad, localWidth, localHeight, lineBox, node.extractedStyle, cs, zIndex++, "left", availableHeight);
      if (textNode) nodes.push(textNode);
    }
    return nodes;
  }

  const selectedText = select.selectedOptions[0]?.textContent?.trim() ?? "";
  const textNode = createSingleLineTextNode(selectedText, quad, localWidth, localHeight, contentBox, node.extractedStyle, cs, globalIndex + 1, "left", Math.min(lineHeight, contentBox.height));
  if (textNode) nodes.push(textNode);

  const arrowSize = clamp(Math.min(fontSize * 0.55, localHeight * 0.25), 4, 8);
  const arrowCenterX = localWidth - arrowSlotWidth / 2;
  const arrowCenterY = localHeight / 2;

  nodes.push({
    type: "polyline",
    points: [
      mapLocalPoint(quad, arrowCenterX - arrowSize / 2, arrowCenterY - arrowSize * 0.22, localWidth, localHeight),
      mapLocalPoint(quad, arrowCenterX, arrowCenterY + arrowSize * 0.22, localWidth, localHeight),
      mapLocalPoint(quad, arrowCenterX + arrowSize / 2, arrowCenterY - arrowSize * 0.22, localWidth, localHeight),
    ],
    closed: false,
    style: {
      stroke: DEFAULT_ICON_COLOR,
      strokeWidth: `${clamp(arrowSize * 0.2, 1.25, 2)}px`,
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex + 2,
  });

  return nodes;
}

function extractProgressGeometry(
  progress: HTMLProgressElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(progress);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(progress);
  const accentColor = getAccentColor(cs, node.extractedStyle.color);
  const outerStyle = getControlBoxStyle(node.extractedStyle, DEFAULT_PROGRESS_TRACK, DEFAULT_BORDER_COLOR, Math.max(3, localHeight / 2));
  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: outerStyle,
    zIndex: globalIndex,
  }];

  const hasValue = progress.hasAttribute("value");
  const max = progress.max > 0 ? progress.max : 1;
  const ratio = hasValue ? clamp(progress.value / max, 0, 1) : 0.4;
  const track = insetRect(localWidth, localHeight, 1, 1, 1, 1);

  if (ratio > 0) {
    nodes.push({
      type: "polygon",
      points: localRectToQuad(quad, track.left, track.top, Math.max(1, track.width * ratio), track.height, localWidth, localHeight),
      style: {
        fill: accentColor,
        borderRadius: outerStyle.borderRadius,
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 1,
    });
  }

  if (hasValue) {
    const label = `${Math.round(ratio * 100)}%`;
    const textNode = createSingleLineTextNode(label, quad, localWidth, localHeight, track, node.extractedStyle, cs, globalIndex + 2, "center", Math.min(getLineHeight(node.extractedStyle, cs, getFontSize(node.extractedStyle, cs)), track.height));
    if (textNode) nodes.push(textNode);
  }

  return nodes;
}

function getControlGeometry(el: HTMLElement): { quad: Quad; localWidth: number; localHeight: number } | null {
  const quad = getElementQuad(el, "border");
  if (!quad) return null;

  const size = quadSize(quad);
  const localWidth = el.offsetWidth || el.clientWidth || size.width;
  const localHeight = el.offsetHeight || el.clientHeight || size.height;
  if (localWidth <= 0 || localHeight <= 0) return null;

  return { quad, localWidth, localHeight };
}

function getControlBoxStyle(
  baseStyle: Style,
  fillFallback: string,
  strokeFallback: string,
  radiusFallback: number
): Style {
  return {
    ...baseStyle,
    fill: shouldUseFallbackFill(baseStyle) ? fillFallback : baseStyle.fill,
    stroke: isVisibleColor(baseStyle.stroke) ? baseStyle.stroke : strokeFallback,
    strokeWidth: normalizeStrokeWidth(baseStyle.strokeWidth, 1),
    borderRadius: hasMeaningfulRadius(baseStyle.borderRadius) ? baseStyle.borderRadius : `${radiusFallback}px`,
  };
}

function getAccentColor(cs: CSSStyleDeclaration, colorFallback?: string): string {
  const accent = (cs.getPropertyValue("accent-color") || "").trim();
  if (accent && accent !== "auto") return accent;
  if (isVisibleColor(colorFallback)) return colorFallback!;
  if (isVisibleColor(cs.color)) return cs.color;
  return DEFAULT_ACCENT_COLOR;
}

function shouldUseFallbackControlFill(cs: CSSStyleDeclaration): boolean {
  const appearance = (
    cs.getPropertyValue("appearance") ||
    cs.getPropertyValue("-webkit-appearance") ||
    cs.getPropertyValue("-moz-appearance") ||
    ""
  ).trim().toLowerCase();
  return appearance !== "" && appearance !== "none";
}

function shouldUseFallbackFill(style: Style): boolean {
  if (style.backgroundImage && style.backgroundImage !== "none") return false;
  return !isVisibleColor(style.fill);
}

function normalizeStrokeWidth(value: string | undefined, fallbackPx: number): string {
  if (value) {
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed) && parsed > 0) return value;
  }
  return `${fallbackPx}px`;
}

function hasMeaningfulRadius(borderRadius: string | undefined): boolean {
  return !!borderRadius && borderRadius !== "0px" && borderRadius !== "0%";
}

function createSingleLineTextNode(
  text: string,
  quad: Quad,
  localWidth: number,
  localHeight: number,
  box: LocalRect,
  baseStyle: Style,
  cs: CSSStyleDeclaration,
  zIndex: number,
  align: "left" | "center",
  lineHeight: number
): IRNode | null {
  if (!text.trim() || box.width <= 0 || box.height <= 0) return null;

  const fontSize = getFontSize(baseStyle, cs);
  const measuredWidth = Math.max(fontSize * 0.5, Math.min(measureTextWidth(text, baseStyle, cs), box.width));
  let left = box.left;
  if (align === "center") {
    left += Math.max(0, (box.width - measuredWidth) / 2);
  }

  const height = Math.max(1, Math.min(lineHeight, box.height));
  const top = box.top + Math.max(0, (box.height - height) / 2);
  const textQuad = localRectToQuad(quad, left, top, measuredWidth, height, localWidth, localHeight);
  const clipBounds = quadBounds(localRectToQuad(quad, box.left, box.top, box.width, box.height, localWidth, localHeight));

  return {
    type: "text",
    quad: textQuad,
    text,
    style: {
      ...baseStyle,
      color: isVisibleColor(baseStyle.color) ? baseStyle.color : DEFAULT_ICON_COLOR,
      fill: undefined,
      stroke: undefined,
      strokeWidth: undefined,
      clipBounds: { x: clipBounds.x, y: clipBounds.y, w: clipBounds.w, h: clipBounds.h, radius: 0 },
    },
    zIndex,
  };
}

function getInputDisplayValue(input: HTMLInputElement): string {
  const type = input.type.toLowerCase();
  const value = input.value ?? "";
  if (!value) return "";

  switch (type) {
    case "password":
      return "*".repeat(value.length);
    case "datetime-local":
      return value.replace("T", " ");
    default:
      return value;
  }
}

function defaultButtonLabel(type: string): string {
  switch (type) {
    case "submit":
      return "Submit";
    case "reset":
      return "Reset";
    default:
      return "Button";
  }
}

function wrapText(text: string, maxWidth: number, style: Style, cs: CSSStyleDeclaration): string[] {
  const wrapped: string[] = [];
  const rawLines = text.split("\n");

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      wrapped.push("");
      continue;
    }

    const words = rawLine.trim().split(/\s+/);
    let current = words[0] ?? "";
    for (let index = 1; index < words.length; index++) {
      const candidate = `${current} ${words[index]}`;
      if (measureTextWidth(candidate, style, cs) <= maxWidth || !current) {
        current = candidate;
      } else {
        wrapped.push(current);
        current = words[index];
      }
    }
    if (current) wrapped.push(current);
  }

  return wrapped;
}

function getFontSize(style: Style, cs: CSSStyleDeclaration): number {
  const parsed = parseFloat(style.fontSize ?? cs.fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}

function getLineHeight(style: Style, cs: CSSStyleDeclaration, fontSize: number): number {
  const parsed = parseFloat(style.lineHeight ?? cs.lineHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fontSize * 1.2;
}

function measureTextWidth(text: string, style: Style, cs: CSSStyleDeclaration): number {
  const context = getMeasureContext();
  if (!context || !text) return 0;

  const fontSize = getFontSize(style, cs);
  const fontParts: string[] = [];
  const fontStyle = style.fontStyle ?? cs.fontStyle;
  const fontWeight = style.fontWeight ?? cs.fontWeight;
  const fontFamily = style.fontFamily ?? cs.fontFamily ?? "sans-serif";

  if (fontStyle && fontStyle !== "normal") fontParts.push(fontStyle);
  if (fontWeight && fontWeight !== "normal" && fontWeight !== "400") fontParts.push(fontWeight);
  fontParts.push(`${fontSize}px`);
  fontParts.push(fontFamily);
  context.font = fontParts.join(" ");

  return context.measureText(text).width;
}

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext !== undefined) return measureContext;
  const canvas = document.createElement("canvas");
  measureContext = canvas.getContext("2d");
  return measureContext;
}

function insetRect(
  totalWidth: number,
  totalHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number
): LocalRect {
  const safeLeft = clamp(left, 0, totalWidth);
  const safeTop = clamp(top, 0, totalHeight);
  const safeRight = clamp(right, 0, totalWidth);
  const safeBottom = clamp(bottom, 0, totalHeight);

  return {
    left: safeLeft,
    top: safeTop,
    width: Math.max(1, totalWidth - safeLeft - safeRight),
    height: Math.max(1, totalHeight - safeTop - safeBottom),
  };
}

function localRectToQuad(
  quad: Quad,
  left: number,
  top: number,
  width: number,
  height: number,
  totalWidth: number,
  totalHeight: number
): Quad {
  return [
    mapLocalPoint(quad, left, top, totalWidth, totalHeight),
    mapLocalPoint(quad, left + width, top, totalWidth, totalHeight),
    mapLocalPoint(quad, left + width, top + height, totalWidth, totalHeight),
    mapLocalPoint(quad, left, top + height, totalWidth, totalHeight),
  ];
}

function mapLocalPoint(
  quad: Quad,
  x: number,
  y: number,
  totalWidth: number,
  totalHeight: number
): Point {
  const u = totalWidth > 0 ? clamp(x / totalWidth, 0, 1) : 0;
  const v = totalHeight > 0 ? clamp(y / totalHeight, 0, 1) : 0;
  const top = lerpPoint(quad[0], quad[1], u);
  const bottom = lerpPoint(quad[3], quad[2], u);
  return lerpPoint(top, bottom, v);
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function approximateEllipsePoints(
  quad: Quad,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  totalWidth: number,
  totalHeight: number,
  segments: number
): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < segments; index++) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(
      mapLocalPoint(
        quad,
        centerX + Math.cos(angle) * radiusX,
        centerY + Math.sin(angle) * radiusY,
        totalWidth,
        totalHeight
      )
    );
  }
  return points;
}

function quadBounds(quad: Quad): { x: number; y: number; w: number; h: number } {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function parsePx(value: string | undefined): number {
  const parsed = parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isVisibleColor(color: string | undefined): boolean {
  if (!color || color === "transparent" || color === "none") return false;
  const rgbaMatch = color.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch?.[1] !== undefined && parseFloat(rgbaMatch[1]) <= 0) return false;
  if (color.startsWith("#") && color.length === 9 && parseInt(color.slice(7, 9), 16) === 0) return false;
  return true;
}