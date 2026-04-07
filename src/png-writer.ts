/**
 * PNG Writer using Canvas 2D API.
 * Maps IR nodes to Canvas 2D drawing operations and produces a PNG image.
 *
 * Returns a PNGResult from end(). Call `await result.finalize()` then
 * `result.toDataURL()` or `result.toBytes()` to get the final PNG.
 *
 * Requires a Canvas-capable environment (browser with document.createElement).
 */
import type { Point, Quad, Style, Writer } from "./types.js";

// ── Color parsing ───────────────────────────────────────────────────

function parseColor(color: string | undefined): string | null {
  if (!color || color === "transparent" || color === "none") return null;
  // Check for fully transparent rgba
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m && m[4] !== undefined && parseFloat(m[4]) <= 0) return null;
  // Check for fully transparent hex (#rrggbbaa)
  if (color.startsWith("#") && color.length === 9) {
    const alpha = parseInt(color.slice(7, 9), 16);
    if (alpha === 0) return null;
  }
  return color;
}

function hasVisibleStroke(style: Style): { color: string; width: number } | null {
  const color = parseColor(style.stroke);
  if (!color) return null;
  const width = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
  if (width <= 0) return null;
  return { color, width };
}

function parseBorderRadius(borderRadius: string | undefined): number {
  if (!borderRadius || borderRadius === "0px") return 0;
  const parts = borderRadius.split(/\s+/).map(s => parseFloat(s)).filter(n => !isNaN(n) && n > 0);
  return parts.length > 0 ? parts[0] : 0;
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

// ── Gradient parsing ────────────────────────────────────────────────

interface GradientStop { offset: number; color: string; }
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
    const colorStr = percentMatch ? part.slice(0, percentMatch.index).trim() : part.trim();
    if (!colorStr) continue;
    let offset = -1;
    if (percentMatch) offset = parseFloat(percentMatch[1]) / 100;
    stops.push({ offset, color: colorStr });
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

// ── Pending image ───────────────────────────────────────────────────

interface PendingImage {
  quad: Quad;
  dataUrl: string;
  width: number;
  height: number;
  style: Style;
}

// ── PNG Result ──────────────────────────────────────────────────────

/**
 * Holds the rendered PNG canvas.
 * Call `finalize()` to draw any pending images (async), then
 * `toDataURL()` or `toBytes()` to get the PNG output.
 */
export class PNGResult {
  /** @internal */
  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D,
    private pendingImages: PendingImage[],
  ) {}

  /** Load and draw pending raster images onto the canvas. */
  async finalize(): Promise<void> {
    for (const img of this.pendingImages) {
      await this.drawImageAsync(img);
    }
  }

  private async drawImageAsync(img: PendingImage): Promise<void> {
    const imgEl = new Image();
    imgEl.src = img.dataUrl;
    await new Promise<void>((resolve) => {
      imgEl.onload = () => resolve();
      imgEl.onerror = () => resolve(); // skip failed images
    });

    if (!imgEl.naturalWidth) return; // failed to load

    const ctx = this.ctx;
    ctx.save();

    if (img.style.opacity !== undefined && img.style.opacity < 1) {
      ctx.globalAlpha = img.style.opacity;
    }

    // Compute transform for potentially rotated quad
    const q = img.quad;
    const dx = q[1].x - q[0].x;
    const dy = q[1].y - q[0].y;
    const topEdge = Math.sqrt(dx * dx + dy * dy);
    const ldx = q[3].x - q[0].x;
    const ldy = q[3].y - q[0].y;
    const leftEdge = Math.sqrt(ldx * ldx + ldy * ldy);

    if (topEdge > 0 && leftEdge > 0) {
      const angle = Math.atan2(dy, dx);
      if (Math.abs(angle) > 0.01) {
        ctx.translate(q[0].x, q[0].y);
        ctx.rotate(angle);
        ctx.drawImage(imgEl, 0, 0, topEdge, leftEdge);
      } else {
        ctx.drawImage(imgEl, q[0].x, q[0].y, topEdge, leftEdge);
      }
    }

    ctx.restore();
  }

  /** Get the PNG as a data URL string. */
  toDataURL(): string {
    return this.canvas.toDataURL("image/png");
  }

  /** Get the PNG as a Uint8Array of raw PNG bytes. */
  toBytes(): Uint8Array {
    const dataUrl = this.toDataURL();
    const base64 = dataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

// ── PNG Writer ──────────────────────────────────────────────────────

export class PNGWriter implements Writer<PNGResult> {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private scale: number;
  private pendingImages: PendingImage[] = [];

  /**
   * @param width  Canvas width in CSS pixels.
   * @param height Canvas height in CSS pixels.
   * @param scale  Device pixel ratio / resolution multiplier (default 1).
   */
  constructor(width: number, height: number, scale = 1) {
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  begin(): void {
    const w = Math.ceil(this.width * this.scale);
    const h = Math.ceil(this.height * this.scale);

    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;

    this.ctx = this.canvas.getContext("2d")!;
    if (this.scale !== 1) {
      this.ctx.scale(this.scale, this.scale);
    }
    this.pendingImages = [];

    // White background
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  drawPolygon(points: Quad, style: Style): void {
    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);

    if (!fill && !stroke) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyOpacity(ctx, style);

    // Border-radius for axis-aligned rectangles
    const radius = parseBorderRadius(style.borderRadius);
    if (radius > 0 && isAxisAlignedRect(points)) {
      this.drawRoundedRect(points, radius, fill, stroke, style);
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < 4; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();

    this.fillAndStroke(ctx, points, fill, stroke, style);
    ctx.restore();
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    if (points.length < 2) return;

    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);

    if (!fill && !stroke) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyOpacity(ctx, style);

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (closed) ctx.closePath();

    if (closed && fill) {
      const grad = this.createGradient(ctx, null, style.backgroundImage);
      ctx.fillStyle = grad ?? fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.stroke();
    }

    ctx.restore();
  }

  drawText(quad: Quad, text: string, style: Style): void {
    const sanitized = text.replace(/\s+/g, " ").trim();
    if (!sanitized) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyOpacity(ctx, style);

    // Compute font size from quad height
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const fontSize = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    const fontWeight = style.fontWeight ?? "normal";
    const fontStyle = style.fontStyle ?? "normal";
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "sans-serif";

    // Build CSS font string
    const fontParts: string[] = [];
    if (fontStyle !== "normal") fontParts.push(fontStyle);
    if (fontWeight !== "normal" && fontWeight !== "400") fontParts.push(fontWeight);
    fontParts.push(`${fontSize}px`);
    fontParts.push(fontFamily);
    ctx.font = fontParts.join(" ");

    // Text color
    const textColor = parseColor(style.color) ?? parseColor(style.fill) ?? "#000000";
    ctx.fillStyle = textColor;

    // Compute rotation from quad top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);

    // Position: baseline at bottom-left of quad
    ctx.textBaseline = "alphabetic";

    if (Math.abs(angle) > 0.01) {
      ctx.translate(quad[3].x, quad[3].y);
      ctx.rotate(angle);
      ctx.fillText(sanitized, 0, 0);
    } else {
      ctx.fillText(sanitized, quad[3].x, quad[3].y);
    }

    ctx.restore();
  }

  drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): void {
    this.pendingImages.push({ quad, dataUrl, width, height, style });
  }

  end(): PNGResult {
    return new PNGResult(this.canvas, this.ctx, this.pendingImages);
  }

  // ── Private helpers ─────────────────────────────────────────────

  private applyOpacity(ctx: CanvasRenderingContext2D, style: Style): void {
    if (style.opacity !== undefined && style.opacity < 1) {
      ctx.globalAlpha = style.opacity;
    }
  }

  private fillAndStroke(
    ctx: CanvasRenderingContext2D,
    points: Quad | null,
    fill: string | null,
    stroke: { color: string; width: number } | null,
    style: Style,
  ): void {
    if (fill) {
      const grad = points ? this.createGradient(ctx, points, style.backgroundImage) : null;
      ctx.fillStyle = grad ?? fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.stroke();
    }
  }

  private drawRoundedRect(
    points: Quad,
    radius: number,
    fill: string | null,
    stroke: { color: string; width: number } | null,
    style: Style,
  ): void {
    const ctx = this.ctx;
    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const r = Math.min(radius, w / 2, h / 2);

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();

    this.fillAndStroke(ctx, points, fill, stroke, style);
  }

  private createGradient(
    ctx: CanvasRenderingContext2D,
    points: Quad | null,
    backgroundImage: string | undefined,
  ): CanvasGradient | null {
    const gradient = parseGradient(backgroundImage);
    if (!gradient || !points) return null;

    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x) || 1;
    const h = Math.abs(points[3].y - points[0].y) || 1;
    const cx = x + w / 2;
    const cy = y + h / 2;

    let canvasGrad: CanvasGradient;

    if (gradient.type === "linear") {
      const angleRad = ((gradient.angleDeg - 90) * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const halfDiag = Math.abs(w * cos) / 2 + Math.abs(h * sin) / 2;
      canvasGrad = ctx.createLinearGradient(
        cx - cos * halfDiag,
        cy - sin * halfDiag,
        cx + cos * halfDiag,
        cy + sin * halfDiag,
      );
    } else {
      const r = Math.max(w, h) / 2;
      canvasGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    }

    for (const stop of gradient.stops) {
      try {
        canvasGrad.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
      } catch {
        // skip invalid color stops
      }
    }

    return canvasGrad;
  }
}
