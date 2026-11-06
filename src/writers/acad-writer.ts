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
  TextStyle as TextStyleType,
  Insert as InsertType,
  BlockRecord as BlockRecordType,
  Color as ColorType,
  XY as XYType,
  XYZ as XYZType,
  DwgWriter as DwgWriterType,
  DxfWriter as AcadDxfWriterType,
} from "@node-projects/acad-ts";

import type { Point, Quad, Style, Writer } from "../types.js";
import { cadImageRectangles, cadImageQuad, cadUnicodeText, cadFontFilename } from "./shared/cad-image.js";
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
let TextStyle: typeof TextStyleType | undefined;
let Insert: typeof InsertType | undefined;
let BlockRecord: typeof BlockRecordType | undefined;
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
    TextStyle = acad.TextStyle;
    Insert = acad.Insert;
    BlockRecord = acad.BlockRecord;
    Color = acad.Color;
    XY = acad.XY;
    XYZ = acad.XYZ;
    DwgWriter = acad.DwgWriter;
    AcadDxfWriter = acad.DxfWriter;
  }
}

const STABLE_CAD_DATE_MS = Date.UTC(2000, 0, 1, 0, 0, 0);
const STABLE_CAD_FINGERPRINT_GUID = "00000000-0000-0000-0000-000000000000";
const STABLE_CAD_VERSION_GUID = "00000000-0000-0000-0000-000000000001";

function cloneStableCadDate(): Date {
  return new Date(STABLE_CAD_DATE_MS);
}

function normalizeCadMetadata(doc: InstanceType<typeof CadDocumentType>): void {
  if (doc.header) {
    doc.header.createDateTime = cloneStableCadDate();
    doc.header.universalCreateDateTime = cloneStableCadDate();
    doc.header.universalUpdateDateTime = cloneStableCadDate();
    doc.header.updateDateTime = cloneStableCadDate();
    doc.header.fingerPrintGuid = STABLE_CAD_FINGERPRINT_GUID;
    doc.header.totalEditingTime = 0;
    doc.header.userElapsedTimeSpan = 0;
    doc.header.versionGuid = STABLE_CAD_VERSION_GUID;
  }

  if (doc.summaryInfo) {
    doc.summaryInfo.createdDate = cloneStableCadDate();
    doc.summaryInfo.modifiedDate = cloneStableCadDate();
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
  acadVersion?: ACadVersionType; // Default to AutoCAD 2007 for Unicode text.
};

/**
 * Internal shared writer that builds a CadDocument from IR.
 * Used by both AcadDXFWriter and DWGWriter.
 */
class AcadDocumentBuilder implements Writer<InstanceType<typeof CadDocumentType>> {
  private doc!: InstanceType<typeof CadDocumentType>;
  private maxY: number;
  private acadVersion?: ACadVersionType;
  private fontStyles = new Map<string, InstanceType<typeof TextStyleType>>();
  private imageBlocks = new Map<string, InstanceType<typeof BlockRecordType>>();

  constructor(options?: AcadWriterOptions) {
    const z = options?.zoom ?? 1;
    this.maxY = (options?.maxY ?? 1000) * z;
    this.acadVersion = options?.acadVersion;
  }

  async begin(): Promise<void> {
    await ensureAcadLoaded();
    this.doc = new CadDocument!(this.acadVersion ?? ACadVersion!.AC1021);
    this.doc.createDefaults();
    normalizeCadMetadata(this.doc);
    this.fontStyles.clear();
    this.imageBlocks.clear();
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
    this.doc.modelSpace!.entities.add(poly);
  }

  /** Add a solid-filled HATCH for one or more closed boundary paths. */
  private addSolidHatchPaths(paths: { x: number; y: number }[][], fillColor: InstanceType<typeof ColorType>, target = this.doc.modelSpace!, maxY = this.maxY): void {
    const hatch = new Hatch!();
    hatch.isSolid = true;
    hatch.patternType = HatchPatternTypeEnum!.SolidFill;
    hatch.pattern = HatchPattern!.solid;
    hatch.color = fillColor;

    let hasPath = false;
    for (const verts of paths) {
      if (verts.length < 3) continue;
      const boundaryEdge = new HatchBoundaryPathPolyline!();
      boundaryEdge.isClosed = true;
      boundaryEdge.vertices = verts.map(v => new XYZ!(v.x, maxY - v.y, 0));

      const path = new HatchBoundaryPath!([boundaryEdge]);
      hatch.paths.push(path);
      hasPath = true;
    }
    if (!hasPath) return;
    target.entities.add(hatch);
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

    if (radius > 0 && isAxisAlignedRect(points) && !style.cornerShapes) {
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

      if (fillVisible && fillColor) this.addSolidHatchPaths([verts], fillColor);
      this.createPolyline(verts, true, trueColor);
      return;
    }

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
      if (fillVisible && fillColor) this.addSolidHatchPaths([verts], fillColor);
      this.createPolyline(verts, true, trueColor);
      return;
    }

    const verts = points.map(p => ({ x: p.x, y: p.y }));
    if (fillVisible && fillColor) this.addSolidHatchPaths([verts], fillColor);
    this.createPolyline(verts, true, trueColor);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    const fillColor = cssToAcadColor(style.fill);
    const stroke = getVisibleStroke(style, (c) => cssToAcadColor(c));
    const strokeColor = stroke?.color;
    const fillVisible = fillColor !== undefined;

    if (!fillVisible && !stroke) return;

    if (style.pathSubpaths?.length && fillVisible && fillColor !== undefined) {
      const hatchPaths = style.pathSubpaths
        .filter((subpath) => subpath.points.length >= 3)
        .map((subpath) => subpath.points.map((point) => ({ x: point.x, y: point.y })));
      this.addSolidHatchPaths(hatchPaths, fillColor);
    } else if (closed && fillVisible && fillColor !== undefined && points.length >= 3) {
      this.addSolidHatchPaths([
        points.map(p => ({ x: p.x, y: p.y })),
      ], fillColor);
    }

    const trueColor = strokeColor ?? fillColor;
    const subpaths = style.pathSubpaths?.length ? style.pathSubpaths : [{ points, closed }];
    for (const subpath of subpaths) {
      this.createPolyline(
        subpath.points.map(point => ({ x: point.x, y: point.y })),
        subpath.closed,
        trueColor,
      );
    }
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    let sanitized = normalizeWhitespaceAwareText(text, style);
    if (sanitized.length === 0) return;

    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const rotationRad = -Math.atan2(dy, dx);

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
    const family = style.fontFamily?.split(",")[0]?.replace(/["']/g, "").trim();
    if (family && !["serif", "sans-serif", "monospace"].includes(family)) {
      let font = this.fontStyles.get(family);
      if (!font) {
        font = new TextStyle!(family);
        font.filename = cadFontFilename(family);
        this.doc.textStyles!.add(font); this.fontStyles.set(family, font);
      }
      entity.style = font;
    }
    if (Math.abs(rotationRad) > 0.001) entity.rotation = rotationRad;
    if (textColor) entity.color = textColor;

    this.doc.modelSpace!.entities.add(entity);
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, _style: Style, rgbData?: number[]): Promise<void> {
    const key = dataUrl + ':' + width + ':' + height;
    let block = this.imageBlocks.get(key);
    if (!block) {
      block = new BlockRecord!('L2V_IMAGE_' + this.imageBlocks.size);
      this.doc.blockRecords!.add(block);
      const groups = new Map<string, Point[][]>();
      const unitQuad: Quad = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
      for (const rect of await cadImageRectangles(dataUrl, width, height, rgbData)) {
        const paths = groups.get(rect.color) ?? [];
        paths.push(cadImageQuad(rect, unitQuad, width, height)); groups.set(rect.color, paths);
      }
      for (const [color, paths] of groups) this.addSolidHatchPaths(paths, cssToAcadColor(color)!, block, 1);
      this.imageBlocks.set(key, block);
    }
    const dx = quad[1].x - quad[0].x, dy = quad[1].y - quad[0].y;
    const vx = quad[3].x - quad[0].x, vy = quad[3].y - quad[0].y;
    const insert = new Insert!(); insert.block = block;
    insert.insertPoint = new XYZ!(quad[3].x, this.flipY(quad[3].y), 0);
    insert.xScale = Math.hypot(dx, dy);
    insert.yScale = Math.hypot(vx, vy) * (dx * vy - dy * vx < 0 ? -1 : 1);
    insert.rotation = -Math.atan2(dy, dx);
    this.doc.modelSpace!.entities.add(insert);
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

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    await this.builder.drawImage(quad, dataUrl, width, height, style, rgbData);
  }

  async end(): Promise<Uint8Array> {
    await ensureAcadLoaded();
    const doc = await this.builder.end();

    return DwgWriter!.writeToBuffer(doc);
  }
}

/** Options for the acad-ts based DXF writer. */
export type AcadDXFWriterOptions = AcadWriterOptions;

function trimTrailingZeros(buffer: Uint8Array): Uint8Array {
  let end = buffer.length;
  while (end > 0 && buffer[end - 1] === 0) {
    end--;
  }
  return buffer.slice(0, end);
}

async function writeAcadDxfBytes(doc: InstanceType<typeof CadDocumentType>): Promise<Uint8Array> {
  let bufferSize = 2 * 1024 * 1024;

  while (true) {
    const buffer = new Uint8Array(bufferSize);
    const writer = new AcadDxfWriter!(buffer, doc);

    try {
      writer.write();
      return trimTrailingZeros(buffer);
    } catch (error) {
      if (error instanceof Error && error.message.includes("DXF output buffer is too small")) {
        bufferSize *= 2;
        continue;
      }
      throw error;
    } finally {
      writer.dispose();
    }
  }
}

/**
 * DXF Writer using @node-projects/acad-ts.
 * Maps IR nodes to a CadDocument and serializes to DXF ASCII bytes.
 * This is an alternative to the existing DXFWriter (which uses @tarikjabiri/dxf).
 */
export class AcadDXFWriter implements Writer<Uint8Array> {
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

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    await this.builder.drawImage(quad, dataUrl, width, height, style, rgbData);
  }

  async end(): Promise<Uint8Array> {
    await ensureAcadLoaded();
    const doc = await this.builder.end();
    for (const entity of doc.modelSpace!.entities) {
      if (entity instanceof TextEntity!) entity.value = cadUnicodeText(entity.value);
    }
    return writeAcadDxfBytes(doc);
  }
}
