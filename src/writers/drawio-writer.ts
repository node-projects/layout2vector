/** Editable draw.io cells in an uncompressed, single-page XML document. */
import type { Point, Quad, SourceMetadata, Style, Writer } from "../types.js";
import { cssColorToHex, parseCssColor } from "./shared/css-color.js";
import { formatWriterNumber as n, isAxisAlignedRect, parseMinDimensionBorderRadius } from "./shared/writer-utils.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";

export type DrawIOWriterOptions = {
  /** Page dimensions in CSS pixels. Defaults to 850 × 1100. */
  width?: number;
  height?: number;
  /** Diagram tab name. Defaults to "Page-1". */
  pageName?: string;
};

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

// Style values are delimited by semicolons; XML escaping alone cannot protect them.
function styleValue(value: string): string { return value.replace(/[;=]/g, ""); }

function bounds(points: Point[]) {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x); y = Math.min(y, p.y);
    right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}

function geometry(b: { x: number; y: number; width: number; height: number }): string {
  return `<mxGeometry x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" as="geometry"/>`;
}

/** draw.io stencils require base64 raw DEFLATE. Stored blocks need no compression library. */
function encodeStencil(value: string): string {
  const data = new TextEncoder().encode(encodeURIComponent(value));
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 65535) {
    const length = Math.min(65535, data.length - offset);
    binary += String.fromCharCode(offset + length === data.length ? 1 : 0,
      length & 255, length >> 8, (~length) & 255, ((~length) >> 8) & 255);
    for (let i = offset; i < offset + length; i++) binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/** Rectangular quads retain their size and rotation; skewed text/images use their bounding box. */
function quadGeometry(q: Quad) {
  const u = { x: q[1].x - q[0].x, y: q[1].y - q[0].y };
  const v = { x: q[3].x - q[0].x, y: q[3].y - q[0].y };
  const width = Math.hypot(u.x, u.y), height = Math.hypot(v.x, v.y);
  if (width > 0 && height > 0 && Math.abs(u.x * v.x + u.y * v.y) < 0.001 * width * height &&
      u.x * v.y - u.y * v.x > 0 &&
      Math.hypot(q[2].x - q[0].x - u.x - v.x, q[2].y - q[0].y - u.y - v.y) < 0.01) {
    return { x: (q[0].x + q[2].x - width) / 2, y: (q[0].y + q[2].y - height) / 2,
      width, height, rotation: Math.atan2(u.y, u.x) * 180 / Math.PI };
  }
  return { ...bounds(q), rotation: 0 };
}

export class DrawIOWriter implements Writer<string> {
  private cells: string[] = [];
  private nextId = 2;
  private readonly options: Required<DrawIOWriterOptions>;

  constructor(options: DrawIOWriterOptions = {}) {
    this.options = { width: options.width ?? 850, height: options.height ?? 1100, pageName: options.pageName ?? "Page-1" };
    for (const size of [this.options.width, this.options.height]) {
      if (!Number.isFinite(size) || size <= 0) throw new Error("DrawIOWriter page dimensions must be positive finite numbers");
    }
  }

  async begin(): Promise<void> { this.cells = []; this.nextId = 2; }

  private cell(style: string, geom: string, value = "", source?: SourceMetadata, edge = false): void {
    const metadata = source ? ` sourceXPath="${xml(source.xpath)}" sourceOriginalType="${xml(source.originalType)}"${source.id ? ` sourceId="${xml(source.id)}"` : ""}` : "";
    this.cells.push(`<mxCell id="${this.nextId++}" value="${xml(value)}" style="${xml(style)}" ${edge ? 'edge="1"' : 'vertex="1"'} parent="1"${metadata}>${geom}</mxCell>`);
  }

  private paint(style: Style, fill = true): string {
    const fillColor = fill ? (style.fill ?? style.backgroundColor) : undefined;
    const strokeWidth = Math.max(0, parseFloat(style.strokeWidth ?? "0") || 0);
    const alpha = (color?: string) => n(100 * (parseCssColor(color)?.a ?? 1));
    let result = `fillColor=${cssColorToHex(fillColor) ?? "none"};fillOpacity=${alpha(fillColor)};strokeColor=${strokeWidth > 0 ? cssColorToHex(style.stroke) ?? "none" : "none"};strokeWidth=${n(strokeWidth)};strokeOpacity=${alpha(style.stroke)};opacity=${n(100 * Math.max(0, Math.min(1, style.opacity ?? 1)))};`;
    if (style.strokeDasharray && style.strokeDasharray !== "none") {
      const dash = style.strokeDasharray.split(/[ ,]+/).map(Number).filter(v => Number.isFinite(v) && v >= 0);
      if (dash.length && dash.some(v => v > 0)) result += `dashed=1;dashPattern=${dash.map(v => n(v / (strokeWidth || 1))).join(" ")};`;
    }
    return result;
  }

  async drawPolygon(points: Quad, style: Style, source?: SourceMetadata): Promise<void> {
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const borders = sides.map(side => ({ width: style[`border${side}Width`], color: style[`border${side}Color`], kind: style[`border${side}Style`] }));
    const hasBorders = borders.some(b => b.width !== undefined);
    const first = borders[0];
    const uniform = hasBorders && borders.every(b => b.width === first.width && b.color === first.color && b.kind === first.kind);
    let paint = style;
    if (hasBorders) {
      paint = { ...style, stroke: uniform && first.kind !== "none" && first.kind !== "hidden" ? first.color : undefined,
        strokeWidth: uniform ? first.width : "0",
        strokeDasharray: first.kind === "dashed" ? "3 3" : first.kind === "dotted" ? "1 1" : undefined };
    }
    if (isAxisAlignedRect(points) && points[1].x >= points[0].x && points[3].y >= points[0].y) {
      const b = bounds(points);
      const radius = parseMinDimensionBorderRadius(style.borderRadius, b.width, b.height);
      this.cell(`shape=rectangle;${this.paint(paint)}rounded=${radius > 0 ? 1 : 0};absoluteArcSize=1;arcSize=${n(radius * 2)};`, geometry(b), "", source);
    } else {
      await this.path([{ points, closed: true }], paint, source);
    }
    if (uniform) return;
    for (let i = 0; i < 4; i++) {
      const side = sides[i], width = style[`border${side}Width`], kind = style[`border${side}Style`];
      if (parseFloat(width ?? "0") > 0 && kind !== "none" && kind !== "hidden") {
        await this.drawPolyline([points[i], points[(i + 1) % 4]], false, {
          stroke: style[`border${side}Color`], strokeWidth: width, opacity: style.opacity,
          strokeDasharray: kind === "dashed" ? "3 3" : kind === "dotted" ? "1 1" : undefined,
        }, source);
      }
    }
  }

  private async path(paths: { points: Point[]; closed: boolean }[], style: Style, source?: SourceMetadata): Promise<void> {
    paths = paths.filter(p => p.points.length > 1);
    if (!paths.length) return;
    const b = bounds(paths.flatMap(p => p.points));
    const width = Math.max(b.width, 0.01), height = Math.max(b.height, 0.01);
    const commands = paths.map(p => p.points.map((v, i) => `<${i ? "line" : "move"} x="${n(v.x - b.x)}" y="${n(v.y - b.y)}"/>`).join("") + (p.closed ? "<close/>" : "")).join("");
    const stencil = `<shape name="Polygon" w="${n(width)}" h="${n(height)}" aspect="variable" strokewidth="inherit"><foreground><path>${commands}</path><fillstroke/></foreground></shape>`;
    this.cell(`shape=stencil(${encodeStencil(stencil)});${this.paint(style)}`, geometry({ ...b, width, height }), "", source);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style, source?: SourceMetadata): Promise<void> {
    if (style.pathSubpaths?.length) return this.path(style.pathSubpaths, style, source);
    if (points.length < 2) return;
    if (closed || cssColorToHex(style.fill)) return this.path([{ points, closed }], style, source);
    const point = (p: Point, attr: string) => `<mxPoint x="${n(p.x)}" y="${n(p.y)}" as="${attr}"/>`;
    const waypoints = points.slice(1, -1).map(p => `<mxPoint x="${n(p.x)}" y="${n(p.y)}"/>`).join("");
    this.cell(`shape=connector;edgeStyle=none;noEdgeStyle=1;startArrow=none;endArrow=none;rounded=0;${this.paint(style, false)}`,
      `<mxGeometry relative="1" as="geometry">${point(points[0], "sourcePoint")}${point(points[points.length - 1], "targetPoint")}<Array as="points">${waypoints}</Array></mxGeometry>`, "", source, true);
  }

  async drawText(quad: Quad, text: string, style: Style, source?: SourceMetadata): Promise<void> {
    const b = quadGeometry(quad);
    const weight = style.fontWeight ?? "normal";
    const decoration = style.textDecoration ?? "";
    const flags = (weight === "bold" || Number(weight) >= 600 ? 1 : 0) |
      (style.fontStyle === "italic" || style.fontStyle === "oblique" ? 2 : 0) |
      (decoration.includes("underline") ? 4 : 0) | (decoration.includes("line-through") ? 8 : 0);
    const family = (style.fontFamily ?? "Arial").split(",")[0].trim().replace(/^["']|["']$/g, "");
    const align = ["left", "right", "center"].includes(style.textAlign ?? "") ? style.textAlign : style.direction === "rtl" ? "right" : "left";
    const color = style.color ?? style.fill ?? "#000000";
    this.cell(`text;html=0;whiteSpace=wrap;overflow=visible;spacing=0;verticalAlign=top;align=${align};fillColor=none;strokeColor=none;fontFamily=${styleValue(family)};fontSize=${n(parseFloat(style.fontSize ?? "16") || 16)};fontStyle=${flags};fontColor=${cssColorToHex(color) ?? "#000000"};textOpacity=${n(100 * (parseCssColor(color)?.a ?? 1))};opacity=${n(100 * (style.opacity ?? 1))};rotation=${n(b.rotation)};`, geometry(b), normalizeWhitespaceAwareText(text, style), source);
  }

  async drawImage(quad: Quad, dataUrl: string, _width: number, _height: number, style: Style, _rgbData?: number[], source?: SourceMetadata): Promise<void> {
    const b = quadGeometry(quad);
    // draw.io's style parser splits on semicolons; its image loader restores the base64 marker.
    const image = dataUrl.replace(/;base64,/i, ",").replace(/;/g, "%3B");
    this.cell(`shape=image;imageAspect=0;aspect=fixed;image=${image};rotation=${n(b.rotation)};opacity=${n(100 * (style.opacity ?? 1))};`, geometry(b), "", source);
  }

  async end(): Promise<string> {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" compressed="false"><diagram id="page-1" name="${xml(this.options.pageName)}"><mxGraphModel grid="0" page="1" pageScale="1" pageWidth="${n(this.options.width)}" pageHeight="${n(this.options.height)}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>\n${this.cells.join("\n")}\n</root></mxGraphModel></diagram></mxfile>`;
  }
}
