/**
 * PDF Writer using jsPDF.
 * Maps IR nodes to PDF drawing operations.
 */
import { jsPDF } from "jspdf";
import type { Point, Quad, Style, Writer } from "./types.js";

/** Parse a CSS color string to RGB components (0–255). */
function parseColor(color: string | undefined): { r: number; g: number; b: number } | null {
  if (!color || color === "transparent" || color === "none") return null;

  // Hex
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  // rgb/rgba
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
  }

  return null;
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
    this.applyStyle(style);

    const drawMode = this.getDrawMode(style);

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

    this.applyStyle(style);
    const drawMode = this.getDrawMode(style);

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

    const fillColor = parseColor(style.fill);
    if (fillColor) {
      this.doc.setTextColor(fillColor.r, fillColor.g, fillColor.b);
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

  private applyStyle(style: Style): void {
    const fillColor = parseColor(style.fill);
    const strokeColor = parseColor(style.stroke);

    if (fillColor) {
      this.doc.setFillColor(fillColor.r, fillColor.g, fillColor.b);
    }
    if (strokeColor) {
      this.doc.setDrawColor(strokeColor.r, strokeColor.g, strokeColor.b);
    } else {
      this.doc.setDrawColor(0, 0, 0);
    }

    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 1;
    this.doc.setLineWidth(pxToPt(strokeWidth));
  }

  private getDrawMode(style: Style): "S" | "F" | "FD" {
    const hasFill = style.fill && style.fill !== "transparent" && style.fill !== "none";
    const hasStroke = style.stroke && style.stroke !== "transparent" && style.stroke !== "none";

    if (hasFill && hasStroke) return "FD";
    if (hasFill) return "F";
    return "S"; // stroke only (default)
  }
}
