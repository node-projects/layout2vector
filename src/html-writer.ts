/**
 * HTML Writer.
 * Maps IR nodes to HTML elements and produces a standalone HTML document string.
 */
import type { Point, Quad, Style, Writer } from "./types.js";
import { getVisibleCssColorString } from "./css-color.js";
import { roundedQuadPath } from "./geometry.js";
import { normalizeWhitespaceAwareText, preservesWhitespace } from "./text-whitespace.js";
import { formatWriterNumber as n, getVisibleStroke, isAxisAlignedRect, parseMinDimensionBorderRadius } from "./writer-utils.js";

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

  /** Wrap an HTML string in a clip container if clipBounds is set. */
  private applyClip(html: string, style: Style): string {
    const clip = style.clipBounds;
    if (!clip) return html;
    const css = [
      "position:absolute",
      `left:${n(clip.x)}px`,
      `top:${n(clip.y)}px`,
      `width:${n(clip.w)}px`,
      `height:${n(clip.h)}px`,
      "overflow:hidden",
    ];
    if (clip.radius > 0) css.push(`border-radius:${n(clip.radius)}px`);
    return `<div style="${css.join(";")}"><div style="position:relative;left:${n(-clip.x)}px;top:${n(-clip.y)}px">${html}</div></div>`;
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const fill = getVisibleCssColorString(style.fill);
    const stroke = getVisibleStroke(style, getVisibleCssColorString);
    // Only output gradients in background-image; url() images are handled by drawImage
    const bgImage = style.backgroundImage && style.backgroundImage !== "none"
      ? style.backgroundImage : undefined;
    const hasGradient = bgImage && !(/url\s*\(/.test(bgImage));
    if (!fill && !stroke && !style.boxShadow && !hasGradient) return;

    const opacity = style.opacity;

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
      ];

      if (fill) css.push(`background-color:${fill}`);
      if (hasGradient) css.push(`background-image:${bgImage}`);
      if (stroke) css.push(`border:${n(stroke.width)}px solid ${stroke.color}`);
      if (style.borderRadius && style.borderRadius !== "0px") css.push(`border-radius:${style.borderRadius}`);
      if (style.boxShadow && style.boxShadow !== "none") css.push(`box-shadow:${style.boxShadow}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);

      this.elements.push(this.applyClip(`<div style="${css.join(";")}"></div>`, style));
    } else {
      // Non-axis-aligned quad → use inline SVG
      // Calculate edge lengths for border-radius resolution
      const edgeW = Math.sqrt((points[1].x - points[0].x) ** 2 + (points[1].y - points[0].y) ** 2);
      const edgeH = Math.sqrt((points[3].x - points[0].x) ** 2 + (points[3].y - points[0].y) ** 2);
      const radius = parseMinDimensionBorderRadius(style.borderRadius, edgeW, edgeH);
      const d = radius > 0 ? roundedQuadToSvgPath(points, radius) : quadToSvgPath(points);
      const svgAttrs: string[] = [];
      if (fill) svgAttrs.push(`fill="${escHtml(fill)}"`);
      else svgAttrs.push(`fill="none"`);
      if (stroke) svgAttrs.push(`stroke="${escHtml(stroke.color)}" stroke-width="${n(stroke.width)}"`);
      if (opacity !== undefined && opacity < 1) svgAttrs.push(`opacity="${n(opacity)}"`);

      this.elements.push(this.applyClip(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><path d="${d}" ${svgAttrs.join(" ")}/></svg>`, style));
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

    this.elements.push(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><path d="${d}" ${svgAttrs.join(" ")}/></svg>`);
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
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "sans-serif";
    const textColor = getVisibleCssColorString(style.color) ?? getVisibleCssColorString(style.fill) ?? "black";

    // Compute half-leading: the line box (quad) is taller than the em square by the leading.
    // We offset by half the leading so text sits at the correct position.
    const halfLeading = Math.max(0, (quadHeight - fontSize) / 2);

    // Compute rotation from the quad's top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);

    if (Math.abs(angleDeg) > 0.5) {
      // Rotated text → use SVG text element for precise positioning
      // Position at the em-square top (quad[0] offset by halfLeading toward quad[3])
      const t = quadHeight > 0 ? halfLeading / quadHeight : 0;
      const x = quad[0].x + (quad[3].x - quad[0].x) * t;
      const y = quad[0].y + (quad[3].y - quad[0].y) * t;

      const attrs: string[] = [];
      attrs.push(`x="${n(x)}" y="${n(y)}"`);
      attrs.push(`fill="${escHtml(textColor)}"`);
      attrs.push(`dominant-baseline="text-before-edge"`);
      if (fontStyle !== "normal") attrs.push(`font-style="${fontStyle}"`);
      if (fontWeight !== "normal" && fontWeight !== "400") attrs.push(`font-weight="${fontWeight}"`);
      attrs.push(`font-size="${n(fontSize)}px"`);
      attrs.push(`font-family="${escHtml(fontFamily)}"`);
      attrs.push(`transform="rotate(${n(angleDeg)},${n(x)},${n(y)})"`);
      if (opacity !== undefined && opacity < 1) attrs.push(`opacity="${n(opacity)}"`);
      if (preserveWhitespace) attrs.push(`xml:space="preserve"`);

      this.elements.push(this.applyClip(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><text ${attrs.join(" ")}>${escHtml(sanitized)}</text></svg>`, style));
    } else {
      // Axis-aligned text → use a positioned span
      const css: string[] = [
        "position:absolute",
        `left:${n(quad[0].x)}px`,
        `top:${n(quad[0].y + halfLeading)}px`,
        `font-size:${n(fontSize)}px`,
        `font-family:${escHtml(fontFamily)}`,
        `color:${textColor}`,
        preserveWhitespace ? "white-space:pre" : "white-space:nowrap",
        "line-height:1",
      ];

      if (fontWeight !== "normal" && fontWeight !== "400") css.push(`font-weight:${fontWeight}`);
      if (fontStyle !== "normal") css.push(`font-style:${fontStyle}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);

      if (style.textDecoration && style.textDecoration !== "none") {
        css.push(`text-decoration:${style.textDecoration}`);
      }
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

      this.elements.push(this.applyClip(`<span style="${css.join(";")}">${escHtml(sanitized)}</span>`, style));
    }
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): Promise<void> {
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const topEdge = Math.sqrt(dx * dx + dy * dy);
    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const leftEdge = Math.sqrt(ldx * ldx + ldy * ldy);
    if (topEdge <= 0 || leftEdge <= 0) return;

    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);
    const opacity = style.opacity;

    const css: string[] = [
      "position:absolute",
      `left:${n(quad[0].x)}px`,
      `top:${n(quad[0].y)}px`,
      `width:${n(topEdge)}px`,
      `height:${n(leftEdge)}px`,
    ];

    if (Math.abs(angleDeg) > 0.5) {
      css.push(`transform:rotate(${n(angleDeg)}deg)`);
      css.push("transform-origin:top left");
    }
    if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);
    const ir = style.imageRendering;
    if (ir === "pixelated" || ir === "crisp-edges" || ir === "-moz-crisp-edges") {
      css.push("image-rendering:pixelated");
    }

    if (this.imageMode.type === "css") {
      const className = this.getCssImageClass(dataUrl);
      this.elements.push(this.applyClip(`<div class="${className}" style="${css.join(";")}"></div>`, style));
    } else {
      const src = this.imageMode.type === "external" ? this.getImageFilename(dataUrl) : dataUrl;
      this.elements.push(this.applyClip(`<img src="${escHtml(src)}" style="${css.join(";")}" />`, style));
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
