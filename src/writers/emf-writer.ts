/**
 * EMF (Enhanced Metafile) Writer.
 * Maps IR nodes to EMF binary records and produces an EMF file as Uint8Array.
 *
 * EMF is a Windows vector graphics format (GDI-based).
 * This writer produces a standalone EMF file with polygons, polylines, text, and images.
 *
 * Reference: [MS-EMF] Enhanced Metafile Format specification.
 */
import type { Point, Quad, Style, Writer } from "../types.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";
import { cssColorToColorRef } from "./shared/css-color.js";
import { getPointBounds, getQuadBounds, parseClipPathShape, type ClipPathBounds } from "./shared/clip-path.js";
import { getVisibleStroke, isAxisAlignedRect, parseAverageBorderRadius as parseBorderRadius } from "./shared/writer-utils.js";
import { roundedQuadPath } from "../geometry.js";

type RenderedOutline = {
  color: number;
  width: number;
  style: string;
  offset: number;
};

function getVisibleOutline(style: Style): RenderedOutline | null {
  if (!style.outlineWidth) return null;
  const width = parseFloat(style.outlineWidth);
  if (!Number.isFinite(width) || width <= 0) return null;

  const outlineStyle = style.outlineStyle === "auto" ? "solid" : style.outlineStyle;
  if (!outlineStyle || outlineStyle === "none") return null;

  const color = cssColorToColorRef(style.outlineColor ?? style.color ?? style.stroke ?? style.fill);
  if (color === null) return null;

  const offset = style.outlineOffset ? parseFloat(style.outlineOffset) : 0;
  return {
    color,
    width,
    style: outlineStyle,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

// ── Color helpers ───────────────────────────────────────────────────
// ── EMF Binary Helpers ──────────────────────────────────────────────

/** EMF record type constants. */
const EMR = {
  HEADER: 0x0001,
  POLYBEZIER: 0x0002,
  POLYGON: 0x0003,
  POLYLINE: 0x0004,
  SETWINDOWEXTEX: 0x0009,
  SETWINDOWORGEX: 0x000A,
  SAVEDC: 0x0021,
  RESTOREDC: 0x0022,
  EOF: 0x000E,
  SETMAPMODE: 0x0011,
  SETBKMODE: 0x0012,
  SETPOLYFILLMODE: 0x0013,
  SETTEXTALIGN: 0x0016,
  SETTEXTCOLOR: 0x0018,
  MOVETOEX: 0x001B,
  LINETO: 0x0036,
  SETWORLDTRANSFORM: 0x0023,
  MODIFYWORLDTRANSFORM: 0x0024,
  SELECTOBJECT: 0x0025,
  CREATEPEN: 0x0026,
  CREATEBRUSHINDIRECT: 0x0027,
  DELETEOBJECT: 0x0028,
  RECTANGLE: 0x002B,
  ROUNDRECT: 0x002C,
  ELLIPSE: 0x002E,
  SELECTCLIPPATH: 0x0043,
  BEGINPATH: 0x003B,
  ENDPATH: 0x003C,
  CLOSEFIGURE: 0x003D,
  FILLPATH: 0x003E,
  STROKEANDFILLPATH: 0x003F,
  STROKEPATH: 0x0040,
  EXTTEXTOUTW: 0x0054,
  POLYGON16: 0x0056,
  POLYLINE16: 0x0057,
  EXTCREATEFONTINDIRECTW: 0x0052,
  STRETCHDIBITS: 0x0051,
  INTERSECTCLIPRECT: 0x001E,
};

/** Brush styles. */
const BS_SOLID = 0x0000;
const BS_NULL = 0x0001;

/** Pen styles. */
const PS_SOLID = 0x0000;
const PS_DASH = 0x0001;
const PS_DOT = 0x0002;
const PS_DASHDOT = 0x0003;
const PS_NULL = 0x0005;

/** RGN_ modes for SELECTCLIPPATH. */
const RGN_AND = 0x0001;
const RGN_COPY = 0x0005;

/** Map mode: MM_TEXT (1 logical unit = 1 device pixel). */
const MM_TEXT = 0x0001;

/** Background mode: TRANSPARENT. */
const TRANSPARENT = 1;

/** Polygon fill modes. */
const ALTERNATE = 1;
const WINDING = 2;

/** Text alignment: TA_LEFT | TA_TOP. */
const TA_LEFT = 0;
const TA_TOP = 0;

/**
 * Low-level binary buffer for building EMF records.
 */
class EmfBuffer {
  private chunks: Uint8Array[] = [];
  private totalSize = 0;
  private numRecords = 0;

  /** Write a complete EMF record. */
  writeRecord(type: number, data: Uint8Array | null): void {
    const dataSize = data ? data.byteLength : 0;
    const recordSize = 8 + dataSize;
    // EMF records must be DWORD-aligned
    const padded = (recordSize + 3) & ~3;
    const buf = new Uint8Array(padded);
    const view = new DataView(buf.buffer);
    view.setUint32(0, type, true);
    view.setUint32(4, padded, true);
    if (data) buf.set(data, 8);
    this.chunks.push(buf);
    this.totalSize += padded;
    this.numRecords++;
  }

  getNumRecords(): number { return this.numRecords; }
  getTotalSize(): number { return this.totalSize; }
  getChunks(): Uint8Array[] { return this.chunks; }
}

/** Build a Uint8Array from little-endian int32 values. */
function int32Array(...values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setInt32(i * 4, values[i], true);
  }
  return buf;
}

/** Build a Uint8Array from little-endian uint32 values. */
function uint32Array(...values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint32(i * 4, values[i], true);
  }
  return buf;
}

/** Build a Uint8Array from little-endian int16 values. */
function int16Array(...values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setInt16(i * 2, values[i], true);
  }
  return buf;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

/** Encode a string as UTF-16LE. */
function encodeUtf16LE(str: string): Uint8Array {
  const buf = new Uint8Array(str.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < str.length; i++) {
    view.setUint16(i * 2, str.charCodeAt(i), true);
  }
  return buf;
}

// ── EMF Writer Options ──────────────────────────────────────────────

/** Options for the EMF writer. */
export type EMFWriterOptions = {
  /** Viewport width in pixels. */
  width: number;
  /** Viewport height in pixels. */
  height: number;
  /** Scale factor. */
  zoom?: number;
};

// ── EMF Writer Class ────────────────────────────────────────────────

export class EMFWriter implements Writer<Uint8Array> {
  private width: number;
  private height: number;
  private emf!: EmfBuffer;
  private records!: EmfBuffer;
  private nextHandle = 0;

  constructor(optionsOrWidth: EMFWriterOptions | number, height?: number, zoom?: number) {
    if (typeof optionsOrWidth === "object") {
      const z = optionsOrWidth.zoom ?? 1;
      this.width = Math.round(optionsOrWidth.width * z);
      this.height = Math.round(optionsOrWidth.height * z);
    } else {
      const z = zoom ?? 1;
      this.width = Math.round(optionsOrWidth * z);
      this.height = Math.round((height ?? 0) * z);
    }
  }

  async begin(): Promise<void> {
    this.records = new EmfBuffer();
    this.nextHandle = 0;

    // Set map mode to MM_TEXT (1:1 pixels)
    this.records.writeRecord(EMR.SETMAPMODE, uint32Array(MM_TEXT));

    // Set window origin and extents
    this.records.writeRecord(EMR.SETWINDOWORGEX, int32Array(0, 0));
    this.records.writeRecord(EMR.SETWINDOWEXTEX, int32Array(this.width, this.height));

    // Set background mode to transparent (for text rendering)
    this.records.writeRecord(EMR.SETBKMODE, uint32Array(TRANSPARENT));

    // Set text alignment: left, top
    this.records.writeRecord(EMR.SETTEXTALIGN, uint32Array(TA_LEFT | TA_TOP));
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    // Skip fully transparent elements
    if (style.opacity !== undefined && style.opacity <= 0) return;

    const fillColor = cssColorToColorRef(style.fill);
    const stroke = getVisibleStroke(style, cssColorToColorRef);
    const outline = getVisibleOutline(style);

    const clipBounds = getQuadBounds(points);

    // Check for per-side borders
    if (this.hasMixedBorders(style)) {
      // Draw fill first, then per-side borders
      if (fillColor !== null) {
        this.saveState();
        this.applyClip(style, clipBounds);
        const brushHandle = this.createBrush(fillColor);
        const penHandle = this.createPen(null);
        this.selectObject(brushHandle);
        this.selectObject(penHandle);
        const bounds = this.computeBounds(points);
        const ptData = int16Array(
          ...points.flatMap(p => [Math.round(p.x), Math.round(p.y)])
        );
        this.records.writeRecord(EMR.POLYGON16, concat(
          int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
          uint32Array(4),
          ptData
        ));
        this.deleteObject(brushHandle);
        this.deleteObject(penHandle);
        this.restoreState();
      }
      this.drawPerSideBorders(points, style);
      return;
    }

    if (fillColor === null && !stroke && !outline) return;

    this.saveState();
      if (outline) this.drawOutline(points, style, outline);
  this.applyClip(style, clipBounds);

    const emfElW = Math.abs(points[1].x - points[0].x);
    const emfElH = Math.abs(points[3].y - points[0].y);
    const radius = parseBorderRadius(style.borderRadius, emfElW, emfElH);

    // Rounded rectangle
    if (radius > 0 && isAxisAlignedRect(points) && !style.cornerShapes) {
      const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const w = Math.abs(points[1].x - points[0].x);
      const h = Math.abs(points[3].y - points[0].y);
      const r = Math.min(radius, w / 2, h / 2);

      if (fillColor !== null || stroke) {
        const brushHandle = this.createBrush(fillColor);
        const penHandle = this.createPen(stroke);
        this.selectObject(brushHandle);
        this.selectObject(penHandle);

        this.records.writeRecord(EMR.ROUNDRECT, int32Array(
          Math.round(x), Math.round(y),
          Math.round(x + w), Math.round(y + h),
          Math.round(r * 2), Math.round(r * 2)
        ));

        this.deleteObject(brushHandle);
        this.deleteObject(penHandle);
      }

      if (outline) this.drawOutline(points, style, outline);
      this.restoreState();
      return;
    }

    // Rounded quad (non-axis-aligned, or axis-aligned with corner-shape)
    if (radius > 0 && (!isAxisAlignedRect(points) || style.cornerShapes)) {
      const segs = roundedQuadPath(points, radius, style.cornerShapes);
      const verts: { x: number; y: number }[] = [];
      for (const s of segs) {
        if (s.type === "M" || s.type === "L") {
          verts.push({ x: s.x, y: s.y });
        } else if (s.type === "Q") {
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

      if (fillColor !== null || stroke) {
        const brushHandle = this.createBrush(fillColor);
        const penHandle = this.createPen(stroke);
        this.selectObject(brushHandle);
        this.selectObject(penHandle);

        const emfBounds = this.computeBoundsFromPoints(verts);
        const ptData = int16Array(
          ...verts.flatMap(p => [Math.round(p.x), Math.round(p.y)])
        );
        this.records.writeRecord(EMR.POLYGON16, concat(
          int32Array(emfBounds.left, emfBounds.top, emfBounds.right, emfBounds.bottom),
          uint32Array(verts.length),
          ptData
        ));

        this.deleteObject(brushHandle);
        this.deleteObject(penHandle);
      }

      if (outline) this.drawOutline(points, style, outline);
      this.restoreState();
      return;
    }

    // Regular polygon (quad)
    if (fillColor !== null || stroke) {
      const brushHandle = this.createBrush(fillColor);
      const penHandle = this.createPen(stroke);
      this.selectObject(brushHandle);
      this.selectObject(penHandle);

      const bounds = this.computeBounds(points);
      const ptData = int16Array(
        ...points.flatMap(p => [Math.round(p.x), Math.round(p.y)])
      );
      this.records.writeRecord(EMR.POLYGON16, concat(
        int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
        uint32Array(4),
        ptData
      ));

      this.deleteObject(brushHandle);
      this.deleteObject(penHandle);
    }

    if (outline) this.drawOutline(points, style, outline);
    this.restoreState();
  }

  private drawOutline(points: Quad, style: Style, outline: RenderedOutline): void {
    const penHandle = this.createPenStyled({ color: outline.color, width: outline.width }, undefined, outline.style);
    const nullBrush = this.createBrush(null);
    this.selectObject(nullBrush);
    this.selectObject(penHandle);

    if (isAxisAlignedRect(points) && !style.cornerShapes) {
      const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const width = Math.abs(points[1].x - points[0].x);
      const height = Math.abs(points[3].y - points[0].y);
      const padding = outline.offset + outline.width / 2;
      const radius = parseBorderRadius(style.borderRadius, width, height);
      const outlineRadius = Math.min(Math.max(radius + padding, 0), (width + padding * 2) / 2, (height + padding * 2) / 2);
      this.records.writeRecord(EMR.ROUNDRECT, int32Array(
        Math.round(minX - padding),
        Math.round(minY - padding),
        Math.round(minX + width + padding),
        Math.round(minY + height + padding),
        Math.round(outlineRadius * 2),
        Math.round(outlineRadius * 2)
      ));
    } else {
      const bounds = this.computeBounds(points);
      const ptData = int16Array(...points.flatMap((point) => [Math.round(point.x), Math.round(point.y)]));
      this.records.writeRecord(EMR.POLYGON16, concat(
        int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
        uint32Array(4),
        ptData
      ));
    }

    this.deleteObject(nullBrush);
    this.deleteObject(penHandle);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    if (points.length < 2) return;
    if (style.opacity !== undefined && style.opacity <= 0) return;

    const fillColor = cssColorToColorRef(style.fill);
    const stroke = getVisibleStroke(style, cssColorToColorRef);
    if (fillColor === null && !stroke) return;

    this.saveState();
    this.applyClip(style, getPointBounds(points));

    if (style.pathSubpaths?.length) {
      const drawableSubpaths = style.pathSubpaths.filter((subpath) => subpath.points.length >= 2);
      const hasFilledSubpath = fillColor !== null && drawableSubpaths.some((subpath) => subpath.closed && subpath.points.length >= 3);
      const brushHandle = this.createBrush(hasFilledSubpath ? fillColor : null);
      const penHandle = this.createPenStyled(
        stroke ?? (!hasFilledSubpath && fillColor !== null ? { color: fillColor, width: 1 } : null),
        style.strokeDasharray,
      );
      this.selectObject(brushHandle);
      this.selectObject(penHandle);
      this.records.writeRecord(
        EMR.SETPOLYFILLMODE,
        uint32Array(style.fillRule === "evenodd" ? ALTERNATE : WINDING),
      );
      this.records.writeRecord(EMR.BEGINPATH, null);
      for (const subpath of drawableSubpaths) {
        const bounds = this.computeBoundsFromPoints(subpath.points);
        const ptData = int16Array(
          ...subpath.points.flatMap((point) => [Math.round(point.x), Math.round(point.y)])
        );
        this.records.writeRecord(EMR.POLYLINE16, concat(
          int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
          uint32Array(subpath.points.length),
          ptData
        ));
        if (subpath.closed) {
          this.records.writeRecord(EMR.CLOSEFIGURE, null);
        }
      }
      this.records.writeRecord(EMR.ENDPATH, null);
      if (hasFilledSubpath && stroke) {
        this.records.writeRecord(EMR.STROKEANDFILLPATH, null);
      } else if (hasFilledSubpath) {
        this.records.writeRecord(EMR.FILLPATH, null);
      } else {
        this.records.writeRecord(EMR.STROKEPATH, null);
      }

      this.deleteObject(brushHandle);
      this.deleteObject(penHandle);
      this.restoreState();
      return;
    }

    if (closed && fillColor !== null && points.length >= 3) {
      // Draw as filled polygon
      const brushHandle = this.createBrush(fillColor);
      const penHandle = this.createPenStyled(stroke, style.strokeDasharray);
      this.selectObject(brushHandle);
      this.selectObject(penHandle);

      const bounds = this.computeBoundsFromPoints(points);
      const ptData = int16Array(
        ...points.flatMap(p => [Math.round(p.x), Math.round(p.y)])
      );
      this.records.writeRecord(EMR.POLYGON16, concat(
        int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
        uint32Array(points.length),
        ptData
      ));

      this.deleteObject(brushHandle);
      this.deleteObject(penHandle);
    } else {
      // Draw as polyline (stroke only)
      const penHandle = this.createPenStyled(
        stroke ?? { color: fillColor ?? 0, width: 1 },
        style.strokeDasharray
      );
      const nullBrush = this.createBrush(null);
      this.selectObject(nullBrush);
      this.selectObject(penHandle);

      const bounds = this.computeBoundsFromPoints(points);
      const ptData = int16Array(
        ...points.flatMap(p => [Math.round(p.x), Math.round(p.y)])
      );
      this.records.writeRecord(EMR.POLYLINE16, concat(
        int32Array(bounds.left, bounds.top, bounds.right, bounds.bottom),
        uint32Array(points.length),
        ptData
      ));

      this.deleteObject(nullBrush);
      this.deleteObject(penHandle);
    }

    this.restoreState();
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    const sanitized = normalizeWhitespaceAwareText(text, style);
    if (sanitized.length === 0) return;
    if (style.opacity !== undefined && style.opacity <= 0) return;

    this.saveState();
    this.applyClip(style, getQuadBounds(quad));

    // Text color
    const textColor = cssColorToColorRef(style.color) ?? cssColorToColorRef(style.fill) ?? 0x00000000;
    this.records.writeRecord(EMR.SETTEXTCOLOR, uint32Array(textColor));

    // Font metrics
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const fontSize = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    // Rotation from top edge
    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angleRad = Math.atan2(dy, dx);
    // EMF escapement/orientation in tenths of a degree, counter-clockwise
    const angleTenths = Math.round(-angleRad * (1800 / Math.PI));

    // Create font
    const fontFamily = style.fontFamily?.split(",")[0]?.trim().replace(/['"]/g, "") || "Arial";
    const isBold = style.fontWeight === "bold" || !!(style.fontWeight && parseInt(style.fontWeight) >= 700);
    const isItalic = style.fontStyle === "italic" || style.fontStyle === "oblique";

    const fontHandle = this.createFont(Math.round(fontSize), angleTenths, fontFamily, isBold, !!isItalic);
    this.selectObject(fontHandle);

    // Position: top-left of the text, offset by half-leading
    const halfLeading = Math.max(0, (quadHeight - fontSize) / 2);
    const t = quadHeight > 0 ? halfLeading / quadHeight : 0;
    const x = Math.round(quad[0].x + (quad[3].x - quad[0].x) * t);
    const y = Math.round(quad[0].y + (quad[3].y - quad[0].y) * t);

    // EMR_EXTTEXTOUTW record
    const textUtf16 = encodeUtf16LE(sanitized);
    const nChars = sanitized.length;

    // rclBounds (text bounding rect — approximate)
    const bounds = this.computeBounds(quad);

    // Build the EMRTEXT structure
    // ptlReference: POINTL
    // nChars: UINT32
    // offString: UINT32 (offset from start of record data to string)
    // fOptions: UINT32 (0 = no clipping/opaque)
    // rcl: RECTL (optional clipping rect — set to same as bounds)
    // offDx: UINT32 (offset to intercharacter spacing array, 0 = none)

    // Record data layout after the 8-byte record header:
    // [0..15]   rclBounds (4 × int32)
    // [16..19]  iGraphicsMode (1 = GM_COMPATIBLE)
    // [20..23]  exScale (float, 0 for MM_TEXT)
    // [24..27]  eyScale (float, 0 for MM_TEXT)
    // [28..35]  EMRTEXT.ptlReference (2 × int32 = x, y)
    // [36..39]  EMRTEXT.nChars
    // [40..43]  EMRTEXT.offString (offset from record start)
    // [44..47]  EMRTEXT.fOptions
    // [48..63]  EMRTEXT.rcl (4 × int32 — clipping rect)
    // [64..67]  EMRTEXT.offDx (0 = no spacing array)
    // [68..]    string data (UTF-16LE)

    const offString = 8 + 68; // record header (8) + data before string (68)
    const recordData = new Uint8Array(68 + textUtf16.byteLength);
    const dv = new DataView(recordData.buffer);

    // rclBounds
    dv.setInt32(0, bounds.left, true);
    dv.setInt32(4, bounds.top, true);
    dv.setInt32(8, bounds.right, true);
    dv.setInt32(12, bounds.bottom, true);

    // iGraphicsMode = GM_COMPATIBLE (1)
    dv.setUint32(16, 1, true);
    // exScale, eyScale = 0.0 for MM_TEXT
    dv.setFloat32(20, 0.0, true);
    dv.setFloat32(24, 0.0, true);

    // EMRTEXT
    dv.setInt32(28, x, true);      // ptlReference.x
    dv.setInt32(32, y, true);      // ptlReference.y
    dv.setUint32(36, nChars, true); // nChars
    dv.setUint32(40, offString, true); // offString
    dv.setUint32(44, 0, true);     // fOptions
    // rcl
    dv.setInt32(48, bounds.left, true);
    dv.setInt32(52, bounds.top, true);
    dv.setInt32(56, bounds.right, true);
    dv.setInt32(60, bounds.bottom, true);
    // offDx
    dv.setUint32(64, 0, true);

    // String data
    recordData.set(textUtf16, 68);

    this.records.writeRecord(EMR.EXTTEXTOUTW, recordData);
    this.deleteObject(fontHandle);
    this.restoreState();
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    if (!rgbData || rgbData.length === 0) return;
    if (style.opacity !== undefined && style.opacity <= 0) return;

    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const displayW = Math.sqrt(dx * dx + dy * dy);
    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const displayH = Math.sqrt(ldx * ldx + ldy * ldy);
    if (displayW <= 0 || displayH <= 0) return;

    this.saveState();
    this.applyClip(style, getQuadBounds(quad));

    // Apply rotation via world transform if the quad is rotated
    const angle = Math.atan2(dy, dx);
    if (Math.abs(angle) > 0.01) {
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cx = quad[0].x;
      const cy = quad[0].y;
      // Rotation around (cx, cy): maps (cx, cy) → (cx, cy), (cx+w, cy) → rotated right edge
      this.setWorldTransform(
        cosA, sinA, -sinA, cosA,
        cx * (1 - cosA) + cy * sinA,
        cy * (1 - cosA) - cx * sinA
      );
    }

    const x = Math.round(quad[0].x);
    const y = Math.round(quad[0].y);

    // Build a 24-bit uncompressed DIB from rgbData (RGB → BGR, row-padded)
    const bmpHeaderSize = 40; // BITMAPINFOHEADER
    const rowBytes = ((width * 3 + 3) & ~3); // rows padded to 4-byte boundary
    const bmpDataSize = rowBytes * height;

    const dib = new Uint8Array(bmpHeaderSize + bmpDataSize);
    const dibView = new DataView(dib.buffer);

    // BITMAPINFOHEADER
    dibView.setUint32(0, 40, true);        // biSize
    dibView.setInt32(4, width, true);       // biWidth
    dibView.setInt32(8, -height, true);     // biHeight (negative = top-down)
    dibView.setUint16(12, 1, true);        // biPlanes
    dibView.setUint16(14, 24, true);       // biBitCount (24-bit RGB)
    dibView.setUint32(16, 0, true);        // biCompression (BI_RGB)
    dibView.setUint32(20, bmpDataSize, true); // biSizeImage
    dibView.setUint32(24, 0, true);        // biXPelsPerMeter
    dibView.setUint32(28, 0, true);        // biYPelsPerMeter
    dibView.setUint32(32, 0, true);        // biClrUsed
    dibView.setUint32(36, 0, true);        // biClrImportant

    // Convert RGB to BGR row data with padding
    const pixelOffset = bmpHeaderSize;
    for (let row = 0; row < height; row++) {
      const srcRowStart = row * width * 3;
      const dstRowStart = pixelOffset + row * rowBytes;
      for (let col = 0; col < width; col++) {
        const si = srcRowStart + col * 3;
        const di = dstRowStart + col * 3;
        dib[di] = rgbData[si + 2];     // B
        dib[di + 1] = rgbData[si + 1]; // G
        dib[di + 2] = rgbData[si];     // R
      }
    }

    // Record data layout for EMR_STRETCHDIBITS:
    // rclBounds (4 × int32)
    // xDest, yDest (int32)
    // xSrc, ySrc (int32)
    // cxSrc, cySrc (int32)
    // offBmiSrc (uint32) — offset from record start to BITMAPINFO
    // cbBmiSrc (uint32) — size of BITMAPINFO
    // offBitsSrc (uint32) — offset from record start to bitmap bits
    // cbBitsSrc (uint32) — size of bitmap bits
    // iUsageSrc (uint32) — DIB_RGB_COLORS = 0
    // dwRop (uint32) — SRCCOPY = 0x00CC0020
    // cxDest, cyDest (int32) — destination width/height

    const headerDataSize = 72; // fixed EMRSTRETCHDIBITS fields before DIB data
    const offBmi = 8 + headerDataSize; // offset from record start
    const offBits = offBmi + bmpHeaderSize;
    const recordData = new Uint8Array(headerDataSize + bmpHeaderSize + bmpDataSize);
    const rv = new DataView(recordData.buffer);

    const bounds = this.computeBounds(quad);
    // rclBounds
    rv.setInt32(0, bounds.left, true);
    rv.setInt32(4, bounds.top, true);
    rv.setInt32(8, bounds.right, true);
    rv.setInt32(12, bounds.bottom, true);
    // xDest, yDest
    rv.setInt32(16, x, true);
    rv.setInt32(20, y, true);
    // xSrc, ySrc
    rv.setInt32(24, 0, true);
    rv.setInt32(28, 0, true);
    // cxSrc, cySrc
    rv.setInt32(32, width, true);
    rv.setInt32(36, height, true);
    // offBmiSrc
    rv.setUint32(40, offBmi, true);
    // cbBmiSrc
    rv.setUint32(44, bmpHeaderSize, true);
    // offBitsSrc
    rv.setUint32(48, offBits, true);
    // cbBitsSrc
    rv.setUint32(52, bmpDataSize, true);
    // iUsageSrc (DIB_RGB_COLORS)
    rv.setUint32(56, 0, true);
    // dwRop = SRCCOPY
    rv.setUint32(60, 0x00CC0020, true);
    // cxDest, cyDest
    rv.setInt32(64, Math.round(displayW), true);
    rv.setInt32(68, Math.round(displayH), true);

    // Copy DIB header + pixel data
    recordData.set(dib.subarray(0, bmpHeaderSize), headerDataSize);
    recordData.set(dib.subarray(bmpHeaderSize), headerDataSize + bmpHeaderSize);

    this.records.writeRecord(EMR.STRETCHDIBITS, recordData);
    this.restoreState();
  }

  async end(): Promise<Uint8Array> {
    // Write EOF record
    this.records.writeRecord(EMR.EOF, uint32Array(0, 0, 20)); // nPalEntries=0, offPalEntries=0, nSizeLast=20

    // Build the EMF header
    const nRecords = this.records.getNumRecords() + 1; // +1 for the header record itself
    const bodySize = this.records.getTotalSize();

    // EMF header record data (beyond the 8-byte record type+size):
    // rclBounds: RECTL (4 × int32) — inclusive-inclusive bounding rect in device units
    // rclFrame:  RECTL (4 × int32) — bounding rect in 0.01mm units
    // dSignature: UINT32 = 0x464D4520 (' EMF')
    // nVersion:  UINT32 = 0x00010000
    // nBytes:    UINT32 — total file size
    // nRecords:  UINT32
    // nHandles:  UINT16
    // sReserved: UINT16
    // nDescription: UINT32
    // offDescription: UINT32
    // nPalEntries: UINT32
    // szlDevice:  SIZEL (2 × int32) — reference device size in pixels
    // szlMillimeters: SIZEL (2 × int32) — reference device size in mm

    const headerDataSize = 80;
    const headerRecordSize = 8 + headerDataSize;
    const totalSize = headerRecordSize + bodySize;

    const headerData = new Uint8Array(headerDataSize);
    const hv = new DataView(headerData.buffer);

    // rclBounds (device units, inclusive)
    hv.setInt32(0, 0, true);     // left
    hv.setInt32(4, 0, true);     // top
    hv.setInt32(8, this.width - 1, true);  // right
    hv.setInt32(12, this.height - 1, true); // bottom

    // rclFrame (0.01mm units, approximate: assume 96 DPI → 1px = 0.2646mm = 26.46 × 0.01mm)
    const pxToHundredthMm = 2646 / 100;
    hv.setInt32(16, 0, true);
    hv.setInt32(20, 0, true);
    hv.setInt32(24, Math.round(this.width * pxToHundredthMm), true);
    hv.setInt32(28, Math.round(this.height * pxToHundredthMm), true);

    // Signature: ' EMF' = 0x464D4520
    hv.setUint32(32, 0x464D4520, true);
    // Version
    hv.setUint32(36, 0x00010000, true);
    // Total file size
    hv.setUint32(40, totalSize, true);
    // Number of records
    hv.setUint32(44, nRecords, true);
    // Number of handles
    hv.setUint16(48, this.nextHandle + 1, true);
    // Reserved
    hv.setUint16(50, 0, true);
    // Description (none)
    hv.setUint32(52, 0, true); // nDescription
    hv.setUint32(56, 0, true); // offDescription
    // Palette entries
    hv.setUint32(60, 0, true);
    // Reference device: 1920×1080 pixels
    hv.setInt32(64, 1920, true);
    hv.setInt32(68, 1080, true);
    // Reference device: mm (approximate for 96 DPI)
    hv.setInt32(72, 508, true);  // ~508mm ≈ 20 inches
    hv.setInt32(76, 285, true);  // ~285mm ≈ 11.25 inches

    // Assemble the complete file
    const output = new Uint8Array(totalSize);
    const headerRecord = new Uint8Array(headerRecordSize);
    const hrv = new DataView(headerRecord.buffer);
    hrv.setUint32(0, EMR.HEADER, true);
    hrv.setUint32(4, headerRecordSize, true);
    headerRecord.set(headerData, 8);

    output.set(headerRecord, 0);
    let offset = headerRecordSize;
    for (const chunk of this.records.getChunks()) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return output;
  }

  // ── Private GDI object helpers ────────────────────────────────────

  private allocHandle(): number {
    return this.nextHandle++;
  }

  /** Create a solid brush or null brush. Returns handle index. */
  private createBrush(color: number | null): number {
    const handle = this.allocHandle();
    if (color === null) {
      // Null brush (no fill)
      this.records.writeRecord(EMR.CREATEBRUSHINDIRECT, concat(
        uint32Array(handle),      // ihBrush (handle index)
        uint32Array(BS_NULL),     // lbStyle
        uint32Array(0),           // lbColor
        uint32Array(0)            // lbHatch
      ));
    } else {
      this.records.writeRecord(EMR.CREATEBRUSHINDIRECT, concat(
        uint32Array(handle),
        uint32Array(BS_SOLID),
        uint32Array(color),
        uint32Array(0)
      ));
    }
    return handle;
  }

  /** Create a pen. Returns handle index. */
  private createPen(stroke: { color: number; width: number } | null): number {
    const handle = this.allocHandle();
    if (!stroke) {
      this.records.writeRecord(EMR.CREATEPEN, concat(
        uint32Array(handle),      // ihPen
        uint32Array(PS_NULL),     // lopnStyle
        int32Array(0, 0),         // lopnWidth (POINT: x, y — y is ignored)
        uint32Array(0)            // lopnColor
      ));
    } else {
      this.records.writeRecord(EMR.CREATEPEN, concat(
        uint32Array(handle),
        uint32Array(PS_SOLID),
        int32Array(Math.round(stroke.width), 0),
        uint32Array(stroke.color)
      ));
    }
    return handle;
  }

  /** Create a pen with an optional dash style from strokeDasharray or border style. */
  private createPenStyled(
    stroke: { color: number; width: number } | null,
    dasharray?: string,
    borderStyle?: string
  ): number {
    if (!stroke) return this.createPen(null);

    let penStyle = PS_SOLID;
    if (dasharray && dasharray !== "none") {
      // SVG stroke-dasharray: approximate as PS_DASH or PS_DOT
      const dashes = dasharray.split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n >= 0);
      if (dashes.length > 0) {
        const maxDash = Math.max(...dashes);
        penStyle = maxDash > stroke.width * 2 ? PS_DASH : PS_DOT;
      }
    } else if (borderStyle === "dashed") {
      penStyle = PS_DASH;
    } else if (borderStyle === "dotted") {
      penStyle = PS_DOT;
    }

    const handle = this.allocHandle();
    this.records.writeRecord(EMR.CREATEPEN, concat(
      uint32Array(handle),
      uint32Array(penStyle),
      int32Array(Math.round(stroke.width), 0),
      uint32Array(stroke.color)
    ));
    return handle;
  }

  /** Save the current GDI state (DC). */
  private saveState(): void {
    this.records.writeRecord(EMR.SAVEDC, null);
  }

  /** Restore the previously saved GDI state (DC). */
  private restoreState(): void {
    // RESTOREDC with -1 restores the most recently saved state
    this.records.writeRecord(EMR.RESTOREDC, int32Array(-1));
  }

  /** Apply clip bounds and clip-path shapes from style. */
  private applyClip(style: Style, bounds?: ClipPathBounds): void {
    let hasClip = false;

    if (style.clipQuads?.length) {
      for (const clipQuad of style.clipQuads) {
        this.applyPolygonClipPath(clipQuad.points, hasClip ? RGN_AND : RGN_COPY);
        hasClip = true;
      }
    }

    const clip = style.clipBounds;
    if (clip) {
      // Use INTERSECTCLIPRECT for rectangular clipping (simpler and more compatible)
      this.records.writeRecord(EMR.INTERSECTCLIPRECT, int32Array(
        Math.round(clip.x),
        Math.round(clip.y),
        Math.round(clip.x + clip.w),
        Math.round(clip.y + clip.h)
      ));
      hasClip = true;
    }

    const clipShape = bounds ? parseClipPathShape(style.clipPath, bounds) : null;
    if (!clipShape) return;

    if (clipShape.kind === "polygon") {
      this.records.writeRecord(
        EMR.SETPOLYFILLMODE,
        uint32Array(clipShape.fillRule === "evenodd" ? ALTERNATE : WINDING),
      );
      this.applyPolygonClipPath(clipShape.points, hasClip ? RGN_AND : RGN_COPY);
      return;
    }

    switch (clipShape.kind) {
      case "inset":
        this.applyPolygonClipPath(
          this.buildRoundedRectClipPoints(
            clipShape.x,
            clipShape.y,
            clipShape.w,
            clipShape.h,
            clipShape.rx,
            clipShape.ry,
          ),
          hasClip ? RGN_AND : RGN_COPY,
        );
        break;
      case "ellipse":
        this.applyPolygonClipPath(
          this.buildEllipseClipPoints(clipShape.cx, clipShape.cy, clipShape.rx, clipShape.ry),
          hasClip ? RGN_AND : RGN_COPY,
        );
        break;
    }
  }

  private applyPolygonClipPath(points: Point[], combineMode: number): void {
    const shapeBounds = this.computeBoundsFromPoints(points);
    const ptData = int16Array(
      ...points.flatMap((point) => [Math.round(point.x), Math.round(point.y)])
    );

    this.records.writeRecord(EMR.BEGINPATH, null);
    this.records.writeRecord(EMR.POLYGON16, concat(
      int32Array(shapeBounds.left, shapeBounds.top, shapeBounds.right, shapeBounds.bottom),
      uint32Array(points.length),
      ptData,
    ));
    this.records.writeRecord(EMR.ENDPATH, null);
    this.records.writeRecord(EMR.SELECTCLIPPATH, uint32Array(combineMode));
  }

  private buildEllipseClipPoints(cx: number, cy: number, rx: number, ry: number, segments = 32): Point[] {
    const points: Point[] = [];

    for (let index = 0; index < segments; index += 1) {
      const angle = (-Math.PI / 2) + (Math.PI * 2 * index) / segments;
      points.push({
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
      });
    }

    return points;
  }

  private buildRoundedRectClipPoints(
    x: number,
    y: number,
    w: number,
    h: number,
    rx: number,
    ry: number,
    segmentsPerCorner = 6,
  ): Point[] {
    const clampedRx = Math.max(0, Math.min(rx, w / 2));
    const clampedRy = Math.max(0, Math.min(ry, h / 2));

    if (clampedRx === 0 || clampedRy === 0) {
      return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    }

    const points: Point[] = [
      { x: x + clampedRx, y },
      { x: x + w - clampedRx, y },
    ];

    this.appendArcPoints(points, x + w - clampedRx, y + clampedRy, clampedRx, clampedRy, -Math.PI / 2, 0, segmentsPerCorner);
    points.push({ x: x + w, y: y + h - clampedRy });
    this.appendArcPoints(points, x + w - clampedRx, y + h - clampedRy, clampedRx, clampedRy, 0, Math.PI / 2, segmentsPerCorner);
    points.push({ x: x + clampedRx, y: y + h });
    this.appendArcPoints(points, x + clampedRx, y + h - clampedRy, clampedRx, clampedRy, Math.PI / 2, Math.PI, segmentsPerCorner);
    points.push({ x, y: y + clampedRy });
    this.appendArcPoints(points, x + clampedRx, y + clampedRy, clampedRx, clampedRy, Math.PI, (Math.PI * 3) / 2, segmentsPerCorner);

    return points;
  }

  private appendArcPoints(
    points: Point[],
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    startAngle: number,
    endAngle: number,
    segments: number,
  ): void {
    for (let index = 1; index <= segments; index += 1) {
      const ratio = index / segments;
      const angle = startAngle + (endAngle - startAngle) * ratio;
      points.push({
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
      });
    }
  }

  /**
   * Set the world-space to page-space transform (XFORM matrix).
   * Used for rotating images. The XFORM is 6 × FLOAT32: eM11, eM12, eM21, eM22, eDx, eDy.
   *
   * Page coordinates: page_x = world_x * eM11 + world_y * eM21 + eDx
   *                   page_y = world_x * eM12 + world_y * eM22 + eDy
   */
  private setWorldTransform(eM11: number, eM12: number, eM21: number, eM22: number, eDx: number, eDy: number): void {
    const data = new Uint8Array(24);
    const dv = new DataView(data.buffer);
    dv.setFloat32(0, eM11, true);
    dv.setFloat32(4, eM12, true);
    dv.setFloat32(8, eM21, true);
    dv.setFloat32(12, eM22, true);
    dv.setFloat32(16, eDx, true);
    dv.setFloat32(20, eDy, true);
    this.records.writeRecord(EMR.SETWORLDTRANSFORM, data);
  }

  /** Check if borders have different colors/widths/styles per side. */
  private hasMixedBorders(style: Style): boolean {
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
  private drawPerSideBorders(points: Quad, style: Style): void {
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
      const color = cssColorToColorRef(side.color);
      const w = side.width ? parseFloat(side.width) : 0;
      if (color === null || w <= 0 || !side.borderStyle || side.borderStyle === "none" || side.borderStyle === "hidden") continue;

      const stroke = { color, width: w };

      if (side.borderStyle === "double" && w >= 3) {
        const lineW = Math.max(1, w / 3);
        const dx = side.to.x - side.from.x;
        const dy = side.to.y - side.from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len <= 0) continue;
        const nx = -dy / len;
        const ny = dx / len;
        const off = w / 3;

        // Outer line
        const outerPen = this.createPen({ color, width: lineW });
        const nullBrush1 = this.createBrush(null);
        this.selectObject(nullBrush1);
        this.selectObject(outerPen);
        this.records.writeRecord(EMR.MOVETOEX, int32Array(
          Math.round(side.from.x - nx * off), Math.round(side.from.y - ny * off)
        ));
        this.records.writeRecord(EMR.LINETO, int32Array(
          Math.round(side.to.x - nx * off), Math.round(side.to.y - ny * off)
        ));
        this.deleteObject(nullBrush1);
        this.deleteObject(outerPen);

        // Inner line
        const innerPen = this.createPen({ color, width: lineW });
        const nullBrush2 = this.createBrush(null);
        this.selectObject(nullBrush2);
        this.selectObject(innerPen);
        this.records.writeRecord(EMR.MOVETOEX, int32Array(
          Math.round(side.from.x + nx * off), Math.round(side.from.y + ny * off)
        ));
        this.records.writeRecord(EMR.LINETO, int32Array(
          Math.round(side.to.x + nx * off), Math.round(side.to.y + ny * off)
        ));
        this.deleteObject(nullBrush2);
        this.deleteObject(innerPen);
      } else {
        // Solid, dashed, or dotted single line
        const penHandle = this.createPenStyled(stroke, undefined, side.borderStyle);
        const nullBrush = this.createBrush(null);
        this.selectObject(nullBrush);
        this.selectObject(penHandle);

        this.records.writeRecord(EMR.MOVETOEX, int32Array(
          Math.round(side.from.x), Math.round(side.from.y)
        ));
        this.records.writeRecord(EMR.LINETO, int32Array(
          Math.round(side.to.x), Math.round(side.to.y)
        ));

        this.deleteObject(nullBrush);
        this.deleteObject(penHandle);
      }
    }
  }

  /** Create a font. Returns handle index. */
  private createFont(height: number, escapement: number, faceName: string, bold: boolean, italic: boolean): number {
    const handle = this.allocHandle();

    // EMR_EXTCREATEFONTINDIRECTW requires a full EXTLOGFONTW payload.
    // We populate the LOGFONTW prefix and leave the extension fields zeroed.

    // LOGFONTW layout (92 bytes):
    // lfHeight (int32), lfWidth (int32), lfEscapement (int32), lfOrientation (int32),
    // lfWeight (int32), lfItalic (uint8), lfUnderline (uint8), lfStrikeOut (uint8),
    // lfCharSet (uint8), lfOutPrecision (uint8), lfClipPrecision (uint8),
    // lfQuality (uint8), lfPitchAndFamily (uint8),
    // lfFaceName (64 bytes = 32 UTF-16LE chars)

    const extLogFont = new Uint8Array(320);
    const lfv = new DataView(extLogFont.buffer);
    lfv.setInt32(0, -height, true); // lfHeight (negative = character height)
    lfv.setInt32(4, 0, true);       // lfWidth
    lfv.setInt32(8, escapement, true);  // lfEscapement
    lfv.setInt32(12, escapement, true); // lfOrientation
    lfv.setInt32(16, bold ? 700 : 400, true); // lfWeight
    extLogFont[20] = italic ? 1 : 0; // lfItalic
    extLogFont[21] = 0;              // lfUnderline
    extLogFont[22] = 0;              // lfStrikeOut
    extLogFont[23] = 1;              // lfCharSet = DEFAULT_CHARSET
    extLogFont[24] = 0;              // lfOutPrecision = OUT_DEFAULT_PRECIS
    extLogFont[25] = 0;              // lfClipPrecision
    extLogFont[26] = 0;              // lfQuality = DEFAULT_QUALITY
    extLogFont[27] = 0;              // lfPitchAndFamily = DEFAULT_PITCH

    // lfFaceName: up to 31 chars + null (32 UTF-16LE chars = 64 bytes)
    const nameBytes = encodeUtf16LE(faceName.slice(0, 31));
    extLogFont.set(nameBytes, 28);

    this.records.writeRecord(EMR.EXTCREATEFONTINDIRECTW, concat(
      uint32Array(handle),
      extLogFont
    ));
    return handle;
  }

  private selectObject(handle: number): void {
    this.records.writeRecord(EMR.SELECTOBJECT, uint32Array(handle));
  }

  private deleteObject(handle: number): void {
    this.records.writeRecord(EMR.DELETEOBJECT, uint32Array(handle));
  }

  private computeBounds(quad: Quad): { left: number; top: number; right: number; bottom: number } {
    const xs = quad.map(p => p.x);
    const ys = quad.map(p => p.y);
    return {
      left: Math.round(Math.min(...xs)),
      top: Math.round(Math.min(...ys)),
      right: Math.round(Math.max(...xs)),
      bottom: Math.round(Math.max(...ys)),
    };
  }

  private computeBoundsFromPoints(points: Point[]): { left: number; top: number; right: number; bottom: number } {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const p of points) {
      if (p.x < left) left = p.x;
      if (p.y < top) top = p.y;
      if (p.x > right) right = p.x;
      if (p.y > bottom) bottom = p.y;
    }
    return {
      left: Math.round(left), top: Math.round(top),
      right: Math.round(right), bottom: Math.round(bottom),
    };
  }
}
