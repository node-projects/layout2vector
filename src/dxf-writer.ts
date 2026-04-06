/**
 * DXF Writer using @tarikjabiri/dxf.
 * Maps IR nodes to DXF entities.
 */
import { DxfWriter, point3d, point2d } from "@tarikjabiri/dxf";
import type { Point, Quad, Style, Writer } from "./types.js";

/** Parse a CSS color, returning hex and alpha. Returns undefined for invisible colors. */
function cssColorToHex(color: string | undefined): string | undefined {
  if (!color || color === "transparent" || color === "none") return undefined;

  // Handle hex colors
  if (color.startsWith("#")) {
    // Normalize #rgb to #rrggbb
    if (color.length === 4) {
      const r = color[1], g = color[2], b = color[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    // #rrggbbaa — check alpha
    if (color.length === 9) {
      const alpha = parseInt(color.slice(7, 9), 16);
      if (alpha === 0) return undefined;
    }
    return color.substring(0, 7);
  }

  // Handle rgb/rgba
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbMatch) {
    // Check alpha channel
    if (rgbMatch[4] !== undefined && parseFloat(rgbMatch[4]) <= 0) {
      return undefined; // fully transparent
    }
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, "0");
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, "0");
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  return undefined;
}

/**
 * Convert a hex color string to a DXF trueColor integer.
 * DXF group 420 requires a 24-bit decimal integer: (R << 16) | (G << 8) | B
 */
function hexToTrueColor(hex: string): number {
  const stripped = hex.startsWith("#") ? hex.slice(1) : hex;
  return parseInt(stripped, 16);
}

/** Get trueColor integer from a CSS color, or undefined if invisible. */
function getTrueColor(color: string | undefined): number | undefined {
  const hex = cssColorToHex(color);
  if (!hex) return undefined;
  return hexToTrueColor(hex);
}

/** Check if stroke is visible (has color and non-zero width). */
function hasVisibleStroke(style: Style): boolean {
  const strokeHex = cssColorToHex(style.stroke);
  if (!strokeHex) return false;
  const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
  return strokeWidth > 0;
}

/** Parse border-radius to a radius value in pixels. */
function parseBorderRadius(borderRadius: string | undefined): number {
  if (!borderRadius || borderRadius === "0px") return 0;
  const val = parseFloat(borderRadius);
  return isNaN(val) ? 0 : val;
}

/** Generate arc points for a rounded corner. */
function arcPoints(cx: number, cy: number, r: number, startAngle: number, endAngle: number, segments: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (endAngle - startAngle) * (i / segments);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Check if a quad is an axis-aligned rectangle. */
function isAxisAlignedRect(points: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]): boolean {
  const eps = 0.5;
  return (
    Math.abs(points[0].y - points[1].y) < eps &&
    Math.abs(points[2].y - points[3].y) < eps &&
    Math.abs(points[0].x - points[3].x) < eps &&
    Math.abs(points[1].x - points[2].x) < eps
  );
}

export class DXFWriter implements Writer<string> {
  private dxf!: DxfWriter;
  private maxY: number;

  /**
   * @param maxY The maximum Y coordinate (viewport height) for Y-axis flipping.
   *             DXF uses Y-up; browser uses Y-down.
   */
  constructor(maxY = 1000) {
    this.maxY = maxY;
  }

  begin(): void {
    this.dxf = new DxfWriter();
  }

  drawPolygon(points: Quad, style: Style): void {
    const trueColor = getTrueColor(style.stroke) ?? getTrueColor(style.fill);
    const fillVisible = cssColorToHex(style.fill) !== undefined;
    const strokeVisible = hasVisibleStroke(style);

    // Skip fully transparent elements
    if (!fillVisible && !strokeVisible) return;

    const opts = trueColor !== undefined ? { trueColor: String(trueColor) } : undefined;

    // Check for rounded rect
    const radius = parseBorderRadius(style.borderRadius);
    if (radius > 0 && isAxisAlignedRect(points)) {
      const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const w = Math.abs(points[1].x - points[0].x);
      const h = Math.abs(points[3].y - points[0].y);
      const r = Math.min(radius, w / 2, h / 2);
      const ARC_SEGS = 8;

      // Build rounded rectangle polyline
      const verts: { x: number; y: number }[] = [];
      // Top edge (left to right)
      verts.push({ x: x + r, y: y });
      verts.push({ x: x + w - r, y: y });
      // Top-right corner
      verts.push(...arcPoints(x + w - r, y + r, r, -Math.PI / 2, 0, ARC_SEGS));
      // Right edge
      verts.push({ x: x + w, y: y + h - r });
      // Bottom-right corner
      verts.push(...arcPoints(x + w - r, y + h - r, r, 0, Math.PI / 2, ARC_SEGS));
      // Bottom edge
      verts.push({ x: x + r, y: y + h });
      // Bottom-left corner
      verts.push(...arcPoints(x + r, y + h - r, r, Math.PI / 2, Math.PI, ARC_SEGS));
      // Left edge
      verts.push({ x: x, y: y + r });
      // Top-left corner
      verts.push(...arcPoints(x + r, y + r, r, Math.PI, Math.PI * 1.5, ARC_SEGS));

      const vertices = verts.map((p) => ({
        point: point2d(p.x, this.flipY(p.y)),
      }));
      // Close
      vertices.push({ point: point2d(verts[0].x, this.flipY(verts[0].y)) });

      this.dxf.addLWPolyline(vertices, opts);
      return;
    }

    const vertices = points.map((p) => ({
      point: point2d(p.x, this.flipY(p.y)),
    }));

    // Close the polygon
    vertices.push({
      point: point2d(points[0].x, this.flipY(points[0].y)),
    });

    this.dxf.addLWPolyline(vertices, opts);
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    const trueColor = getTrueColor(style.stroke) ?? getTrueColor(style.fill);
    const fillVisible = cssColorToHex(style.fill) !== undefined;
    const strokeVisible = hasVisibleStroke(style);

    // Skip fully transparent elements
    if (!fillVisible && !strokeVisible) return;

    const opts = trueColor !== undefined ? { trueColor: String(trueColor) } : undefined;

    const vertices = points.map((p) => ({
      point: point2d(p.x, this.flipY(p.y)),
    }));

    if (closed && points.length > 0) {
      vertices.push({
        point: point2d(points[0].x, this.flipY(points[0].y)),
      });
    }

    this.dxf.addLWPolyline(vertices, opts);
  }

  drawText(quad: Quad, text: string, style: Style): void {
    // Position text at the bottom-left of the quad (DXF convention)
    const bottomLeft = quad[3];
    const topLeft = quad[0];

    // Estimate text height from the quad
    const height = Math.abs(topLeft.y - bottomLeft.y) || 12;

    // Text color: prefer style.color (CSS color), then style.fill
    const trueColor = getTrueColor(style.color) ?? getTrueColor(style.fill);
    const opts = trueColor !== undefined ? { trueColor: String(trueColor) } : undefined;

    this.dxf.addText(
      point3d(bottomLeft.x, this.flipY(bottomLeft.y)),
      height,
      text,
      opts
    );
  }

  end(): string {
    return this.dxf.stringify();
  }

  /** Flip Y coordinate for DXF (Y-up) coordinate system. */
  private flipY(y: number): number {
    return this.maxY - y;
  }
}
