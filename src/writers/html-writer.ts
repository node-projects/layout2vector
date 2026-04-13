/**
 * HTML Writer.
 * Maps IR nodes to HTML elements and produces a standalone HTML document string.
 */
import type { ClipQuad, Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath } from "../geometry.js";
import { normalizeWhitespaceAwareText, preservesWhitespace } from "../shared/text-whitespace.js";
import { getVisibleCssColorString } from "./shared/css-color.js";
import { getPointBounds, getQuadBounds, type ClipPathBounds } from "./shared/clip-path.js";
import { formatWriterNumber as n, getVisibleStroke, isAxisAlignedRect, parseMinDimensionBorderRadius } from "./shared/writer-utils.js";

// ── Color helpers ───────────────────────────────────────────────────

/** Escape text for use inside HTML. Non-ASCII chars are encoded as numeric entities for encoding safety. */
function escHtml(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case "&": out += "&amp;"; break;
      case "<": out += "&lt;"; break;
      case ">": out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case "'": out += "&#39;"; break;
      default:
        if (code > 0x7E) {
          out += `&#x${code.toString(16).toUpperCase()};`;
        } else {
          out += ch;
        }
        break;
    }
  }
  return out;
}

/** Build an SVG polygon path string from quad points. */
function quadToSvgPath(points: Quad): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + " Z";
}

/** Build an SVG polyline/polygon path string. */
function pointsToSvgPath(points: Point[], closed: boolean): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + (closed ? " Z" : "");
}

/** Build an SVG path from rounded quad path segments. */
function roundedQuadToSvgPath(points: Quad, radius: number): string {
  const segs = roundedQuadPath(points, radius);
  return segs.map(s => {
    switch (s.type) {
      case "M": return `M${n(s.x)},${n(s.y)}`;
      case "L": return `L${n(s.x)},${n(s.y)}`;
      case "Q": return `Q${n(s.cx)},${n(s.cy)} ${n(s.x)},${n(s.y)}`;
    }
  }).join(" ") + " Z";
}

function clipQuadToCssClipPath(clipQuad: ClipQuad): string {
  if (clipQuad.radius > 0) {
    return `path('${roundedQuadToSvgPath(clipQuad.points, clipQuad.radius)}')`;
  }

  const polygon = clipQuad.points
    .map((point) => `${n(point.x)}px ${n(point.y)}px`)
    .join(",");
  return `polygon(${polygon})`;
}

/** Determine file extension from a data URL MIME type. */
function dataUrlToExtension(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([^;,]+)/);
  if (match) {
    const mime = match[1].toLowerCase();
    if (mime === "jpeg" || mime === "jpg") return "jpg";
    if (mime === "png") return "png";
    if (mime === "gif") return "gif";
    if (mime === "webp") return "webp";
    if (mime === "bmp") return "bmp";
  }
  return "jpg";
}

type RenderedOutline = {
  color: string;
  width: string;
  style: string;
  offset?: string;
};

type QuadTransform = {
  width: number;
  height: number;
  matrix: string;
};

function pushCss(css: string[], name: string, value: string | undefined): void {
  if (!value) return;
  css.push(`${name}:${escHtml(value)}`);
}

function getVisibleOutline(style: Style): RenderedOutline | null {
  if (!style.outlineWidth || parseFloat(style.outlineWidth) <= 0) return null;
  if (!style.outlineStyle || style.outlineStyle === "none") return null;

  const color = getVisibleCssColorString(style.outlineColor ?? style.color ?? style.stroke ?? style.fill);
  if (!color) return null;

  return {
    color,
    width: style.outlineWidth,
    style: style.outlineStyle,
    offset: style.outlineOffset,
  };
}

function appendEffectCss(css: string[], style: Style, includeOutline = true): void {
  if (includeOutline) {
    const outline = getVisibleOutline(style);
    if (outline) {
      css.push(`outline:${escHtml(outline.width)} ${escHtml(outline.style)} ${escHtml(outline.color)}`);
      if (outline.offset && outline.offset !== "0px") {
        pushCss(css, "outline-offset", outline.offset);
      }
    }
  }

  pushCss(css, "filter", style.filter);
  pushCss(css, "mix-blend-mode", style.mixBlendMode);
  if (style.mask) {
    pushCss(css, "mask", style.mask);
    pushCss(css, "-webkit-mask", style.mask);
  }
}

function appendTextCss(css: string[], style: Style, preserveWhitespace: boolean): void {
  const whiteSpace = style.whiteSpace
    ? style.whiteSpace
    : preserveWhitespace
      ? "pre"
      : "normal";
  pushCss(css, "white-space", whiteSpace);

  if (style.lineHeight && style.lineHeight !== "normal") {
    pushCss(css, "line-height", style.lineHeight);
  }
  if (style.letterSpacing && style.letterSpacing !== "normal") {
    pushCss(css, "letter-spacing", style.letterSpacing);
  }
  if (style.wordSpacing && style.wordSpacing !== "normal" && style.wordSpacing !== "0px") {
    pushCss(css, "word-spacing", style.wordSpacing);
  }
  if (style.textDecoration && style.textDecoration !== "none") {
    pushCss(css, "text-decoration", style.textDecoration);
  }
  if (style.textIndent && style.textIndent !== "0px") {
    pushCss(css, "text-indent", style.textIndent);
  }
  if (style.textAlign && style.textAlign !== "start") {
    pushCss(css, "text-align", style.textAlign);
  }
  if (style.wordBreak && style.wordBreak !== "normal") {
    pushCss(css, "word-break", style.wordBreak);
  }
  if (style.overflowWrap && style.overflowWrap !== "normal") {
    pushCss(css, "overflow-wrap", style.overflowWrap);
  }
  if (style.direction && style.direction !== "ltr") {
    pushCss(css, "direction", style.direction);
  }
  if (style.writingMode && style.writingMode !== "horizontal-tb") {
    pushCss(css, "writing-mode", style.writingMode);
  }
}

function getQuadTransform(points: Quad): QuadTransform | null {
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  const ldx = points[3].x - points[0].x;
  const ldy = points[3].y - points[0].y;
  const width = Math.hypot(dx, dy);
  const height = Math.hypot(ldx, ldy);
  if (width <= 0 || height <= 0) return null;

  return {
    width,
    height,
    matrix: `matrix(${n(dx / width)},${n(dy / width)},${n(ldx / height)},${n(ldy / height)},${n(points[0].x)},${n(points[0].y)})`,
  };
}

// ── HTML Writer ─────────────────────────────────────────────────────

/** Image handling mode for the HTML writer. */
export type HTMLImageMode =
  | { type: "inline" }
  | { type: "external"; basePath: string }
  | { type: "css" };

/** Options for the HTML writer. */
export type HTMLWriterOptions = {
  /** Viewport width in pixels. */
  width: number;
  /** Viewport height in pixels. */
  height: number;
  /** How images are embedded in the HTML output. */
  imageMode?: HTMLImageMode;
  /** Scale factor applied to width and height. */
  zoom?: number;
  /** Custom CSS to prepend inside the `<style>` block. */
  customCss?: string;
};

export class HTMLWriter implements Writer<string> {
  private width: number;
  private height: number;
  private elements: string[] = [];
  private imageMode: HTMLImageMode;
  private imageCounter = 0;
  private imageDedup = new Map<string, string>(); // dataUrl → filename
  private cssImageClasses = new Map<string, string>(); // dataUrl → CSS class name
  private customCss: string;

  /**
   * Image files referenced by the HTML output.
   * Maps relative file paths to data URL strings.
   * After calling `end()`, save these files alongside the HTML to display images.
   * Only populated when `imageMode` is `{ type: "external" }`.
   */
  imageFiles = new Map<string, string>();

  /**
   * @param optionsOrWidth Options object, or viewport width in pixels (deprecated positional form).
   * @param height Viewport height in pixels (positional form).
   * @param imageMode How images are embedded in the HTML output (positional form).
   * @param zoom Scale factor applied to width and height (positional form).
   */
  constructor(optionsOrWidth: HTMLWriterOptions | number, height?: number, imageMode?: HTMLImageMode, zoom?: number) {
    if (typeof optionsOrWidth === "object") {
      const opts = optionsOrWidth;
      const z = opts.zoom ?? 1;
      this.width = opts.width * z;
      this.height = opts.height * z;
      this.imageMode = opts.imageMode ?? { type: "inline" };
      this.customCss = opts.customCss ?? "";
    } else {
      const z = zoom ?? 1;
      this.width = optionsOrWidth * z;
      this.height = (height ?? 0) * z;
      this.imageMode = imageMode ?? { type: "inline" };
      this.customCss = "";
    }
  }

  async begin(): Promise<void> {
    this.elements = [];
    this.imageCounter = 0;
    this.imageDedup.clear();
    this.imageFiles.clear();
    this.cssImageClasses.clear();
  }

  /** Get or create a CSS class name for an image data URL, deduplicating identical images. */
  private getCssImageClass(dataUrl: string): string {
    const existing = this.cssImageClasses.get(dataUrl);
    if (existing) return existing;
    const idx = ++this.imageCounter;
    const className = `ir-img-${idx}`;
    this.cssImageClasses.set(dataUrl, className);
    return className;
  }

  /** Get or create an external filename for an image data URL, deduplicating identical images. */
  private getImageFilename(dataUrl: string): string {
    const existing = this.imageDedup.get(dataUrl);
    if (existing) return existing;
    const ext = dataUrlToExtension(dataUrl);
    const idx = ++this.imageCounter;
    const filename = `image${idx}.${ext}`;
    const basePath = this.imageMode.type === "external" ? this.imageMode.basePath : "";
    const relativePath = basePath ? `${basePath}/${filename}` : filename;
    this.imageDedup.set(dataUrl, relativePath);
    this.imageFiles.set(relativePath, dataUrl);
    return relativePath;
  }

  /** Wrap an HTML string in clip containers when clip bounds or clip-path are present. */
  private applyClip(html: string, style: Style, bounds?: ClipPathBounds): string {
    let wrapped = html;

    if (bounds && style.clipPath && style.clipPath !== "none" && bounds.w > 0 && bounds.h > 0) {
      const css = [
        "position:absolute",
        `left:${n(bounds.x)}px`,
        `top:${n(bounds.y)}px`,
        `width:${n(bounds.w)}px`,
        `height:${n(bounds.h)}px`,
        `clip-path:${style.clipPath}`,
        `-webkit-clip-path:${style.clipPath}`,
      ];
      wrapped = `<div style="${css.join(";")}"><div style="position:relative;left:${n(-bounds.x)}px;top:${n(-bounds.y)}px">${wrapped}</div></div>`;
    }

    if (style.clipQuads?.length) {
      for (const clipQuad of style.clipQuads) {
        const clipPath = clipQuadToCssClipPath(clipQuad);
        const css = [
          "position:absolute",
          "left:0",
          "top:0",
          `width:${n(this.width)}px`,
          `height:${n(this.height)}px`,
          `clip-path:${clipPath}`,
          `-webkit-clip-path:${clipPath}`,
        ];
        wrapped = `<div style="${css.join(";")}">${wrapped}</div>`;
      }
    }

    const clip = style.clipBounds;
    if (!clip) return wrapped;

    const css = [
      "position:absolute",
      `left:${n(clip.x)}px`,
      `top:${n(clip.y)}px`,
      `width:${n(clip.w)}px`,
      `height:${n(clip.h)}px`,
      "overflow:hidden",
    ];
    if (clip.radius > 0) css.push(`border-radius:${n(clip.radius)}px`);
    return `<div style="${css.join(";")}"><div style="position:relative;left:${n(-clip.x)}px;top:${n(-clip.y)}px">${wrapped}</div></div>`;
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const fill = getVisibleCssColorString(style.fill);
    const stroke = getVisibleStroke(style, getVisibleCssColorString);
    const outline = getVisibleOutline(style);
    // Only output gradients in background-image; url() images are handled by drawImage
    const bgImage = style.backgroundImage && style.backgroundImage !== "none"
      ? style.backgroundImage : undefined;
    const hasGradient = bgImage && !(/url\s*\(/.test(bgImage));
    if (!fill && !stroke && !outline && !style.boxShadow && !hasGradient) return;

    const opacity = style.opacity;

    const clipBounds = getQuadBounds(points);

    if (isAxisAlignedRect(points)) {
      // Axis-aligned rectangle → use a positioned div
      const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const w = Math.abs(points[1].x - points[0].x);
      const h = Math.abs(points[3].y - points[0].y);

      const css: string[] = [
        "position:absolute",
        `left:${n(x)}px`,
        `top:${n(y)}px`,
        `width:${n(w)}px`,
        `height:${n(h)}px`,
        "box-sizing:border-box",
      ];

      if (fill) css.push(`background-color:${fill}`);
      if (hasGradient) css.push(`background-image:${bgImage}`);
      if (stroke) css.push(`border:${n(stroke.width)}px solid ${stroke.color}`);
      if (style.borderRadius && style.borderRadius !== "0px") css.push(`border-radius:${style.borderRadius}`);
      if (style.boxShadow && style.boxShadow !== "none") css.push(`box-shadow:${style.boxShadow}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
      appendEffectCss(css, style);

      this.elements.push(this.applyClip(`<div style="${css.join(";")}"></div>`, style, clipBounds));
    } else {
      const transform = getQuadTransform(points);
      if (!transform) return;

      const css: string[] = [
        "position:absolute",
        "left:0",
        "top:0",
        `width:${n(transform.width)}px`,
        `height:${n(transform.height)}px`,
        "box-sizing:border-box",
        "transform-origin:0 0",
        `transform:${transform.matrix}`,
      ];

      if (fill) css.push(`background-color:${fill}`);
      if (hasGradient) css.push(`background-image:${bgImage}`);
      if (stroke) css.push(`border:${n(stroke.width)}px solid ${stroke.color}`);
      if (style.borderRadius && style.borderRadius !== "0px") css.push(`border-radius:${style.borderRadius}`);
      if (style.boxShadow && style.boxShadow !== "none") css.push(`box-shadow:${style.boxShadow}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
      appendEffectCss(css, style);

      this.elements.push(this.applyClip(`<div style="${css.join(";")}"></div>`, style, clipBounds));
    }
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    if (points.length < 2) return;
    const fill = getVisibleCssColorString(style.fill);
    const stroke = getVisibleStroke(style, getVisibleCssColorString);
    if (!fill && !stroke) return;

    const opacity = style.opacity;
    const d = pointsToSvgPath(points, closed);
    const svgAttrs: string[] = [];
    if (fill && closed) svgAttrs.push(`fill="${escHtml(fill)}"`);
    else svgAttrs.push(`fill="none"`);
    if (stroke) svgAttrs.push(`stroke="${escHtml(stroke.color)}" stroke-width="${n(stroke.width)}"`);
    if (style.strokeDasharray && style.strokeDasharray !== "none") svgAttrs.push(`stroke-dasharray="${escHtml(style.strokeDasharray)}"`);
    if (opacity !== undefined && opacity < 1) svgAttrs.push(`opacity="${n(opacity)}"`);

    this.elements.push(this.applyClip(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><path d="${d}" ${svgAttrs.join(" ")}/></svg>`, style, getPointBounds(points)));
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    const preserveWhitespace = preservesWhitespace(style);
    const sanitized = normalizeWhitespaceAwareText(text, style);
    if (sanitized.length === 0) return;

    const opacity = style.opacity;

    // Compute font metrics from the quad
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const fontSize = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    const fontWeight = style.fontWeight ?? "normal";
    const fontStyle = style.fontStyle ?? "normal";
    const fontFamily = style.fontFamily?.trim() || "sans-serif";
    const textColor = getVisibleCssColorString(style.color) ?? getVisibleCssColorString(style.fill) ?? "black";
    const usesVerticalWriting = !!style.writingMode && style.writingMode !== "horizontal-tb";

    // Compute half-leading: the line box (quad) is taller than the em square by the leading.
    // We offset by half the leading so text sits at the correct position.
    const halfLeading = Math.max(0, (quadHeight - fontSize) / 2);

    // Compute rotation from the quad's top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);

    if (Math.abs(angleDeg) > 0.5) {
      const transform = getQuadTransform(quad);
      if (!transform) return;

      const css: string[] = [
        "position:absolute",
        "left:0",
        "top:0",
        `width:${n(transform.width)}px`,
        usesVerticalWriting
          ? `height:${n(transform.height)}px`
          : `min-height:${n(transform.height)}px`,
        "box-sizing:border-box",
        "transform-origin:0 0",
        `transform:${transform.matrix}`,
        `font-size:${n(fontSize)}px`,
        `font-family:${escHtml(fontFamily)}`,
        `color:${textColor}`,
      ];

      if (!usesVerticalWriting && halfLeading > 0) {
        css.push(`padding-top:${n(halfLeading)}px`);
      }
      if (fontWeight !== "normal" && fontWeight !== "400") css.push(`font-weight:${fontWeight}`);
      if (fontStyle !== "normal") css.push(`font-style:${fontStyle}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
      appendTextCss(css, style, preserveWhitespace);

      if (style.textShadow && style.textShadow !== "none") {
        css.push(`text-shadow:${style.textShadow}`);
      }
      if (style.textAlign === "justify") {
        css.push("text-align:justify");
        css.push("text-align-last:justify");
      }

      this.elements.push(this.applyClip(`<div style="${css.join(";")}">${escHtml(sanitized)}</div>`, style, getQuadBounds(quad)));
    } else {
      // Axis-aligned text → use a positioned span
      const css: string[] = [
        "position:absolute",
        `left:${n(quad[0].x)}px`,
        `top:${n(quad[0].y + halfLeading)}px`,
        `font-size:${n(fontSize)}px`,
        `font-family:${escHtml(fontFamily)}`,
        `color:${textColor}`,
        "line-height:1",
      ];

      if (fontWeight !== "normal" && fontWeight !== "400") css.push(`font-weight:${fontWeight}`);
      if (fontStyle !== "normal") css.push(`font-style:${fontStyle}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
      appendTextCss(css, style, preserveWhitespace);

      if (style.textShadow && style.textShadow !== "none") {
        css.push(`text-shadow:${style.textShadow}`);
      }

      // Justified text: set explicit width and justify to match original spacing
      if (style.textAlign === "justify") {
        const quadWidth = Math.sqrt(dx * dx + dy * dy);
        if (quadWidth > 0) {
          css.push(`width:${n(quadWidth)}px`);
          css.push("text-align:justify");
          css.push("text-align-last:justify");
        }
      }

      this.elements.push(this.applyClip(`<span style="${css.join(";")}">${escHtml(sanitized)}</span>`, style, getQuadBounds(quad)));
    }
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): Promise<void> {
    const transform = getQuadTransform(quad);
    if (!transform) return;

    const opacity = style.opacity;
    const outline = getVisibleOutline(style);

    const css: string[] = [
      "position:absolute",
      "left:0",
      "top:0",
      `width:${n(transform.width)}px`,
      `height:${n(transform.height)}px`,
      "transform-origin:0 0",
      `transform:${transform.matrix}`,
    ];

    if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
    const ir = style.imageRendering;
    if (ir === "pixelated" || ir === "crisp-edges" || ir === "-moz-crisp-edges") {
      css.push("image-rendering:pixelated");
    }
    if (outline) {
      css.push(`outline:${escHtml(outline.width)} ${escHtml(outline.style)} ${escHtml(outline.color)}`);
      if (outline.offset && outline.offset !== "0px") {
        pushCss(css, "outline-offset", outline.offset);
      }
    }
    appendEffectCss(css, style, false);

    if (this.imageMode.type === "css") {
      const className = this.getCssImageClass(dataUrl);
      this.elements.push(this.applyClip(`<div class="${className}" style="${css.join(";")}"></div>`, style, getQuadBounds(quad)));
    } else {
      const src = this.imageMode.type === "external" ? this.getImageFilename(dataUrl) : dataUrl;
      this.elements.push(this.applyClip(`<img src="${escHtml(src)}" style="${css.join(";")}" />`, style, getQuadBounds(quad)));
    }
  }

  async end(): Promise<string> {
    const content = this.elements.join("\n");
    let cssImageRules = "";
    if (this.imageMode.type === "css" && this.cssImageClasses.size > 0) {
      const rules: string[] = [];
      for (const [dataUrl, className] of this.cssImageClasses) {
        const src = dataUrl;
        rules.push(`  .${className} { background-image: url("${escHtml(src)}"); background-size: 100% 100%; }`);
      }
      cssImageRules = "\n" + rules.join("\n");
    }
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; }
  .ir-container { position: relative; width: ${n(this.width)}px; height: ${n(this.height)}px; overflow: hidden; }${cssImageRules}
${this.customCss ? "\n" + this.customCss : ""}
</style>
</head>
<body>
<div class="ir-container">
${content}
</div>
</body>
</html>`;
  }
}
