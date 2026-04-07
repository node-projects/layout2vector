/**
 * SVG Writer.
 * Maps IR nodes to SVG elements and produces a standalone SVG document string.
 */
import type { Point, Quad, Style, Writer } from "./types.js";

// ── Color helpers ───────────────────────────────────────────────────

function parseColor(color: string | undefined): string | null {
  if (!color || color === "transparent" || color === "none") return null;
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m && m[4] !== undefined && parseFloat(m[4]) <= 0) return null;
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

function parseBorderRadius(borderRadius: string | undefined, w?: number, h?: number): number {
  if (!borderRadius || borderRadius === "0px" || borderRadius === "0%") return 0;
  const raw = borderRadius.split(/\s+/)[0];
  if (!raw) return 0;
  if (raw.endsWith("%")) {
    const pct = parseFloat(raw);
    if (isNaN(pct) || pct <= 0) return 0;
    const ref = (w !== undefined && h !== undefined) ? Math.min(w, h) : 0;
    return (pct / 100) * ref;
  }
  const val = parseFloat(raw);
  return !isNaN(val) && val > 0 ? val : 0;
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

/** Escape text for use inside XML/SVG elements. */
function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Format a number, trimming trailing zeros. */
function n(v: number): string {
  return +v.toFixed(2) + "";
}

// ── Gradient parsing (subset of png-writer logic) ───────────────────

interface GradientStop { offset: number; color: string; }
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; }
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
    if (ch === "(") depth++; else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const percentMatch = part.match(/([\d.]+)%\s*$/);
    const colorStr = percentMatch ? part.slice(0, percentMatch.index).trim() : part.trim();
    if (!colorStr) continue;
    const offset = percentMatch ? parseFloat(percentMatch[1]) / 100 : -1;
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
  let depth = 0;
  for (let i = match.index; i < bgImage.length; i++) {
    if (bgImage[i] === "(") depth++; else if (bgImage[i] === ")") { depth--; if (depth === 0) return bgImage.slice(match.index, i + 1); }
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
    let inner = radialMatch[1];
    // Strip optional shape/size prefix (e.g. "circle", "ellipse", "closest-side", "farthest-corner at center")
    let depth = 0, splitIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "(") depth++; else if (inner[i] === ")") depth--;
      else if (inner[i] === "," && depth === 0) { splitIdx = i; break; }
    }
    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim().toLowerCase();
      if (/^(circle|ellipse|closest|farthest|at\s)/.test(firstPart)) {
        inner = inner.slice(splitIdx + 1);
      }
    }
    const stops = parseColorStops(inner);
    if (stops.length < 2) return null;
    return { type: "radial", stops };
  }

  const conicMatch = gradientStr.match(/^conic-gradient\((.+)\)$/);
  if (conicMatch) {
    const inner = conicMatch[1];
    let fromAngleDeg = 0;
    let stopsStr = inner;
    const fromMatch = inner.match(/^from\s+([\d.]+)(deg|rad|turn)/i);
    if (fromMatch) {
      const val = parseFloat(fromMatch[1]);
      const unit = fromMatch[2].toLowerCase();
      fromAngleDeg = unit === "rad" ? val * (180 / Math.PI) : unit === "turn" ? val * 360 : val;
      let depth = 0;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "(") depth++; else if (inner[i] === ")") depth--;
        else if (inner[i] === "," && depth === 0) { stopsStr = inner.slice(i + 1); break; }
      }
    }
    const stops = parseColorStops(stopsStr);
    if (stops.length < 2) return null;
    return { type: "conic", fromAngleDeg, stops };
  }
  return null;
}

// ── Box Shadow parsing ──────────────────────────────────────────────

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
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of boxShadow) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const inset = /\binset\b/i.test(part);
    const cleaned = part.replace(/\binset\b/gi, "").trim();
    let color = "rgba(0,0,0,0.5)";
    let numericPart = cleaned;
    const rgbaMatch = cleaned.match(/rgba?\([^)]+\)/);
    if (rgbaMatch) { color = rgbaMatch[0]; numericPart = cleaned.replace(rgbaMatch[0], "").trim(); }
    else {
      const hexMatch = cleaned.match(/#[0-9a-fA-F]{3,8}/);
      if (hexMatch) { color = hexMatch[0]; numericPart = cleaned.replace(hexMatch[0], "").trim(); }
    }
    const nums = numericPart.match(/-?[\d.]+px/g)?.map(s => parseFloat(s)) ?? [];
    if (nums.length >= 2) {
      shadows.push({ inset, offsetX: nums[0], offsetY: nums[1], blur: nums[2] ?? 0, spread: nums[3] ?? 0, color });
    }
  }
  return shadows;
}

// ── SVG Writer ──────────────────────────────────────────────────────

export class SVGWriter implements Writer<string> {
  private width: number;
  private height: number;
  private elements: string[] = [];
  private defs: string[] = [];
  private defIdCounter = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  begin(): void {
    this.elements = [];
    this.defs = [];
    this.defIdCounter = 0;
  }

  drawPolygon(points: Quad, style: Style): void {
    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);
    if (!fill && !stroke && !style.boxShadow) return;

    const w = Math.abs(points[1].x - points[0].x);
    const h = Math.abs(points[3].y - points[0].y);
    const radius = parseBorderRadius(style.borderRadius, w, h);

    // Outer box shadows (drop shadows via SVG filter)
    const shadows = parseBoxShadow(style.boxShadow);
    const outerShadows = shadows.filter(s => !s.inset);
    let filterId: string | undefined;
    if (outerShadows.length > 0) {
      filterId = this.addDropShadowFilter(outerShadows);
    }

    const opacity = (style.opacity !== undefined && style.opacity < 1) ? style.opacity : undefined;

    if (radius > 0 && isAxisAlignedRect(points)) {
      const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const r = Math.min(radius, w / 2, h / 2);

      const gradId = this.addGradientDef(style.backgroundImage, x, y, w, h);
      const attrs = this.buildShapeAttrs(fill, stroke, style, gradId, filterId, opacity);
      this.elements.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ry="${n(r)}"${attrs}/>`);

      // Inset shadows as clipped overlays
      this.addInsetShadows(shadows.filter(s => s.inset), x, y, w, h, r);
      return;
    }

    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + " Z";
    const x = Math.min(...points.map(p => p.x));
    const y = Math.min(...points.map(p => p.y));
    const gradId = this.addGradientDef(style.backgroundImage, x, y, w || 1, h || 1);
    const attrs = this.buildShapeAttrs(fill, stroke, style, gradId, filterId, opacity);
    this.elements.push(`<path d="${d}"${attrs}/>`);

    if (isAxisAlignedRect(points)) {
      this.addInsetShadows(shadows.filter(s => s.inset), x, y, w, h, 0);
    }
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    if (points.length < 2) return;
    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);
    if (!fill && !stroke) return;

    const opacity = (style.opacity !== undefined && style.opacity < 1) ? style.opacity : undefined;

    // Compute bounding box for gradient
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const gradId = this.addGradientDef(style.backgroundImage, minX, minY, maxX - minX || 1, maxY - minY || 1);

    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + (closed ? " Z" : "");
    const attrs = this.buildPolylineAttrs(fill, stroke, style, gradId, opacity, closed);
    this.elements.push(`<path d="${d}"${attrs}/>`);
  }

  drawText(quad: Quad, text: string, style: Style): void {
    const sanitized = text.replace(/\s+/g, " ").trim();
    if (!sanitized) return;

    const opacity = (style.opacity !== undefined && style.opacity < 1) ? style.opacity : undefined;

    // Compute font metrics
    const quadHeight = Math.sqrt((quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2);
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const fontSize = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    const fontWeight = style.fontWeight ?? "normal";
    const fontStyle = style.fontStyle ?? "normal";
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "sans-serif";

    const textColor = parseColor(style.color) ?? parseColor(style.fill) ?? "#000000";

    // Compute rotation
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);

    // Text position: bottom-left of quad (baseline)
    const x = quad[3].x;
    const y = quad[3].y;

    const attrs: string[] = [];
    attrs.push(`x="${n(x)}" y="${n(y)}"`);
    attrs.push(`fill="${escXml(textColor)}"`);

    const fontParts: string[] = [];
    if (fontStyle !== "normal") fontParts.push(`font-style="${fontStyle}"`);
    if (fontWeight !== "normal" && fontWeight !== "400") fontParts.push(`font-weight="${fontWeight}"`);
    fontParts.push(`font-size="${n(fontSize)}px"`);
    fontParts.push(`font-family="${escXml(fontFamily)}"`);
    attrs.push(...fontParts);

    if (Math.abs(angleDeg) > 0.5) {
      attrs.push(`transform="rotate(${n(angleDeg)},${n(x)},${n(y)})"`);
    }
    if (opacity !== undefined) {
      attrs.push(`opacity="${n(opacity)}"`);
    }

    // Text shadow
    let shadowFilterId: string | undefined;
    if (style.textShadow && style.textShadow !== "none") {
      shadowFilterId = this.addTextShadowFilter(style.textShadow);
      if (shadowFilterId) attrs.push(`filter="url(#${shadowFilterId})"`);
    }

    // Text decoration
    let decoration: string | undefined;
    if (style.textDecoration) {
      if (style.textDecoration.includes("underline")) decoration = "underline";
      else if (style.textDecoration.includes("line-through")) decoration = "line-through";
      else if (style.textDecoration.includes("overline")) decoration = "overline";
      if (decoration) attrs.push(`text-decoration="${decoration}"`);
    }

    this.elements.push(`<text ${attrs.join(" ")}>${escXml(sanitized)}</text>`);
  }

  drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): void {
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const topEdge = Math.sqrt(dx * dx + dy * dy);
    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const leftEdge = Math.sqrt(ldx * ldx + ldy * ldy);
    if (topEdge <= 0 || leftEdge <= 0) return;

    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);
    const opacity = (style.opacity !== undefined && style.opacity < 1) ? style.opacity : undefined;

    const attrs: string[] = [];
    if (Math.abs(angleDeg) > 0.5) {
      attrs.push(`transform="translate(${n(quad[0].x)},${n(quad[0].y)}) rotate(${n(angleDeg)})"`);
      attrs.push(`x="0" y="0"`);
    } else {
      attrs.push(`x="${n(quad[0].x)}" y="${n(quad[0].y)}"`);
    }
    attrs.push(`width="${n(topEdge)}" height="${n(leftEdge)}"`);
    attrs.push(`href="${escXml(dataUrl)}"`);
    attrs.push(`preserveAspectRatio="none"`);
    if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);

    this.elements.push(`<image ${attrs.join(" ")}/>`);
  }

  end(): string {
    const defsBlock = this.defs.length > 0 ? `<defs>\n${this.defs.join("\n")}\n</defs>\n` : "";
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(this.width)}" height="${n(this.height)}" viewBox="0 0 ${n(this.width)} ${n(this.height)}">\n${defsBlock}${this.elements.join("\n")}\n</svg>`;
  }

  // ── Private helpers ─────────────────────────────────────────────

  private nextId(prefix: string): string {
    return `${prefix}${++this.defIdCounter}`;
  }

  private buildShapeAttrs(
    fill: string | null,
    stroke: { color: string; width: number } | null,
    style: Style,
    gradId: string | undefined,
    filterId: string | undefined,
    opacity: number | undefined,
  ): string {
    const parts: string[] = [];
    if (gradId) {
      parts.push(` fill="url(#${gradId})"`);
    } else if (fill) {
      parts.push(` fill="${escXml(fill)}"`);
    } else {
      parts.push(` fill="none"`);
    }
    if (stroke) {
      parts.push(` stroke="${escXml(stroke.color)}" stroke-width="${n(stroke.width)}"`);
    }
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      parts.push(` stroke-dasharray="${escXml(style.strokeDasharray)}"`);
    }
    if (filterId) parts.push(` filter="url(#${filterId})"`);
    if (opacity !== undefined) parts.push(` opacity="${n(opacity)}"`);
    return parts.join("");
  }

  private buildPolylineAttrs(
    fill: string | null,
    stroke: { color: string; width: number } | null,
    style: Style,
    gradId: string | undefined,
    opacity: number | undefined,
    closed: boolean,
  ): string {
    const parts: string[] = [];
    if (fill && closed) {
      if (gradId) {
        parts.push(` fill="url(#${gradId})"`);
      } else {
        parts.push(` fill="${escXml(fill)}"`);
      }
    } else if (fill && !closed) {
      // SVG fills open paths from first to last point
      if (gradId) {
        parts.push(` fill="url(#${gradId})"`);
      } else {
        parts.push(` fill="${escXml(fill)}"`);
      }
    } else {
      parts.push(` fill="none"`);
    }
    if (stroke) {
      parts.push(` stroke="${escXml(stroke.color)}" stroke-width="${n(stroke.width)}"`);
    } else if (!fill) {
      // Neither fill nor stroke visible — shouldn't reach here, but safety
      parts.push(` stroke="none"`);
    }
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      parts.push(` stroke-dasharray="${escXml(style.strokeDasharray)}"`);
    }
    if (opacity !== undefined) parts.push(` opacity="${n(opacity)}"`);
    return parts.join("");
  }

  /** Add an SVG gradient definition and return its id, or undefined if no gradient. */
  private addGradientDef(
    backgroundImage: string | undefined,
    x: number, y: number, w: number, h: number,
  ): string | undefined {
    const gradient = parseGradient(backgroundImage);
    if (!gradient) return undefined;

    const cx = x + w / 2;
    const cy = y + h / 2;

    if (gradient.type === "linear") {
      const id = this.nextId("lg");
      const angleRad = ((gradient.angleDeg - 90) * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      // Compute gradient line endpoints in the bounding box
      const halfDiag = Math.abs(w * cos) / 2 + Math.abs(h * sin) / 2;
      const x1 = cx - cos * halfDiag;
      const y1 = cy - sin * halfDiag;
      const x2 = cx + cos * halfDiag;
      const y2 = cy + sin * halfDiag;

      const stops = gradient.stops.map(s =>
        `<stop offset="${n(s.offset * 100)}%" stop-color="${escXml(s.color)}"/>`
      ).join("");
      this.defs.push(`<linearGradient id="${id}" x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`);
      return id;
    }

    if (gradient.type === "radial") {
      const id = this.nextId("rg");
      const r = Math.max(w, h) / 2;
      const stops = gradient.stops.map(s =>
        `<stop offset="${n(s.offset * 100)}%" stop-color="${escXml(s.color)}"/>`
      ).join("");
      this.defs.push(`<radialGradient id="${id}" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" gradientUnits="userSpaceOnUse">${stops}</radialGradient>`);
      return id;
    }

    // Conic gradients: approximate with multiple radial slices
    // SVG doesn't natively support conic gradients, so we skip for now
    // (the fill color will be used as fallback)
    return undefined;
  }

  /** Add a drop shadow SVG filter and return its id. */
  private addDropShadowFilter(shadows: ParsedBoxShadow[]): string {
    const id = this.nextId("ds");
    const filterParts: string[] = [];
    // Use the first outer shadow for simplicity; combine multiple if needed
    for (let i = 0; i < shadows.length; i++) {
      const s = shadows[i];
      const resultId = `s${i}`;
      filterParts.push(
        `<feDropShadow dx="${n(s.offsetX)}" dy="${n(s.offsetY)}" stdDeviation="${n(s.blur / 2)}" flood-color="${escXml(s.color)}" result="${resultId}"/>`
      );
    }
    // Pad the filter region to avoid clipping
    this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${filterParts.join("")}</filter>`);
    return id;
  }

  /** Add inset shadow overlays. */
  private addInsetShadows(
    shadows: ParsedBoxShadow[],
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    for (const s of shadows) {
      if (!s.inset) continue;
      // Create a filter for the inset shadow effect
      const clipId = this.nextId("ic");
      const filtId = this.nextId("is");

      // Clip path matching the shape
      if (r > 0) {
        this.defs.push(`<clipPath id="${clipId}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ry="${n(r)}"/></clipPath>`);
      } else {
        this.defs.push(`<clipPath id="${clipId}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`);
      }

      // Inset shadow filter: invert the drop shadow
      const std = n(s.blur / 2);
      this.defs.push(
        `<filter id="${filtId}" x="-50%" y="-50%" width="200%" height="200%">` +
        `<feComponentTransfer in="SourceAlpha"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>` +
        `<feGaussianBlur stdDeviation="${std}"/>` +
        `<feOffset dx="${n(s.offsetX)}" dy="${n(s.offsetY)}" result="offsetblur"/>` +
        `<feFlood flood-color="${escXml(s.color)}" result="color"/>` +
        `<feComposite in2="offsetblur" operator="in"/>` +
        `<feComposite in2="SourceAlpha" operator="in"/>` +
        `</filter>`
      );

      this.elements.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ry="${n(r)}" fill="none" clip-path="url(#${clipId})" filter="url(#${filtId})"/>`);
    }
  }

  /** Add a text shadow filter and return its id. */
  private addTextShadowFilter(textShadow: string): string | undefined {
    let color = "rgba(0,0,0,0.3)";
    let numericPart = textShadow;
    const rgbaMatch = textShadow.match(/rgba?\([^)]+\)/);
    if (rgbaMatch) { color = rgbaMatch[0]; numericPart = textShadow.replace(rgbaMatch[0], "").trim(); }
    else {
      const hexMatch = textShadow.match(/#[0-9a-fA-F]{3,8}/);
      if (hexMatch) { color = hexMatch[0]; numericPart = textShadow.replace(hexMatch[0], "").trim(); }
    }
    const nums = numericPart.match(/-?[\d.]+px/g)?.map(s => parseFloat(s)) ?? [];
    if (nums.length < 2) return undefined;

    const id = this.nextId("ts");
    const dx = nums[0], dy = nums[1], blur = nums[2] ?? 0;
    this.defs.push(
      `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">` +
      `<feDropShadow dx="${n(dx)}" dy="${n(dy)}" stdDeviation="${n(blur / 2)}" flood-color="${escXml(color)}"/>` +
      `</filter>`
    );
    return id;
  }
}
