/**
 * DXF Writer using @tarikjabiri/dxf.
 * Maps IR nodes to DXF entities.
 */
import {
  DxfWriter,
  point3d,
  point2d,
  HatchBoundaryPaths,
  HatchPolylineBoundary,
  HatchPredefinedPatterns,
  pattern,
} from "@tarikjabiri/dxf";
import type { Point, Quad, Style, Writer } from "./types.js";
import { roundedQuadPath } from "./geometry.js";

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
    if (mime === "tiff") return "tiff";
  }
  return "jpg";
}

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
  private imageCounter = 0;
  private fontStyles = new Map<string, string>();

  /**
   * Image files referenced by the DXF output.
   * Maps relative file paths (as used in the DXF IMAGE entities) to data URL strings.
   * After calling `end()`, save these files alongside the DXF to display raster images.
   */
  imageFiles = new Map<string, string>();

  /**
   * @param maxY The maximum Y coordinate (viewport height) for Y-axis flipping.
   *             DXF uses Y-up; browser uses Y-down.
   * @param zoom Scale factor applied to the maxY coordinate.
   */
  constructor(maxY = 1000, zoom = 1) {
    this.maxY = maxY * zoom;
  }

  begin(): void {
    this.dxf = new DxfWriter();
    this.imageCounter = 0;
    this.imageFiles.clear();
    this.fontStyles.clear();
  }

  /** Get or create a DXF text style for a given font family. Returns the style name. */
  private getTextStyle(fontFamily: string | undefined): string | undefined {
    if (!fontFamily) return undefined;
    // Extract the first font name from the CSS font-family list
    const name = fontFamily.split(",")[0]?.trim().replace(/['"]/g, "");
    if (!name || name === "serif" || name === "sans-serif" || name === "monospace") return undefined;

    if (this.fontStyles.has(name)) return this.fontStyles.get(name)!;

    // Create a DXF text style referencing this TrueType font
    const style = this.dxf.tables.addStyle(name);
    style.fontFileName = name + ".ttf";
    this.fontStyles.set(name, name);
    return name;
  }

  /** Add a HATCH entity with SOLID fill for the given vertices. */
  private addSolidHatch(verts: { x: number; y: number }[], fillColor: number): void {
    const boundary = new HatchBoundaryPaths();
    const polyBoundary = new HatchPolylineBoundary();
    for (const v of verts) {
      polyBoundary.add({ x: v.x, y: this.flipY(v.y) });
    }
    boundary.addPolylineBoundary(polyBoundary);
    this.dxf.addHatch(
      boundary,
      pattern({ name: HatchPredefinedPatterns.SOLID }),
      { trueColor: String(fillColor) },
    );
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

    // Non-axis-aligned quad with border-radius: use rounded quad path as polyline approximation
    if (radius > 0 && !isAxisAlignedRect(points)) {
      const segs = roundedQuadPath(points, radius);
      const verts: { x: number; y: number }[] = [];
      for (const s of segs) {
        if (s.type === "M" || s.type === "L") {
          verts.push({ x: s.x, y: s.y });
        } else if (s.type === "Q") {
          // Approximate quadratic bezier with line segments
          const prev = verts[verts.length - 1];
          if (prev) {
            for (let t = 0.25; t <= 1; t += 0.25) {
              const u = 1 - t;
              verts.push({
                x: u * u * prev.x + 2 * u * t * s.cx + t * t * s.x,
                y: u * u * prev.y + 2 * u * t * s.cy + t * t * s.y,
              });
            }
          }
        }
      }
      if (fillVisible) {
        const fillColor2 = getTrueColor(style.fill);
        if (fillColor2 !== undefined) this.addSolidHatch(verts, fillColor2);
      }
      const dxfVerts = verts.map(p => ({ point: point2d(p.x, this.flipY(p.y)) }));
      dxfVerts.push({ point: point2d(verts[0].x, this.flipY(verts[0].y)) });
      this.dxf.addLWPolyline(dxfVerts, opts);
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
    const fillColor = getTrueColor(style.fill);
    const strokeColor = getTrueColor(style.stroke);
    const fillVisible = cssColorToHex(style.fill) !== undefined;
    const strokeVisible = hasVisibleStroke(style);

    // Skip fully transparent elements
    if (!fillVisible && !strokeVisible) return;

    // Solid fill via HATCH for closed shapes with a visible fill
    if (closed && fillVisible && fillColor !== undefined && points.length >= 3) {
      this.addSolidHatch(
        points.map(p => ({ x: p.x, y: p.y })),
        fillColor,
      );
    }

    // Always draw the polyline outline — use stroke color if available, otherwise fill color
    const trueColor = strokeColor ?? fillColor;
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
    // Sanitize text: collapse whitespace/newlines to single spaces (DXF is line-based)
    const sanitized = text.replace(/\s+/g, " ").trim();
    if (!sanitized) return;

    // Compute rotation angle from quad top edge (topLeft → topRight)
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angleRad = Math.atan2(dy, dx);
    // DXF Y-up vs browser Y-down — negate the angle
    const angleDeg = -angleRad * (180 / Math.PI);

    // Compute text height from left edge of quad
    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const quadHeight = Math.sqrt(ldx * ldx + ldy * ldy) || 12;

    // Use actual font size (em square) as DXF text height, not line-height
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const height = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    // Position at baseline: offset from quad[0] by halfLeading + ascent
    const halfLeading = Math.max(0, (quadHeight - height) / 2);
    const ascentRatio = 0.75; // approximate for most Latin fonts
    const baselineT = quadHeight > 0 ? (halfLeading + ascentRatio * height) / quadHeight : 1;
    const bottomLeft = {
      x: quad[0].x + (quad[3].x - quad[0].x) * baselineT,
      y: quad[0].y + (quad[3].y - quad[0].y) * baselineT,
    };

    // Text color: prefer style.color (CSS color), then style.fill
    const trueColor = getTrueColor(style.color) ?? getTrueColor(style.fill);
    const opts: Record<string, any> = {};
    if (trueColor !== undefined) opts.trueColor = String(trueColor);
    if (Math.abs(angleDeg) > 0.1) opts.rotation = angleDeg;

    const textEntity = this.dxf.addText(
      point3d(bottomLeft.x, this.flipY(bottomLeft.y)),
      height,
      sanitized,
      Object.keys(opts).length > 0 ? opts : undefined
    );

    // Assign font-specific text style if needed
    const textStyleName = this.getTextStyle(style.fontFamily);
    if (textStyleName) {
      textEntity.textStyle = textStyleName;
    }
  }

  drawImage(quad: Quad, dataUrl: string, width: number, height: number, _style: Style): void {
    // Determine file extension from data URL MIME type
    const ext = dataUrlToExtension(dataUrl);
    const idx = ++this.imageCounter;
    const fileName = `images/image${idx}.${ext}`;

    // Store the image data for external saving
    this.imageFiles.set(fileName, dataUrl);

    // Compute rotation angle from the top edge of the quad (topLeft → topRight)
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angleRad = Math.atan2(dy, dx);
    // Browser Y is down, DXF Y is up — negate the angle
    const angleDeg = -angleRad * (180 / Math.PI);

    // Compute display size from edge lengths (works for rotated quads)
    const displayWidth = Math.sqrt(dx * dx + dy * dy);
    // The scale parameter is the display size in DXF units (not a multiplier)
    const scale = displayWidth || 1;

    // Insertion point is bottom-left in DXF coords.
    // For DXF IMAGE, the insertion point is the top-left corner before rotation,
    // but in DXF Y-up coords that's quad[0] with flipped Y.
    const x = quad[0].x;
    const y = this.flipY(quad[0].y);

    this.dxf.addImage(
      fileName,
      `image${idx}`,
      point3d(x, y, 0),
      width,
      height,
      scale,
      angleDeg
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
