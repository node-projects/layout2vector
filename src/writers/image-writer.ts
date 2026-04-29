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
import type { ClipQuad, Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath } from "../geometry.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";
import { getVisibleCssColorString, parseCssColor, type ParsedCssColor } from "./shared/css-color.js";
import {
  expandRepeatingGradientStops,
  normalizeGradientStopOffsets,
  parseAllGradientsAst,
  parseGradientAst,
  type GradientStopAst,
  type ParsedGradientAst,
} from "./shared/gradient-utils.js";
import { getCssCanvasFilter, mapMixBlendModeToCanvasComposite } from "./shared/filter-effects.js";
import { parseClipPathShape, type ClipPathShape } from "./shared/clip-path.js";
import { getVisibleStroke, isAxisAlignedRect, parseMinDimensionBorderRadius } from "./shared/writer-utils.js";

// ── Color parsing ───────────────────────────────────────────────────

// ── Gradient parsing ────────────────────────────────────────────────

interface GradientStop { offset: number; color: string; }
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; repeating: boolean; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; repeating: boolean; }
interface ConicGradient { type: "conic"; fromAngleDeg: number; stops: GradientStop[]; repeating: boolean; }
type ParsedGradient = LinearGradient | RadialGradient | ConicGradient;

function applyRenderEffects(ctx: CanvasRenderingContext2D, style: Style): void {
  const filter = getCssCanvasFilter(style.filter);
  if (filter && "filter" in ctx) {
    ctx.filter = filter;
  }

  const composite = mapMixBlendModeToCanvasComposite(style.mixBlendMode);
  if (composite) {
    ctx.globalCompositeOperation = composite;
  }
}

function normalizeFontFamily(fontFamily: string | undefined, fallback: string): string {
  const normalized = fontFamily?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function formatCssColor(color: ParsedCssColor): string {
  if (color.a >= 0.999) return `rgb(${color.r}, ${color.g}, ${color.b})`;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Number(color.a.toFixed(3))})`;
}

function interpolateGradientColor(t: number, stops: GradientStop[], repeating = false): string {
  const parsedStops = stops
    .map((stop) => ({ ...stop, parsed: parseCssColor(stop.color) }))
    .filter((stop): stop is GradientStop & { parsed: ParsedCssColor } => !!stop.parsed)
    .sort((left, right) => left.offset - right.offset);

  if (parsedStops.length === 0) return stops[0]?.color ?? "transparent";
  const maxOffset = parsedStops[parsedStops.length - 1].offset;
  if (repeating && maxOffset > 0 && maxOffset < 0.999999) {
    t = ((t % maxOffset) + maxOffset) % maxOffset;
  }
  if (t <= parsedStops[0].offset) return formatCssColor(parsedStops[0].parsed);
  if (t >= parsedStops[parsedStops.length - 1].offset) return formatCssColor(parsedStops[parsedStops.length - 1].parsed);

  for (let i = 0; i < parsedStops.length - 1; i++) {
    const start = parsedStops[i];
    const end = parsedStops[i + 1];
    if (t < start.offset || t > end.offset) continue;
    const range = end.offset - start.offset;
    const fraction = range > 0 ? (t - start.offset) / range : 0;
    return formatCssColor({
      r: Math.round(start.parsed.r + (end.parsed.r - start.parsed.r) * fraction),
      g: Math.round(start.parsed.g + (end.parsed.g - start.parsed.g) * fraction),
      b: Math.round(start.parsed.b + (end.parsed.b - start.parsed.b) * fraction),
      a: start.parsed.a + (end.parsed.a - start.parsed.a) * fraction,
    });
  }

  return formatCssColor(parsedStops[parsedStops.length - 1].parsed);
}

function traceClipQuadPath(ctx: CanvasRenderingContext2D, clipQuad: ClipQuad): void {
  if (clipQuad.radius > 0) {
    const segments = roundedQuadPath(clipQuad.points, clipQuad.radius);
    ctx.beginPath();
    for (const segment of segments) {
      switch (segment.type) {
        case "M":
          ctx.moveTo(segment.x, segment.y);
          break;
        case "L":
          ctx.lineTo(segment.x, segment.y);
          break;
        case "Q":
          ctx.quadraticCurveTo(segment.cx, segment.cy, segment.x, segment.y);
          break;
      }
    }
    ctx.closePath();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(clipQuad.points[0].x, clipQuad.points[0].y);
  for (let index = 1; index < clipQuad.points.length; index++) {
    ctx.lineTo(clipQuad.points[index].x, clipQuad.points[index].y);
  }
  ctx.closePath();
}

function resolveGradientStops(stopsAst: GradientStopAst<string>[]): GradientStop[] {
  const stops = stopsAst.map((stop) => ({
    color: stop.color,
    offset: stop.unit === "auto" ? -1 : stop.offset,
  }));

  if (stops.length === 0) return stops;
  if (stopsAst.some((stop) => stop.unit === "px")) {
    for (let index = 0; index < stops.length; index += 1) {
      if (stopsAst[index].unit === "auto") stops[index].offset = 0;
    }
    return stops;
  }

  return normalizeGradientStopOffsets(stops);
}

function toCanvasGradient(gradient: ParsedGradientAst<string>): ParsedGradient {
  const stops = resolveGradientStops(gradient.stops);
  if (gradient.type === "linear") return { ...gradient, stops };
  if (gradient.type === "radial") return { ...gradient, stops };
  return { ...gradient, stops };
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

type Bounds = { x: number; y: number; w: number; h: number };

function quadBounds(quad: Quad): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of quad) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function parseClipLength(token: string, reference: number): number {
  const value = token.trim().toLowerCase();
  if (!value) return 0;
  if (value.endsWith("%")) {
    return (parseFloat(value) / 100) * reference;
  }
  const numeric = parseFloat(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function expandInsetValues(values: string[]): [string, string, string, string] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0], values[1], values[2], values[3]];
}

function traceCanvasClipPath(ctx: CanvasRenderingContext2D, shape: ClipPathShape): CanvasFillRule {
  ctx.beginPath();

  switch (shape.kind) {
    case "inset":
      if (shape.rx > 0 || shape.ry > 0) {
        const rx = Math.min(shape.rx, shape.w / 2);
        const ry = Math.min(shape.ry, shape.h / 2);
        ctx.moveTo(shape.x + rx, shape.y);
        ctx.lineTo(shape.x + shape.w - rx, shape.y);
        ctx.ellipse(shape.x + shape.w - rx, shape.y + ry, rx, ry, 0, -Math.PI / 2, 0);
        ctx.lineTo(shape.x + shape.w, shape.y + shape.h - ry);
        ctx.ellipse(shape.x + shape.w - rx, shape.y + shape.h - ry, rx, ry, 0, 0, Math.PI / 2);
        ctx.lineTo(shape.x + rx, shape.y + shape.h);
        ctx.ellipse(shape.x + rx, shape.y + shape.h - ry, rx, ry, 0, Math.PI / 2, Math.PI);
        ctx.lineTo(shape.x, shape.y + ry);
        ctx.ellipse(shape.x + rx, shape.y + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
        ctx.closePath();
      } else {
        ctx.rect(shape.x, shape.y, shape.w, shape.h);
      }
      break;
    case "ellipse":
      ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
      break;
    case "polygon":
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let index = 1; index < shape.points.length; index += 1) ctx.lineTo(shape.points[index].x, shape.points[index].y);
      ctx.closePath();
      break;
    case "path":
      for (const subpath of shape.subpaths) {
        if (subpath.points.length === 0) continue;
        ctx.moveTo(subpath.points[0].x, subpath.points[0].y);
        for (let index = 1; index < subpath.points.length; index += 1) {
          ctx.lineTo(subpath.points[index].x, subpath.points[index].y);
        }
        ctx.closePath();
      }
      break;
  }

  return shape.fillRule === "evenodd" ? "evenodd" : "nonzero";
}

function tracePolylinePath(ctx: CanvasRenderingContext2D, points: Point[], closed: boolean, style: Style): void {
  const subpaths = style.pathSubpaths;
  if (subpaths?.length) {
    for (const subpath of subpaths) {
      if (subpath.points.length === 0) continue;
      ctx.moveTo(subpath.points[0].x, subpath.points[0].y);
      for (let index = 1; index < subpath.points.length; index += 1) {
        ctx.lineTo(subpath.points[index].x, subpath.points[index].y);
      }
      if (subpath.closed) ctx.closePath();
    }
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }
  if (closed) ctx.closePath();
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
  ) {}

  /** Load and draw pending raster images onto the canvas. */
  async finalize(): Promise<void> {
    return Promise.resolve();
  }

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

  private applyClipQuads(ctx: CanvasRenderingContext2D, style: Style): void {
    if (!style.clipQuads?.length) return;

    for (const clipQuad of style.clipQuads) {
      traceClipQuadPath(ctx, clipQuad);
      ctx.clip();
    }
  }

  private applyClipPath(ctx: CanvasRenderingContext2D, bounds: Bounds, style: Style): void {
    const clipPath = style.clipPath?.trim();
    if (!clipPath || clipPath === "none") return;

    const fillRule = this.traceClipPath(ctx, clipPath, bounds);
    if (fillRule) ctx.clip(fillRule);
  }

  private applyBorderRadiusClip(ctx: CanvasRenderingContext2D, quad: Quad, style: Style): void {
    const topEdge = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const leftEdge = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    const radius = Math.min(
      parseMinDimensionBorderRadius(style.borderRadius, topEdge, leftEdge),
      topEdge / 2,
      leftEdge / 2,
    );
    if (!Number.isFinite(radius) || radius <= 0) return;

    traceClipQuadPath(ctx, { points: quad, radius });
    ctx.clip();
  }

  private traceClipPath(ctx: CanvasRenderingContext2D, clipPath: string, bounds: Bounds): CanvasFillRule | null {
    const shape = parseClipPathShape(clipPath, bounds);
    return shape ? traceCanvasClipPath(ctx, shape) : null;
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

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}

// ── Image Writer ────────────────────────────────────────────────────

/** Options for the image writer. */
export type ImageWriterOptions = {
  /** Canvas width in CSS pixels. */
  width: number;
  /** Canvas height in CSS pixels. */
  height: number;
  /** Optional existing canvas to render into. */
  canvas?: HTMLCanvasElement;
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
  private targetCanvas?: HTMLCanvasElement;

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
      this.targetCanvas = optionsOrWidth.canvas;
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

    this.canvas = this.targetCanvas ?? document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;

    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

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
    this.applyClipQuads(ctx, style);
    this.applyClipBounds(ctx, style);
    this.applyClipPath(ctx, quadBounds(points), style);
    this.applyOpacity(ctx, style);
    applyRenderEffects(ctx, style);

    // Draw outer (drop) shadows before the shape
    this.drawBoxShadows(ctx, points, style, false);

    // Border-radius for axis-aligned rectangles
    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const radius = parseMinDimensionBorderRadius(style.borderRadius, w, h);
    if (radius > 0 && isAxisAlignedRect(points) && !style.cornerShapes) {
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
        const segs = roundedQuadPath(points, r, style.cornerShapes);
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
    this.applyClipQuads(ctx, style);
    this.applyClipBounds(ctx, style);
    this.applyClipPath(ctx, this.computeBoundingBox(points), style);
    this.applyOpacity(ctx, style);
    applyRenderEffects(ctx, style);

    ctx.beginPath();
    tracePolylinePath(ctx, points, closed, style);

    // Fill even for non-closed paths when fill is specified (SVG behavior)
    if (fill) {
      const bbox = this.computeBoundingBox(points);
      const grad = this.createGradientFromBBox(ctx, bbox, style.backgroundImage);
      ctx.fillStyle = grad ?? fill;
      ctx.fill(style.fillRule === "evenodd" ? "evenodd" : "nonzero");
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
    this.applyClipQuads(ctx, style);
    this.applyClipBounds(ctx, style);
    this.applyClipPath(ctx, quadBounds(quad), style);
    this.applyOpacity(ctx, style);
    applyRenderEffects(ctx, style);

    // Compute font size from quad height
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const fontSize = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    const fontWeight = style.fontWeight ?? "normal";
    const fontStyle = style.fontStyle ?? "normal";
    const fontFamily = normalizeFontFamily(style.fontFamily, "sans-serif");

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

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, _rgbData?: number[]): Promise<void> {
    const imgEl = new Image();
    imgEl.src = dataUrl;
    await new Promise<void>((resolve) => {
      imgEl.onload = () => resolve();
      imgEl.onerror = () => resolve();
    });

    if (!imgEl.naturalWidth) return;

    const ctx = this.ctx;
    ctx.save();

    this.applyClipQuads(ctx, style);
    this.applyClipBounds(ctx, style);
    this.applyClipPath(ctx, quadBounds(quad), style);
    this.applyBorderRadiusClip(ctx, quad, style);

    if (style.opacity !== undefined && style.opacity < 1) {
      ctx.globalAlpha = style.opacity;
    }
    applyRenderEffects(ctx, style);

    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const topEdge = Math.sqrt(dx * dx + dy * dy);
    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const leftEdge = Math.sqrt(ldx * ldx + ldy * ldy);

    if (topEdge > 0 && leftEdge > 0) {
      const imageRendering = style.imageRendering;
      if (imageRendering === "pixelated" || imageRendering === "crisp-edges" || imageRendering === "-moz-crisp-edges") {
        ctx.imageSmoothingEnabled = false;
      }
      const angle = Math.atan2(dy, dx);
      if (Math.abs(angle) > 0.01) {
        ctx.translate(quad[0].x, quad[0].y);
        ctx.rotate(angle);
        ctx.drawImage(imgEl, 0, 0, topEdge, leftEdge);
      } else {
        ctx.drawImage(imgEl, quad[0].x, quad[0].y, topEdge, leftEdge);
      }
    }

    ctx.restore();
  }

  async end(): Promise<ImageResult> {
    return new ImageResult(this.canvas, this.ctx);
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

  private applyClipQuads(ctx: CanvasRenderingContext2D, style: Style): void {
    if (!style.clipQuads?.length) return;

    for (const clipQuad of style.clipQuads) {
      traceClipQuadPath(ctx, clipQuad);
      ctx.clip();
    }
  }

  private applyClipPath(ctx: CanvasRenderingContext2D, bounds: Bounds, style: Style): void {
    const clipPath = style.clipPath?.trim();
    if (!clipPath || clipPath === "none") return;

    const fillRule = this.traceClipPath(ctx, clipPath, bounds);
    if (fillRule) ctx.clip(fillRule);
  }

  private applyBorderRadiusClip(ctx: CanvasRenderingContext2D, quad: Quad, style: Style): void {
    const topEdge = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const leftEdge = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    const radius = Math.min(
      parseMinDimensionBorderRadius(style.borderRadius, topEdge, leftEdge),
      topEdge / 2,
      leftEdge / 2,
    );
    if (!Number.isFinite(radius) || radius <= 0) return;

    traceClipQuadPath(ctx, { points: quad, radius });
    ctx.clip();
  }

  private traceClipPath(ctx: CanvasRenderingContext2D, clipPath: string, bounds: Bounds): CanvasFillRule | null {
    const shape = parseClipPathShape(clipPath, bounds);
    return shape ? traceCanvasClipPath(ctx, shape) : null;
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
    const gradientAst = parseGradientAst(backgroundImage);
    if (!gradientAst || !points) return null;

    const gradient = toCanvasGradient(gradientAst);

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
    const gradients = parseAllGradientsAst(backgroundImage).map(toCanvasGradient);
    if (gradients.length === 0) return [];

    const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
    const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
    const w = Math.abs(points[1].x - points[0].x) || 1;
    const h = Math.abs(points[3].y - points[0].y) || 1;

    const result: CanvasGradient[] = [];
    for (const gradient of gradients) {
      const cg = this.buildCanvasGradient(ctx, gradient, x, y, w, h);
      if (cg) result.push(cg);
    }
    return result;
  }

  private createGradientFromBBox(
    ctx: CanvasRenderingContext2D,
    bbox: { x: number; y: number; w: number; h: number },
    backgroundImage: string | undefined,
  ): CanvasGradient | null {
    const gradientAst = parseGradientAst(backgroundImage);
    if (!gradientAst) return null;
    const gradient = toCanvasGradient(gradientAst);

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
      stops = gradient.repeating
        ? expandRepeatingGradientStops(stops, (sortedStops) => ({
          offset: 1,
          color: interpolateGradientColor(1, [...sortedStops], true),
        }))
        : this.normalizeStopsToFraction(stops, 1);
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
    textTopY: number,
    textWidth: number,
    fontSize: number,
    color: string,
  ): void {
    const dec = style.textDecoration;
    if (!dec || dec === "none") return;

    const previousBaseline = ctx.textBaseline;
    ctx.textBaseline = "alphabetic";
    const metrics = ctx.measureText("Mg");
    ctx.textBaseline = previousBaseline;
    const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
    const descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
    const lineWidth = Math.max(1, fontSize / 14);
    const baselineY = textTopY + ascent;
    const overlineY = Math.max(textTopY + fontSize * 0.08, baselineY - ascent + lineWidth / 2);

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);  // solid line

    if (dec.includes("underline")) {
      const y = textTopY + fontSize - lineWidth;
      ctx.beginPath();
      ctx.moveTo(textX, y);
      ctx.lineTo(textX + textWidth, y);
      ctx.stroke();
    }
    if (dec.includes("line-through")) {
      // Line-through at ~40% above baseline (middle of x-height)
      const y = baselineY - ascent * 0.45;
      ctx.beginPath();
      ctx.moveTo(textX, y);
      ctx.lineTo(textX + textWidth, y);
      ctx.stroke();
    }
    if (dec.includes("overline")) {
      const y = overlineY;
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
