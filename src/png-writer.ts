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
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; repeating: boolean; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; repeating: boolean; }
interface ConicGradient { type: "conic"; fromAngleDeg: number; stops: GradientStop[]; }
type ParsedGradient = LinearGradient | RadialGradient | ConicGradient;

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
    const colorStr = (percentMatch || pxMatch)
      ? part.slice(0, (percentMatch || pxMatch)!.index).trim()
      : part.trim();
    if (!colorStr) continue;
    let offset = -1;
    if (percentMatch) offset = parseFloat(percentMatch[1]) / 100;
    else if (pxMatch) offset = -parseFloat(pxMatch[1]) - 2; // negative: raw px (encode as -(px+2) to distinguish from -1=unknown)
    stops.push({ offset, color: colorStr });
  }

  if (stops.length > 0) {
    // Check if all stops are in px units (offset <= -2)
    const hasPxStops = stops.some(s => s.offset <= -2);
    if (hasPxStops) {
      // Convert px stops: find the max px value and normalize to 0..1
      // The actual px values are encoded as -(px+2)
      for (const s of stops) {
        if (s.offset <= -2) {
          s.offset = -(s.offset + 2); // decode to actual px
        } else if (s.offset < 0) {
          s.offset = 0; // unknown → 0
        }
      }
      // Keep raw px values; they'll be resolved in buildCanvasGradient
      return stops;
    }

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

  const linearMatch = gradientStr.match(/^(repeating-)?linear-gradient\((.+)\)$/);
  if (linearMatch) {
    const repeating = !!linearMatch[1];
    const inner = linearMatch[2];
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
    return { type: "linear", angleDeg, stops, repeating };
  }

  const radialMatch = gradientStr.match(/^(repeating-)?radial-gradient\((.+)\)$/);
  if (radialMatch) {
    const repeating = !!radialMatch[1];
    const stops = parseColorStops(radialMatch[2]);
    if (stops.length < 2) return null;
    return { type: "radial", stops, repeating };
  }

  const conicMatch = gradientStr.match(/^conic-gradient\((.+)\)$/);
  if (conicMatch) {
    const inner = conicMatch[1];
    // Parse optional "from <angle>" prefix
    let fromAngleDeg = 0;
    let stopsStr = inner;
    const fromMatch = inner.match(/^from\s+([\d.]+)(deg|rad|turn)/i);
    if (fromMatch) {
      const val = parseFloat(fromMatch[1]);
      const unit = fromMatch[2].toLowerCase();
      fromAngleDeg = unit === "rad" ? val * (180 / Math.PI) : unit === "turn" ? val * 360 : val;
      // Find the comma after the "from" part
      let depth = 0;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "(") depth++;
        else if (inner[i] === ")") depth--;
        else if (inner[i] === "," && depth === 0) { stopsStr = inner.slice(i + 1); break; }
      }
    }
    const stops = parseColorStops(stopsStr);
    if (stops.length < 2) return null;
    return { type: "conic", fromAngleDeg, stops };
  }

  return null;
}

// ── Box shadow parsing ──────────────────────────────────────────────

interface ParsedBoxShadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
}

function parseBoxShadow(boxShadow: string | undefined): ParsedBoxShadow[] {
  if (!boxShadow || boxShadow === "none") return [];

  const shadows: ParsedBoxShadow[] = [];
  // Split on commas at depth 0 (handles rgba commas)
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of boxShadow) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const inset = /\binset\b/i.test(part);
    const cleaned = part.replace(/\binset\b/gi, "").trim();

    // Extract color (rgb/rgba/hex/named) and numeric values
    let color = "rgba(0,0,0,0.5)";
    let numericPart = cleaned;

    // Try to extract rgba/rgb color
    const rgbaMatch = cleaned.match(/rgba?\([^)]+\)/);
    if (rgbaMatch) {
      color = rgbaMatch[0];
      numericPart = cleaned.replace(rgbaMatch[0], "").trim();
    } else {
      // Try hex color
      const hexMatch = cleaned.match(/#[0-9a-fA-F]{3,8}/);
      if (hexMatch) {
        color = hexMatch[0];
        numericPart = cleaned.replace(hexMatch[0], "").trim();
      }
    }

    const nums = numericPart.match(/-?[\d.]+px/g)?.map(s => parseFloat(s)) ?? [];
    if (nums.length >= 2) {
      shadows.push({
        inset,
        offsetX: nums[0],
        offsetY: nums[1],
        blur: nums[2] ?? 0,
        spread: nums[3] ?? 0,
        color,
      });
    }
  }

  return shadows;
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

    if (!fill && !stroke && !style.boxShadow) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyOpacity(ctx, style);

    // Draw box shadows before the shape
    this.drawBoxShadows(ctx, points, style);

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

    // Fill even for non-closed paths when fill is specified (SVG behavior)
    if (fill) {
      const bbox = this.computeBoundingBox(points);
      const grad = this.createGradientFromBBox(ctx, bbox, style.backgroundImage);
      ctx.fillStyle = grad ?? fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      this.applyDashArray(ctx, style);
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
      this.applyDashArray(ctx, style);
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

    return this.buildCanvasGradient(ctx, gradient, x, y, w, h);
  }

  private createGradientFromBBox(
    ctx: CanvasRenderingContext2D,
    bbox: { x: number; y: number; w: number; h: number },
    backgroundImage: string | undefined,
  ): CanvasGradient | null {
    const gradient = parseGradient(backgroundImage);
    if (!gradient) return null;

    return this.buildCanvasGradient(ctx, gradient, bbox.x, bbox.y, bbox.w || 1, bbox.h || 1);
  }

  private buildCanvasGradient(
    ctx: CanvasRenderingContext2D,
    gradient: ParsedGradient,
    x: number,
    y: number,
    w: number,
    h: number,
  ): CanvasGradient | null {
    const cx = x + w / 2;
    const cy = y + h / 2;

    let canvasGrad: CanvasGradient;
    let stops = gradient.stops;

    if (gradient.type === "linear") {
      const angleRad = ((gradient.angleDeg - 90) * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const halfDiag = Math.abs(w * cos) / 2 + Math.abs(h * sin) / 2;
      const totalLength = halfDiag * 2;

      canvasGrad = ctx.createLinearGradient(
        cx - cos * halfDiag,
        cy - sin * halfDiag,
        cx + cos * halfDiag,
        cy + sin * halfDiag,
      );

      // Handle repeating gradients with px-based stops
      if (gradient.repeating && totalLength > 0) {
        stops = this.resolveRepeatingStops(stops, totalLength);
      } else {
        stops = this.normalizeStopsToFraction(stops, totalLength);
      }
    } else if (gradient.type === "radial") {
      const r = Math.max(w, h) / 2;
      canvasGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);

      if ((gradient as RadialGradient).repeating && r > 0) {
        stops = this.resolveRepeatingStops(stops, r);
      } else {
        stops = this.normalizeStopsToFraction(stops, r);
      }
    } else if (gradient.type === "conic") {
      canvasGrad = ctx.createConicGradient(
        (gradient.fromAngleDeg - 90) * Math.PI / 180,
        cx,
        cy,
      );
    } else {
      return null;
    }

    for (const stop of stops) {
      try {
        canvasGrad.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
      } catch {
        // skip invalid color stops
      }
    }

    return canvasGrad;
  }

  /** Convert px-based stops to fractional [0..1] stops, given the total gradient length in px. */
  private normalizeStopsToFraction(stops: GradientStop[], totalLength: number): GradientStop[] {
    // Check if any stop has large px values (not already normalized)
    const maxOffset = Math.max(...stops.map(s => s.offset));
    if (maxOffset <= 1.001) return stops; // already normalized

    return stops.map(s => ({
      color: s.color,
      offset: totalLength > 0 ? s.offset / totalLength : s.offset,
    }));
  }

  /** Expand repeating gradient stops by tiling them across the full [0..1] range. */
  private resolveRepeatingStops(stops: GradientStop[], totalLength: number): GradientStop[] {
    if (stops.length < 2 || totalLength <= 0) return stops;

    const maxOffset = Math.max(...stops.map(s => s.offset));
    // If stops are already in [0..1] range, the pattern length is the last stop offset
    const patternLength = maxOffset > 1.001 ? maxOffset : maxOffset * totalLength;
    if (patternLength <= 0) return stops;

    // Normalize source stops to [0..patternLength] range
    const srcStops = maxOffset > 1.001
      ? stops
      : stops.map(s => ({ color: s.color, offset: s.offset * totalLength }));

    const result: GradientStop[] = [];
    const repetitions = Math.ceil(totalLength / patternLength);

    for (let rep = 0; rep < repetitions; rep++) {
      const baseOffset = rep * patternLength;
      for (const s of srcStops) {
        const absOffset = baseOffset + s.offset;
        if (absOffset > totalLength + 0.01) break;
        result.push({
          color: s.color,
          offset: Math.min(absOffset / totalLength, 1),
        });
      }
    }

    return result;
  }

  private computeBoundingBox(points: Point[]): { x: number; y: number; w: number; h: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private applyDashArray(ctx: CanvasRenderingContext2D, style: Style): void {
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      const dashes = style.strokeDasharray.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n >= 0);
      if (dashes.length > 0) {
        ctx.setLineDash(dashes);
      }
    }
  }

  private drawBoxShadows(ctx: CanvasRenderingContext2D, points: Quad, style: Style): void {
    const shadows = parseBoxShadow(style.boxShadow);
    if (shadows.length === 0) return;

    const radius = parseBorderRadius(style.borderRadius);
    const isAARect = isAxisAlignedRect(points);
    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const r = isAARect ? Math.min(radius, w / 2, h / 2) : 0;

    for (const shadow of shadows) {
      if (shadow.inset) {
        // Inset shadow: draw inside the shape using clipping
        ctx.save();
        // Clip to the shape
        ctx.beginPath();
        if (r > 0) {
          this.traceRoundedRect(ctx, x, y, w, h, r);
        } else if (isAARect) {
          ctx.rect(x, y, w, h);
        } else {
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(points[i].x, points[i].y);
          ctx.closePath();
        }
        ctx.clip();

        // Draw a large box outside the element that casts a shadow inward
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = shadow.blur;
        ctx.shadowOffsetX = shadow.offsetX;
        ctx.shadowOffsetY = shadow.offsetY;
        ctx.fillStyle = shadow.color;

        // Draw a frame around the shape (the shadow renders inward from it)
        const pad = Math.max(shadow.blur, 50) + Math.abs(shadow.spread);
        ctx.beginPath();
        ctx.rect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
        // Cut out the center (the shape) so only the shadow-casting frame remains
        if (r > 0) {
          this.traceRoundedRect(ctx, x - shadow.spread, y - shadow.spread, w + 2 * shadow.spread, h + 2 * shadow.spread, r);
        } else {
          ctx.rect(x - shadow.spread, y - shadow.spread, w + 2 * shadow.spread, h + 2 * shadow.spread);
        }
        ctx.fill("evenodd");

        ctx.restore();
      } else {
        // Outer shadow: use canvas shadow on a shape drawn off-screen or via shadowColor
        ctx.save();
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = shadow.blur;
        ctx.shadowOffsetX = shadow.offsetX;
        ctx.shadowOffsetY = shadow.offsetY;

        // We need to draw the shape but not have it visible — only its shadow.
        // Move the shape far away, but offset the shadow to compensate.
        const farX = -10000;
        const farY = -10000;
        ctx.shadowOffsetX = shadow.offsetX - farX + x;
        ctx.shadowOffsetY = shadow.offsetY - farY + y;

        ctx.fillStyle = shadow.color;
        ctx.beginPath();
        if (r > 0) {
          this.traceRoundedRect(ctx, farX - shadow.spread, farY - shadow.spread, w + 2 * shadow.spread, h + 2 * shadow.spread, r);
        } else {
          ctx.rect(farX - shadow.spread, farY - shadow.spread, w + 2 * shadow.spread, h + 2 * shadow.spread);
        }
        ctx.fill();

        ctx.restore();
      }
    }
  }

  private traceRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    r = Math.min(r, w / 2, h / 2);
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
  }
}
