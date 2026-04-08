/**
 * HTML Writer.
 * Maps IR nodes to HTML elements and produces a standalone HTML document string.
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

function isAxisAlignedRect(points: Quad): boolean {
  const eps = 0.5;
  return (
    Math.abs(points[0].y - points[1].y) < eps &&
    Math.abs(points[2].y - points[3].y) < eps &&
    Math.abs(points[0].x - points[3].x) < eps &&
    Math.abs(points[1].x - points[2].x) < eps
  );
}

/** Escape text for use inside HTML. */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Format a number, trimming trailing zeros. */
function n(v: number): string {
  return +v.toFixed(2) + "";
}

/** Build an SVG polygon path string from quad points. */
function quadToSvgPath(points: Quad): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + " Z";
}

/** Build an SVG polyline/polygon path string. */
function pointsToSvgPath(points: Point[], closed: boolean): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${n(p.x)},${n(p.y)}`).join(" ") + (closed ? " Z" : "");
}

// ── HTML Writer ─────────────────────────────────────────────────────

export class HTMLWriter implements Writer<string> {
  private width: number;
  private height: number;
  private elements: string[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  begin(): void {
    this.elements = [];
  }

  drawPolygon(points: Quad, style: Style): void {
    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);
    const hasBgImage = style.backgroundImage && style.backgroundImage !== "none";
    if (!fill && !stroke && !style.boxShadow && !hasBgImage) return;

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
      if (hasBgImage) css.push(`background-image:${style.backgroundImage}`);
      if (stroke) css.push(`border:${n(stroke.width)}px solid ${stroke.color}`);
      if (style.borderRadius && style.borderRadius !== "0px") css.push(`border-radius:${style.borderRadius}`);
      if (style.boxShadow && style.boxShadow !== "none") css.push(`box-shadow:${style.boxShadow}`);
      if (opacity !== undefined && opacity < 1) css.push(`opacity:${n(opacity)}`);

      this.elements.push(`<div style="${css.join(";")}"></div>`);
    } else {
      // Non-axis-aligned quad → use inline SVG
      const d = quadToSvgPath(points);
      const svgAttrs: string[] = [];
      if (fill) svgAttrs.push(`fill="${escHtml(fill)}"`);
      else svgAttrs.push(`fill="none"`);
      if (stroke) svgAttrs.push(`stroke="${escHtml(stroke.color)}" stroke-width="${n(stroke.width)}"`);
      if (opacity !== undefined && opacity < 1) svgAttrs.push(`opacity="${n(opacity)}"`);

      this.elements.push(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><path d="${d}" ${svgAttrs.join(" ")}/></svg>`);
    }
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    if (points.length < 2) return;
    const fill = parseColor(style.fill);
    const stroke = hasVisibleStroke(style);
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

  drawText(quad: Quad, text: string, style: Style): void {
    const sanitized = text.replace(/\s+/g, " ").trim();
    if (!sanitized) return;

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
    const textColor = parseColor(style.color) ?? parseColor(style.fill) ?? "black";

    // Compute rotation from the quad's top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angle = Math.atan2(dy, dx);
    const angleDeg = angle * (180 / Math.PI);

    if (Math.abs(angleDeg) > 0.5) {
      // Rotated text → use SVG text element for precise positioning
      const x = quad[3].x;
      const y = quad[3].y;

      const attrs: string[] = [];
      attrs.push(`x="${n(x)}" y="${n(y)}"`);
      attrs.push(`fill="${escHtml(textColor)}"`);
      if (fontStyle !== "normal") attrs.push(`font-style="${fontStyle}"`);
      if (fontWeight !== "normal" && fontWeight !== "400") attrs.push(`font-weight="${fontWeight}"`);
      attrs.push(`font-size="${n(fontSize)}px"`);
      attrs.push(`font-family="${escHtml(fontFamily)}"`);
      attrs.push(`transform="rotate(${n(angleDeg)},${n(x)},${n(y)})"`);
      if (opacity !== undefined && opacity < 1) attrs.push(`opacity="${n(opacity)}"`);

      this.elements.push(`<svg style="position:absolute;left:0;top:0;width:${n(this.width)}px;height:${n(this.height)}px;pointer-events:none;overflow:visible"><text ${attrs.join(" ")}>${escHtml(sanitized)}</text></svg>`);
    } else {
      // Axis-aligned text → use a positioned span
      const css: string[] = [
        "position:absolute",
        `left:${n(quad[0].x)}px`,
        `top:${n(quad[0].y)}px`,
        `font-size:${n(fontSize)}px`,
        `font-family:${escHtml(fontFamily)}`,
        `color:${textColor}`,
        "white-space:nowrap",
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

      this.elements.push(`<span style="${css.join(";")}">${escHtml(sanitized)}</span>`);
    }
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

    this.elements.push(`<img src="${escHtml(dataUrl)}" style="${css.join(";")}" />`);
  }

  end(): string {
    const content = this.elements.join("\n");
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; }
  .ir-container { position: relative; width: ${n(this.width)}px; height: ${n(this.height)}px; overflow: hidden; }
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
