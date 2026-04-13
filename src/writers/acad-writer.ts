/**
 * Shared AutoCAD document builder for DWG and DXF writers using @node-projects/acad-ts.
 * Builds a CadDocument from IR nodes with LwPolyline, Hatch, TextEntity entities.
 */

// Type-only imports for static typing
import type {
  CadDocument as CadDocumentType,
  ACadVersion as ACadVersionType,
  LwPolyline as LwPolylineType,
  LwPolylineVertex as LwPolylineVertexType,
  Hatch as HatchType,
  HatchBoundaryPath as HatchBoundaryPathType,
  HatchBoundaryPathPolyline as HatchBoundaryPathPolylineType,
  HatchPattern as HatchPatternType,
  HatchPatternType as HatchPatternTypeEnumType,
  TextEntity as TextEntityType,
  Color as ColorType,
  XY as XYType,
  XYZ as XYZType,
  DwgWriter as DwgWriterType,
  DxfWriter as AcadDxfWriterType,
} from "@node-projects/acad-ts";

import type { Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath } from "../geometry.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";
import { parseCssColor, type ParsedCssColor } from "./shared/css-color.js";
import { getVisibleStroke, isAxisAlignedRect, parseAverageBorderRadius as parseBorderRadius } from "./shared/writer-utils.js";

// Lazy-loaded dependencies
let CadDocument: typeof CadDocumentType | undefined;
let ACadVersion: typeof ACadVersionType | undefined;
let LwPolyline: typeof LwPolylineType | undefined;
let LwPolylineVertex: typeof LwPolylineVertexType | undefined;
let Hatch: typeof HatchType | undefined;
let HatchBoundaryPath: typeof HatchBoundaryPathType | undefined;
let HatchBoundaryPathPolyline: typeof HatchBoundaryPathPolylineType | undefined;
let HatchPattern: typeof HatchPatternType | undefined;
let HatchPatternTypeEnum: typeof HatchPatternTypeEnumType | undefined;
let TextEntity: typeof TextEntityType | undefined;
let Color: typeof ColorType | undefined;
let XY: typeof XYType | undefined;
let XYZ: typeof XYZType | undefined;
let DwgWriter: typeof DwgWriterType | undefined;
let AcadDxfWriter: typeof AcadDxfWriterType | undefined;

async function ensureAcadLoaded() {
  if (!CadDocument) {
    const acad = await import("@node-projects/acad-ts");
    CadDocument = acad.CadDocument;
    ACadVersion = acad.ACadVersion;
    LwPolyline = acad.LwPolyline;
    LwPolylineVertex = acad.LwPolylineVertex;
    Hatch = acad.Hatch;
    HatchBoundaryPath = acad.HatchBoundaryPath;
    HatchBoundaryPathPolyline = acad.HatchBoundaryPathPolyline;
    HatchPattern = acad.HatchPattern;
    HatchPatternTypeEnum = acad.HatchPatternType;
    TextEntity = acad.TextEntity;
    Color = acad.Color;
    XY = acad.XY;
    XYZ = acad.XYZ;
    DwgWriter = acad.DwgWriter;
    AcadDxfWriter = acad.DxfWriter;
  }
}

/** Convert CSS color to acad-ts Color (true color). Returns undefined for invisible colors. */
function cssToAcadColor(color: string | undefined): InstanceType<typeof ColorType> | undefined {
  const parsed = parseCssColor(color);
  if (!parsed || parsed.a <= 0) return undefined;
  return new Color!(parsed.r, parsed.g, parsed.b);
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

/** Options for the Acad-based writers. */
export type AcadWriterOptions = {
  /** The maximum Y coordinate (viewport height) for Y-axis flipping. */
  maxY?: number;
  /** Scale factor applied to the maxY coordinate. */
  zoom?: number;
  /** AutoCAD version for the output file. */
  acadVersion?: ACadVersionType; // Default to AutoCAD 2018 version for broad compatibility
};

/**
 * Internal shared writer that builds a CadDocument from IR.
 * Used by both AcadDXFWriter and DWGWriter.
 */
class AcadDocumentBuilder implements Writer<InstanceType<typeof CadDocumentType>> {
  private doc!: InstanceType<typeof CadDocumentType>;
  private maxY: number;
  private acadVersion?: ACadVersionType;

  constructor(options?: AcadWriterOptions) {
    const z = options?.zoom ?? 1;
    this.maxY = (options?.maxY ?? 1000) * z;
    this.acadVersion = options?.acadVersion ?? ACadVersion?.AC1018;
  }

  async begin(): Promise<void> {
    await ensureAcadLoaded();
    this.doc = new CadDocument!(this.acadVersion!);
    this.doc.createDefaults();
  }

  /** Flip Y coordinate for DXF/DWG (Y-up) coordinate system. */
  private flipY(y: number): number {
    return this.maxY - y;
  }

  /** Create a LwPolyline from vertices. */
  private createPolyline(verts: { x: number; y: number }[], closed: boolean, color?: InstanceType<typeof ColorType>): void {
    const xyVerts = verts.map(v => new XY!(v.x, this.flipY(v.y)));
    const poly = new LwPolyline!(xyVerts);
    poly.isClosed = closed;
    if (color) poly.color = color;
    this.doc.modelSpace.entities.add(poly);
  }

  /** Add a solid-filled HATCH for the given vertices. */
  private addSolidHatch(verts: { x: number; y: number }[], fillColor: InstanceType<typeof ColorType>): void {
    const hatch = new Hatch!();
    hatch.isSolid = true;
    hatch.patternType = HatchPatternTypeEnum!.SolidFill;
    hatch.pattern = HatchPattern!.Solid;
    hatch.color = fillColor;

    const boundaryEdge = new HatchBoundaryPathPolyline!();
    boundaryEdge.isClosed = true;
    boundaryEdge.vertices = verts.map(v => new XYZ!(v.x, this.flipY(v.y), 0));

    const path = new HatchBoundaryPath!([boundaryEdge]);
    hatch.paths.push(path);
    this.doc.modelSpace.entities.add(hatch);
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const fillColor = cssToAcadColor(style.fill);
    const stroke = getVisibleStroke(style, (c) => cssToAcadColor(c));
    const strokeColor = stroke?.color;
    const trueColor = strokeColor ?? fillColor;
    const fillVisible = fillColor !== undefined;

    if (!fillVisible && !stroke) return;

    const dxfElW = Math.abs(points[1].x - points[0].x);
    const dxfElH = Math.abs(points[3].y - points[0].y);
    const radius = parseBorderRadius(style.borderRadius, dxfElW, dxfElH);

    if (radius > 0 && isAxisAlignedRect(points)) {
      const x = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const y = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const w = Math.abs(points[1].x - points[0].x);
      const h = Math.abs(points[3].y - points[0].y);
      const r = Math.min(radius, w / 2, h / 2);
      const ARC_SEGS = 8;

      const verts: { x: number; y: number }[] = [];
      verts.push({ x: x + r, y: y });
      verts.push({ x: x + w - r, y: y });
      verts.push(...arcPoints(x + w - r, y + r, r, -Math.PI / 2, 0, ARC_SEGS));
      verts.push({ x: x + w, y: y + h - r });
      verts.push(...arcPoints(x + w - r, y + h - r, r, 0, Math.PI / 2, ARC_SEGS));
      verts.push({ x: x + r, y: y + h });
      verts.push(...arcPoints(x + r, y + h - r, r, Math.PI / 2, Math.PI, ARC_SEGS));
      verts.push({ x: x, y: y + r });
      verts.push(...arcPoints(x + r, y + r, r, Math.PI, Math.PI * 1.5, ARC_SEGS));

      if (fillVisible && fillColor) this.addSolidHatch(verts, fillColor);
      this.createPolyline(verts, true, trueColor);
      return;
    }

    if (radius > 0 && !isAxisAlignedRect(points)) {
      const segs = roundedQuadPath(points, radius);
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
      if (fillVisible && fillColor) this.addSolidHatch(verts, fillColor);
      this.createPolyline(verts, true, trueColor);
      return;
    }

    const verts = points.map(p => ({ x: p.x, y: p.y }));
    if (fillVisible && fillColor) this.addSolidHatch(verts, fillColor);
    this.createPolyline(verts, true, trueColor);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    const fillColor = cssToAcadColor(style.fill);
    const stroke = getVisibleStroke(style, (c) => cssToAcadColor(c));
    const strokeColor = stroke?.color;
    const fillVisible = fillColor !== undefined;

    if (!fillVisible && !stroke) return;

    if (closed && fillVisible && fillColor && points.length >= 3) {
      this.addSolidHatch(
        points.map(p => ({ x: p.x, y: p.y })),
        fillColor,
      );
    }

    const trueColor = strokeColor ?? fillColor;
    this.createPolyline(
      points.map(p => ({ x: p.x, y: p.y })),
      closed,
      trueColor,
    );
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    const sanitized = normalizeWhitespaceAwareText(text, style);
    if (sanitized.length === 0) return;

    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const angleRad = Math.atan2(dy, dx);
    const angleDeg = -angleRad * (180 / Math.PI);

    const ldx = quad[3].x - quad[0].x;
    const ldy = quad[3].y - quad[0].y;
    const quadHeight = Math.sqrt(ldx * ldx + ldy * ldy) || 12;

    const styleFontSize = style.fontSize ? parseFloat(style.fontSize) : 12;
    const height = quadHeight > 0 ? Math.min(styleFontSize, quadHeight) : styleFontSize;

    const halfLeading = Math.max(0, (quadHeight - height) / 2);
    const ascentRatio = 0.75;
    const baselineT = quadHeight > 0 ? (halfLeading + ascentRatio * height) / quadHeight : 1;
    const bottomLeft = {
      x: quad[0].x + (quad[3].x - quad[0].x) * baselineT,
      y: quad[0].y + (quad[3].y - quad[0].y) * baselineT,
    };

    const textColor = cssToAcadColor(style.color) ?? cssToAcadColor(style.fill);

    const entity = new TextEntity!();
    entity.insertPoint = new XYZ!(bottomLeft.x, this.flipY(bottomLeft.y), 0);
    entity.height = height;
    entity.value = sanitized;
    if (Math.abs(angleDeg) > 0.1) entity.rotation = angleDeg;
    if (textColor) entity.color = textColor;

    this.doc.modelSpace.entities.add(entity);
  }

  async drawImage(_quad: Quad, _dataUrl: string, _width: number, _height: number, _style: Style): Promise<void> {
    // Image embedding in acad-ts CadDocument is not straightforward — skip for now.
    // The polyline/hatch/text entities cover the main vector use case.
  }

  async end(): Promise<InstanceType<typeof CadDocumentType>> {
    return this.doc;
  }
}

/** Options for the DWG writer. */
export type DWGWriterOptions = AcadWriterOptions;

/**
 * DWG Writer using @node-projects/acad-ts.
 * Maps IR nodes to a CadDocument and serializes to DWG binary format.
 */
export class DWGWriter implements Writer<Uint8Array> {
  private builder: AcadDocumentBuilder;

  constructor(options?: DWGWriterOptions) {
    this.builder = new AcadDocumentBuilder(options);
  }

  async begin(): Promise<void> {
    await this.builder.begin();
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    await this.builder.drawPolygon(points, style);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    await this.builder.drawPolyline(points, closed, style);
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    await this.builder.drawText(quad, text, style);
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): Promise<void> {
    await this.builder.drawImage(quad, dataUrl, width, height, style);
  }

  async end(): Promise<Uint8Array> {
    await ensureAcadLoaded();
    const doc = await this.builder.end();

    // DWG stores angles in radians, but the shared builder stores degrees (for DXF).
    // Convert text rotation from degrees to radians before DWG serialization.
    for (const entity of doc.modelSpace.entities) {
      if (entity instanceof TextEntity!) {
        entity.rotation = entity.rotation * (Math.PI / 180);
      }
    }

    // Estimate a generous buffer size for the DWG output
    const buffer = new ArrayBuffer(10 * 1024 * 1024);
    const writer = new DwgWriter!(buffer, doc);
    writer.Write();
    const bytesWritten = writer.bytesWritten;
    writer.Dispose();
    return new Uint8Array(buffer, 0, bytesWritten);
  }
}

/** Options for the acad-ts based DXF writer. */
export type AcadDXFWriterOptions = AcadWriterOptions;

/**
 * DXF Writer using @node-projects/acad-ts.
 * Maps IR nodes to a CadDocument and serializes to DXF ASCII format.
 * This is an alternative to the existing DXFWriter (which uses @tarikjabiri/dxf).
 */
export class AcadDXFWriter implements Writer<string> {
  private builder: AcadDocumentBuilder;

  constructor(options?: AcadDXFWriterOptions) {
    this.builder = new AcadDocumentBuilder(options);
  }

  async begin(): Promise<void> {
    await this.builder.begin();
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    await this.builder.drawPolygon(points, style);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    await this.builder.drawPolyline(points, closed, style);
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    await this.builder.drawText(quad, text, style);
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style): Promise<void> {
    await this.builder.drawImage(quad, dataUrl, width, height, style);
  }

  async end(): Promise<string> {
    await ensureAcadLoaded();
    const doc = await this.builder.end();

    // Collect DXF output as text
    let result = "";
    const target = {
      write(value: string) { result += value; },
    };
    const writer = new AcadDxfWriter!(target, doc);
    writer.Write();
    writer.Dispose();
    return result;
  }
}
