import type { Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath, type PathSegment } from "../geometry.js";
import { normalizeWhitespaceAwareText } from "../shared/text-whitespace.js";
import { getPointBounds, getQuadBounds, parseClipPathShape, type ClipPathBounds, type ClipPathShape } from "./shared/clip-path.js";
import { parseCssColor } from "./shared/css-color.js";
import { isAxisAlignedRect, parseAverageBorderRadius as parseBorderRadius } from "./shared/writer-utils.js";

export type EMFPlusWriterOptions = {
  width: number;
  height: number;
  zoom?: number;
};

type RenderedStroke = {
  color: number;
  width: number;
  dasharray?: string;
  borderStyle?: string;
};

type RenderedOutline = {
  color: number;
  width: number;
  style: string;
  offset: number;
};

type PathFigure = {
  start: Point;
  segments: PathFigureSegment[];
  closed: boolean;
};

type PathFigureSegment =
  | { kind: "line"; to: Point }
  | { kind: "bezier"; cp1: Point; cp2: Point; to: Point };

type ImageSource = {
  width: number;
  height: number;
  data: Uint8Array;
  pixelFormat: number;
  stride: number;
  compressed: boolean;
};

type PngImage = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

const EMPTY_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array(0);

const EMR = {
  HEADER: 0x0001,
  EOF: 0x000E,
  COMMENT: 0x0046,
} as const;

const EMFPLUS_COMMENT_IDENTIFIER = 0x2B464D45;

const EMFPLUS = {
  HEADER: 0x4001,
  EOF: 0x4002,
  OBJECT: 0x4008,
  DRAW_LINES: 0x400D,
  FILL_PATH: 0x4014,
  DRAW_PATH: 0x4015,
  DRAW_STRING: 0x401C,
  SET_ANTI_ALIAS_MODE: 0x401E,
  SET_TEXT_RENDERING_HINT: 0x401F,
  SET_INTERPOLATION_MODE: 0x4021,
  SET_PIXEL_OFFSET_MODE: 0x4022,
  SET_COMPOSITING_MODE: 0x4023,
  SAVE: 0x4025,
  RESTORE: 0x4026,
  SET_WORLD_TRANSFORM: 0x402A,
  RESET_WORLD_TRANSFORM: 0x402B,
  SET_PAGE_TRANSFORM: 0x4030,
  RESET_CLIP: 0x4031,
  SET_CLIP_RECT: 0x4032,
  SET_CLIP_PATH: 0x4033,
  DRAW_IMAGE_POINTS: 0x401B,
} as const;

const OBJECT_TYPE = {
  PEN: 0x02,
  PATH: 0x03,
  IMAGE: 0x05,
  FONT: 0x06,
  STRING_FORMAT: 0x07,
  IMAGE_ATTRIBUTES: 0x08,
} as const;

const UNIT_PIXEL = 0x02;
const STRING_ALIGNMENT_NEAR = 0x00;
const STRING_ALIGNMENT_CENTER = 0x01;
const STRING_ALIGNMENT_FAR = 0x02;
const STRING_DIGIT_SUBSTITUTION_USER = 0x00;
const HOTKEY_PREFIX_NONE = 0x00;
const STRING_TRIMMING_NONE = 0x00;
const OBJECT_CLAMP_RECT = 0x00;
const WRAP_MODE_CLAMP = 0x04;
const COMBINE_MODE_REPLACE = 0x00;
const COMBINE_MODE_INTERSECT = 0x01;
const LINE_STYLE_SOLID = 0x00;
const LINE_STYLE_DASH = 0x01;
const LINE_STYLE_DOT = 0x02;
const LINE_STYLE_CUSTOM = 0x05;
const DASHED_LINE_CAP_FLAT = 0x00;
const PIXEL_FORMAT_UNDEFINED = 0x00000000;
const PIXEL_FORMAT_24BPP_RGB = 0x00021808;
const PIXEL_FORMAT_32BPP_ARGB = 0x0026200A;
const BITMAP_DATA_TYPE_PIXEL = 0x00000000;
const BITMAP_DATA_TYPE_COMPRESSED = 0x00000001;
const IMAGE_DATA_TYPE_BITMAP = 0x00000001;
const SMOOTHING_MODE_HIGH_QUALITY = 0x02;
const TEXT_RENDERING_HINT_ANTIALIAS = 0x04;
const INTERPOLATION_MODE_NEAREST_NEIGHBOR = 0x05;
const INTERPOLATION_MODE_HIGH_QUALITY_BICUBIC = 0x07;
const PIXEL_OFFSET_MODE_HIGH_QUALITY = 0x02;
const COMPOSITING_MODE_SOURCE_OVER = 0x00;
const STRING_FORMAT_DIRECTION_RIGHT_TO_LEFT = 0x00000001;
const STRING_FORMAT_DIRECTION_VERTICAL = 0x00000002;
const STRING_FORMAT_NO_FIT_BLACK_BOX = 0x00000004;
const STRING_FORMAT_MEASURE_TRAILING_SPACES = 0x00000800;
const STRING_FORMAT_NO_WRAP = 0x00001000;
const FONT_STYLE_BOLD = 0x00000001;
const FONT_STYLE_ITALIC = 0x00000002;
const FONT_STYLE_UNDERLINE = 0x00000004;
const FONT_STYLE_STRIKEOUT = 0x00000008;
const PATH_POINT_TYPE_START = 0x00;
const PATH_POINT_TYPE_LINE = 0x01;
const PATH_POINT_TYPE_BEZIER = 0x03;
const PATH_POINT_FLAG_CLOSE_SUBPATH = 0x08;
const PATH_POINT_FLAGS_COMPRESSED = 0x4000;
const GRAPHICS_VERSION = 0xDBC01001;
const EMFPLUS_HEADER_FLAG_DUAL = 0x0001;
const EMFPLUS_FLAGS_DISPLAY = 0x00000001;
const DEFAULT_DPI = 96;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const PATH_SLOT = 0;
const PEN_SLOT = 1;
const FONT_SLOT = 2;
const STRING_FORMAT_SLOT = 3;
const IMAGE_SLOT = 4;
const DEFAULT_IMAGE_ATTRIBUTES_SLOT = 5;

function concatBytes(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result as Uint8Array<ArrayBuffer>;
}

function uint16Array(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setUint16(index * 2, values[index], true);
  }
  return out as Uint8Array<ArrayBuffer>;
}

function uint32Array(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setUint32(index * 4, values[index] >>> 0, true);
  }
  return out as Uint8Array<ArrayBuffer>;
}

function int32Array(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setInt32(index * 4, values[index] | 0, true);
  }
  return out as Uint8Array<ArrayBuffer>;
}

function float32Array(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * 4, values[index], true);
  }
  return out as Uint8Array<ArrayBuffer>;
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function align4(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const padding = pad4(bytes.byteLength);
  if (padding === 0) return bytes as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(bytes.byteLength + padding);
  out.set(bytes, 0);
  return out as Uint8Array<ArrayBuffer>;
}

function encodeUtf16LE(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return out as Uint8Array<ArrayBuffer>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y);
  if (length === 0) return { x: 0, y: 0 };
  return { x: point.x / length, y: point.y / length };
}

function addPoint(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtractPoint(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scalePoint(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

function pointsEqual(a: Point, b: Point, epsilon = 0.01): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function parseNumeric(value: string | undefined): number {
  if (!value) return 0;
  const numeric = parseFloat(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes as Uint8Array<ArrayBuffer>;
  }

  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64")) as Uint8Array<ArrayBuffer>;
  }

  throw new Error("No base64 decoder available");
}

function decodeDataUrl(dataUrl: string): { mimeType: string; data: Uint8Array } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;

  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const parts = header.split(";");
  const mimeType = (parts[0] || "application/octet-stream").toLowerCase();
  const isBase64 = parts.some((part) => part.toLowerCase() === "base64");

  if (isBase64) {
    return { mimeType, data: decodeBase64(payload) };
  }

  return { mimeType, data: new TextEncoder().encode(decodeURIComponent(payload)) };
}

async function inflateDeflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  if (typeof process !== "undefined" && typeof process.versions === "object" && process.versions?.node) {
    const zlib = await import("node:zlib");
    return Uint8Array.from(zlib.inflateSync(data));
  }

  throw new Error("No deflate decompressor available");
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const prediction = a + b - c;
  const pa = Math.abs(prediction - a);
  const pb = Math.abs(prediction - b);
  const pc = Math.abs(prediction - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function decodePng(data: Uint8Array): Promise<PngImage | null> {
  if (data.byteLength < PNG_SIGNATURE.byteLength) return null;
  for (let index = 0; index < PNG_SIGNATURE.byteLength; index += 1) {
    if (data[index] !== PNG_SIGNATURE[index]) return null;
  }

  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset + 12 <= data.byteLength) {
    const chunkLength = readUint32BE(data, offset);
    offset += 4;
    const chunkType = String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3],
    );
    offset += 4;
    if (offset + chunkLength + 4 > data.byteLength) return null;
    const chunkData = data.subarray(offset, offset + chunkLength);
    offset += chunkLength + 4;

    if (chunkType === "IHDR") {
      width = readUint32BE(chunkData, 0);
      height = readUint32BE(chunkData, 4);
      bitDepth = chunkData[8] ?? 0;
      colorType = chunkData[9] ?? 0;
      interlace = chunkData[12] ?? 0;
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 2 && colorType !== 6) return null;

  const channelCount = colorType === 6 ? 4 : 3;
  const stride = width * channelCount;
  const inflated = await inflateDeflate(concatBytes(...idatChunks));
  if (inflated.byteLength < height * (stride + 1)) return null;

  const rowBytes = width * channelCount;
  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  let previousRow = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[sourceOffset];
    sourceOffset += 1;
    const row = inflated.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;

    const unfiltered = new Uint8Array(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channelCount ? unfiltered[index - channelCount] : 0;
      const up = previousRow[index] ?? 0;
      const upLeft = index >= channelCount ? previousRow[index - channelCount] : 0;
      let value = row[index];

      switch (filterType) {
        case 0:
          break;
        case 1:
          value = (value + left) & 0xFF;
          break;
        case 2:
          value = (value + up) & 0xFF;
          break;
        case 3:
          value = (value + Math.floor((left + up) / 2)) & 0xFF;
          break;
        case 4:
          value = (value + paethPredictor(left, up, upLeft)) & 0xFF;
          break;
        default:
          return null;
      }

      unfiltered[index] = value;
    }

    const destRow = y * width * 4;
    if (colorType === 6) {
      rgba.set(unfiltered, destRow);
    } else {
      for (let x = 0; x < width; x += 1) {
        const src = x * 3;
        const dest = destRow + x * 4;
        rgba[dest] = unfiltered[src];
        rgba[dest + 1] = unfiltered[src + 1];
        rgba[dest + 2] = unfiltered[src + 2];
        rgba[dest + 3] = 255;
      }
    }

    previousRow = unfiltered;
  }

  return { width, height, rgba };
}

function rgbaToBgraPixels(width: number, height: number, rgba: Uint8Array): { stride: number; data: Uint8Array } {
  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  for (let index = 0; index < width * height; index += 1) {
    const rgbaOffset = index * 4;
    const bgraOffset = index * 4;
    data[bgraOffset] = rgba[rgbaOffset + 2];
    data[bgraOffset + 1] = rgba[rgbaOffset + 1];
    data[bgraOffset + 2] = rgba[rgbaOffset];
    data[bgraOffset + 3] = rgba[rgbaOffset + 3];
  }
  return { stride, data };
}

function rgbToBgrPixels(width: number, height: number, rgbData: number[]): { stride: number; data: Uint8Array } {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3;
      const dest = y * stride + x * 3;
      data[dest] = rgbData[source + 2] ?? 0;
      data[dest + 1] = rgbData[source + 1] ?? 0;
      data[dest + 2] = rgbData[source] ?? 0;
    }
  }
  return { stride, data };
}

function rgbToBgraPixels(width: number, height: number, rgbData: number[], alpha: number): { stride: number; data: Uint8Array } {
  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * 3;
    const dest = index * 4;
    data[dest] = rgbData[source + 2] ?? 0;
    data[dest + 1] = rgbData[source + 1] ?? 0;
    data[dest + 2] = rgbData[source] ?? 0;
    data[dest + 3] = alpha;
  }
  return { stride, data };
}

function scaleRgbaAlpha(rgba: Uint8Array, opacity: number): Uint8Array {
  if (opacity >= 1) return rgba;
  const scaled = new Uint8Array(rgba);
  for (let index = 3; index < scaled.byteLength; index += 4) {
    scaled[index] = Math.round(scaled[index] * opacity);
  }
  return scaled;
}

function cssColorToArgb(value: string | undefined, opacity = 1): number | null {
  const parsed = parseCssColor(value);
  if (!parsed) return null;
  const alpha = clamp(Math.round(parsed.a * opacity * 255), 0, 255);
  if (alpha <= 0) return null;
  return (((alpha << 24) >>> 0) | (parsed.r << 16) | (parsed.g << 8) | parsed.b) >>> 0;
}

function parseVisibleStroke(style: Pick<Style, "stroke" | "strokeWidth" | "strokeDasharray">, opacity: number): RenderedStroke | null {
  const color = cssColorToArgb(style.stroke, opacity);
  if (color === null) return null;
  const width = parseNumeric(style.strokeWidth);
  if (width <= 0) return null;
  return {
    color,
    width,
    dasharray: style.strokeDasharray,
  };
}

function parseVisibleOutline(style: Style, opacity: number): RenderedOutline | null {
  const width = parseNumeric(style.outlineWidth);
  if (width <= 0) return null;

  const outlineStyle = style.outlineStyle === "auto" ? "solid" : style.outlineStyle;
  if (!outlineStyle || outlineStyle === "none") return null;

  const color = cssColorToArgb(style.outlineColor ?? style.color ?? style.stroke ?? style.fill, opacity);
  if (color === null) return null;

  const offset = parseNumeric(style.outlineOffset);
  return {
    color,
    width,
    style: outlineStyle,
    offset,
  };
}

function parseFontFamily(fontFamily: string | undefined): string {
  if (!fontFamily) return "Arial";
  const first = fontFamily.split(",")[0]?.trim();
  if (!first) return "Arial";
  return first.replace(/^['"]|['"]$/g, "") || "Arial";
}

function parseFontStyleFlags(style: Style): number {
  let flags = 0;
  const weight = (style.fontWeight ?? "").toLowerCase();
  const numericWeight = parseInt(weight, 10);
  if (weight === "bold" || numericWeight >= 600) flags |= FONT_STYLE_BOLD;
  if ((style.fontStyle ?? "").toLowerCase().includes("italic")) flags |= FONT_STYLE_ITALIC;
  const decoration = (style.textDecoration ?? "").toLowerCase();
  if (decoration.includes("underline")) flags |= FONT_STYLE_UNDERLINE;
  if (decoration.includes("line-through")) flags |= FONT_STYLE_STRIKEOUT;
  return flags;
}

function parseTextAlignment(style: Style): number {
  const align = (style.textAlign ?? "").toLowerCase();
  if (align === "center") return STRING_ALIGNMENT_CENTER;
  if (align === "right" || align === "end") return STRING_ALIGNMENT_FAR;
  return STRING_ALIGNMENT_NEAR;
}

function parseStringFormatFlags(style: Style): number {
  let flags = STRING_FORMAT_NO_FIT_BLACK_BOX | STRING_FORMAT_NO_WRAP;
  if ((style.direction ?? "").toLowerCase() === "rtl") {
    flags |= STRING_FORMAT_DIRECTION_RIGHT_TO_LEFT;
  }
  if ((style.writingMode ?? "").toLowerCase().includes("vertical")) {
    flags |= STRING_FORMAT_DIRECTION_VERTICAL;
  }
  if ((style.whiteSpace ?? "").toLowerCase().includes("pre")) {
    flags |= STRING_FORMAT_MEASURE_TRAILING_SPACES;
  }
  return flags >>> 0;
}

function parseDashArray(dasharray: string | undefined): number[] {
  if (!dasharray || dasharray === "none") return [];
  return dasharray
    .split(/[\s,]+/)
    .map((token) => parseFloat(token))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

function createStrokeFromBorder(color: string | undefined, width: string | undefined, borderStyle: string | undefined, opacity: number): RenderedStroke | null {
  const argb = cssColorToArgb(color, opacity);
  const numericWidth = parseNumeric(width);
  if (argb === null || numericWidth <= 0 || !borderStyle || borderStyle === "none" || borderStyle === "hidden") {
    return null;
  }

  return {
    color: argb,
    width: numericWidth,
    borderStyle,
  };
}

function pointArrayToFloat32(points: Point[]): Uint8Array {
  return float32Array(...points.flatMap((point) => [point.x, point.y]));
}

function quadToTransform(quad: Quad): { matrix: [number, number, number, number, number, number]; width: number; height: number } | null {
  const xAxis = subtractPoint(quad[1], quad[0]);
  const yAxis = subtractPoint(quad[3], quad[0]);
  const width = Math.hypot(xAxis.x, xAxis.y);
  const height = Math.hypot(yAxis.x, yAxis.y);
  if (width <= 0 || height <= 0) return null;

  return {
    matrix: [
      xAxis.x / width,
      xAxis.y / width,
      yAxis.x / height,
      yAxis.y / height,
      quad[0].x,
      quad[0].y,
    ],
    width,
    height,
  };
}

function quadraticToCubic(from: Point, control: Point, to: Point): { cp1: Point; cp2: Point; to: Point } {
  return {
    cp1: {
      x: from.x + ((control.x - from.x) * 2) / 3,
      y: from.y + ((control.y - from.y) * 2) / 3,
    },
    cp2: {
      x: to.x + ((control.x - to.x) * 2) / 3,
      y: to.y + ((control.y - to.y) * 2) / 3,
    },
    to,
  };
}

function figureFromPoints(points: Point[], closed: boolean): PathFigure | null {
  if (points.length < 2) return null;
  return {
    start: points[0],
    segments: points.slice(1).map((point) => ({ kind: "line", to: point })),
    closed,
  };
}

function figureFromRoundedQuad(points: Quad, radius: number, cornerShapes?: [number, number, number, number]): PathFigure {
  const segments = roundedQuadPath(points, radius, cornerShapes);
  const start = { x: segments[0].x, y: segments[0].y };
  const pathSegments: PathFigureSegment[] = [];
  let current = start;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] as Exclude<PathSegment, { type: "M" }>;
    if (segment.type === "L") {
      pathSegments.push({ kind: "line", to: { x: segment.x, y: segment.y } });
      current = { x: segment.x, y: segment.y };
    } else {
      const cubic = quadraticToCubic(current, { x: segment.cx, y: segment.cy }, { x: segment.x, y: segment.y });
      pathSegments.push({ kind: "bezier", cp1: cubic.cp1, cp2: cubic.cp2, to: cubic.to });
      current = cubic.to;
    }
  }
  return { start, segments: pathSegments, closed: true };
}

function roundedRectFigure(x: number, y: number, width: number, height: number, rx: number, ry: number): PathFigure {
  const clampedRx = clamp(rx, 0, width / 2);
  const clampedRy = clamp(ry, 0, height / 2);
  if (clampedRx <= 0 || clampedRy <= 0) {
    return {
      start: { x, y },
      segments: [
        { kind: "line", to: { x: x + width, y } },
        { kind: "line", to: { x: x + width, y: y + height } },
        { kind: "line", to: { x, y: y + height } },
      ],
      closed: true,
    };
  }

  const kappa = 0.5522847498307936;
  const ox = clampedRx * kappa;
  const oy = clampedRy * kappa;
  const right = x + width;
  const bottom = y + height;

  return {
    start: { x: x + clampedRx, y },
    segments: [
      { kind: "line", to: { x: right - clampedRx, y } },
      {
        kind: "bezier",
        cp1: { x: right - clampedRx + ox, y },
        cp2: { x: right, y: y + clampedRy - oy },
        to: { x: right, y: y + clampedRy },
      },
      { kind: "line", to: { x: right, y: bottom - clampedRy } },
      {
        kind: "bezier",
        cp1: { x: right, y: bottom - clampedRy + oy },
        cp2: { x: right - clampedRx + ox, y: bottom },
        to: { x: right - clampedRx, y: bottom },
      },
      { kind: "line", to: { x: x + clampedRx, y: bottom } },
      {
        kind: "bezier",
        cp1: { x: x + clampedRx - ox, y: bottom },
        cp2: { x, y: bottom - clampedRy + oy },
        to: { x, y: bottom - clampedRy },
      },
      { kind: "line", to: { x, y: y + clampedRy } },
      {
        kind: "bezier",
        cp1: { x, y: y + clampedRy - oy },
        cp2: { x: x + clampedRx - ox, y },
        to: { x: x + clampedRx, y },
      },
    ],
    closed: true,
  };
}

function ellipseFigure(cx: number, cy: number, rx: number, ry: number): PathFigure {
  const kappa = 0.5522847498307936;
  const ox = rx * kappa;
  const oy = ry * kappa;
  return {
    start: { x: cx + rx, y: cy },
    segments: [
      {
        kind: "bezier",
        cp1: { x: cx + rx, y: cy + oy },
        cp2: { x: cx + ox, y: cy + ry },
        to: { x: cx, y: cy + ry },
      },
      {
        kind: "bezier",
        cp1: { x: cx - ox, y: cy + ry },
        cp2: { x: cx - rx, y: cy + oy },
        to: { x: cx - rx, y: cy },
      },
      {
        kind: "bezier",
        cp1: { x: cx - rx, y: cy - oy },
        cp2: { x: cx - ox, y: cy - ry },
        to: { x: cx, y: cy - ry },
      },
      {
        kind: "bezier",
        cp1: { x: cx + ox, y: cy - ry },
        cp2: { x: cx + rx, y: cy - oy },
        to: { x: cx + rx, y: cy },
      },
    ],
    closed: true,
  };
}

function figuresFromClipShape(shape: ClipPathShape): PathFigure[] {
  if (shape.kind === "polygon") {
    const figure = figureFromPoints(shape.points, true);
    return figure ? [figure] : [];
  }

  if (shape.kind === "ellipse") {
    return [ellipseFigure(shape.cx, shape.cy, shape.rx, shape.ry)];
  }

  return [roundedRectFigure(shape.x, shape.y, shape.w, shape.h, shape.rx, shape.ry)];
}

function serializePathFigures(figures: PathFigure[]): Uint8Array {
  const points: Point[] = [];
  const pointTypes: number[] = [];

  for (const figure of figures) {
    if (figure.segments.length === 0) continue;
    points.push(figure.start);
    pointTypes.push(PATH_POINT_TYPE_START);

    for (const segment of figure.segments) {
      if (segment.kind === "line") {
        points.push(segment.to);
        pointTypes.push(PATH_POINT_TYPE_LINE);
      } else {
        points.push(segment.cp1, segment.cp2, segment.to);
        pointTypes.push(PATH_POINT_TYPE_BEZIER, PATH_POINT_TYPE_BEZIER, PATH_POINT_TYPE_BEZIER);
      }
    }

    if (figure.closed && pointTypes.length > 0) {
      pointTypes[pointTypes.length - 1] |= PATH_POINT_FLAG_CLOSE_SUBPATH << 4;
    }
  }

  const pathData = concatBytes(
    uint32Array(GRAPHICS_VERSION, points.length, 0),
    pointArrayToFloat32(points),
    align4(Uint8Array.from(pointTypes)),
  );

  return pathData;
}

class EmfRecordBuffer {
  private readonly chunks: Uint8Array[] = [];

  writeRecord(type: number, data: Uint8Array = EMPTY_BYTES): void {
    const recordSize = (8 + data.byteLength + 3) & ~3;
    const record = new Uint8Array(recordSize);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, type, true);
    recordView.setUint32(4, recordSize, true);
    record.set(data, 8);
    this.chunks.push(record);
  }

  writeEmfPlusRecord(type: number, flags: number, data: Uint8Array = EMPTY_BYTES): void {
    const dataSize = data.byteLength;
    const recordSize = (12 + dataSize + 3) & ~3;
    const emfPlusRecord = new Uint8Array(recordSize);
    const view = new DataView(emfPlusRecord.buffer);
    view.setUint16(0, type, true);
    view.setUint16(2, flags, true);
    view.setUint32(4, recordSize, true);
    view.setUint32(8, dataSize, true);
    emfPlusRecord.set(data, 12);
    this.writeRecord(
      EMR.COMMENT,
      concatBytes(uint32Array(emfPlusRecord.byteLength + 4, EMFPLUS_COMMENT_IDENTIFIER), emfPlusRecord),
    );
  }

  getNumRecords(): number {
    return this.chunks.length;
  }

  getTotalSize(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  getChunks(): readonly Uint8Array[] {
    return this.chunks;
  }
}

export class EMFPlusWriter implements Writer<Uint8Array> {
  private readonly width: number;
  private readonly height: number;
  private records!: EmfRecordBuffer;
  private nextStateId = 1;

  constructor(optionsOrWidth: EMFPlusWriterOptions | number, height?: number, zoom?: number) {
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
    this.records = new EmfRecordBuffer();
    this.nextStateId = 1;

    this.emitRecord(
      EMFPLUS.HEADER,
      EMFPLUS_HEADER_FLAG_DUAL,
      concatBytes(
        uint32Array(GRAPHICS_VERSION, EMFPLUS_FLAGS_DISPLAY, DEFAULT_DPI, DEFAULT_DPI),
      ),
    );
    this.emitSetPageTransform(1, UNIT_PIXEL);
    this.emitRecord(EMFPLUS.SET_ANTI_ALIAS_MODE, 1 | (SMOOTHING_MODE_HIGH_QUALITY << 1));
    this.emitRecord(EMFPLUS.SET_TEXT_RENDERING_HINT, TEXT_RENDERING_HINT_ANTIALIAS);
    this.emitRecord(EMFPLUS.SET_INTERPOLATION_MODE, INTERPOLATION_MODE_HIGH_QUALITY_BICUBIC);
    this.emitRecord(EMFPLUS.SET_PIXEL_OFFSET_MODE, PIXEL_OFFSET_MODE_HIGH_QUALITY);
    this.emitRecord(EMFPLUS.SET_COMPOSITING_MODE, COMPOSITING_MODE_SOURCE_OVER);
    this.emitObject(DEFAULT_IMAGE_ATTRIBUTES_SLOT, OBJECT_TYPE.IMAGE_ATTRIBUTES, this.buildImageAttributesObject());
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const opacity = style.opacity ?? 1;
    if (opacity <= 0) return;

    const fillColor = cssColorToArgb(style.fill, opacity);
    const stroke = parseVisibleStroke(style, opacity);
    const outline = parseVisibleOutline(style, opacity);
    const clipBounds = getQuadBounds(points);

    if (this.hasMixedBorders(style)) {
      if (fillColor !== null) {
        this.saveState();
        this.applyClip(style, clipBounds);
        this.emitFigures([this.figureForPolygon(points, style)], fillColor, null, style.fillRule, undefined);
        this.restoreState();
      }
      this.drawPerSideBorders(points, style, opacity);
      return;
    }

    if (outline) {
      this.drawOutline(points, style, outline);
    }

    if (fillColor === null && !stroke) return;

    this.saveState();
    this.applyClip(style, clipBounds);
    this.emitFigures([this.figureForPolygon(points, style)], fillColor, stroke, style.fillRule, style.strokeDasharray);
    this.restoreState();
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    const opacity = style.opacity ?? 1;
    if (opacity <= 0 || points.length < 2) return;

    const fillColor = cssColorToArgb(style.fill, opacity);
    const stroke = parseVisibleStroke(style, opacity);
    if (fillColor === null && !stroke) return;

    this.saveState();
    this.applyClip(style, getPointBounds(points));

    if (style.pathSubpaths?.length) {
      const figures = style.pathSubpaths
        .map((subpath) => figureFromPoints(subpath.points, subpath.closed))
        .filter((figure): figure is PathFigure => figure !== null);
      const hasFilledFigure = fillColor !== null && figures.some((figure) => figure.closed && figure.segments.length >= 2);
      const effectiveStroke = stroke ?? (!hasFilledFigure && fillColor !== null ? { color: fillColor, width: 1, dasharray: style.strokeDasharray } : null);
      this.emitFigures(figures, hasFilledFigure ? fillColor : null, effectiveStroke, style.fillRule, style.strokeDasharray);
      this.restoreState();
      return;
    }

    const figure = figureFromPoints(points, closed);
    if (!figure) {
      this.restoreState();
      return;
    }

    if (closed && fillColor !== null && points.length >= 3) {
      this.emitFigures([figure], fillColor, stroke, style.fillRule, style.strokeDasharray);
    } else {
      const effectiveStroke = stroke ?? (fillColor !== null ? { color: fillColor, width: 1, dasharray: style.strokeDasharray } : null);
      if (effectiveStroke) {
        this.emitFigures([figure], null, effectiveStroke, style.fillRule, style.strokeDasharray);
      }
    }

    this.restoreState();
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    const opacity = style.opacity ?? 1;
    if (opacity <= 0) return;

    const normalizedText = normalizeWhitespaceAwareText(text, style);
    if (!normalizedText) return;

    const color = cssColorToArgb(style.color ?? style.fill ?? style.stroke, opacity);
    if (color === null) return;

    const transform = quadToTransform(quad);
    if (!transform) return;

    const fontSize = parseNumeric(style.fontSize) || transform.height;
    if (fontSize <= 0) return;

    this.saveState();
    this.applyClip(style, getQuadBounds(quad));
    this.emitObject(FONT_SLOT, OBJECT_TYPE.FONT, this.buildFontObject(fontSize, style));
    this.emitObject(STRING_FORMAT_SLOT, OBJECT_TYPE.STRING_FORMAT, this.buildStringFormatObject(style));
    this.emitSetWorldTransform(transform.matrix);
    this.emitDrawString(FONT_SLOT, STRING_FORMAT_SLOT, color, normalizedText, transform.width, transform.height);
    this.emitRecord(EMFPLUS.RESET_WORLD_TRANSFORM, 0, EMPTY_BYTES);
    this.restoreState();
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    const opacity = style.opacity ?? 1;
    if (opacity <= 0 || width <= 0 || height <= 0) return;

    const imageSource = await this.resolveImageSource(dataUrl, width, height, opacity, rgbData);
    if (!imageSource) return;

    this.saveState();
    this.applyClip(style, getQuadBounds(quad));

    const imageRendering = (style.imageRendering ?? "").toLowerCase();
    if (imageRendering === "pixelated" || imageRendering === "crisp-edges") {
      this.emitRecord(EMFPLUS.SET_INTERPOLATION_MODE, INTERPOLATION_MODE_NEAREST_NEIGHBOR);
    }

    this.emitObject(IMAGE_SLOT, OBJECT_TYPE.IMAGE, this.buildImageObject(imageSource));
    this.emitDrawImagePoints(
      IMAGE_SLOT,
      DEFAULT_IMAGE_ATTRIBUTES_SLOT,
      [quad[0], quad[1], quad[3]],
      imageSource.width,
      imageSource.height,
    );
    this.restoreState();
  }

  async end(): Promise<Uint8Array> {
    this.emitRecord(EMFPLUS.EOF, 0, EMPTY_BYTES);
    this.records.writeRecord(EMR.EOF, uint32Array(0, 0, 20));
    return this.buildOuterEmf();
  }

  private emitRecord(type: number, flags = 0, data: Uint8Array = EMPTY_BYTES): void {
    this.records.writeEmfPlusRecord(type, flags, data);
  }

  private emitObject(slot: number, objectType: number, data: Uint8Array): void {
    this.emitRecord(EMFPLUS.OBJECT, slot | (objectType << 8), data);
  }

  private emitSetPageTransform(pageScale: number, pageUnit: number): void {
    this.emitRecord(EMFPLUS.SET_PAGE_TRANSFORM, pageUnit, float32Array(pageScale));
  }

  private emitSetWorldTransform(matrix: [number, number, number, number, number, number]): void {
    this.emitRecord(EMFPLUS.SET_WORLD_TRANSFORM, 0, float32Array(...matrix));
  }

  private emitDrawString(fontSlot: number, stringFormatSlot: number, color: number, text: string, width: number, height: number): void {
    const stringBytes = align4(encodeUtf16LE(text));
    const data = concatBytes(
      uint32Array(color, stringFormatSlot, text.length),
      float32Array(0, 0, width, height),
      stringBytes,
    );
    this.emitRecord(EMFPLUS.DRAW_STRING, fontSlot | 0x8000, data);
  }

  private emitDrawImagePoints(imageSlot: number, imageAttributesSlot: number, points: [Point, Point, Point], sourceWidth: number, sourceHeight: number): void {
    const flags = imageSlot;
    const data = concatBytes(
      uint32Array(imageAttributesSlot, UNIT_PIXEL),
      float32Array(0, 0, sourceWidth, sourceHeight),
      uint32Array(3),
      pointArrayToFloat32(points),
    );
    this.emitRecord(EMFPLUS.DRAW_IMAGE_POINTS, flags, data);
  }

  private saveState(): number {
    const stateId = this.nextStateId;
    this.nextStateId += 1;
    this.emitRecord(EMFPLUS.SAVE, 0, uint32Array(stateId));
    return stateId;
  }

  private restoreState(stateId?: number): void {
    const resolvedStateId = stateId ?? (this.nextStateId - 1);
    this.emitRecord(EMFPLUS.RESTORE, 0, uint32Array(resolvedStateId));
  }

  private applyClip(style: Style, bounds: ClipPathBounds): void {
    let hasClip = false;

    if (style.clipQuads?.length) {
      for (const clipQuad of style.clipQuads) {
        this.applyClipFigures(
          [clipQuad.radius > 0 ? figureFromRoundedQuad(clipQuad.points, clipQuad.radius) : this.figureForClipQuad(clipQuad.points)],
          hasClip ? COMBINE_MODE_INTERSECT : COMBINE_MODE_REPLACE,
        );
        hasClip = true;
      }
    }

    if (style.clipBounds) {
      this.emitRecord(
        EMFPLUS.SET_CLIP_RECT,
        (hasClip ? COMBINE_MODE_INTERSECT : COMBINE_MODE_REPLACE) << 8,
        float32Array(style.clipBounds.x, style.clipBounds.y, style.clipBounds.w, style.clipBounds.h),
      );
      hasClip = true;
    }

    const clipPath = parseClipPathShape(style.clipPath, bounds);
    if (clipPath) {
      this.applyClipFigures(figuresFromClipShape(clipPath), hasClip ? COMBINE_MODE_INTERSECT : COMBINE_MODE_REPLACE);
    }
  }

  private applyClipFigures(figures: PathFigure[], combineMode: number): void {
    if (figures.length === 0) return;
    this.emitObject(PATH_SLOT, OBJECT_TYPE.PATH, serializePathFigures(figures));
    this.emitRecord(EMFPLUS.SET_CLIP_PATH, PATH_SLOT | (combineMode << 8), EMPTY_BYTES);
  }

  private emitFigures(figures: PathFigure[], fillColor: number | null, stroke: RenderedStroke | null, _fillRule: Style["fillRule"], dasharray: string | undefined): void {
    if (figures.length === 0) return;

    this.emitObject(PATH_SLOT, OBJECT_TYPE.PATH, serializePathFigures(figures));

    if (fillColor !== null) {
      this.emitRecord(EMFPLUS.FILL_PATH, PATH_SLOT | 0x8000, uint32Array(fillColor));
    }

    if (stroke) {
      this.emitObject(PEN_SLOT, OBJECT_TYPE.PEN, this.buildPenObject(stroke, dasharray, stroke.borderStyle));
      this.emitRecord(EMFPLUS.DRAW_PATH, PATH_SLOT, uint32Array(PEN_SLOT));
    }
  }

  private buildPenObject(stroke: RenderedStroke, dasharray: string | undefined, borderStyle: string | undefined): Uint8Array {
    let penFlags = 0;
    let optionalData = EMPTY_BYTES;

    const rawDashArray = parseDashArray(dasharray);
    if (rawDashArray.length > 0) {
      penFlags |= 0x00000020 | 0x00000100;
      optionalData = concatBytes(optionalData, uint32Array(LINE_STYLE_CUSTOM));
      optionalData = concatBytes(optionalData, uint32Array(rawDashArray.length), float32Array(...rawDashArray));
    } else if (borderStyle === "dashed") {
      penFlags |= 0x00000020;
      optionalData = concatBytes(optionalData, uint32Array(LINE_STYLE_DASH));
    } else if (borderStyle === "dotted") {
      penFlags |= 0x00000020;
      optionalData = concatBytes(optionalData, uint32Array(LINE_STYLE_DOT));
    }

    const brushData = uint32Array(GRAPHICS_VERSION, 0, stroke.color);
    return concatBytes(
      uint32Array(GRAPHICS_VERSION, 0, penFlags, UNIT_PIXEL),
      float32Array(stroke.width),
      optionalData,
      brushData,
    );
  }

  private buildFontObject(fontSize: number, style: Style): Uint8Array {
    const familyName = align4(encodeUtf16LE(parseFontFamily(style.fontFamily)));
    return concatBytes(
      uint32Array(GRAPHICS_VERSION),
      float32Array(fontSize),
      uint32Array(UNIT_PIXEL, parseFontStyleFlags(style), 0, familyName.byteLength / 2),
      familyName,
    );
  }

  private buildStringFormatObject(style: Style): Uint8Array {
    return concatBytes(
      uint32Array(
        GRAPHICS_VERSION,
        parseStringFormatFlags(style),
        0,
        parseTextAlignment(style),
        STRING_ALIGNMENT_NEAR,
        STRING_DIGIT_SUBSTITUTION_USER,
        0,
      ),
      float32Array(0, 0, 0, 0, 1),
      uint32Array(STRING_TRIMMING_NONE),
      int32Array(0, 0),
    );
  }

  private buildImageAttributesObject(): Uint8Array {
    return concatBytes(
      uint32Array(GRAPHICS_VERSION, 0, WRAP_MODE_CLAMP, 0, OBJECT_CLAMP_RECT, 0),
    );
  }

  private buildImageObject(image: ImageSource): Uint8Array {
    const bitmapData = concatBytes(
      uint32Array(image.width, image.height),
      int32Array(image.stride),
      uint32Array(image.pixelFormat, image.compressed ? BITMAP_DATA_TYPE_COMPRESSED : BITMAP_DATA_TYPE_PIXEL),
      image.data,
    );
    return concatBytes(uint32Array(GRAPHICS_VERSION, IMAGE_DATA_TYPE_BITMAP), bitmapData);
  }

  private async resolveImageSource(dataUrl: string, width: number, height: number, opacity: number, rgbData?: number[]): Promise<ImageSource | null> {
    const decoded = decodeDataUrl(dataUrl);
    const mimeType = decoded?.mimeType ?? "";

    if ((mimeType === "image/png" || this.looksLikePng(decoded?.data)) && decoded) {
      const png = await decodePng(decoded.data);
      if (png) {
        const scaled = scaleRgbaAlpha(png.rgba, opacity);
        const pixels = rgbaToBgraPixels(png.width, png.height, scaled);
        return {
          width: png.width,
          height: png.height,
          data: pixels.data,
          pixelFormat: PIXEL_FORMAT_32BPP_ARGB,
          stride: pixels.stride,
          compressed: false,
        };
      }
    }

    if (rgbData && rgbData.length === width * height * 3) {
      if (opacity < 1) {
        const pixels = rgbToBgraPixels(width, height, rgbData, Math.round(opacity * 255));
        return {
          width,
          height,
          data: pixels.data,
          pixelFormat: PIXEL_FORMAT_32BPP_ARGB,
          stride: pixels.stride,
          compressed: false,
        };
      }

      const pixels = rgbToBgrPixels(width, height, rgbData);
      return {
        width,
        height,
        data: pixels.data,
        pixelFormat: PIXEL_FORMAT_24BPP_RGB,
        stride: pixels.stride,
        compressed: false,
      };
    }

    if (decoded && opacity >= 1 && (mimeType === "image/jpeg" || mimeType === "image/jpg" || mimeType === "image/gif" || mimeType === "image/tiff" || mimeType === "image/png")) {
      return {
        width,
        height,
        data: decoded.data,
        pixelFormat: PIXEL_FORMAT_UNDEFINED,
        stride: 0,
        compressed: true,
      };
    }

    return null;
  }

  private looksLikePng(data: Uint8Array | undefined): boolean {
    if (!data || data.byteLength < PNG_SIGNATURE.byteLength) return false;
    for (let index = 0; index < PNG_SIGNATURE.byteLength; index += 1) {
      if (data[index] !== PNG_SIGNATURE[index]) return false;
    }
    return true;
  }

  private figureForPolygon(points: Quad, style: Style): PathFigure {
    const width = distance(points[0], points[1]);
    const height = distance(points[0], points[3]);
    const radius = parseBorderRadius(style.borderRadius, width, height);
    if (radius > 0) {
      return figureFromRoundedQuad(points, radius, style.cornerShapes);
    }
    return this.figureForClipQuad(points);
  }

  private figureForClipQuad(points: Quad): PathFigure {
    return {
      start: points[0],
      segments: [
        { kind: "line", to: points[1] },
        { kind: "line", to: points[2] },
        { kind: "line", to: points[3] },
      ],
      closed: true,
    };
  }

  private drawOutline(points: Quad, style: Style, outline: RenderedOutline): void {
    let figure: PathFigure;

    if (isAxisAlignedRect(points) && !style.cornerShapes) {
      const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x);
      const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y);
      const width = Math.abs(points[1].x - points[0].x);
      const height = Math.abs(points[3].y - points[0].y);
      const padding = outline.offset + outline.width / 2;
      const radius = parseBorderRadius(style.borderRadius, width, height);
      const outlineRadius = Math.min(
        Math.max(radius + padding, 0),
        (width + padding * 2) / 2,
        (height + padding * 2) / 2,
      );
      figure = roundedRectFigure(minX - padding, minY - padding, width + padding * 2, height + padding * 2, outlineRadius, outlineRadius);
    } else {
      figure = this.figureForClipQuad(points);
    }

    this.emitFigures([
      figure,
    ], null, { color: outline.color, width: outline.width, borderStyle: outline.style }, style.fillRule, undefined);
  }

  private hasMixedBorders(style: Style): boolean {
    if (style.borderRadius && style.borderRadius !== "0px" && style.borderRadius !== "0%") return false;
    const sides = [
      { color: style.borderTopColor, width: style.borderTopWidth, borderStyle: style.borderTopStyle },
      { color: style.borderRightColor, width: style.borderRightWidth, borderStyle: style.borderRightStyle },
      { color: style.borderBottomColor, width: style.borderBottomWidth, borderStyle: style.borderBottomStyle },
      { color: style.borderLeftColor, width: style.borderLeftWidth, borderStyle: style.borderLeftStyle },
    ];
    if (!sides[0].borderStyle) return false;
    if (sides.some((side) => side.borderStyle === "double")) return true;
    const reference = sides[0];
    return sides.some((side) => side.color !== reference.color || side.width !== reference.width || side.borderStyle !== reference.borderStyle);
  }

  private drawPerSideBorders(points: Quad, style: Style, opacity: number): void {
    const sides: Array<{ from: Point; to: Point; color?: string; width?: string; borderStyle?: string }> = [
      { from: points[0], to: points[1], color: style.borderTopColor, width: style.borderTopWidth, borderStyle: style.borderTopStyle },
      { from: points[1], to: points[2], color: style.borderRightColor, width: style.borderRightWidth, borderStyle: style.borderRightStyle },
      { from: points[2], to: points[3], color: style.borderBottomColor, width: style.borderBottomWidth, borderStyle: style.borderBottomStyle },
      { from: points[3], to: points[0], color: style.borderLeftColor, width: style.borderLeftWidth, borderStyle: style.borderLeftStyle },
    ];

    for (const side of sides) {
      const stroke = createStrokeFromBorder(side.color, side.width, side.borderStyle, opacity);
      if (!stroke) continue;

      if (stroke.borderStyle === "double" && stroke.width >= 3) {
        const dx = side.to.x - side.from.x;
        const dy = side.to.y - side.from.y;
        const normal = normalize({ x: -dy, y: dx });
        const offset = stroke.width / 3;
        const lineWidth = Math.max(1, stroke.width / 3);
        this.emitFigures([
          {
            start: addPoint(side.from, scalePoint(normal, -offset)),
            segments: [{ kind: "line", to: addPoint(side.to, scalePoint(normal, -offset)) }],
            closed: false,
          },
        ], null, { color: stroke.color, width: lineWidth }, undefined, undefined);
        this.emitFigures([
          {
            start: addPoint(side.from, scalePoint(normal, offset)),
            segments: [{ kind: "line", to: addPoint(side.to, scalePoint(normal, offset)) }],
            closed: false,
          },
        ], null, { color: stroke.color, width: lineWidth }, undefined, undefined);
      } else {
        this.emitFigures([
          {
            start: side.from,
            segments: [{ kind: "line", to: side.to }],
            closed: false,
          },
        ], null, stroke, undefined, undefined);
      }
    }
  }

  private buildOuterEmf(): Uint8Array {
    const nRecords = this.records.getNumRecords() + 1;
    const bodySize = this.records.getTotalSize();
    const headerDataSize = 100;
    const headerRecordSize = 8 + headerDataSize;
    const totalSize = headerRecordSize + bodySize;
    const headerData = new Uint8Array(headerDataSize);
    const view = new DataView(headerData.buffer);

    view.setInt32(0, 0, true);
    view.setInt32(4, 0, true);
    view.setInt32(8, this.width - 1, true);
    view.setInt32(12, this.height - 1, true);

    const pxToHundredthMm = 2646 / 100;
    view.setInt32(16, 0, true);
    view.setInt32(20, 0, true);
    view.setInt32(24, Math.round(this.width * pxToHundredthMm), true);
    view.setInt32(28, Math.round(this.height * pxToHundredthMm), true);
    view.setUint32(32, 0x464D4520, true);
    view.setUint32(36, 0x00010000, true);
    view.setUint32(40, totalSize, true);
    view.setUint32(44, nRecords, true);
    view.setUint16(48, 1, true);
    view.setUint16(50, 0, true);
    view.setUint32(52, 0, true);
    view.setUint32(56, 0, true);
    view.setUint32(60, 0, true);
    view.setInt32(64, 1920, true);
    view.setInt32(68, 1080, true);
    view.setInt32(72, 508, true);
    view.setInt32(76, 285, true);
    view.setUint32(80, 0, true);
    view.setUint32(84, 0, true);
    view.setUint32(88, 0, true);
    view.setInt32(92, 508000, true);
    view.setInt32(96, 285000, true);

    const output = new Uint8Array(totalSize);
    const headerRecord = new Uint8Array(headerRecordSize);
    const headerView = new DataView(headerRecord.buffer);
    headerView.setUint32(0, EMR.HEADER, true);
    headerView.setUint32(4, headerRecordSize, true);
    headerRecord.set(headerData, 8);

    output.set(headerRecord, 0);
    let offset = headerRecordSize;
    for (const chunk of this.records.getChunks()) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}
