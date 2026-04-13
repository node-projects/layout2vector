/**
 * Image Writer using Canvas 2D API.
 * Maps IR nodes to Canvas 2D drawing operations and produces a raster image
 * (PNG, JPEG, or WebP).
 *
 * Returns an ImageResult from end(). Call `await result.finalize()` then
 * `result.toDataURL()` or `result.toBytes()` to get the final image.
 *
 * Requires a Canvas-capable environment (browser with document.createElement).
 */
import type { Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath } from "../geometry.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";
import { getVisibleCssColorString } from "./shared/css-color.js";
import { extractFirstGradient, findFirstTopLevelComma, parseGradientAngle, splitTopLevelCommaSeparated } from "./shared/gradient-utils.js";
import { getVisibleStroke, isAxisAlignedRect, parseMinDimensionBorderRadius } from "./shared/writer-utils.js";

// ── Color parsing ───────────────────────────────────────────────────

// ── Gradient parsing ────────────────────────────────────────────────

interface GradientStop { offset: number; color: string; }
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; repeating: boolean; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; repeating: boolean; }
interface ConicGradient { type: "conic"; fromAngleDeg: number; stops: GradientStop[]; }
type ParsedGradient = LinearGradient | RadialGradient | ConicGradient;

function parseColorStops(argsStr: string): GradientStop[] {
  const stops: GradientStop[] = [];
  const parts = splitTopLevelCommaSeparated(argsStr);

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

/** Extract ALL gradient strings from a backgroundImage value (CSS layer order: first = top). */
function extractAllGradients(bgImage: string): string[] {
  const gradients: string[] = [];
  const re = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bgImage)) !== null) {
    let depth = 0;
    const start = m.index;
    for (let i = start; i < bgImage.length; i++) {
      if (bgImage[i] === "(") depth++;
      else if (bgImage[i] === ")") {
        depth--;
        if (depth === 0) {
          gradients.push(bgImage.slice(start, i + 1));
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return gradients;
}

function parseGradient(bgImage: string | undefined): ParsedGradient | null {
  if (!bgImage || bgImage === "none") return null;
  const gradientStr = extractFirstGradient(bgImage);
  if (!gradientStr) return null;

  const linearMatch = gradientStr.match(/^(repeating-)?linear-gradient\((.+)\)$/);
  if (linearMatch) {
    const repeating = !!linearMatch[1];
    const inner = linearMatch[2];
    const splitIdx = findFirstTopLevelComma(inner);
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
      const splitIdx = findFirstTopLevelComma(inner);
      if (splitIdx >= 0) stopsStr = inner.slice(splitIdx + 1);
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

// ── Image Result ────────────────────────────────────────────────────

/**
 * Holds the rendered image canvas.
 * Call `finalize()` to draw any pending images (async), then
 * `toDataURL()` or `toBytes()` to get the image output.
 */
export class ImageResult {
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

    // Apply clip bounds from ancestor with overflow:hidden
    const clip = img.style.clipBounds;
    if (clip) {
      ctx.beginPath();
      if (clip.radius > 0) {
        const r = Math.min(clip.radius, clip.w / 2, clip.h / 2);
        ctx.moveTo(clip.x + r, clip.y);
        ctx.lineTo(clip.x + clip.w - r, clip.y);
        ctx.arcTo(clip.x + clip.w, clip.y, clip.x + clip.w, clip.y + r, r);
        ctx.lineTo(clip.x + clip.w, clip.y + clip.h - r);
        ctx.arcTo(clip.x + clip.w, clip.y + clip.h, clip.x + clip.w - r, clip.y + clip.h, r);
        ctx.lineTo(clip.x + r, clip.y + clip.h);
        ctx.arcTo(clip.x, clip.y + clip.h, clip.x, clip.y + clip.h - r, r);
        ctx.lineTo(clip.x, clip.y + r);
        ctx.arcTo(clip.x, clip.y, clip.x + r, clip.y, r);
        ctx.closePath();
      } else {
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
      }
      ctx.clip();
    }

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
      const ir = img.style.imageRendering;
      if (ir === "pixelated" || ir === "crisp-edges" || ir === "-moz-crisp-edges") {
        ctx.imageSmoothingEnabled = false;
      }
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

  /**
   * Get the image as a data URL string.
   * @param mimeType  Output format: "image/png" (default), "image/jpeg", or "image/webp".
   * @param quality   Quality for lossy formats (0–1). Only applies to "image/jpeg" and "image/webp".
   */
  toDataURL(mimeType = "image/png", quality?: number): string {
    return this.canvas.toDataURL(mimeType, quality);
  }

  /**
   * Get the image as a Uint8Array of raw bytes.
   * @param mimeType  Output format: "image/png" (default), "image/jpeg", or "image/webp".
   * @param quality   Quality for lossy formats (0–1). Only applies to "image/jpeg" and "image/webp".
   */
  toBytes(mimeType = "image/png", quality?: number): Uint8Array {
    const dataUrl = this.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

// ── Image Writer ────────────────────────────────────────────────────

/** Options for the image writer. */
export type ImageWriterOptions = {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Device pixel ratio / resolution multiplier. */
  scale?: number;
  /** Scale factor applied to width and height. */
  zoom?: number;
};

export class ImageWriter implements Writer<ImageResult> {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private scale: number;
  private pendingImages: PendingImage[] = [];

  /**
   * @param optionsOrWidth Options object, or canvas width in CSS pixels (positional form).
   * @param height Canvas height in CSS pixels (positional form).
   * @param scale  Device pixel ratio / resolution multiplier (positional form).
   * @param zoom   Scale factor applied to width and height (positional form).
   */
  constructor(optionsOrWidth: ImageWriterOptions | number, height?: number, scale?: number, zoom?: number) {
    if (typeof optionsOrWidth === "object") {
      const z = optionsOrWidth.zoom ?? 1;
      this.width = optionsOrWidth.width * z;
      this.height = optionsOrWidth.height * z;
      this.scale = optionsOrWidth.scale ?? 1;
    } else {
      const z = zoom ?? 1;
      this.width = optionsOrWidth * z;
      this.height = (height ?? 0) * z;
      this.scale = scale ?? 1;
    }
  }

  async begin(): Promise<void> {
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

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const fill = getVisibleCssColorString(style.fill);
    const stroke = getVisibleStroke(style, getVisibleCssColorString);

    if (!fill && !stroke && !style.boxShadow) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyClipBounds(ctx, style);
    this.applyOpacity(ctx, style);

    // Draw outer (drop) shadows before the shape
    this.drawBoxShadows(ctx, points, style, false);

    // Border-radius for axis-aligned rectangles
    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const radius = parseMinDimensionBorderRadius(style.borderRadius, w, h);
    if (radius > 0 && isAxisAlignedRect(points)) {
      this.drawRoundedRect(points, radius, fill, stroke, style);
      // Draw inset shadows after fill
      this.drawBoxShadows(ctx, points, style, true);
      ctx.restore();
      return;
    }

    // Non-axis-aligned quad with border-radius → rounded quad path
    if (radius > 0) {
      const edgeW = Math.sqrt((points[1].x - points[0].x) ** 2 + (points[1].y - points[0].y) ** 2);
      const edgeH = Math.sqrt((points[3].x - points[0].x) ** 2 + (points[3].y - points[0].y) ** 2);
      const r = parseMinDimensionBorderRadius(style.borderRadius, edgeW, edgeH);
      if (r > 0) {
        const segs = roundedQuadPath(points, r);
        ctx.beginPath();
        for (const s of segs) {
          switch (s.type) {
            case "M": ctx.moveTo(s.x, s.y); break;
            case "L": ctx.lineTo(s.x, s.y); break;
            case "Q": ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y); break;
          }
        }
        ctx.closePath();
        this.fillAndStroke(ctx, points, fill, stroke, style);
        this.drawBoxShadows(ctx, points, style, true);
        ctx.restore();
        return;
      }
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < 4; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();

    this.fillAndStroke(ctx, points, fill, stroke, style);
    // Draw inset shadows after fill
    this.drawBoxShadows(ctx, points, style, true);
    ctx.restore();
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    if (points.length < 2) return;

    const fill = getVisibleCssColorString(style.fill);
    const stroke = getVisibleStroke(style, getVisibleCssColorString);

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
      this.applyDashArray(ctx, style, stroke.width);
      ctx.stroke();
    }

    ctx.restore();
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    const sanitized = normalizeWhitespaceAwareText(text, style);
    if (sanitized.length === 0) return;

    const ctx = this.ctx;
    ctx.save();
    this.applyClipBounds(ctx, style);
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
    const textColor = getVisibleCssColorString(style.color) ?? getVisibleCssColorString(style.fill) ?? "#000000";
    ctx.fillStyle = textColor;

    // Compute rotation from quad top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);
    const topEdge = Math.sqrt(dx * dx + dy * dy);

    // Position: em-square top (quad[0] offset by half-leading toward quad[3])
    ctx.textBaseline = "top";
    const halfLeading = Math.max(0, (quadHeight - fontSize) / 2);
    const tHL = quadHeight > 0 ? halfLeading / quadHeight : 0;
    const emTopX = quad[0].x + (quad[3].x - quad[0].x) * tHL;
    const emTopY = quad[0].y + (quad[3].y - quad[0].y) * tHL;

    // Apply text shadow before drawing text
    this.applyTextShadow(ctx, style);

    if (Math.abs(angle) > 0.01) {
      ctx.translate(emTopX, emTopY);
      ctx.rotate(angle);
      ctx.fillText(sanitized, 0, 0);

      // Draw text decorations (underline / line-through)
      ctx.shadowColor = "transparent"; // don't shadow the decoration lines
      this.drawTextDecoration(ctx, style, 0, 0, topEdge, fontSize, textColor);
    } else {
      ctx.fillText(sanitized, emTopX, emTopY);

      // Draw text decorations (underline / line-through)
      ctx.shadowColor = "transparent";
      this.drawTextDecoration(ctx, style, emTopX, emTopY, topEdge, fontSize, textColor);
    }

    ctx.restore();
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): Promise<void> {
    this.pendingImages.push({ quad, dataUrl, width, height, style });
  }

  async end(): Promise<ImageResult> {
    return new ImageResult(this.canvas, this.ctx, this.pendingImages);
  }

  // ── Private helpers ─────────────────────────────────────────────

  private applyOpacity(ctx: CanvasRenderingContext2D, style: Style): void {
    if (style.opacity !== undefined && style.opacity < 1) {
      ctx.globalAlpha = style.opacity;
    }
  }

  /** Apply clip bounds from an ancestor with overflow:hidden + border-radius. */
  private applyClipBounds(ctx: CanvasRenderingContext2D, style: Style): void {
    const clip = style.clipBounds;
    if (!clip) return;
    ctx.beginPath();
    if (clip.radius > 0) {
      this.traceRoundedRect(ctx, clip.x, clip.y, clip.w, clip.h, Math.min(clip.radius, clip.w / 2, clip.h / 2));
    } else {
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
    }
    ctx.clip();
  }

  private fillAndStroke(
    ctx: CanvasRenderingContext2D,
    points: Quad | null,
    fill: string | null,
    stroke: { color: string; width: number } | null,
    style: Style,
  ): void {
    if (fill) {
      // Render multiple background layers (CSS order: first = top, last = bottom)
      const allGrads = points ? this.createAllGradients(ctx, points, style.backgroundImage) : [];
      if (allGrads.length > 0) {
        // First draw solid fill as base
        ctx.fillStyle = fill;
        ctx.fill();
        // Then draw gradients bottom-to-top (reverse of CSS order)
        for (let i = allGrads.length - 1; i >= 0; i--) {
          ctx.fillStyle = allGrads[i];
          ctx.fill();
        }
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
      }
    }
    if (points && this.hasMixedBorders(style)) {
      this.drawPerSideBorders(ctx, points, style);
    } else if (stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      this.applyDashArray(ctx, style, stroke.width);
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

  /** Create canvas gradients for ALL background layers. */
  private createAllGradients(
    ctx: CanvasRenderingContext2D,
    points: Quad,
    backgroundImage: string | undefined,
  ): CanvasGradient[] {
    if (!backgroundImage || backgroundImage === "none") return [];
    const gradStrs = extractAllGradients(backgroundImage);
    if (gradStrs.length === 0) return [];

    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x) || 1;
    const h = Math.abs(points[3].y - points[0].y) || 1;

    const result: CanvasGradient[] = [];
    for (const gs of gradStrs) {
      const parsed = parseGradient(gs);
      if (!parsed) continue;
      const cg = this.buildCanvasGradient(ctx, parsed, x, y, w, h);
      if (cg) result.push(cg);
    }
    return result;
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

    let validStops = 0;
    for (const stop of stops) {
      try {
        canvasGrad.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
        validStops++;
      } catch {
        // skip invalid color stops
      }
    }

    return validStops >= 2 ? canvasGrad : null;
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

  private applyDashArray(ctx: CanvasRenderingContext2D, style: Style, strokeWidth?: number): void {
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      const dashes = style.strokeDasharray.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n >= 0);
      if (dashes.length > 0) {
        ctx.setLineDash(dashes);
        return;
      }
    }
    // CSS border-style: dashed/dotted
    const w = strokeWidth ?? 1;
    const bs = style.borderTopStyle;
    if (bs === "dashed") {
      ctx.setLineDash([w * 3, w * 3]);
    } else if (bs === "dotted") {
      ctx.setLineDash([w, w]);
      ctx.lineCap = "round";
    }
  }

  private drawBoxShadows(ctx: CanvasRenderingContext2D, points: Quad, style: Style, insetOnly: boolean): void {
    const shadows = parseBoxShadow(style.boxShadow);
    if (shadows.length === 0) return;

    const isAARect = isAxisAlignedRect(points);
    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const radius = parseMinDimensionBorderRadius(style.borderRadius, w, h);
    const r = isAARect ? Math.min(radius, w / 2, h / 2) : 0;

    for (const shadow of shadows) {
      // Skip shadows that don't match the requested phase
      if (shadow.inset !== insetOnly) continue;
      if (shadow.inset) {
        // The inset-shadow emulation below relies on an axis-aligned inner cutout.
        // Transformed quads leak the temporary black stencil into the clipped area,
        // so skip inset shadows for those shapes instead of rendering artifacts.
        if (!isAARect) continue;

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
        // Use fully opaque fill so canvas shadow is generated at full intensity
        ctx.fillStyle = "rgba(0,0,0,1)";

        // Draw a frame around the shape (the shadow renders inward from it)
        const pad = Math.max(shadow.blur, 50) + Math.abs(shadow.spread) + 100;
        ctx.beginPath();
        ctx.rect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
        // Cut out a smaller rect (shadow emanates inward from these edges)
        // For inset: positive spread → shadow larger → inner cutout smaller
        if (r > 0) {
          this.traceRoundedRect(ctx, x + shadow.spread, y + shadow.spread, w - 2 * shadow.spread, h - 2 * shadow.spread, r);
        } else {
          ctx.rect(x + shadow.spread, y + shadow.spread, w - 2 * shadow.spread, h - 2 * shadow.spread);
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

  private applyTextShadow(ctx: CanvasRenderingContext2D, style: Style): void {
    if (!style.textShadow || style.textShadow === "none") return;
    // Parse text-shadow: offsetX offsetY blur color
    const ts = style.textShadow;
    // Extract color first (rgba/rgb or hex)
    let color = "rgba(0,0,0,0.3)";
    let numericPart = ts;
    const rgbaMatch = ts.match(/rgba?\([^)]+\)/);
    if (rgbaMatch) {
      color = rgbaMatch[0];
      numericPart = ts.replace(rgbaMatch[0], "").trim();
    } else {
      const hexMatch = ts.match(/#[0-9a-fA-F]{3,8}/);
      if (hexMatch) {
        color = hexMatch[0];
        numericPart = ts.replace(hexMatch[0], "").trim();
      }
    }
    const nums = numericPart.match(/-?[\d.]+px/g)?.map(s => parseFloat(s)) ?? [];
    if (nums.length >= 2) {
      ctx.shadowOffsetX = nums[0];
      ctx.shadowOffsetY = nums[1];
      ctx.shadowBlur = nums[2] ?? 0;
      ctx.shadowColor = color;
    }
  }

  private drawTextDecoration(
    ctx: CanvasRenderingContext2D,
    style: Style,
    textX: number,
    baselineY: number,
    textWidth: number,
    fontSize: number,
    color: string,
  ): void {
    const dec = style.textDecoration;
    if (!dec || dec === "none") return;

    // Measure actual text width for accurate line placement
    const measuredWidth = Math.min(textWidth, ctx.measureText("").width || textWidth);
    const lineWidth = Math.max(1, fontSize / 14);

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);  // solid line

    if (dec.includes("underline")) {
      const y = baselineY + fontSize * 0.15;
      ctx.beginPath();
      ctx.moveTo(textX, y);
      ctx.lineTo(textX + textWidth, y);
      ctx.stroke();
    }
    if (dec.includes("line-through")) {
      // Line-through at ~40% above baseline (middle of x-height)
      const y = baselineY - fontSize * 0.3;
      ctx.beginPath();
      ctx.moveTo(textX, y);
      ctx.lineTo(textX + textWidth, y);
      ctx.stroke();
    }
    if (dec.includes("overline")) {
      const y = baselineY - fontSize * 0.85;
      ctx.beginPath();
      ctx.moveTo(textX, y);
      ctx.lineTo(textX + textWidth, y);
      ctx.stroke();
    }
  }

  /** Check if borders have different colors/widths/styles per side, requiring per-side drawing. */
  private hasMixedBorders(style: Style): boolean {
    // Don't use per-side drawing for rounded rects (corners need arcs)
    if (style.borderRadius && style.borderRadius !== "0px" && style.borderRadius !== "0%") return false;

    const sides = [
      { c: style.borderTopColor, w: style.borderTopWidth, s: style.borderTopStyle },
      { c: style.borderRightColor, w: style.borderRightWidth, s: style.borderRightStyle },
      { c: style.borderBottomColor, w: style.borderBottomWidth, s: style.borderBottomStyle },
      { c: style.borderLeftColor, w: style.borderLeftWidth, s: style.borderLeftStyle },
    ];

    if (!sides[0].s) return false;
    if (sides.some(s => s.s === "double")) return true;

    const ref = sides[0];
    return sides.some(s => s.c !== ref.c || s.w !== ref.w || s.s !== ref.s);
  }

  /** Draw each border side independently with its own color, width, and style. */
  private drawPerSideBorders(ctx: CanvasRenderingContext2D, points: Quad, style: Style): void {
    const sides: Array<{
      from: Point; to: Point;
      color?: string; width?: string; borderStyle?: string;
    }> = [
      { from: points[0], to: points[1], color: style.borderTopColor, width: style.borderTopWidth, borderStyle: style.borderTopStyle },
      { from: points[1], to: points[2], color: style.borderRightColor, width: style.borderRightWidth, borderStyle: style.borderRightStyle },
      { from: points[2], to: points[3], color: style.borderBottomColor, width: style.borderBottomWidth, borderStyle: style.borderBottomStyle },
      { from: points[3], to: points[0], color: style.borderLeftColor, width: style.borderLeftWidth, borderStyle: style.borderLeftStyle },
    ];

    for (const side of sides) {
      const color = getVisibleCssColorString(side.color);
      const w = side.width ? parseFloat(side.width) : 0;
      if (!color || w <= 0 || !side.borderStyle || side.borderStyle === "none" || side.borderStyle === "hidden") continue;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.setLineDash([]);

      if (side.borderStyle === "dashed") {
        ctx.setLineDash([w * 3, w * 3]);
      } else if (side.borderStyle === "dotted") {
        ctx.setLineDash([w, w]);
        ctx.lineCap = "round";
      } else if (side.borderStyle === "double" && w >= 3) {
        const lineW = Math.max(1, w / 3);
        ctx.lineWidth = lineW;
        const dx = side.to.x - side.from.x;
        const dy = side.to.y - side.from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          // Inward normal for clockwise winding
          const nx = -dy / len;
          const ny = dx / len;
          const off = w / 3;
          // Outer line
          ctx.beginPath();
          ctx.moveTo(side.from.x - nx * off, side.from.y - ny * off);
          ctx.lineTo(side.to.x - nx * off, side.to.y - ny * off);
          ctx.stroke();
          // Inner line
          ctx.beginPath();
          ctx.moveTo(side.from.x + nx * off, side.from.y + ny * off);
          ctx.lineTo(side.to.x + nx * off, side.to.y + ny * off);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(side.from.x, side.from.y);
      ctx.lineTo(side.to.x, side.to.y);
      ctx.stroke();
      ctx.restore();
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

// ── Backward-compatible aliases ─────────────────────────────────────

/** @deprecated Use `ImageResult` instead. */
export const PNGResult = ImageResult;
/** @deprecated Use `ImageWriter` instead. */
export const PNGWriter = ImageWriter;
/** @deprecated Use `ImageWriterOptions` instead. */
export type PNGWriterOptions = ImageWriterOptions;
