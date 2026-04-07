/**
 * PDF Writer using pdf-lite.
 * Maps IR nodes to PDF drawing operations via raw PDF content stream operators.
 *
 * Returns a PdfDocument from `end()`. Call `await doc.finalize()` then `doc.toBytes()`
 * to get the final PDF bytes.
 */
import {
  PdfFont,
  PdfArray,
  PdfBoolean,
  PdfDictionary,
  PdfIndirectObject,
  PdfName,
  PdfNumber,
  PdfReference,
  PdfStream,
  PdfDocument,
  PdfPage,
  PdfPages,
} from "./pdf-objects.js";
import { parseTTF, type ParsedTTF } from "./ttf-parser.js";
import type { Point, Quad, Style, Writer } from "./types.js";

// ── Shared helpers ──────────────────────────────────────────────────

interface ParsedColor { r: number; g: number; b: number; a: number; }

function parseColor(color: string | undefined): ParsedColor | null {
  if (!color || color === "transparent" || color === "none") return null;
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a };
  }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
  return null;
}

function parseVisibleColor(color: string | undefined): ParsedColor | null {
  const c = parseColor(color);
  return c && c.a > 0 ? c : null;
}

function parseBorderRadius(borderRadius: string | undefined): { rx: number; ry: number } | null {
  if (!borderRadius || borderRadius === "0px") return null;
  const parts = borderRadius.split(/\s+/).map(s => parseFloat(s)).filter(n => !isNaN(n) && n > 0);
  if (parts.length === 0) return null;
  return { rx: parts[0], ry: parts.length > 1 ? parts[1] : parts[0] };
}

function isAxisAlignedRect(points: Quad): boolean {
  const eps = 0.5;
  return (
    Math.abs(points[0].y - points[1].y) < eps &&
    Math.abs(points[2].y - points[3].y) < eps &&
    Math.abs(points[0].x - points[3].x) < eps &&
    Math.abs(points[1].x - points[2].x) < eps
  );
}

function parseFontSize(fontSize: string | undefined): number {
  if (!fontSize) return 12;
  const px = parseFloat(fontSize);
  return isNaN(px) ? 12 : px * 0.75;
}

function mapFontWeight(weight: string | undefined): "bold" | "normal" {
  if (!weight) return "normal";
  const n = parseInt(weight);
  if (!isNaN(n) && n >= 700) return "bold";
  if (weight === "bold" || weight === "bolder") return "bold";
  return "normal";
}

/** Convert pixel to PDF points (1px ≈ 0.75pt). */
function pxToPt(px: number): number { return px * 0.75; }

/** Format a number for PDF content stream operators. */
function pn(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(4).replace(/\.?0+$/, "");
}

/**
 * Unicode → WinAnsiEncoding (Windows-1252) byte mapping for code points
 * in the 0x80–0x9F range that differ from ISO 8859-1.
 */
const unicodeToWinAnsi: Record<number, number> = {
  0x20AC: 0x80, // €
  0x201A: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201E: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02C6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8A, // Š
  0x2039: 0x8B, // ‹
  0x0152: 0x8C, // Œ
  0x017D: 0x8E, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201C: 0x93, // "
  0x201D: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02DC: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9A, // š
  0x203A: 0x9B, // ›
  0x0153: 0x9C, // œ
  0x017E: 0x9E, // ž
  0x0178: 0x9F, // Ÿ
};

/**
 * Escape a text string for use in a PDF content stream `( )`.
 * Encodes non-ASCII characters as WinAnsiEncoding octal escapes
 * so they survive UTF-8 serialization and match the font encoding.
 */
function escapePdfText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === "\\") { out += "\\\\"; }
    else if (ch === "(") { out += "\\("; }
    else if (ch === ")") { out += "\\)"; }
    else if (code < 0x80) {
      // ASCII — emit as-is
      out += ch;
    } else {
      // Non-ASCII — encode as WinAnsi octal escape
      let winByte = unicodeToWinAnsi[code];
      if (winByte === undefined && code >= 0xA0 && code <= 0xFF) {
        // Latin-1 supplement: WinAnsi matches Unicode
        winByte = code;
      }
      if (winByte !== undefined) {
        out += "\\" + winByte.toString(8).padStart(3, "0");
      }
      // Characters not in WinAnsiEncoding are dropped
    }
  }
  return out;
}

/**
 * Escape text for symbolic fonts (ZapfDingbats, Symbol).
 * These fonts use their own encoding — emit raw byte values as octal escapes.
 */
function escapePdfSymbolic(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === "\\") { out += "\\\\"; }
    else if (ch === "(") { out += "\\("; }
    else if (ch === ")") { out += "\\)"; }
    else if (code <= 0xFF) {
      // Emit as octal for any byte to ensure correct encoding
      if (code < 0x80 && code >= 0x20) {
        out += ch;
      } else {
        out += "\\" + code.toString(8).padStart(3, "0");
      }
    } else {
      // Characters outside single-byte range — drop
    }
  }
  return out;
}

/** Decode a data URL to raw bytes and MIME type. */
function decodeDataUrl(dataUrl: string): { data: Uint8Array; mimeType: string } | null {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const base64 = match[2];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data: bytes, mimeType };
}

// ── Gradient parsing (identical logic to jspdf-writer) ──────────────

interface GradientStop { offset: number; color: ParsedColor; }
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; }
type ParsedGradient = LinearGradient | RadialGradient;

function parseGradientAngle(dirStr: string): number {
  dirStr = dirStr.trim();
  const degMatch = dirStr.match(/^([\d.]+)deg$/);
  if (degMatch) return parseFloat(degMatch[1]);
  const radMatch = dirStr.match(/^([\d.]+)rad$/);
  if (radMatch) return parseFloat(radMatch[1]) * (180 / Math.PI);
  const turnMatch = dirStr.match(/^([\d.]+)turn$/);
  if (turnMatch) return parseFloat(turnMatch[1]) * 360;
  const dirMap: Record<string, number> = {
    "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
    "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
    "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315,
  };
  return dirMap[dirStr] ?? 180;
}

function parseColorStops(argsStr: string): GradientStop[] {
  const stops: GradientStop[] = [];
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of argsStr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const percentMatch = part.match(/([\d.]+)%\s*$/);
    const pxMatch = !percentMatch ? part.match(/([\d.]+)px\s*$/) : null;
    const colorStr = (percentMatch || pxMatch) ? part.slice(0, (percentMatch || pxMatch)!.index).trim() : part.trim();
    const color = parseColor(colorStr);
    if (!color) continue;
    let offset = -1;
    if (percentMatch) offset = parseFloat(percentMatch[1]) / 100;
    else if (pxMatch) offset = -(parseFloat(pxMatch[1]) + 1);
    stops.push({ offset, color });
  }

  const hasPxStops = stops.some(s => s.offset < -1);
  if (hasPxStops) {
    let maxPx = 0;
    for (const s of stops) { if (s.offset < -1) { const px = -(s.offset + 1); if (px > maxPx) maxPx = px; } }
    if (maxPx > 0) { for (const s of stops) { if (s.offset < -1) s.offset = -(s.offset + 1) / maxPx; } }
  }
  if (stops.length > 0) {
    if (stops[0].offset < 0) stops[0].offset = 0;
    if (stops[stops.length - 1].offset < 0) stops[stops.length - 1].offset = 1;
    let lastKnown = 0;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].offset >= 0) {
        const gap = i - lastKnown;
        if (gap > 1) {
          const s0 = stops[lastKnown].offset, s1 = stops[i].offset;
          for (let j = lastKnown + 1; j < i; j++) stops[j].offset = s0 + (s1 - s0) * ((j - lastKnown) / gap);
        }
        lastKnown = i;
      }
    }
  }
  return stops;
}

function extractFirstGradient(bgImage: string): string | null {
  const match = bgImage.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/);
  if (!match || match.index === undefined) return null;
  let depth = 0, start = match.index;
  for (let i = start; i < bgImage.length; i++) {
    if (bgImage[i] === "(") depth++;
    else if (bgImage[i] === ")") { depth--; if (depth === 0) return bgImage.slice(start, i + 1); }
  }
  return null;
}

function parseGradient(bgImage: string | undefined): ParsedGradient | null {
  if (!bgImage || bgImage === "none") return null;
  const gradientStr = extractFirstGradient(bgImage);
  if (!gradientStr) return null;

  const linearMatch = gradientStr.match(/^(?:repeating-)?linear-gradient\((.+)\)$/);
  if (linearMatch) {
    const inner = linearMatch[1];
    let depth = 0, splitIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") depth++; else if (inner[i] === ")") depth--;
      else if (inner[i] === "," && depth === 0) { splitIdx = i; break; }
    }
    let angleDeg = 180, stopsStr = inner;
    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim();
      if (/^(to\s|[\d.]+deg|[\d.]+rad|[\d.]+turn)/i.test(firstPart)) {
        angleDeg = parseGradientAngle(firstPart);
        stopsStr = inner.slice(splitIdx + 1);
      }
    }
    const stops = parseColorStops(stopsStr);
    if (stops.length < 2) return null;
    return { type: "linear", angleDeg, stops };
  }

  const radialMatch = gradientStr.match(/^(?:repeating-)?radial-gradient\((.+)\)$/);
  if (radialMatch) {
    const stops = parseColorStops(radialMatch[1]);
    if (stops.length < 2) return null;
    return { type: "radial", stops };
  }
  return null;
}

// ── Resource tracking ───────────────────────────────────────────────

interface GStateDef { name: string; ca: number; CA: number; }

interface ShadingDef {
  name: string;
  type: 2 | 3;          // 2 = axial, 3 = radial
  coords: number[];     // in PDF coordinates
  stops: { offset: number; r: number; g: number; b: number }[];
}

interface ImageDef {
  name: string;
  data: Uint8Array;
  width: number;
  height: number;
  filter: string | null; // "DCTDecode" for JPEG, null for raw RGB
}

// ── PDF-Lite Writer ─────────────────────────────────────────────────

/** Bezier approximation constant for quarter-circle arcs. */
const KAPPA = 0.5522847498;

export class PDFWriter implements Writer<PdfDocument> {
  private ops: string[] = [];
  private pageWidthPt: number;
  private pageHeightPt: number;

  // Resource tracking
  private fontMap = new Map<string, string>();  // standard PDF font name → resource name (F1, …)
  private fontCounter = 0;
  private gstates: GStateDef[] = [];
  private shadings: ShadingDef[] = [];
  private shadingCounter = 0;
  private images: ImageDef[] = [];
  private imageCounter = 0;

  // Custom TrueType fonts: CSS family (lowercase) → parsed TTF data
  private customFonts = new Map<string, ParsedTTF>();
  // Track which characters (Unicode code points) are used per custom font (PostScript name)
  private customFontUsedChars = new Map<string, Set<number>>();

  /**
   * @param pageWidth Page width in mm (default A4 = 210)
   * @param pageHeight Page height in mm (default A4 = 297)
   * @param customFonts Optional map of CSS font-family name → TTF file bytes
   */
  constructor(pageWidth = 210, pageHeight = 297, customFonts?: Map<string, Uint8Array>) {
    this.pageWidthPt = pageWidth * 2.835;    // mm → pt
    this.pageHeightPt = pageHeight * 2.835;
    if (customFonts) {
      for (const [family, data] of customFonts) {
        this.customFonts.set(family.toLowerCase(), parseTTF(data));
      }
    }
  }

  begin(): void {
    this.ops = [];
    this.fontMap.clear();
    this.fontCounter = 0;
    this.gstates = [];
    this.shadings = [];
    this.shadingCounter = 0;
    this.images = [];
    this.imageCounter = 0;
    this.customFontUsedChars.clear();
  }

  // ── Coordinate helpers ──────────────────────────────────────────

  /** Convert px X to PDF pt (same direction). */
  private ptX(px: number): number { return px * 0.75; }

  /** Convert px Y to PDF pt (flipped: PDF Y=0 is bottom). */
  private ptY(px: number): number { return this.pageHeightPt - px * 0.75; }

  // ── Font helpers ────────────────────────────────────────────────

  /** Map CSS font family + weight to a standard PDF font name (or custom font ID). */
  private mapToPdfFont(family: string, weight: "bold" | "normal"): string {
    const fam = family.toLowerCase();

    // Check custom fonts first
    for (const [cssFamily, parsed] of this.customFonts) {
      if (fam.includes(cssFamily)) {
        return `custom:${parsed.postScriptName}`;
      }
    }

    if (fam.includes("wingdings") || fam.includes("zapfdingbats") || fam.includes("dingbats")) {
      return "ZapfDingbats";
    }
    if (fam.includes("symbol")) {
      return "Symbol";
    }
    if (fam.includes("times") || (fam.includes("serif") && !fam.includes("sans"))) {
      return weight === "bold" ? "Times-Bold" : "Times-Roman";
    }
    if (fam.includes("courier") || fam.includes("mono")) {
      return weight === "bold" ? "Courier-Bold" : "Courier";
    }
    return weight === "bold" ? "Helvetica-Bold" : "Helvetica";
  }

  /** Check if a PDF font name is a symbolic font (no WinAnsi encoding). */
  private isSymbolicFont(pdfFontName: string): boolean {
    return pdfFontName === "ZapfDingbats" || pdfFontName === "Symbol";
  }

  /** Check if a PDF font name refers to a custom TrueType font. */
  private isCustomFont(pdfFontName: string): boolean {
    return pdfFontName.startsWith("custom:");
  }

  /** Get the ascent ratio (ascent / unitsPerEm) for a PDF font. */
  private getFontAscentRatio(pdfFontName: string): number {
    // Custom TrueType fonts: use actual parsed metrics
    const parsed = this.getCustomFontData(pdfFontName);
    if (parsed) {
      return parsed.ascent / parsed.unitsPerEm;
    }
    // Standard PDF font ascent values (per 1000 em units)
    const standardAscents: Record<string, number> = {
      "Helvetica":      0.718,
      "Helvetica-Bold": 0.718,
      "Times-Roman":    0.683,
      "Times-Bold":     0.683,
      "Courier":        0.629,
      "Courier-Bold":   0.629,
      "ZapfDingbats":   0.820,
      "Symbol":         0.800,
    };
    return standardAscents[pdfFontName] ?? 0.75;
  }

  /** Get the parsed TTF data for a custom font name. */
  private getCustomFontData(pdfFontName: string): ParsedTTF | null {
    if (!pdfFontName.startsWith("custom:")) return null;
    const psName = pdfFontName.slice(7); // strip "custom:"
    for (const parsed of this.customFonts.values()) {
      if (parsed.postScriptName === psName) return parsed;
    }
    return null;
  }

  /** Get or create a font resource name for the given PDF font. */
  private getFontResName(pdfFontName: string): string {
    let name = this.fontMap.get(pdfFontName);
    if (!name) {
      name = `F${++this.fontCounter}`;
      this.fontMap.set(pdfFontName, name);
    }
    return name;
  }

  /**
   * Encode text for a custom TrueType font.
   * For symbol fonts: returns escaped single-byte string (for use in parentheses).
   * For CID fonts: returns hex string of 4-digit glyph IDs (for use in angle brackets).
   * Also tracks used characters for width tables and ToUnicode.
   */
  private encodeCustomText(text: string, pdfFontName: string): string {
    const parsed = this.getCustomFontData(pdfFontName);
    if (!parsed) return "";

    // Track used characters
    let usedChars = this.customFontUsedChars.get(parsed.postScriptName);
    if (!usedChars) {
      usedChars = new Set<number>();
      this.customFontUsedChars.set(parsed.postScriptName, usedChars);
    }

    if (parsed.isSymbolFont) {
      // Symbol font: single-byte encoding, use raw byte values
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        usedChars.add(charCode);
        const byte = charCode & 0xFF;
        if (byte === 0x28 || byte === 0x29 || byte === 0x5C) {
          // Escape ( ) and backslash
          out += "\\" + String.fromCharCode(byte);
        } else if (byte >= 0x20 && byte < 0x7F) {
          out += String.fromCharCode(byte);
        } else {
          out += "\\" + byte.toString(8).padStart(3, "0");
        }
      }
      return out;
    } else {
      // CID font: encode as hex glyph IDs
      let hex = "";
      for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        usedChars.add(charCode);
        const glyphId = parsed.cmap.get(charCode) ?? 0;
        hex += glyphId.toString(16).padStart(4, "0").toUpperCase();
      }
      return hex;
    }
  }

  // ── GState helpers ──────────────────────────────────────────────

  /** Get or create an ExtGState resource name for the given opacity values. */
  private getGStateResName(fillOpacity: number, strokeOpacity: number): string {
    const existing = this.gstates.find(g => g.ca === fillOpacity && g.CA === strokeOpacity);
    if (existing) return existing.name;
    const name = `GS${this.gstates.length + 1}`;
    this.gstates.push({ name, ca: fillOpacity, CA: strokeOpacity });
    return name;
  }

  // ── Path helpers ────────────────────────────────────────────────

  /** Emit polygon path (4 points) in PDF coordinates. */
  private emitQuadPath(points: Quad): void {
    const xs = points.map(p => this.ptX(p.x));
    const ys = points.map(p => this.ptY(p.y));
    this.ops.push(`${pn(xs[0])} ${pn(ys[0])} m`);
    for (let i = 1; i < 4; i++) this.ops.push(`${pn(xs[i])} ${pn(ys[i])} l`);
    this.ops.push("h");
  }

  /** Emit a rounded-rectangle path in PDF coordinates. */
  private emitRoundedRectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): void {
    // (x,y) = top-left in PDF coords, h goes downward (y - h = bottom)
    const krx = rx * KAPPA;
    const kry = ry * KAPPA;
    const b = y - h; // bottom

    this.ops.push(`${pn(x + rx)} ${pn(y)} m`);
    // Top edge
    this.ops.push(`${pn(x + w - rx)} ${pn(y)} l`);
    // Top-right corner
    this.ops.push(`${pn(x + w - rx + krx)} ${pn(y)} ${pn(x + w)} ${pn(y - kry)} ${pn(x + w)} ${pn(y - ry)} c`);
    // Right edge
    this.ops.push(`${pn(x + w)} ${pn(b + ry)} l`);
    // Bottom-right corner
    this.ops.push(`${pn(x + w)} ${pn(b + ry - kry)} ${pn(x + w - rx + krx)} ${pn(b)} ${pn(x + w - rx)} ${pn(b)} c`);
    // Bottom edge
    this.ops.push(`${pn(x + rx)} ${pn(b)} l`);
    // Bottom-left corner
    this.ops.push(`${pn(x + rx - krx)} ${pn(b)} ${pn(x)} ${pn(b + ry - kry)} ${pn(x)} ${pn(b + ry)} c`);
    // Left edge
    this.ops.push(`${pn(x)} ${pn(y - ry)} l`);
    // Top-left corner
    this.ops.push(`${pn(x)} ${pn(y - ry + kry)} ${pn(x + rx - krx)} ${pn(y)} ${pn(x + rx)} ${pn(y)} c`);
    this.ops.push("h");
  }

  // ── Style helpers ───────────────────────────────────────────────

  /** Set fill color (RGB 0–1). */
  private setFill(c: ParsedColor): void {
    this.ops.push(`${pn(c.r / 255)} ${pn(c.g / 255)} ${pn(c.b / 255)} rg`);
  }

  /** Set stroke color (RGB 0–1). */
  private setStroke(c: ParsedColor): void {
    this.ops.push(`${pn(c.r / 255)} ${pn(c.g / 255)} ${pn(c.b / 255)} RG`);
  }

  /** Set line width in pt. */
  private setLineWidth(pt: number): void {
    this.ops.push(`${pn(pt)} w`);
  }

  /**
   * Apply fill/stroke style operators and return the paint operator.
   * Returns null if the shape is fully transparent.
   */
  private applyStyleOps(style: Style): "S" | "f" | "B" | null {
    const fillColor = parseVisibleColor(style.fill);
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;

    const hasFill = fillColor !== null;
    const hasStroke = strokeColor !== null && strokeWidth > 0;

    if (!hasFill && !hasStroke) return null;

    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      const gsName = this.getGStateResName(
        hasFill ? opacity : 1,
        hasStroke ? opacity : 1,
      );
      this.ops.push(`/${gsName} gs`);
    }

    if (fillColor) this.setFill(fillColor);
    if (hasStroke) {
      this.setStroke(strokeColor!);
      this.setLineWidth(pxToPt(strokeWidth));
    } else {
      this.setStroke({ r: 0, g: 0, b: 0, a: 1 });
      this.setLineWidth(pxToPt(0.5));
    }

    if (hasFill && hasStroke) return "B";
    if (hasFill) return "f";
    return "S";
  }

  // ── Drawing methods ─────────────────────────────────────────────

  drawPolygon(points: Quad, style: Style): void {
    const gradient = parseGradient(style.backgroundImage);
    if (gradient) {
      this.drawGradientPolygon(points, gradient, style);
      return;
    }

    this.ops.push("q");
    const paintOp = this.applyStyleOps(style);
    if (!paintOp) { this.ops.push("Q"); return; }

    const radius = parseBorderRadius(style.borderRadius);
    if (radius && isAxisAlignedRect(points)) {
      const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
      const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
      const w = pxToPt(Math.abs(points[1].x - points[0].x));
      const h = pxToPt(Math.abs(points[3].y - points[0].y));
      const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
      const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
      this.emitRoundedRectPath(left, top, w, h, rx, ry);
    } else {
      this.emitQuadPath(points);
    }

    this.ops.push(paintOp);
    this.ops.push("Q");
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    if (points.length < 2) return;

    this.ops.push("q");
    const paintOp = this.applyStyleOps(style);
    if (!paintOp) { this.ops.push("Q"); return; }

    const x0 = this.ptX(points[0].x);
    const y0 = this.ptY(points[0].y);
    this.ops.push(`${pn(x0)} ${pn(y0)} m`);
    for (let i = 1; i < points.length; i++) {
      this.ops.push(`${pn(this.ptX(points[i].x))} ${pn(this.ptY(points[i].y))} l`);
    }
    if (closed) this.ops.push("h");

    this.ops.push(paintOp);
    this.ops.push("Q");
  }

  drawText(quad: Quad, text: string, style: Style): void {
    if (style.textTransform) {
      switch (style.textTransform) {
        case "uppercase": text = text.toUpperCase(); break;
        case "lowercase": text = text.toLowerCase(); break;
        case "capitalize": text = text.replace(/\b\w/g, c => c.toUpperCase()); break;
      }
    }

    // Derive font size: use quad height as the authoritative rendered size,
    // since style.fontSize may reflect an unscaled coordinate system (e.g. SVG in <img>).
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = parseFontSize(style.fontSize);
    const quadFontSize = quadHeight > 0 ? pxToPt(quadHeight) : styleFontSize;
    const fontSize = Math.min(styleFontSize, quadFontSize);
    const fontWeight = mapFontWeight(style.fontWeight);
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "Helvetica";
    const pdfFontName = this.mapToPdfFont(fontFamily, fontWeight);
    const fontRes = this.getFontResName(pdfFontName);

    const textColor = parseVisibleColor(style.color) ?? parseVisibleColor(style.fill);
    const r = textColor ? textColor.r / 255 : 0;
    const g = textColor ? textColor.g / 255 : 0;
    const b = textColor ? textColor.b / 255 : 0;

    // Compute rotation from quad top edge
    const dxScreen = quad[1].x - quad[0].x;
    const dyScreen = quad[1].y - quad[0].y;
    const anglePdf = Math.atan2(-dyScreen, dxScreen); // negative because Y is flipped

    // Baseline position: offset from top-left of quad
    // The quad represents the visual line box. Baseline = halfLeading + ascent.
    const quadHeightPt = pxToPt(quadHeight);
    const ascentRatio = this.getFontAscentRatio(pdfFontName);
    const halfLeading = Math.max(0, (quadHeightPt - fontSize) / 2);
    const baselineOffset = halfLeading + ascentRatio * fontSize;

    const sinA = Math.sin(anglePdf);
    const cosA = Math.cos(anglePdf);
    const bx = this.ptX(quad[0].x) + sinA * baselineOffset;
    const by = this.ptY(quad[0].y) - cosA * baselineOffset;

    this.ops.push("q");

    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.ops.push("BT");
    this.ops.push(`${pn(r)} ${pn(g)} ${pn(b)} rg`);
    this.ops.push(`/${fontRes} ${pn(fontSize)} Tf`);

    if (Math.abs(anglePdf) > 0.01) {
      // Use text matrix for rotation
      this.ops.push(`${pn(cosA)} ${pn(sinA)} ${pn(-sinA)} ${pn(cosA)} ${pn(bx)} ${pn(by)} Tm`);
    } else {
      this.ops.push(`${pn(bx)} ${pn(by)} Td`);
    }

    const escaped = this.isCustomFont(pdfFontName)
      ? this.encodeCustomText(text, pdfFontName)
      : this.isSymbolicFont(pdfFontName) ? escapePdfSymbolic(text) : escapePdfText(text);

    const customData = this.getCustomFontData(pdfFontName);
    if (this.isCustomFont(pdfFontName) && customData && !customData.isSymbolFont) {
      // CID font: use hex string <...>
      this.ops.push(`<${escaped}> Tj`);
    } else {
      this.ops.push(`(${escaped}) Tj`);
    }
    this.ops.push("ET");
    this.ops.push("Q");

    // Text decorations: underline, line-through, overline
    const dec = style.textDecoration;
    if (dec && dec !== "none" && (dec.includes("underline") || dec.includes("line-through") || dec.includes("overline"))) {
      // Compute the text line extent in PDF coordinates
      const topEdgePx = Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen);
      const lineWidthPt = Math.max(0.5, fontSize / 14);

      this.ops.push("q");
      this.ops.push(`${pn(r)} ${pn(g)} ${pn(b)} RG`);
      this.ops.push(`${pn(lineWidthPt)} w`);

      if (dec.includes("underline")) {
        // Underline: slightly below baseline
        const underlineOffset = baselineOffset + fontSize * 0.15;
        const ux = this.ptX(quad[0].x) + sinA * underlineOffset;
        const uy = this.ptY(quad[0].y) - cosA * underlineOffset;
        const ex = ux + cosA * pxToPt(topEdgePx);
        const ey = uy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(ux)} ${pn(uy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      if (dec.includes("line-through")) {
        // Line-through: ~40% above baseline (middle of x-height)
        const strikeOffset = baselineOffset - fontSize * 0.3;
        const sx = this.ptX(quad[0].x) + sinA * strikeOffset;
        const sy = this.ptY(quad[0].y) - cosA * strikeOffset;
        const ex = sx + cosA * pxToPt(topEdgePx);
        const ey = sy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(sx)} ${pn(sy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      if (dec.includes("overline")) {
        // Overline: near top of text
        const overlineOffset = baselineOffset - fontSize * 0.85;
        const ox = this.ptX(quad[0].x) + sinA * overlineOffset;
        const oy = this.ptY(quad[0].y) - cosA * overlineOffset;
        const ex = ox + cosA * pxToPt(topEdgePx);
        const ey = oy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(ox)} ${pn(oy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      this.ops.push("Q");
    }
  }

  drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): void {
    const imgName = `Im${++this.imageCounter}`;

    if (rgbData) {
      // Use raw RGB pixel data (lossless, no compression artifacts)
      this.images.push({
        name: imgName,
        data: new Uint8Array(rgbData),
        width,
        height,
        filter: null,
      });
    } else {
      // Decode the data URL to raw bytes (JPEG)
      const decoded = decodeDataUrl(dataUrl);
      if (!decoded) return;
      this.images.push({
        name: imgName,
        data: decoded.data,
        width,
        height,
        filter: "DCTDecode",
      });
    }

    // Compute affine transform from unit square to PDF quad coordinates.
    // Image XObject renders in unit square (0,0)-(1,0)-(1,1)-(0,1).
    // Map: (0,0)→bottomLeft, (1,0)→bottomRight, (0,1)→topLeft
    // quad: [topLeft, topRight, bottomRight, bottomLeft]
    const tl = { x: this.ptX(quad[0].x), y: this.ptY(quad[0].y) };
    const tr = { x: this.ptX(quad[1].x), y: this.ptY(quad[1].y) };
    const br = { x: this.ptX(quad[2].x), y: this.ptY(quad[2].y) };
    const bl = { x: this.ptX(quad[3].x), y: this.ptY(quad[3].y) };
    const a = br.x - bl.x, b = br.y - bl.y; // (1,0) - (0,0)
    const c = tl.x - bl.x, d = tl.y - bl.y; // (0,1) - (0,0)
    const e = bl.x, f = bl.y;                // (0,0) origin

    this.ops.push("q");

    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.ops.push(`${pn(a)} ${pn(b)} ${pn(c)} ${pn(d)} ${pn(e)} ${pn(f)} cm`);
    this.ops.push(`/${imgName} Do`);
    this.ops.push("Q");
  }

  end(): PdfDocument {
    const doc = new PdfDocument();

    // ── Create font objects ────────────────────────────────────────
    const fontDict = new PdfDictionary();
    for (const [pdfFontName, resName] of this.fontMap) {
      if (this.isCustomFont(pdfFontName)) {
        // TrueType font embedding
        const parsed = this.getCustomFontData(pdfFontName);
        if (!parsed) continue;

        const usedChars = this.customFontUsedChars.get(parsed.postScriptName) ?? new Set<number>();
        if (parsed.isSymbolFont) {
          // Simple TrueType embedding for symbol fonts (better compatibility)
          const fontRef = this.createSimpleTrueTypeFont(doc, parsed, usedChars);
          fontDict.set(resName, fontRef);
        } else {
          // CID font embedding for Unicode fonts
          const fontRef = this.createCIDFont(doc, parsed, usedChars);
          fontDict.set(resName, fontRef);
        }
      } else {
        // Standard Type1 font
        const font = PdfFont.fromStandardFont(pdfFontName as any);
        font.resourceName = resName;
        doc.add(font);
        fontDict.set(resName, font.reference);
      }
    }

    // ── Create ExtGState objects ───────────────────────────────────
    const gsDict = new PdfDictionary();
    for (const gs of this.gstates) {
      const d = new PdfDictionary();
      d.set("Type", new PdfName("ExtGState"));
      d.set("ca", new PdfNumber(gs.ca));
      d.set("CA", new PdfNumber(gs.CA));
      const obj = new PdfIndirectObject({ content: d });
      doc.add(obj);
      gsDict.set(gs.name, obj.reference);
    }

    // ── Create Shading objects ─────────────────────────────────────
    const shadingDict = new PdfDictionary();
    for (const sh of this.shadings) {
      const d = new PdfDictionary();
      d.set("ShadingType", new PdfNumber(sh.type));
      d.set("ColorSpace", new PdfName("DeviceRGB"));
      d.set("Coords", new PdfArray(sh.coords.map(c => new PdfNumber(c))));
      d.set("Function", this.buildColorFunction(sh.stops));
      d.set("Extend", new PdfArray([new PdfBoolean(true), new PdfBoolean(true)]));
      const obj = new PdfIndirectObject({ content: d });
      doc.add(obj);
      shadingDict.set(sh.name, obj.reference);
    }

    // ── Resources dictionary ───────────────────────────────────────
    const resourcesDict = new PdfDictionary();
    if (this.fontMap.size > 0) resourcesDict.set("Font", fontDict);
    if (this.gstates.length > 0) resourcesDict.set("ExtGState", gsDict);
    if (this.shadings.length > 0) resourcesDict.set("Shading", shadingDict);

    // ── Create Image XObject entries ──────────────────────────────
    if (this.images.length > 0) {
      const xobjectDict = new PdfDictionary();
      for (const img of this.images) {
        const imgDict = new PdfDictionary();
        imgDict.set("Type", new PdfName("XObject"));
        imgDict.set("Subtype", new PdfName("Image"));
        imgDict.set("Width", new PdfNumber(img.width));
        imgDict.set("Height", new PdfNumber(img.height));
        imgDict.set("ColorSpace", new PdfName("DeviceRGB"));
        imgDict.set("BitsPerComponent", new PdfNumber(8));
        if (img.filter) imgDict.set("Filter", new PdfName(img.filter));

        const imgObj = new PdfIndirectObject({
          content: new PdfStream({ header: imgDict, binary: img.data }),
        });
        doc.add(imgObj);
        xobjectDict.set(img.name, imgObj.reference);
      }
      resourcesDict.set("XObject", xobjectDict);
    }

    const resources = new PdfIndirectObject({ content: resourcesDict });
    doc.add(resources);

    // ── Content stream ─────────────────────────────────────────────
    const contentStream = new PdfIndirectObject({
      content: new PdfStream({
        header: new PdfDictionary(),
        original: this.ops.join("\n"),
      }),
    });
    doc.add(contentStream);

    // ── Page ───────────────────────────────────────────────────────
    const page = new PdfPage();
    page.mediaBox = [0, 0, this.pageWidthPt, this.pageHeightPt];
    page.contents = contentStream.reference;
    page.resources = resources.reference;
    doc.add(page);

    // ── Pages ──────────────────────────────────────────────────────
    const pages = new PdfPages();
    pages.kids = new PdfArray([page.reference]);
    pages.count = 1;
    page.parent = pages;
    doc.add(pages);

    // ── Catalog ────────────────────────────────────────────────────
    const catalogDict = new PdfDictionary();
    catalogDict.set("Type", new PdfName("Catalog"));
    catalogDict.set("Pages", pages.reference);
    const catalog = new PdfIndirectObject({ content: catalogDict });
    doc.add(catalog);

    doc.trailerDict.set("Root", catalog.reference);
    return doc;
  }

  // ── Simple TrueType Font creation (for Symbol fonts) ─────────

  /**
   * Create a simple TrueType font with embedded data for symbol fonts.
   * This is more compatible with PDF viewers than CIDFontType2 for single-byte fonts.
   */
  private createSimpleTrueTypeFont(
    doc: PdfDocument,
    parsed: ParsedTTF,
    usedChars: Set<number>,
  ): PdfReference {
    const psName = parsed.postScriptName;
    const scale = 1000 / parsed.unitsPerEm;

    // 1. Embedded font stream (FontFile2)
    const fontStreamHeader = new PdfDictionary();
    fontStreamHeader.set("Length1", new PdfNumber(parsed.rawData.length));
    const fontStreamObj = new PdfIndirectObject({
      content: new PdfStream({ header: fontStreamHeader, binary: parsed.rawData }),
    });
    doc.add(fontStreamObj);

    // 2. FontDescriptor
    const fdDict = new PdfDictionary();
    fdDict.set("Type", new PdfName("FontDescriptor"));
    fdDict.set("FontName", new PdfName(psName));
    fdDict.set("Flags", new PdfNumber(parsed.flags));
    fdDict.set("FontBBox", new PdfArray(parsed.bbox.map(n => new PdfNumber(Math.round(n * scale)))));
    fdDict.set("ItalicAngle", new PdfNumber(parsed.italicAngle));
    fdDict.set("Ascent", new PdfNumber(Math.round(parsed.ascent * scale)));
    fdDict.set("Descent", new PdfNumber(Math.round(parsed.descent * scale)));
    fdDict.set("CapHeight", new PdfNumber(Math.round(parsed.ascent * scale * 0.8)));
    fdDict.set("StemV", new PdfNumber(80));
    fdDict.set("FontFile2", fontStreamObj.reference);
    const fdObj = new PdfIndirectObject({ content: fdDict });
    doc.add(fdObj);

    // 3. Build Widths array for FirstChar..LastChar
    // For symbol fonts, character bytes map to glyphs through the font's cmap.
    // Determine FirstChar and LastChar from used characters.
    let firstChar = 255, lastChar = 0;
    for (const charCode of usedChars) {
      const byte = charCode & 0xFF;
      if (byte < firstChar) firstChar = byte;
      if (byte > lastChar) lastChar = byte;
    }
    if (firstChar > lastChar) { firstChar = 32; lastChar = 255; }

    const widths: number[] = [];
    for (let i = firstChar; i <= lastChar; i++) {
      const glyphId = parsed.cmap.get(i) ?? 0;
      const rawWidth = parsed.glyphWidths.get(glyphId) ?? 0;
      widths.push(Math.round(rawWidth * scale));
    }

    // 4. Simple TrueType font dictionary
    const fontDict = new PdfDictionary();
    fontDict.set("Type", new PdfName("Font"));
    fontDict.set("Subtype", new PdfName("TrueType"));
    fontDict.set("BaseFont", new PdfName(psName));
    fontDict.set("FirstChar", new PdfNumber(firstChar));
    fontDict.set("LastChar", new PdfNumber(lastChar));
    fontDict.set("Widths", new PdfArray(widths.map(w => new PdfNumber(w))));
    fontDict.set("FontDescriptor", fdObj.reference);
    // No Encoding for symbolic fonts — uses font's built-in cmap

    const fontObj = new PdfIndirectObject({ content: fontDict });
    doc.add(fontObj);

    return fontObj.reference;
  }

  // ── CID Font creation ──────────────────────────────────────────

  /**
   * Create a Type0 composite font with embedded TrueType data for PDF.
   * Returns the PdfReference for the Type0 font dictionary.
   */
  private createCIDFont(
    doc: PdfDocument,
    parsed: ParsedTTF,
    usedChars: Set<number>,
  ): PdfReference {
    const psName = parsed.postScriptName;
    const scale = 1000 / parsed.unitsPerEm;

    // 1. Embedded font stream (FontFile2) — full TTF data
    const fontStreamHeader = new PdfDictionary();
    fontStreamHeader.set("Length1", new PdfNumber(parsed.rawData.length));
    const fontStreamObj = new PdfIndirectObject({
      content: new PdfStream({ header: fontStreamHeader, binary: parsed.rawData }),
    });
    doc.add(fontStreamObj);

    // 2. FontDescriptor
    const fdDict = new PdfDictionary();
    fdDict.set("Type", new PdfName("FontDescriptor"));
    fdDict.set("FontName", new PdfName(psName));
    fdDict.set("Flags", new PdfNumber(parsed.flags));
    fdDict.set("FontBBox", new PdfArray(parsed.bbox.map(n => new PdfNumber(Math.round(n * scale)))));
    fdDict.set("ItalicAngle", new PdfNumber(parsed.italicAngle));
    fdDict.set("Ascent", new PdfNumber(Math.round(parsed.ascent * scale)));
    fdDict.set("Descent", new PdfNumber(Math.round(parsed.descent * scale)));
    fdDict.set("CapHeight", new PdfNumber(Math.round(parsed.ascent * scale * 0.8)));
    fdDict.set("StemV", new PdfNumber(80));
    fdDict.set("FontFile2", fontStreamObj.reference);
    const fdObj = new PdfIndirectObject({ content: fdDict });
    doc.add(fdObj);

    // 3. Build width array /W for used glyphs
    //    Format: [gid [width] gid [width] ...]
    const wItems: { serialize(): string }[] = [];
    const usedGlyphs = new Map<number, number>(); // glyphId → width in 1/1000 units
    for (const charCode of usedChars) {
      const gid = parsed.cmap.get(charCode) ?? 0;
      if (gid === 0) continue;
      const rawWidth = parsed.glyphWidths.get(gid) ?? 0;
      usedGlyphs.set(gid, Math.round(rawWidth * scale));
    }
    // Sort glyph IDs for deterministic output
    const sortedGids = Array.from(usedGlyphs.keys()).sort((a, b) => a - b);
    for (const gid of sortedGids) {
      wItems.push(new PdfNumber(gid));
      wItems.push(new PdfArray([new PdfNumber(usedGlyphs.get(gid)!)]));
    }

    // 4. CIDFont (CIDFontType2)
    const cidDict = new PdfDictionary();
    cidDict.set("Type", new PdfName("Font"));
    cidDict.set("Subtype", new PdfName("CIDFontType2"));
    cidDict.set("BaseFont", new PdfName(psName));
    const cidSysInfo = new PdfDictionary();
    cidSysInfo.set("Registry", { serialize: () => "(Adobe)" } as any);
    cidSysInfo.set("Ordering", { serialize: () => "(Identity)" } as any);
    cidSysInfo.set("Supplement", new PdfNumber(0));
    cidDict.set("CIDSystemInfo", cidSysInfo);
    cidDict.set("FontDescriptor", fdObj.reference);
    cidDict.set("DW", new PdfNumber(1000));
    if (wItems.length > 0) cidDict.set("W", new PdfArray(wItems));
    cidDict.set("CIDToGIDMap", new PdfName("Identity"));
    const cidObj = new PdfIndirectObject({ content: cidDict });
    doc.add(cidObj);

    // 5. ToUnicode CMap (enables copy-paste of text from PDF)
    const toUnicodeCMap = this.buildToUnicodeCMap(parsed, usedChars);
    const toUnicodeHeader = new PdfDictionary();
    const toUnicodeObj = new PdfIndirectObject({
      content: new PdfStream({ header: toUnicodeHeader, original: toUnicodeCMap }),
    });
    doc.add(toUnicodeObj);

    // 6. Type0 composite font (top-level)
    const type0Dict = new PdfDictionary();
    type0Dict.set("Type", new PdfName("Font"));
    type0Dict.set("Subtype", new PdfName("Type0"));
    type0Dict.set("BaseFont", new PdfName(psName));
    type0Dict.set("Encoding", new PdfName("Identity-H"));
    type0Dict.set("DescendantFonts", new PdfArray([cidObj.reference]));
    type0Dict.set("ToUnicode", toUnicodeObj.reference);
    const type0Obj = new PdfIndirectObject({ content: type0Dict });
    doc.add(type0Obj);

    return type0Obj.reference;
  }

  /**
   * Build a ToUnicode CMap stream for a CID font.
   * Maps glyph IDs back to Unicode code points for text extraction/copy.
   */
  private buildToUnicodeCMap(parsed: ParsedTTF, usedChars: Set<number>): string {
    // Build glyph ID → Unicode mapping for used characters
    const gidToUnicode = new Map<number, number>();
    for (const charCode of usedChars) {
      const gid = parsed.cmap.get(charCode) ?? 0;
      if (gid !== 0) gidToUnicode.set(gid, charCode);
    }

    const sortedGids = Array.from(gidToUnicode.keys()).sort((a, b) => a - b);

    // Split into chunks of 100 (PDF limit per beginbfchar block)
    const lines: string[] = [];
    lines.push("/CIDInit /ProcSet findresource begin");
    lines.push("12 dict begin");
    lines.push("begincmap");
    lines.push("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def");
    lines.push("/CMapName /Adobe-Identity-UCS def");
    lines.push("/CMapType 2 def");
    lines.push("1 begincodespacerange");
    lines.push("<0000> <FFFF>");
    lines.push("endcodespacerange");

    for (let i = 0; i < sortedGids.length; i += 100) {
      const chunk = sortedGids.slice(i, i + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const gid of chunk) {
        const uni = gidToUnicode.get(gid)!;
        lines.push(`<${gid.toString(16).padStart(4, "0").toUpperCase()}> <${uni.toString(16).padStart(4, "0").toUpperCase()}>`);
      }
      lines.push("endbfchar");
    }

    lines.push("endcmap");
    lines.push("CMapName currentdict /CMap defineresource pop");
    lines.push("end");
    lines.push("end");
    return lines.join("\n");
  }

  // ── Gradient drawing ────────────────────────────────────────────

  private drawGradientPolygon(points: Quad, gradient: ParsedGradient, style: Style): void {
    // Compute bounding box in PDF coords
    const xs = points.map(p => this.ptX(p.x));
    const ys = points.map(p => this.ptY(p.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Register shading
    const shName = `SH${++this.shadingCounter}`;
    const stops = gradient.stops.map(s => ({
      offset: s.offset,
      r: s.color.r,
      g: s.color.g,
      b: s.color.b,
    }));

    let coords: number[];
    let shadingType: 2 | 3;

    if (gradient.type === "linear") {
      const A = gradient.angleDeg * Math.PI / 180;
      const halfDiag = Math.sqrt(w * w + h * h) / 2;
      const dx = Math.sin(A) * halfDiag;
      const dy = Math.cos(A) * halfDiag;
      coords = [cx - dx, cy - dy, cx + dx, cy + dy];
      shadingType = 2;
    } else {
      const r = Math.max(w, h) / 2;
      coords = [cx, cy, 0, cx, cy, r];
      shadingType = 3;
    }

    this.shadings.push({ name: shName, type: shadingType, coords, stops });

    // Save state, set opacity, clip, shade, restore
    this.ops.push("q");

    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    // Clip path
    const radius = parseBorderRadius(style.borderRadius);
    if (radius && isAxisAlignedRect(points)) {
      const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
      const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
      const rw = pxToPt(Math.abs(points[1].x - points[0].x));
      const rh = pxToPt(Math.abs(points[3].y - points[0].y));
      const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
      const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
      this.emitRoundedRectPath(left, top, rw, rh, rx, ry);
    } else {
      this.emitQuadPath(points);
    }
    this.ops.push("W n");   // clip + discard path

    // Paint shading
    this.ops.push(`/${shName} sh`);
    this.ops.push("Q");

    // Stroke on top if needed
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
    if (strokeColor && strokeWidth > 0) {
      this.ops.push("q");
      this.setStroke(strokeColor);
      this.setLineWidth(pxToPt(strokeWidth));
      if (radius && isAxisAlignedRect(points)) {
        const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
        const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
        const rw = pxToPt(Math.abs(points[1].x - points[0].x));
        const rh = pxToPt(Math.abs(points[3].y - points[0].y));
        const rx = pxToPt(Math.min(radius.rx, Math.abs(points[1].x - points[0].x) / 2));
        const ry = pxToPt(Math.min(radius.ry, Math.abs(points[3].y - points[0].y) / 2));
        this.emitRoundedRectPath(left, top, rw, rh, rx, ry);
      } else {
        this.emitQuadPath(points);
      }
      this.ops.push("S");
      this.ops.push("Q");
    }
  }

  /** Build a PDF color function dictionary for gradient stops. */
  private buildColorFunction(stops: { offset: number; r: number; g: number; b: number }[]): PdfDictionary {
    if (stops.length === 2) {
      return this.buildType2Function(stops[0], stops[1]);
    }

    // Multi-stop: Type 3 stitching function
    const subFuncs: PdfDictionary[] = [];
    const bounds: number[] = [];
    const encode: number[] = [];

    for (let i = 0; i < stops.length - 1; i++) {
      subFuncs.push(this.buildType2Function(stops[i], stops[i + 1]));
      if (i > 0) bounds.push(stops[i].offset);
      encode.push(0, 1);
    }

    const func = new PdfDictionary();
    func.set("FunctionType", new PdfNumber(3));
    func.set("Domain", new PdfArray([new PdfNumber(0), new PdfNumber(1)]));
    func.set("Functions", new PdfArray(subFuncs));
    func.set("Bounds", new PdfArray(bounds.map(b => new PdfNumber(b))));
    func.set("Encode", new PdfArray(encode.map(e => new PdfNumber(e))));
    return func;
  }

  /** Build a Type 2 (exponential interpolation) function for two colors. */
  private buildType2Function(
    c0: { r: number; g: number; b: number },
    c1: { r: number; g: number; b: number },
  ): PdfDictionary {
    const func = new PdfDictionary();
    func.set("FunctionType", new PdfNumber(2));
    func.set("Domain", new PdfArray([new PdfNumber(0), new PdfNumber(1)]));
    func.set("C0", new PdfArray([new PdfNumber(c0.r / 255), new PdfNumber(c0.g / 255), new PdfNumber(c0.b / 255)]));
    func.set("C1", new PdfArray([new PdfNumber(c1.r / 255), new PdfNumber(c1.g / 255), new PdfNumber(c1.b / 255)]));
    func.set("N", new PdfNumber(1));
    return func;
  }
}
