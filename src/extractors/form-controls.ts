import type { IRNode, Options, Point, Quad, Style } from "../types.js";
import type { StackingNode } from "../traversal.js";
import { getElementQuad, quadSize } from "../geometry.js";

const DEFAULT_ACCENT_COLOR = "rgb(0, 120, 212)";
const DEFAULT_BORDER_COLOR = "rgb(118, 118, 118)";
const DEFAULT_SURFACE_COLOR = "rgb(255, 255, 255)";
const DEFAULT_BUTTON_COLOR = "rgb(239, 239, 239)";
const DEFAULT_PROGRESS_TRACK = "rgb(232, 232, 232)";
const DEFAULT_METER_VALUE_COLOR = "rgb(56, 142, 60)";
const DEFAULT_ICON_COLOR = "rgb(80, 80, 80)";
const DEFAULT_FORM_RADIUS_PX = 2;

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

type ControlDisplayText = {
  text: string;
  isPlaceholder: boolean;
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
  if (el instanceof HTMLMeterElement) {
    return extractMeterGeometry(el, node, globalIndex);
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
  const cs = getComputedStyle(input);

  if (isVisuallyHiddenControl(cs)) {
    return [];
  }

  if (type === "checkbox") {
    return extractCheckboxGeometry(input, node, globalIndex);
  }
  if (type === "radio") {
    return extractRadioGeometry(input, node, globalIndex);
  }
  if (type === "range") {
    return extractRangeGeometry(input, node, globalIndex);
  }
  if (type === "color") {
    return extractColorInputGeometry(input, node, globalIndex);
  }
  if (type === "file") {
    return extractFileInputGeometry(input, node, globalIndex);
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
    borderRadius: hasMeaningfulRadius(node.extractedStyle.borderRadius) ? node.extractedStyle.borderRadius : `${DEFAULT_FORM_RADIUS_PX}px`,
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
  const value: ControlDisplayText = { text: input.value || fallbackLabel, isPlaceholder: false };
  return extractSingleLineControlGeometry(input, node, globalIndex, value, "center", DEFAULT_BUTTON_COLOR);
}

function extractColorInputGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(input);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(input);
  const outerStyle = getControlBoxStyle(
    shouldUseFallbackControlFill(cs) ? { ...node.extractedStyle, fill: undefined } : node.extractedStyle,
    DEFAULT_SURFACE_COLOR,
    DEFAULT_BORDER_COLOR,
    DEFAULT_FORM_RADIUS_PX
  );

  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: outerStyle,
    zIndex: globalIndex,
  }];

  const inset = clamp(Math.min(localWidth, localHeight) * 0.1, 2, 6);
  const swatchRect = insetRect(localWidth, localHeight, inset, inset, inset, inset);
  nodes.push({
    type: "polygon",
    points: localRectToQuad(quad, swatchRect.left, swatchRect.top, swatchRect.width, swatchRect.height, localWidth, localHeight),
    style: {
      fill: input.value || "#000000",
      stroke: outerStyle.stroke,
      strokeWidth: normalizeStrokeWidth(outerStyle.strokeWidth, 1),
      borderRadius: outerStyle.borderRadius,
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex + 1,
  });

  return nodes;
}

function extractSingleLineControlGeometry(
  el: HTMLInputElement,
  node: StackingNode,
  globalIndex: number,
  displayText: ControlDisplayText,
  align: "left" | "center",
  fillFallback: string
): IRNode[] {
  const geometry = getControlGeometry(el);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(el);
  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.min(getLineHeight(node.extractedStyle, cs, fontSize), localHeight);
  const paddingX = Math.max(parsePx(cs.paddingLeft), align === "center" ? 8 : 6);
  const paddingY = Math.max(parsePx(cs.paddingTop), 4);
  const contentBox = insetRect(localWidth, localHeight, paddingX, paddingY, Math.max(parsePx(cs.paddingRight), paddingX), Math.max(parsePx(cs.paddingBottom), paddingY));

  const nodes: IRNode[] = [];
  if (shouldRenderSyntheticControlBox(node.extractedStyle, cs)) {
    const boxStyle = getControlBoxStyle(node.extractedStyle, fillFallback, DEFAULT_BORDER_COLOR, DEFAULT_FORM_RADIUS_PX);
    nodes.push({
      type: "polygon",
      points: quad,
      style: boxStyle,
      zIndex: globalIndex,
    });
  }

  const text = displayText.text.trim();
  if (!text) return nodes;

  const textStyle = resolveControlTextStyle(el, node.extractedStyle, cs, displayText.isPlaceholder);
  const textNode = createSingleLineTextNode(text, quad, localWidth, localHeight, contentBox, textStyle, cs, globalIndex + 1, align, lineHeight);
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
  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.max(1, getLineHeight(node.extractedStyle, cs, fontSize));
  const paddingLeft = Math.max(parsePx(cs.paddingLeft), 6);
  const paddingTop = Math.max(parsePx(cs.paddingTop), 4);
  const paddingRight = Math.max(parsePx(cs.paddingRight), paddingLeft);
  const paddingBottom = Math.max(parsePx(cs.paddingBottom), paddingTop);
  const contentBox = insetRect(localWidth, localHeight, paddingLeft, paddingTop, paddingRight, paddingBottom);

  const nodes: IRNode[] = [];
  if (shouldRenderSyntheticControlBox(node.extractedStyle, cs)) {
    const boxStyle = getControlBoxStyle(node.extractedStyle, DEFAULT_SURFACE_COLOR, DEFAULT_BORDER_COLOR, DEFAULT_FORM_RADIUS_PX);
    nodes.push({
      type: "polygon",
      points: quad,
      style: boxStyle,
      zIndex: globalIndex,
    });
  }

  const rawValue = textarea.value.replace(/\r\n?/g, "\n");
  const rawPlaceholder = textarea.placeholder.replace(/\r\n?/g, "\n");
  const displayText: ControlDisplayText = rawValue.length === 0
    ? { text: rawPlaceholder, isPlaceholder: rawPlaceholder.length > 0 }
    : { text: rawValue, isPlaceholder: false };
  if (!displayText.text.trim()) return nodes;

  const textStyle = resolveControlTextStyle(textarea, node.extractedStyle, cs, displayText.isPlaceholder);

  const lines = textarea.wrap === "off"
    ? displayText.text.split("\n")
    : wrapText(displayText.text, Math.max(1, contentBox.width), textStyle, cs);
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
    const textNode = createSingleLineTextNode(text, quad, localWidth, localHeight, lineBox, textStyle, cs, zIndex++, "left", Math.min(lineHeight, availableHeight));
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
    DEFAULT_FORM_RADIUS_PX
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

function extractMeterGeometry(
  meter: HTMLMeterElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(meter);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(meter);
  const min = Number.isFinite(meter.min) ? meter.min : 0;
  const max = Number.isFinite(meter.max) && meter.max > min ? meter.max : min + 1;
  const ratio = clamp((meter.value - min) / (max - min), 0, 1);
  const trackStyle = getControlBoxStyle(node.extractedStyle, DEFAULT_PROGRESS_TRACK, DEFAULT_BORDER_COLOR, Math.max(3, localHeight / 2));

  const nodes: IRNode[] = [{
    type: "polygon",
    points: quad,
    style: trackStyle,
    zIndex: globalIndex,
  }];

  const track = insetRect(localWidth, localHeight, 1, 1, 1, 1);
  if (ratio <= 0) return nodes;

  const accentColor = getMeterValueColor(cs);
  nodes.push({
    type: "polygon",
    points: localRectToQuad(quad, track.left, track.top, Math.max(1, track.width * ratio), track.height, localWidth, localHeight),
    style: {
      fill: accentColor,
      borderRadius: trackStyle.borderRadius,
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex + 1,
  });

  return nodes;
}

function extractFileInputGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(input);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(input);
  const nodes: IRNode[] = [];

  const outerStyle = getControlBoxStyle(
    shouldUseFallbackControlFill(cs) ? { ...node.extractedStyle, fill: undefined } : node.extractedStyle,
    DEFAULT_SURFACE_COLOR,
    DEFAULT_BORDER_COLOR,
    DEFAULT_FORM_RADIUS_PX
  );
  nodes.push({
    type: "polygon",
    points: quad,
    style: outerStyle,
    zIndex: globalIndex,
  });

  const inset = insetRect(localWidth, localHeight, 1, 1, 1, 1);
  const buttonWidth = clamp(inset.width * 0.34, 72, Math.max(72, inset.width * 0.65));
  const buttonBox: LocalRect = {
    left: inset.left,
    top: inset.top,
    width: Math.min(buttonWidth, inset.width),
    height: inset.height,
  };

  nodes.push({
    type: "polygon",
    points: localRectToQuad(quad, buttonBox.left, buttonBox.top, buttonBox.width, buttonBox.height, localWidth, localHeight),
    style: {
      fill: DEFAULT_BUTTON_COLOR,
      stroke: outerStyle.stroke,
      strokeWidth: normalizeStrokeWidth(outerStyle.strokeWidth, 1),
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex + 1,
  });

  const fontSize = getFontSize(node.extractedStyle, cs);
  const lineHeight = Math.min(getLineHeight(node.extractedStyle, cs, fontSize), Math.max(1, localHeight - 4));
  const buttonLabel = input.multiple ? "Choose Files" : "Choose File";
  const buttonLabelNode = createSingleLineTextNode(
    buttonLabel,
    quad,
    localWidth,
    localHeight,
    buttonBox,
    node.extractedStyle,
    cs,
    globalIndex + 2,
    "center",
    lineHeight
  );
  if (buttonLabelNode) nodes.push(buttonLabelNode);

  const fileName = getFileInputDisplayText(input);
  if (fileName.text.trim()) {
    const textPadding = Math.max(6, parsePx(cs.paddingLeft));
    const fileTextBox: LocalRect = {
      left: Math.min(localWidth - 1, buttonBox.left + buttonBox.width + textPadding),
      top: inset.top,
      width: Math.max(1, localWidth - (buttonBox.left + buttonBox.width + textPadding) - inset.left),
      height: inset.height,
    };
    const fileTextStyle = fileName.isPlaceholder
      ? { ...node.extractedStyle, color: "rgb(98, 105, 120)" }
      : node.extractedStyle;
    const fileTextNode = createSingleLineTextNode(
      fileName.text,
      quad,
      localWidth,
      localHeight,
      fileTextBox,
      fileTextStyle,
      cs,
      globalIndex + 2,
      "left",
      lineHeight
    );
    if (fileTextNode) nodes.push(fileTextNode);
  }

  return nodes;
}

function extractRangeGeometry(
  input: HTMLInputElement,
  node: StackingNode,
  globalIndex: number
): IRNode[] {
  const geometry = getControlGeometry(input);
  if (!geometry) return [];

  const { quad, localWidth, localHeight } = geometry;
  const cs = getComputedStyle(input);
  const accentColor = getAccentColor(cs, node.extractedStyle.color);
  const trackColor = (shouldUseFallbackControlFill(cs) || shouldUseFallbackFill(node.extractedStyle))
    ? DEFAULT_PROGRESS_TRACK
    : (node.extractedStyle.fill ?? DEFAULT_PROGRESS_TRACK);
  const { ratio } = resolveRangeValueMetrics(input);

  const isVertical = isVerticalRangeControl(input, cs, localWidth, localHeight);
  const verticalStartAtTop = isVertical && isVerticalRangeStartAtTop(input, cs);
  const horizontalStartAtLeft = cs.direction !== "rtl";
  const thumbDiameter = clamp((isVertical ? localWidth : localHeight) * 0.7, 10, 20);
  const thumbRadius = thumbDiameter / 2;
  const trackThickness = clamp(Math.min(localWidth, localHeight) * 0.24, 4, 10);

  const nodes: IRNode[] = [];

  if (isVertical) {
    const trackTop = thumbRadius;
    const trackHeight = Math.max(1, localHeight - thumbDiameter);
    const trackLeft = Math.max(0, (localWidth - trackThickness) / 2);

    nodes.push({
      type: "polygon",
      points: localRectToQuad(quad, trackLeft, trackTop, trackThickness, trackHeight, localWidth, localHeight),
      style: {
        fill: trackColor,
        borderRadius: `${Math.max(2, trackThickness / 2)}px`,
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex,
    });

    if (ratio > 0) {
      const filledHeight = Math.max(1, trackHeight * ratio);
      const filledTop = verticalStartAtTop
        ? trackTop
        : trackTop + (trackHeight - filledHeight);
      nodes.push({
        type: "polygon",
        points: localRectToQuad(
          quad,
          trackLeft,
          filledTop,
          trackThickness,
          filledHeight,
          localWidth,
          localHeight
        ),
        style: {
          fill: accentColor,
          borderRadius: `${Math.max(2, trackThickness / 2)}px`,
          opacity: node.extractedStyle.opacity,
        },
        zIndex: globalIndex + 1,
      });
    }

    const thumbCenterX = localWidth / 2;
    const thumbCenterY = verticalStartAtTop
      ? trackTop + trackHeight * ratio
      : trackTop + trackHeight - trackHeight * ratio;
    nodes.push({
      type: "polyline",
      points: approximateEllipsePoints(
        quad,
        thumbCenterX,
        thumbCenterY,
        thumbRadius,
        thumbRadius,
        localWidth,
        localHeight,
        24
      ),
      closed: true,
      style: {
        fill: accentColor,
        stroke: "rgb(255, 255, 255)",
        strokeWidth: normalizeStrokeWidth(node.extractedStyle.strokeWidth, 1),
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 2,
    });

    return nodes;
  }

  const trackLeft = thumbRadius;
  const trackWidth = Math.max(1, localWidth - thumbDiameter);
  const trackTop = Math.max(0, (localHeight - trackThickness) / 2);

  nodes.push({
    type: "polygon",
    points: localRectToQuad(quad, trackLeft, trackTop, trackWidth, trackThickness, localWidth, localHeight),
    style: {
      fill: trackColor,
      borderRadius: `${Math.max(2, trackThickness / 2)}px`,
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex,
  });

  if (ratio > 0) {
    const filledWidth = Math.max(1, trackWidth * ratio);
    const filledLeft = horizontalStartAtLeft
      ? trackLeft
      : trackLeft + (trackWidth - filledWidth);
    nodes.push({
      type: "polygon",
      points: localRectToQuad(quad, filledLeft, trackTop, filledWidth, trackThickness, localWidth, localHeight),
      style: {
        fill: accentColor,
        borderRadius: `${Math.max(2, trackThickness / 2)}px`,
        opacity: node.extractedStyle.opacity,
      },
      zIndex: globalIndex + 1,
    });
  }

  const thumbCenterX = horizontalStartAtLeft
    ? trackLeft + trackWidth * ratio
    : trackLeft + trackWidth - trackWidth * ratio;
  const thumbCenterY = localHeight / 2;
  nodes.push({
    type: "polyline",
    points: approximateEllipsePoints(
      quad,
      thumbCenterX,
      thumbCenterY,
      thumbRadius,
      thumbRadius,
      localWidth,
      localHeight,
      24
    ),
    closed: true,
    style: {
      fill: accentColor,
      stroke: "rgb(255, 255, 255)",
      strokeWidth: normalizeStrokeWidth(node.extractedStyle.strokeWidth, 1),
      opacity: node.extractedStyle.opacity,
    },
    zIndex: globalIndex + 2,
  });

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
  if (shouldUseFallbackControlFill(cs)) return DEFAULT_ACCENT_COLOR;
  if (isVisibleColor(colorFallback)) return colorFallback!;
  if (isVisibleColor(cs.color)) return cs.color;
  return DEFAULT_ACCENT_COLOR;
}

function getMeterValueColor(cs: CSSStyleDeclaration): string {
  const accent = (cs.getPropertyValue("accent-color") || "").trim();
  if (accent && accent !== "auto") return accent;
  if (shouldUseFallbackControlFill(cs)) return DEFAULT_METER_VALUE_COLOR;
  if (isVisibleColor(cs.color)) return cs.color;
  return DEFAULT_METER_VALUE_COLOR;
}

function isVerticalRangeControl(
  input: HTMLInputElement,
  cs: CSSStyleDeclaration,
  localWidth: number,
  localHeight: number
): boolean {
  if (localHeight > localWidth * 1.25) return true;

  const writingMode = (cs.writingMode || cs.getPropertyValue("writing-mode") || "").trim().toLowerCase();
  if (writingMode.startsWith("vertical") || writingMode.startsWith("sideways")) return true;

  const appearance = (
    cs.getPropertyValue("appearance") ||
    cs.getPropertyValue("-webkit-appearance") ||
    cs.getPropertyValue("-moz-appearance") ||
    ""
  ).trim().toLowerCase();
  if (appearance.includes("slider-vertical")) return true;

  const orient = (input.getAttribute("orient") || "").trim().toLowerCase();
  if (orient === "vertical") return true;

  const ariaOrientation = (input.getAttribute("aria-orientation") || "").trim().toLowerCase();
  return ariaOrientation === "vertical";
}

function isVerticalRangeStartAtTop(
  input: HTMLInputElement,
  cs: CSSStyleDeclaration
): boolean {
  const writingMode = (cs.writingMode || cs.getPropertyValue("writing-mode") || "").trim().toLowerCase();
  if (writingMode.startsWith("vertical") || writingMode.startsWith("sideways")) return true;

  const appearance = (
    cs.getPropertyValue("appearance") ||
    cs.getPropertyValue("-webkit-appearance") ||
    cs.getPropertyValue("-moz-appearance") ||
    ""
  ).trim().toLowerCase();
  if (appearance.includes("slider-vertical")) return false;

  const orient = (input.getAttribute("orient") || "").trim().toLowerCase();
  if (orient === "vertical") return false;

  return false;
}

function resolveRangeValueMetrics(input: HTMLInputElement): {
  min: number;
  max: number;
  value: number;
  ratio: number;
} {
  const parsedMin = Number.parseFloat(input.min);
  const min = Number.isFinite(parsedMin) ? parsedMin : 0;

  const parsedMax = Number.parseFloat(input.max);
  const fallbackMax = min + 100;
  const max = Number.isFinite(parsedMax) ? Math.max(parsedMax, min) : fallbackMax;

  const defaultValue = max > min ? min + (max - min) / 2 : min;
  const liveValue = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Number.NaN;
  const parsedValue = Number.parseFloat(input.value);
  const unclampedValue = Number.isFinite(liveValue)
    ? liveValue
    : Number.isFinite(parsedValue)
      ? parsedValue
      : defaultValue;
  const value = clamp(unclampedValue, min, max);
  const ratio = max > min ? (value - min) / (max - min) : 0;

  return { min, max, value, ratio };
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

function isVisuallyHiddenControl(cs: CSSStyleDeclaration): boolean {
  if (cs.display === "none" || cs.visibility === "hidden") return true;
  const opacity = parseFloat(cs.opacity);
  return Number.isFinite(opacity) && opacity <= 0.01;
}

function shouldRenderSyntheticControlBox(baseStyle: Style, cs: CSSStyleDeclaration): boolean {
  // Some custom controls use a transparent native input/textarea only as an interaction target.
  // Synthesizing a fallback box for those controls invents a white/native background that is not present.
  const hasVisibleFill = isVisibleColor(baseStyle.fill);
  const hasVisibleStroke = hasVisibleShapeStroke(baseStyle) || hasVisibleBorderStroke(baseStyle);
  const hasVisibleShadow = !!(baseStyle.boxShadow && baseStyle.boxShadow !== "none");
  const hasVisibleBackgroundImage = !!(baseStyle.backgroundImage && baseStyle.backgroundImage !== "none");
  void cs;

  if (!hasVisibleFill && !hasVisibleStroke && !hasVisibleShadow && !hasVisibleBackgroundImage) {
    return false;
  }

  return true;
}

function hasVisibleShapeStroke(style: Style): boolean {
  if (!isVisibleColor(style.stroke)) return false;
  if (!style.strokeWidth) return false;
  const width = parseFloat(style.strokeWidth);
  return Number.isFinite(width) && width > 0;
}

function hasVisibleBorderStroke(style: Style): boolean {
  return hasVisibleBorderSide(style.borderTopColor, style.borderTopWidth, style.borderTopStyle)
    || hasVisibleBorderSide(style.borderRightColor, style.borderRightWidth, style.borderRightStyle)
    || hasVisibleBorderSide(style.borderBottomColor, style.borderBottomWidth, style.borderBottomStyle)
    || hasVisibleBorderSide(style.borderLeftColor, style.borderLeftWidth, style.borderLeftStyle);
}

function hasVisibleBorderSide(color?: string, width?: string, borderStyle?: string): boolean {
  if (!isVisibleColor(color)) return false;
  if (!width) return false;
  if (!borderStyle || borderStyle === "none" || borderStyle === "hidden") return false;

  const parsedWidth = parseFloat(width);
  return Number.isFinite(parsedWidth) && parsedWidth > 0;
}

function resolveControlTextStyle(
  el: HTMLInputElement | HTMLTextAreaElement,
  baseStyle: Style,
  cs: CSSStyleDeclaration,
  isPlaceholder: boolean
): Style {
  if (!isPlaceholder) return baseStyle;

  let placeholderStyle: CSSStyleDeclaration | null = null;
  try {
    placeholderStyle = getComputedStyle(el, "::placeholder");
  } catch {
    placeholderStyle = null;
  }

  if (!placeholderStyle) return baseStyle;

  return {
    ...baseStyle,
    color: isVisibleColor(placeholderStyle.color) ? placeholderStyle.color : baseStyle.color,
    fontStyle: placeholderStyle.fontStyle && placeholderStyle.fontStyle !== "normal" ? placeholderStyle.fontStyle : baseStyle.fontStyle,
    fontWeight: placeholderStyle.fontWeight && placeholderStyle.fontWeight !== "400" ? placeholderStyle.fontWeight : baseStyle.fontWeight,
    letterSpacing: placeholderStyle.letterSpacing && placeholderStyle.letterSpacing !== "normal" ? placeholderStyle.letterSpacing : baseStyle.letterSpacing,
    wordSpacing: placeholderStyle.wordSpacing && placeholderStyle.wordSpacing !== "normal" ? placeholderStyle.wordSpacing : baseStyle.wordSpacing,
    opacity: resolvePlaceholderOpacity(baseStyle.opacity, placeholderStyle.opacity),
  };
}

function resolvePlaceholderOpacity(baseOpacity: number | undefined, placeholderOpacity: string): number | undefined {
  const parsed = parseFloat(placeholderOpacity);
  if (Number.isNaN(parsed)) return baseOpacity;
  if (baseOpacity === undefined) return parsed;
  return baseOpacity * parsed;
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

function getInputDisplayValue(input: HTMLInputElement): ControlDisplayText {
  const type = input.type.toLowerCase();
  const value = input.value ?? "";
  if (!value) {
    return {
      text: input.placeholder ?? "",
      isPlaceholder: !!input.placeholder,
    };
  }

  switch (type) {
    case "password":
      return { text: "*".repeat(value.length), isPlaceholder: false };
    case "date":
    case "time":
    case "datetime-local":
    case "month":
    case "week": {
      const localized = formatTemporalInputDisplayValue(input, type, value);
      if (localized) {
        return { text: localized, isPlaceholder: false };
      }
      break;
    }
    default:
      return { text: value, isPlaceholder: false };
  }

  return { text: type === "datetime-local" ? value.replace("T", " ") : value, isPlaceholder: false };
}

function formatTemporalInputDisplayValue(
  input: HTMLInputElement,
  type: string,
  value: string
): string | null {
  try {
    switch (type) {
      case "date": {
        const date = parseDateValue(value);
        if (!date) return null;
        return new Intl.DateTimeFormat(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(date);
      }
      case "time": {
        const parts = parseTimeValue(value);
        if (!parts) return null;
        const date = new Date(2000, 0, 1, parts.hour, parts.minute, parts.second, parts.millisecond);
        return new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          second: parts.hasSecond ? "2-digit" : undefined,
        }).format(date);
      }
      case "datetime-local": {
        const date = parseDateTimeLocalValue(value);
        if (!date) return null;
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        }).format(date);
      }
      case "month": {
        const date = parseMonthValue(value);
        if (!date) return null;
        return new Intl.DateTimeFormat(undefined, {
          year: "numeric",
          month: "long",
        }).format(date);
      }
      case "week": {
        const parsed = parseWeekValue(value);
        if (!parsed) return null;
        const rangeFormatter = new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        });
        const startLabel = rangeFormatter.format(parsed.start);
        const endLabel = rangeFormatter.format(parsed.end);
        const yearLabel = new Intl.DateTimeFormat(undefined, {
          year: "numeric",
        }).format(parsed.start);
        return `${startLabel} - ${endLabel}, ${yearLabel}`;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseDateValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function parseTimeValue(value: string): {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  hasSecond: boolean;
} | null {
  const match = value.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return null;

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const second = match[3] ? Number.parseInt(match[3], 10) : 0;
  const millisecond = match[4] ? Number.parseInt(match[4].padEnd(3, "0"), 10) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second) || !Number.isFinite(millisecond)) {
    return null;
  }

  return {
    hour,
    minute,
    second,
    millisecond,
    hasSecond: !!match[3],
  };
}

function parseDateTimeLocalValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = match[6] ? Number.parseInt(match[6], 10) : 0;
  const millisecond = match[7] ? Number.parseInt(match[7].padEnd(3, "0"), 10) : 0;
  if (!Number.isFinite(year)
    || !Number.isFinite(month)
    || !Number.isFinite(day)
    || !Number.isFinite(hour)
    || !Number.isFinite(minute)
    || !Number.isFinite(second)
    || !Number.isFinite(millisecond)) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

function parseMonthValue(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;

  return new Date(year, month - 1, 1, 12, 0, 0, 0);
}

function parseWeekValue(value: string): { start: Date; end: Date } | null {
  const match = value.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;

  const isoYear = Number.parseInt(match[1], 10);
  const isoWeek = Number.parseInt(match[2], 10);
  if (!Number.isFinite(isoYear) || !Number.isFinite(isoWeek)) return null;

  // ISO week 1 is the week containing Jan 4. Monday is day 1.
  const jan4 = new Date(isoYear, 0, 4, 12, 0, 0, 0);
  const day = jan4.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const firstWeekMonday = new Date(isoYear, 0, 4 + mondayOffset, 12, 0, 0, 0);
  const start = new Date(firstWeekMonday);
  start.setDate(firstWeekMonday.getDate() + (isoWeek - 1) * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { start, end };
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

function getFileInputDisplayText(input: HTMLInputElement): ControlDisplayText {
  const files = input.files;
  if (files && files.length > 0) {
    const names = Array.from(files).map((file) => file.name).filter(Boolean);
    if (names.length > 0) {
      return {
        text: input.multiple && names.length > 1 ? `${names.length} files selected` : names.join(", "),
        isPlaceholder: false,
      };
    }
  }

  const rawValue = (input.value ?? "").trim();
  if (rawValue) {
    const basename = rawValue.split(/[\\/]/).pop() ?? rawValue;
    return { text: basename || rawValue, isPlaceholder: false };
  }

  return {
    text: "No file selected",
    isPlaceholder: true,
  };
}