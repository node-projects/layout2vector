/**
 * PDF Writer using jsPDF.
 * Maps IR nodes to PDF drawing operations.
 */
import { jsPDF } from "jspdf";
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

export class PDFWriter implements Writer<jsPDF> {
  private doc!: jsPDF;
  private pageWidth: number;
  private pageHeight: number;

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
  }

  drawPolygon(points: Quad, style: Style): void {
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
