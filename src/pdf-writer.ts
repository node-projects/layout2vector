/**
 * PDF Writer using jsPDF.
 * Maps IR nodes to PDF drawing operations.
 */
import { jsPDF, GState, ShadingPattern } from "jspdf";
import type { Point, Quad, Style, Writer } from "./types.js";

/** Parsed color with alpha. */
interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse a CSS color string to RGBA components (RGB 0–255, A 0–1). */
function parseColor(color: string | undefined): ParsedColor | null {
  if (!color || color === "transparent" || color === "none") return null;

  // Hex
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    // #rrggbbaa
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a,
    };
  }

  // rgb/rgba
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m) {
    return {
      r: parseInt(m[1]),
      g: parseInt(m[2]),
      b: parseInt(m[3]),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }

  return null;
}

/** Returns a parsed color only if it's actually visible (alpha > 0). */
function parseVisibleColor(color: string | undefined): ParsedColor | null {
  const c = parseColor(color);
  if (!c || c.a <= 0) return null;
  return c;
}

/** Parse border-radius to rx, ry in pixels. */
function parseBorderRadius(borderRadius: string | undefined): { rx: number; ry: number } | null {
  if (!borderRadius || borderRadius === "0px") return null;
  // borderRadius can be "10px", "10px 20px", "50%", etc.
  const parts = borderRadius.split(/\s+/).map((s) => parseFloat(s)).filter((n) => !isNaN(n) && n > 0);
  if (parts.length === 0) return null;
  return { rx: parts[0], ry: parts.length > 1 ? parts[1] : parts[0] };
}

/** Check if a quad is an axis-aligned rectangle (no rotation/skew). */
function isAxisAlignedRect(points: Quad): boolean {
  // For an axis-aligned rect, top-left.y == top-right.y, bottom-left.y == bottom-right.y, etc.
  const eps = 0.5;
  return (
    Math.abs(points[0].y - points[1].y) < eps &&
    Math.abs(points[2].y - points[3].y) < eps &&
    Math.abs(points[0].x - points[3].x) < eps &&
    Math.abs(points[1].x - points[2].x) < eps
  );
}

/** Parse CSS font size to pt. */
function parseFontSize(fontSize: string | undefined): number {
  if (!fontSize) return 12;
  const px = parseFloat(fontSize);
  if (isNaN(px)) return 12;
  // Convert px to pt (1pt ≈ 1.333px)
  return px * 0.75;
}

/** Map CSS font-weight to jsPDF style. */
function mapFontWeight(weight: string | undefined): string {
  if (!weight) return "normal";
  const n = parseInt(weight);
  if (!isNaN(n) && n >= 700) return "bold";
  if (weight === "bold" || weight === "bolder") return "bold";
  return "normal";
}

/** Convert pixel coordinates to PDF points (1px ≈ 0.75pt). */
function pxToPt(px: number): number {
  return px * 0.75;
}

/** Parsed gradient stop. */
interface GradientStop {
  offset: number;
  color: ParsedColor;
}

/** Parsed linear gradient. */
interface LinearGradient {
  type: "linear";
  angleDeg: number;
  stops: GradientStop[];
}

/** Parsed radial gradient. */
interface RadialGradient {
  type: "radial";
  stops: GradientStop[];
}

type ParsedGradient = LinearGradient | RadialGradient;

/** Parse a CSS angle like "135deg", "to right", etc. and return degrees. */
function parseGradientAngle(dirStr: string): number {
  dirStr = dirStr.trim();
  const degMatch = dirStr.match(/^([\d.]+)deg$/);
  if (degMatch) return parseFloat(degMatch[1]);

  const radMatch = dirStr.match(/^([\d.]+)rad$/);
  if (radMatch) return parseFloat(radMatch[1]) * (180 / Math.PI);

  const turnMatch = dirStr.match(/^([\d.]+)turn$/);
  if (turnMatch) return parseFloat(turnMatch[1]) * 360;

  // "to <direction>" keywords
  const dirMap: Record<string, number> = {
    "to top": 0,
    "to right": 90,
    "to bottom": 180,
    "to left": 270,
    "to top right": 45,
    "to right top": 45,
    "to bottom right": 135,
    "to right bottom": 135,
    "to bottom left": 225,
    "to left bottom": 225,
    "to top left": 315,
    "to left top": 315,
  };
  if (dirMap[dirStr] !== undefined) return dirMap[dirStr];

  return 180; // default: top to bottom
}

/** Parse color stops from a gradient arguments string. */
function parseColorStops(argsStr: string): GradientStop[] {
  const stops: GradientStop[] = [];
  // Split on commas not inside parentheses
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of argsStr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Try to extract color and optional offset (percentage or px)
    const percentMatch = part.match(/([\d.]+)%\s*$/);
    const pxMatch = !percentMatch ? part.match(/([\d.]+)px\s*$/) : null;
    const colorStr = (percentMatch || pxMatch)
      ? part.slice(0, (percentMatch || pxMatch)!.index).trim()
      : part.trim();
    const color = parseColor(colorStr);
    if (!color) continue;

    let offset = -1;
    if (percentMatch) {
      offset = parseFloat(percentMatch[1]) / 100;
    } else if (pxMatch) {
      // Store raw px value as negative; we'll normalize later
      offset = -(parseFloat(pxMatch[1]) + 1); // encode px as negative (shift by 1 to distinguish from -1 = unknown)
    }
    stops.push({ offset, color });
  }

  // Normalize px-based stops: find the max px value and convert to 0..1
  const hasPxStops = stops.some((s) => s.offset < -1);
  if (hasPxStops) {
    let maxPx = 0;
    for (const s of stops) {
      if (s.offset < -1) {
        const px = -(s.offset + 1);
        if (px > maxPx) maxPx = px;
      }
    }
    if (maxPx > 0) {
      for (const s of stops) {
        if (s.offset < -1) {
          s.offset = -(s.offset + 1) / maxPx;
        }
      }
    }
  }

  // Fill in missing offsets
  if (stops.length > 0) {
    if (stops[0].offset < 0) stops[0].offset = 0;
    if (stops[stops.length - 1].offset < 0) stops[stops.length - 1].offset = 1;

    // Interpolate missing offsets
    let lastKnown = 0;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].offset >= 0) {
        // Fill gaps between lastKnown and i
        const gap = i - lastKnown;
        if (gap > 1) {
          const startOff = stops[lastKnown].offset;
          const endOff = stops[i].offset;
          for (let j = lastKnown + 1; j < i; j++) {
            stops[j].offset = startOff + (endOff - startOff) * ((j - lastKnown) / gap);
          }
        }
        lastKnown = i;
      }
    }
  }

  return stops;
}

/**
 * Extract the first gradient from a possibly multi-background CSS backgroundImage.
 * e.g. "linear-gradient(...), linear-gradient(...), none" → "linear-gradient(...)"
 */
function extractFirstGradient(bgImage: string): string | null {
  // Find the first gradient function, handling nested parentheses
  const match = bgImage.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/);
  if (!match || match.index === undefined) return null;

  let depth = 0;
  let start = match.index;
  for (let i = start; i < bgImage.length; i++) {
    if (bgImage[i] === "(") depth++;
    else if (bgImage[i] === ")") {
      depth--;
      if (depth === 0) {
        return bgImage.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Parse a CSS background-image gradient string. */
function parseGradient(bgImage: string | undefined): ParsedGradient | null {
  if (!bgImage || bgImage === "none") return null;

  // Extract the first gradient from possibly multiple backgrounds
  const gradientStr = extractFirstGradient(bgImage);
  if (!gradientStr) return null;

  // Linear gradient
  const linearMatch = gradientStr.match(/^(?:repeating-)?linear-gradient\((.+)\)$/);
  if (linearMatch) {
    const inner = linearMatch[1];
    // Split on first comma that's not inside parens to separate direction from stops
    let depth = 0;
    let splitIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") depth++;
      else if (inner[i] === ")") depth--;
      else if (inner[i] === "," && depth === 0) {
        splitIdx = i;
        break;
      }
    }

    let angleDeg = 180;
    let stopsStr = inner;

    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim();
      // Check if first part is a direction/angle (not a color)
      if (/^(to\s|[\d.]+deg|[\d.]+rad|[\d.]+turn)/i.test(firstPart)) {
        angleDeg = parseGradientAngle(firstPart);
        stopsStr = inner.slice(splitIdx + 1);
      }
    }

    const stops = parseColorStops(stopsStr);
    if (stops.length < 2) return null;

    return { type: "linear", angleDeg, stops };
  }

  // Radial gradient
  const radialMatch = gradientStr.match(/^(?:repeating-)?radial-gradient\((.+)\)$/);
  if (radialMatch) {
    const inner = radialMatch[1];
    const stops = parseColorStops(inner);
    if (stops.length < 2) return null;

    return { type: "radial", stops };
  }

  // Conic gradient: not supported by PDF, return null to fall back to solid fill
  return null;
}

export class PDFWriter implements Writer<jsPDF> {
  private doc!: jsPDF;
  private pageWidth: number;
  private pageHeight: number;
  private gradientCounter = 0;

  /**
   * @param pageWidth Page width in mm (default A4 = 210)
   * @param pageHeight Page height in mm (default A4 = 297)
   */
  constructor(pageWidth = 210, pageHeight = 297) {
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
  }

  begin(): void {
    this.doc = new jsPDF({
      orientation: this.pageWidth > this.pageHeight ? "landscape" : "portrait",
      unit: "pt",
      format: [this.pageWidth * 2.835, this.pageHeight * 2.835], // mm to pt
    });
    this.gradientCounter = 0;
  }

  drawPolygon(points: Quad, style: Style): void {
    // Try gradient fill first
    const gradient = parseGradient(style.backgroundImage);
    if (gradient) {
      this.drawGradientPolygon(points, gradient, style);
      return;
    }

    const drawMode = this.applyStyleAndGetMode(style);
    if (!drawMode) return; // fully transparent, skip

    // Check if this is an axis-aligned rect with border-radius
    const radius = parseBorderRadius(style.borderRadius);
    if (radius && isAxisAlignedRect(points)) {
      const x = pxToPt(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
      const y = pxToPt(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
      const w = pxToPt(Math.abs(points[1].x - points[0].x));
      const h = pxToPt(Math.abs(points[3].y - points[0].y));
      const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
      const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
      this.doc.roundedRect(x, y, w, h, rx, ry, drawMode);
      return;
    }

    // Build path using lines array format for jsPDF
    const startX = pxToPt(points[0].x);
    const startY = pxToPt(points[0].y);

    // lines relative to first point: [dx, dy] for each segment
    const lines: number[][] = [];
    for (let i = 1; i < points.length; i++) {
      lines.push([
        pxToPt(points[i].x) - pxToPt(points[i - 1].x),
        pxToPt(points[i].y) - pxToPt(points[i - 1].y),
      ]);
    }
    // Close back to start
    lines.push([
      startX - pxToPt(points[points.length - 1].x),
      startY - pxToPt(points[points.length - 1].y),
    ]);

    this.doc.lines(lines, startX, startY, [1, 1], drawMode, true);
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    if (points.length < 2) return;

    const drawMode = this.applyStyleAndGetMode(style);
    if (!drawMode) return; // fully transparent, skip

    const startX = pxToPt(points[0].x);
    const startY = pxToPt(points[0].y);

    const lines: number[][] = [];
    for (let i = 1; i < points.length; i++) {
      lines.push([
        pxToPt(points[i].x) - pxToPt(points[i - 1].x),
        pxToPt(points[i].y) - pxToPt(points[i - 1].y),
      ]);
    }

    if (closed) {
      lines.push([
        startX - pxToPt(points[points.length - 1].x),
        startY - pxToPt(points[points.length - 1].y),
      ]);
    }

    this.doc.lines(lines, startX, startY, [1, 1], drawMode, closed);
  }

  drawText(quad: Quad, text: string, style: Style): void {
    // Apply text-transform
    if (style.textTransform) {
      switch (style.textTransform) {
        case "uppercase": text = text.toUpperCase(); break;
        case "lowercase": text = text.toLowerCase(); break;
        case "capitalize":
          text = text.replace(/\b\w/g, (c) => c.toUpperCase());
          break;
      }
    }

    const fontSize = parseFontSize(style.fontSize);
    const fontWeight = mapFontWeight(style.fontWeight);
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "helvetica";

    this.doc.setFontSize(fontSize);
    try {
      this.doc.setFont(fontFamily, fontWeight);
    } catch {
      this.doc.setFont("helvetica", fontWeight);
    }

    // Text color: prefer style.color (CSS color), then style.fill
    const textColor = parseVisibleColor(style.color) ?? parseVisibleColor(style.fill);
    if (textColor) {
      this.doc.setTextColor(textColor.r, textColor.g, textColor.b);
    } else {
      this.doc.setTextColor(0, 0, 0);
    }

    // Place text at top-left of quad
    const x = pxToPt(quad[0].x);
    const y = pxToPt(quad[0].y) + fontSize; // offset by font size since PDF text baseline is bottom

    this.doc.text(text, x, y);
  }

  end(): jsPDF {
    return this.doc;
  }

  /** Draw a polygon filled with a gradient. */
  private drawGradientPolygon(points: Quad, gradient: ParsedGradient, style: Style): void {
    const pageH = this.doc.internal.pageSize.getHeight();

    // Compute bounding box in pt
    const xs = points.map((p) => pxToPt(p.x));
    const ys = points.map((p) => pxToPt(p.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Build jsPDF-compatible color stops: { offset, color: [r,g,b] }
    const jStops = gradient.stops.map((s) => ({
      offset: s.offset,
      color: [s.color.r, s.color.g, s.color.b] as [number, number, number],
    }));

    const patternName = `grad_${this.gradientCounter++}`;

    let coords: number[];
    let shadingType: "axial" | "radial";

    if (gradient.type === "linear") {
      // CSS gradient angle: 0deg = to top, 90deg = to right, 180deg = to bottom
      const rad = ((gradient.angleDeg - 90) * Math.PI) / 180;
      const halfDiag = Math.sqrt(w * w + h * h) / 2;
      const dx = Math.cos(rad) * halfDiag;
      const dy = Math.sin(rad) * halfDiag;

      // Coords in PDF space (y-up): convert compat y to PDF y
      const x1 = cx - dx;
      const y1 = pageH - (cy - dy);
      const x2 = cx + dx;
      const y2 = pageH - (cy + dy);
      coords = [x1, y1, x2, y2];
      shadingType = "axial";
    } else {
      // Radial: center of bounding box, radius = half diagonal
      const r = Math.max(w, h) / 2;
      const pdfCy = pageH - cy;
      coords = [cx, pdfCy, 0, cx, pdfCy, r];
      shadingType = "radial";
    }

    const pattern = new ShadingPattern(shadingType, coords, jStops);

    // Register pattern (requires advancedAPI)
    this.doc.advancedAPI((doc: jsPDF) => {
      doc.addShadingPattern(patternName, pattern);
    });

    // Save state, clip to polygon, apply shading, restore
    this.doc.saveGraphicsState();

    // Apply opacity if needed
    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      (this.doc as any).setGState(new GState({ opacity }));
    }

    // Define clipping path
    const radius = parseBorderRadius(style.borderRadius);
    if (radius && isAxisAlignedRect(points)) {
      const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
      const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
      this.doc.roundedRect(minX, minY, w, h, rx, ry, null as any);
    } else {
      this.doc.lines(
        [
          [xs[1] - xs[0], ys[1] - ys[0]],
          [xs[2] - xs[1], ys[2] - ys[1]],
          [xs[3] - xs[2], ys[3] - ys[2]],
          [xs[0] - xs[3], ys[0] - ys[3]],
        ],
        xs[0],
        ys[0],
        [1, 1],
        null as any,
        true
      );
    }
    this.doc.clip();
    this.doc.discardPath();

    // Apply gradient shading using the internal pattern ID assigned by jsPDF
    (this.doc as any).internal.write("/" + (pattern as any).id + " sh");

    this.doc.restoreGraphicsState();

    // Draw stroke on top if needed
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
    if (strokeColor && strokeWidth > 0) {
      this.doc.setDrawColor(strokeColor.r, strokeColor.g, strokeColor.b);
      this.doc.setLineWidth(pxToPt(strokeWidth));
      if (radius && isAxisAlignedRect(points)) {
        const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
        const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
        this.doc.roundedRect(minX, minY, w, h, rx, ry, "S");
      } else {
        this.doc.lines(
          [
            [xs[1] - xs[0], ys[1] - ys[0]],
            [xs[2] - xs[1], ys[2] - ys[1]],
            [xs[3] - xs[2], ys[3] - ys[2]],
            [xs[0] - xs[3], ys[0] - ys[3]],
          ],
          xs[0],
          ys[0],
          [1, 1],
          "S",
          true
        );
      }
    }
  }

  /**
   * Apply fill/stroke style to doc and return the draw mode.
   * Returns null if the shape is fully transparent and should be skipped.
   */
  private applyStyleAndGetMode(style: Style): "S" | "F" | "FD" | null {
    const fillColor = parseVisibleColor(style.fill);
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;

    // Determine effective visibility
    const hasFill = fillColor !== null;
    const hasStroke = strokeColor !== null && strokeWidth > 0;

    if (!hasFill && !hasStroke) return null; // nothing to draw

    // Apply opacity via GState if the element has partial opacity
    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      (this.doc as any).setGState(
        new GState({
          opacity: hasFill ? opacity : 1,
          "stroke-opacity": hasStroke ? opacity : 1,
        })
      );
    }

    if (fillColor) {
      this.doc.setFillColor(fillColor.r, fillColor.g, fillColor.b);
    }
    if (strokeColor) {
      this.doc.setDrawColor(strokeColor.r, strokeColor.g, strokeColor.b);
    } else {
      this.doc.setDrawColor(0, 0, 0);
    }

    this.doc.setLineWidth(pxToPt(hasStroke ? strokeWidth : 0.5));

    if (hasFill && hasStroke) return "FD";
    if (hasFill) return "F";
    return "S";
  }
}
