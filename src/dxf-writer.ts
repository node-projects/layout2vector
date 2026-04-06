/**
 * DXF Writer using @tarikjabiri/dxf.
 * Maps IR nodes to DXF entities.
 */
import { DxfWriter, point3d, point2d } from "@tarikjabiri/dxf";
import type { Point, Quad, Style, Writer } from "./types.js";

/** Parse a CSS color to an RGB hex string for DXF trueColor. */
function cssColorToHex(color: string | undefined): string | undefined {
  if (!color || color === "transparent" || color === "none") return undefined;

  // Handle hex colors
  if (color.startsWith("#")) {
    // Normalize #rgb to #rrggbb
    if (color.length === 4) {
      const r = color[1], g = color[2], b = color[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return color.substring(0, 7);
  }

  // Handle rgb/rgba
  const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, "0");
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, "0");
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  return undefined;
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
    const vertices = points.map((p) => ({
      point: point2d(p.x, this.flipY(p.y)),
    }));

    // Close the polygon
    vertices.push({
      point: point2d(points[0].x, this.flipY(points[0].y)),
    });

    const trueColor = cssColorToHex(style.stroke) ?? cssColorToHex(style.fill);

    this.dxf.addLWPolyline(
      vertices,
      trueColor ? { trueColor } : undefined
    );
  }

  drawPolyline(points: Point[], closed: boolean, style: Style): void {
    const vertices = points.map((p) => ({
      point: point2d(p.x, this.flipY(p.y)),
    }));

    if (closed && points.length > 0) {
      vertices.push({
        point: point2d(points[0].x, this.flipY(points[0].y)),
      });
    }

    const trueColor = cssColorToHex(style.stroke) ?? cssColorToHex(style.fill);

    this.dxf.addLWPolyline(
      vertices,
      trueColor ? { trueColor } : undefined
    );
  }

  drawText(quad: Quad, text: string, style: Style): void {
    // Position text at the bottom-left of the quad (DXF convention)
    const bottomLeft = quad[3];
    const topLeft = quad[0];

    // Estimate text height from the quad
    const height = Math.abs(topLeft.y - bottomLeft.y) || 12;

    const trueColor = cssColorToHex(style.fill);

    this.dxf.addText(
      point3d(bottomLeft.x, this.flipY(bottomLeft.y)),
      height,
      text,
      trueColor ? { trueColor } : undefined
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
