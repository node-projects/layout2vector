/**
 * PDF Writer using pdf-lite.
 * Maps IR nodes to PDF drawing operations via raw PDF content stream operators.
 *
 * Returns a PdfDocument from `end()`. Call `await doc.finalize()` then `doc.toBytes()`
 * to get the final PDF bytes.
 */
import {
  PdfFont,
  PdfArray,
  PdfBoolean,
  PdfDictionary,
  PdfIndirectObject,
  PdfName,
  PdfNumber,
  PdfReference,
  PdfStream,
  PdfDocument,
  PdfPage,
  PdfPages,
} from "../pdf-objects.js";
import type { FontAsset, FontAssetCollection, FontAssetSourceFormat } from "../font-assets.js";
import { inflateZlibSync } from "../shared/zlib-inflate.js";
import { parseCssColor as parseColor, parseVisibleCssColor as parseVisibleColor, type ParsedCssColor as ParsedColor } from "./shared/css-color.js";
import { getPointBounds, getQuadBounds, parseClipPathShape, type ClipPathBounds } from "./shared/clip-path.js";
import {
  expandRepeatingGradientStops,
  normalizeGradientStopOffsets,
  parseAllGradientsAst,
  type GradientStopAst,
  type ParsedGradientAst,
} from "./shared/gradient-utils.js";
import { parseTTF, type ParsedTTF } from "../ttf-parser.js";
import type { Point, Quad, Style, Writer } from "../types.js";
import { roundedQuadPath } from "../geometry.js";
import { isAxisAlignedRect } from "./shared/writer-utils.js";

// ── Shared helpers ──────────────────────────────────────────────────

function parseBorderRadius(borderRadius: string | undefined, elWidth?: number, elHeight?: number): { rx: number; ry: number } | null {
  if (!borderRadius || borderRadius === "0px" || borderRadius === "0%") return null;

  const [horizontalPart, verticalPart] = borderRadius.split("/").map((part) => part.trim());
  const horizontalTokens = horizontalPart.split(/\s+/).filter(Boolean);
  const verticalTokens = (verticalPart || horizontalPart).split(/\s+/).filter(Boolean);

  const parseRadiusToken = (token: string | undefined, reference: number | undefined): number | null => {
    if (!token) return null;
    const value = parseFloat(token);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (token.includes("%")) {
      return reference !== undefined && reference > 0 ? (reference * value) / 100 : value;
    }
    return value;
  };

  let rx = parseRadiusToken(horizontalTokens[0], elWidth);
  let ry = parseRadiusToken(verticalTokens[0] ?? horizontalTokens[1] ?? horizontalTokens[0], elHeight);
  if (rx == null || ry == null) return null;

  if ((elWidth ?? 0) > 0 && (elHeight ?? 0) > 0) {
    const scaleX = elWidth! / (rx * 2);
    const scaleY = elHeight! / (ry * 2);
    const scale = Math.min(1, scaleX, scaleY);
    if (scale < 1) {
      rx *= scale;
      ry *= scale;
    }
  }

  return { rx, ry };
}

function parseFontSize(fontSize: string | undefined): number {
  if (!fontSize) return 12;
  const px = parseFloat(fontSize);
  return isNaN(px) ? 12 : px * 0.75;
}

function mapFontWeight(weight: string | undefined): "bold" | "normal" {
  if (!weight) return "normal";
  const n = parseInt(weight);
  if (!isNaN(n) && n >= 700) return "bold";
  if (weight === "bold" || weight === "bolder") return "bold";
  return "normal";
}

function normalizeFontFamilyName(family: string): string {
  return family.replace(/["']/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseFontFamilies(family: string): string[] {
  const seen = new Set<string>();
  const families: string[] = [];

  for (const token of family.split(",")) {
    const normalized = normalizeFontFamilyName(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    families.push(normalized);
  }

  return families;
}

function normalizeCustomFontWeight(weight: string | undefined): string {
  const normalized = (weight ?? "").trim().toLowerCase();
  if (!normalized || normalized === "normal") return "400";
  if (normalized === "bold" || normalized === "bolder") return "700";
  const numeric = parseInt(normalized, 10);
  return Number.isFinite(numeric) ? String(numeric) : normalized;
}

function normalizeCustomFontStyle(style: string | undefined): string {
  const normalized = (style ?? "").trim().toLowerCase();
  if (!normalized || normalized === "normal") return "normal";
  if (normalized.includes("italic")) return "italic";
  if (normalized.includes("oblique")) return "oblique";
  return normalized;
}

function buildCustomFontKey(family: string, weight: string | undefined, style: string | undefined): string {
  return `${normalizeFontFamilyName(family)}|${normalizeCustomFontWeight(weight)}|${normalizeCustomFontStyle(style)}`;
}

function choosePdfFontSource(face: FontAsset): FontAsset["sources"][number] | null {
  return face.sources.find((source) => source.format === "ttf")
    ?? face.sources.find((source) => source.format === "otf")
    ?? face.sources.find((source) => source.format === "woff")
    ?? face.sources.find((source) => source.format === "woff2")
    ?? null;
}

type FontEditorCoreModule = typeof import("fonteditor-core");
type RegisteredCustomFont = {
  id: string;
  pdfName: string;
  parsed: ParsedTTF;
};

let fontEditorCorePromise: Promise<FontEditorCoreModule> | null = null;

async function getFontEditorCore(): Promise<FontEditorCoreModule> {
  if (!fontEditorCorePromise) {
    fontEditorCorePromise = import("fonteditor-core").then(async (mod) => {
      if (mod.woff2 && typeof mod.woff2.init === "function") {
        await mod.woff2.init();
      }
      return mod;
    });
  }

  return fontEditorCorePromise;
}

async function convertFontToTrueType(data: Uint8Array, format: FontAssetSourceFormat): Promise<Uint8Array> {
  if (format === "ttf") return data;

  const { createFont } = await getFontEditorCore();
  const input = new Uint8Array(data.byteLength);
  input.set(data);
  const font = createFont(input.buffer, { type: format });
  const converted = font.write({ type: "ttf" });
  if (converted instanceof Uint8Array) return converted;
  if (typeof converted === "string") return new TextEncoder().encode(converted);
  return new Uint8Array(converted);
}

/** Convert pixel to PDF points (1px ≈ 0.75pt). */
function pxToPt(px: number): number { return px * 0.75; }

/** Format a number for PDF content stream operators. */
function pn(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  // Faster than toFixed+regex: round to 4 decimal places manually
  const rounded = Math.round(n * 10000) / 10000;
  if (Number.isInteger(rounded)) return rounded.toString();
  return rounded.toString();
}

/**
 * Unicode → WinAnsiEncoding (Windows-1252) byte mapping for code points
 * in the 0x80–0x9F range that differ from ISO 8859-1.
 */
const unicodeToWinAnsi: Record<number, number> = {
  0x20AC: 0x80, // €
  0x201A: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201E: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02C6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8A, // Š
  0x2039: 0x8B, // ‹
  0x0152: 0x8C, // Œ
  0x017D: 0x8E, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201C: 0x93, // "
  0x201D: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02DC: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9A, // š
  0x203A: 0x9B, // ›
  0x0153: 0x9C, // œ
  0x017E: 0x9E, // ž
  0x0178: 0x9F, // Ÿ
};

/**
 * Escape a text string for use in a PDF content stream `( )`.
 * Encodes non-ASCII characters as WinAnsiEncoding octal escapes
 * so they survive UTF-8 serialization and match the font encoding.
 * Iterates by full Unicode code points to correctly handle surrogate pairs.
 */
function escapePdfText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") { out += "\\\\"; }
    else if (ch === "(") { out += "\\("; }
    else if (ch === ")") { out += "\\)"; }
    else if (code < 0x80) {
      // ASCII — emit as-is
      out += ch;
    } else {
      // Non-ASCII — encode as WinAnsi octal escape
      let winByte = unicodeToWinAnsi[code];
      if (winByte === undefined && code >= 0xA0 && code <= 0xFF) {
        // Latin-1 supplement: WinAnsi matches Unicode
        winByte = code;
      }
      if (winByte !== undefined) {
        out += "\\" + winByte.toString(8).padStart(3, "0");
      } else {
        // Characters not in WinAnsiEncoding → substitute with '?'
        out += "?";
      }
    }
  }
  return out;
}

/**
 * Check whether a text string contains characters outside WinAnsiEncoding.
 * Returns true if the text needs a Unicode-capable font (CID/Type0).
 * Iterates by full Unicode code points to correctly handle surrogate pairs.
 */
function needsUnicodeFont(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) continue; // ASCII is fine
    if (unicodeToWinAnsi[code] !== undefined) continue; // mapped
    if (code >= 0xA0 && code <= 0xFF) continue; // Latin-1 supplement
    return true; // not encodable in WinAnsi
  }
  return false;
}

/**
 * Escape text for symbolic fonts (ZapfDingbats, Symbol).
 * These fonts use their own encoding — emit raw byte values as octal escapes.
 * Iterates by full Unicode code points to correctly handle surrogate pairs.
 */
function escapePdfSymbolic(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") { out += "\\\\"; }
    else if (ch === "(") { out += "\\("; }
    else if (ch === ")") { out += "\\)"; }
    else if (code <= 0xFF) {
      // Emit as octal for any byte to ensure correct encoding
      if (code < 0x80 && code >= 0x20) {
        out += ch;
      } else {
        out += "\\" + code.toString(8).padStart(3, "0");
      }
    } else {
      // Characters outside single-byte range — drop
    }
  }
  return out;
}

/** Decode a data URL to raw bytes and MIME type. */
function decodeDataUrl(dataUrl: string): { data: Uint8Array; mimeType: string } | null {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const base64 = match[2];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { data: bytes, mimeType };
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type RasterImage = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
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

function decodePng(data: Uint8Array): RasterImage | null {
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
  const rowBytes = width * channelCount;
  const combinedIdat = new Uint8Array(idatChunks.reduce((size, chunk) => size + chunk.length, 0));
  let combinedOffset = 0;
  for (const chunk of idatChunks) {
    combinedIdat.set(chunk, combinedOffset);
    combinedOffset += chunk.length;
  }

  const decoded = inflateZlibSync(combinedIdat);
  if (!decoded || decoded.byteLength < height * (rowBytes + 1)) return null;

  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  let previousRow = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filterType = decoded[sourceOffset];
    sourceOffset += 1;
    const row = decoded.subarray(sourceOffset, sourceOffset + rowBytes);
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

function readGifSubBlocks(bytes: Uint8Array, offset: number): { data: Uint8Array; offset: number } | null {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let cursor = offset;

  while (cursor < bytes.length) {
    const blockSize = bytes[cursor++];
    if (blockSize === 0) {
      const data = new Uint8Array(totalLength);
      let destOffset = 0;
      for (const chunk of chunks) {
        data.set(chunk, destOffset);
        destOffset += chunk.length;
      }
      return { data, offset: cursor };
    }
    if (cursor + blockSize > bytes.length) return null;
    const chunk = bytes.subarray(cursor, cursor + blockSize);
    chunks.push(chunk);
    totalLength += chunk.length;
    cursor += blockSize;
  }

  return null;
}

function decodeGifLzw(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array | null {
  if (minCodeSize < 1 || minCodeSize > 8) return null;

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const pixelStack = new Uint8Array(4097);

  for (let index = 0; index < clearCode; index += 1) {
    suffix[index] = index;
  }

  let available = clearCode + 2;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let oldCode = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let byteIndex = 0;
  let stackSize = 0;
  let outputIndex = 0;
  const output = new Uint8Array(pixelCount);

  while (outputIndex < pixelCount) {
    if (stackSize === 0) {
      while (bits < codeSize) {
        if (byteIndex >= data.length) return null;
        datum |= data[byteIndex] << bits;
        bits += 8;
        byteIndex += 1;
      }

      let code = datum & codeMask;
      datum >>= codeSize;
      bits -= codeSize;

      if (code === clearCode) {
        available = clearCode + 2;
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        oldCode = -1;
        continue;
      }
      if (code === endCode) break;
      if (code > available || code >= 4096) return null;

      if (oldCode === -1) {
        output[outputIndex++] = suffix[code];
        oldCode = code;
        first = code;
        continue;
      }

      const inCode = code;
      if (code === available) {
        pixelStack[stackSize++] = first;
        code = oldCode;
      }

      while (code >= clearCode) {
        if (code >= 4096 || stackSize >= pixelStack.length) return null;
        pixelStack[stackSize++] = suffix[code];
        code = prefix[code];
      }

      first = suffix[code];
      pixelStack[stackSize++] = first;

      if (available < 4096) {
        prefix[available] = oldCode;
        suffix[available] = first;
        available += 1;
        if (available === (1 << codeSize) && codeSize < 12) {
          codeSize += 1;
          codeMask = (1 << codeSize) - 1;
        }
      }

      oldCode = inCode;
    }

    stackSize -= 1;
    output[outputIndex++] = pixelStack[stackSize];
  }

  return outputIndex === pixelCount ? output : null;
}

function decodeGif(data: Uint8Array): RasterImage | null {
  if (data.length < 13) return null;

  const signature = String.fromCharCode(
    data[0],
    data[1],
    data[2],
    data[3],
    data[4],
    data[5],
  );
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;

  let offset = 6;
  const canvasWidth = readUint16LE(data, offset);
  const canvasHeight = readUint16LE(data, offset + 2);
  offset += 4;
  if (canvasWidth <= 0 || canvasHeight <= 0) return null;

  const packed = data[offset++];
  const hasGlobalColorTable = (packed & 0x80) !== 0;
  const globalColorTableSize = 1 << ((packed & 0x07) + 1);
  offset += 2; // background color index + pixel aspect ratio

  let globalColorTable: Uint8Array | null = null;
  if (hasGlobalColorTable) {
    const tableLength = globalColorTableSize * 3;
    if (offset + tableLength > data.length) return null;
    globalColorTable = data.subarray(offset, offset + tableLength);
    offset += tableLength;
  }

  let transparentIndex: number | null = null;

  while (offset < data.length) {
    const blockType = data[offset++];

    if (blockType === 0x3B) break;

    if (blockType === 0x21) {
      if (offset >= data.length) return null;
      const extensionType = data[offset++];
      if (extensionType === 0xF9) {
        const blockSize = data[offset++];
        if (blockSize !== 4 || offset + blockSize + 1 > data.length) return null;
        const controlPacked = data[offset];
        transparentIndex = (controlPacked & 0x01) !== 0 ? data[offset + 3] : null;
        offset += blockSize;
        if (data[offset++] !== 0) return null;
      } else {
        const subBlocks = readGifSubBlocks(data, offset);
        if (!subBlocks) return null;
        offset = subBlocks.offset;
      }
      continue;
    }

    if (blockType !== 0x2C || offset + 9 > data.length) return null;

    const left = readUint16LE(data, offset);
    const top = readUint16LE(data, offset + 2);
    const width = readUint16LE(data, offset + 4);
    const height = readUint16LE(data, offset + 6);
    const imagePacked = data[offset + 8];
    offset += 9;

    if (width <= 0 || height <= 0) return null;

    const hasLocalColorTable = (imagePacked & 0x80) !== 0;
    const interlaced = (imagePacked & 0x40) !== 0;
    const localColorTableSize = 1 << ((imagePacked & 0x07) + 1);

    let colorTable = globalColorTable;
    if (hasLocalColorTable) {
      const tableLength = localColorTableSize * 3;
      if (offset + tableLength > data.length) return null;
      colorTable = data.subarray(offset, offset + tableLength);
      offset += tableLength;
    }
    if (!colorTable) return null;

    const lzwMinCodeSize = data[offset++];
    const subBlocks = readGifSubBlocks(data, offset);
    if (!subBlocks) return null;
    offset = subBlocks.offset;

    const indexStream = decodeGifLzw(subBlocks.data, lzwMinCodeSize, width * height);
    if (!indexStream) return null;

    const rgba = new Uint8Array(canvasWidth * canvasHeight * 4);
    const rowOrder: number[] = [];
    if (interlaced) {
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
        for (let y = start; y < height; y += step) rowOrder.push(y);
      }
    } else {
      for (let y = 0; y < height; y += 1) rowOrder.push(y);
    }

    let sourceIndex = 0;
    const colorCount = colorTable.length / 3;
    for (const sourceY of rowOrder) {
      const destY = top + sourceY;
      for (let x = 0; x < width; x += 1) {
        const colorIndex = indexStream[sourceIndex++];
        const destX = left + x;
        if (destX >= canvasWidth || destY >= canvasHeight || colorIndex >= colorCount) continue;
        const destOffset = (destY * canvasWidth + destX) * 4;
        if (transparentIndex !== null && colorIndex === transparentIndex) {
          rgba[destOffset + 3] = 0;
          continue;
        }
        const colorOffset = colorIndex * 3;
        rgba[destOffset] = colorTable[colorOffset];
        rgba[destOffset + 1] = colorTable[colorOffset + 1];
        rgba[destOffset + 2] = colorTable[colorOffset + 2];
        rgba[destOffset + 3] = 255;
      }
    }

    return { width: canvasWidth, height: canvasHeight, rgba };
  }

  return null;
}

function splitRasterChannels(image: RasterImage): { rgb: Uint8Array; alphaMask?: Uint8Array } {
  const rgb = new Uint8Array(image.width * image.height * 3);
  const alphaMask = new Uint8Array(image.width * image.height);
  let hasTransparency = false;

  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const rgbaOffset = pixel * 4;
    const rgbOffset = pixel * 3;
    rgb[rgbOffset] = image.rgba[rgbaOffset];
    rgb[rgbOffset + 1] = image.rgba[rgbaOffset + 1];
    rgb[rgbOffset + 2] = image.rgba[rgbaOffset + 2];
    const alpha = image.rgba[rgbaOffset + 3];
    alphaMask[pixel] = alpha;
    if (alpha < 255) hasTransparency = true;
  }

  return {
    rgb,
    alphaMask: hasTransparency ? alphaMask : undefined,
  };
}

type SupportedImageColorFilterOp =
  | { kind: "linear-rgb"; slope: number; intercept: number }
  | { kind: "matrix-rgb"; matrix: [number, number, number, number, number, number, number, number, number] };

function clampUnit(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function parseUnitInterval(rawValue: string, defaultValue: number): number | undefined {
  const value = rawValue.trim();
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return clampUnit(value.endsWith("%") ? parsed / 100 : parsed);
}

function parseNonNegativeFilterNumber(rawValue: string, defaultValue: number): number | undefined {
  const value = rawValue.trim();
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, value.endsWith("%") ? parsed / 100 : parsed);
}

function parseAngleDegrees(rawValue: string): number | undefined {
  const value = rawValue.trim();
  if (!value) return 0;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (value.endsWith("rad")) return parsed * (180 / Math.PI);
  if (value.endsWith("turn")) return parsed * 360;
  if (value.endsWith("grad")) return parsed * 0.9;
  return parsed;
}

function buildSaturateMatrix(amount: number): [number, number, number, number, number, number, number, number, number] {
  return [
    0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount,
    0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount,
    0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount,
  ];
}

function buildGrayscaleMatrix(amount: number): [number, number, number, number, number, number, number, number, number] {
  return [
    1 - 0.7874 * amount, 0.7152 * amount, 0.0722 * amount,
    0.2126 * amount, 1 - 0.2848 * amount, 0.0722 * amount,
    0.2126 * amount, 0.7152 * amount, 1 - 0.9278 * amount,
  ];
}

function buildSepiaMatrix(amount: number): [number, number, number, number, number, number, number, number, number] {
  return [
    1 - 0.607 * amount, 0.769 * amount, 0.189 * amount,
    0.349 * amount, 1 - 0.314 * amount, 0.168 * amount,
    0.272 * amount, 0.534 * amount, 1 - 0.869 * amount,
  ];
}

function buildHueRotateMatrix(angleDeg: number): [number, number, number, number, number, number, number, number, number] {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    0.213 + cos * 0.787 - sin * 0.213,
    0.715 - cos * 0.715 - sin * 0.715,
    0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143,
    0.715 + cos * 0.285 + sin * 0.14,
    0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787,
    0.715 - cos * 0.715 + sin * 0.715,
    0.072 + cos * 0.928 + sin * 0.072,
  ];
}

function parseSupportedImageColorFilters(filter: string | undefined): SupportedImageColorFilterOp[] {
  const value = filter?.trim();
  if (!value || value === "none") return [];

  const operations: SupportedImageColorFilterOp[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (index >= value.length) break;

    const nameStart = index;
    while (index < value.length && /[a-z-]/i.test(value[index])) index += 1;
    if (nameStart === index) break;

    const name = value.slice(nameStart, index).toLowerCase();
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (value[index] !== "(") break;

    index += 1;
    const argStart = index;
    let depth = 1;
    while (index < value.length && depth > 0) {
      const char = value[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    if (depth !== 0) break;

    const rawArg = value.slice(argStart, index - 1).trim();

    switch (name) {
      case "invert": {
        const amount = parseUnitInterval(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "linear-rgb", slope: 1 - 2 * amount, intercept: amount });
        break;
      }
      case "brightness": {
        const amount = parseNonNegativeFilterNumber(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "linear-rgb", slope: amount, intercept: 0 });
        break;
      }
      case "contrast": {
        const amount = parseNonNegativeFilterNumber(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "linear-rgb", slope: amount, intercept: 0.5 * (1 - amount) });
        break;
      }
      case "saturate": {
        const amount = parseNonNegativeFilterNumber(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "matrix-rgb", matrix: buildSaturateMatrix(amount) });
        break;
      }
      case "grayscale": {
        const amount = parseUnitInterval(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "matrix-rgb", matrix: buildGrayscaleMatrix(amount) });
        break;
      }
      case "sepia": {
        const amount = parseUnitInterval(rawArg, 1);
        if (amount !== undefined) operations.push({ kind: "matrix-rgb", matrix: buildSepiaMatrix(amount) });
        break;
      }
      case "hue-rotate": {
        const angleDeg = parseAngleDegrees(rawArg);
        if (angleDeg !== undefined) operations.push({ kind: "matrix-rgb", matrix: buildHueRotateMatrix(angleDeg) });
        break;
      }
      default:
        break;
    }
  }

  return operations;
}

function applySupportedImageColorFilters(
  rgb: Uint8Array,
  filter: string | undefined,
  alphaMask?: Uint8Array,
): { rgb: Uint8Array; alphaMask?: Uint8Array } {
  const operations = parseSupportedImageColorFilters(filter);
  if (operations.length === 0) return { rgb, alphaMask };

  const filteredRgb = new Uint8Array(rgb.length);
  const filteredAlpha = alphaMask ? new Uint8Array(alphaMask) : undefined;

  for (let offset = 0; offset < rgb.length; offset += 3) {
    let r = rgb[offset] / 255;
    let g = rgb[offset + 1] / 255;
    let b = rgb[offset + 2] / 255;

    for (const operation of operations) {
      if (operation.kind === "linear-rgb") {
        r = clampUnit(r * operation.slope + operation.intercept);
        g = clampUnit(g * operation.slope + operation.intercept);
        b = clampUnit(b * operation.slope + operation.intercept);
        continue;
      }

      const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = operation.matrix;
      const nextR = clampUnit(r * m0 + g * m1 + b * m2);
      const nextG = clampUnit(r * m3 + g * m4 + b * m5);
      const nextB = clampUnit(r * m6 + g * m7 + b * m8);
      r = nextR;
      g = nextG;
      b = nextB;
    }

    filteredRgb[offset] = Math.round(r * 255);
    filteredRgb[offset + 1] = Math.round(g * 255);
    filteredRgb[offset + 2] = Math.round(b * 255);
  }

  return {
    rgb: filteredRgb,
    alphaMask: filteredAlpha,
  };
}

// ── Gradient parsing (identical logic to jspdf-writer) ──────────────

interface GradientStop { offset: number; color: ParsedColor; }
interface LinearGradient { type: "linear"; angleDeg: number; stops: GradientStop[]; repeating: boolean; }
interface RadialGradient { type: "radial"; stops: GradientStop[]; repeating: boolean; }
interface ConicGradient  { type: "conic";  stops: GradientStop[]; fromAngleDeg: number; repeating: boolean; }
type ParsedGradient = LinearGradient | RadialGradient | ConicGradient;

type RenderedOutline = {
  color: ParsedColor;
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

  const color = parseVisibleColor(style.outlineColor ?? style.color ?? style.stroke ?? style.fill);
  if (!color) return null;

  const offset = style.outlineOffset ? parseFloat(style.outlineOffset) : 0;
  return {
    color,
    width,
    style: outlineStyle,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

function resolveGradientStops(stopsAst: GradientStopAst<ParsedColor>[]): GradientStop[] {
  const stops = stopsAst.map((stop) => ({
    color: stop.color,
    offset: stop.unit === "auto" ? -1 : stop.offset,
  }));

  if (stops.length === 0) return stops;
  if (stopsAst.some((stop) => stop.unit === "px")) {
    let maxPx = 0;
    for (let index = 0; index < stopsAst.length; index += 1) {
      if (stopsAst[index].unit === "px" && stops[index].offset > maxPx) maxPx = stops[index].offset;
    }
    if (maxPx > 0) {
      for (let index = 0; index < stopsAst.length; index += 1) {
        if (stopsAst[index].unit === "px") stops[index].offset /= maxPx;
      }
    }
  }

  return normalizeGradientStopOffsets(stops);
}

function toPdfGradient(gradient: ParsedGradientAst<ParsedColor>): ParsedGradient {
  const stops = resolveGradientStops(gradient.stops);
  if (gradient.type === "linear") return { ...gradient, stops };
  if (gradient.type === "radial") return { ...gradient, stops };
  return { ...gradient, stops };
}

function parseGradients(bgImage: string | undefined): ParsedGradient[] {
  return parseAllGradientsAst(bgImage, { parseColor }).map(toPdfGradient);
}

// ── Box-shadow parsing ──────────────────────────────────────────────

interface BoxShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: ParsedColor | null;
  inset: boolean;
}

/**
 * Parse a CSS box-shadow value into individual shadow definitions.
 * Format: [inset] h-offset v-offset [blur [spread]] [color], ...
 */
function parseBoxShadow(value: string): BoxShadow[] {
  const shadows: BoxShadow[] = [];
  // Split by comma, respecting parentheses (for rgba(...))
  const parts: string[] = [];
  let depth = 0, current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    const inset = /\binset\b/i.test(part);
    const clean = part.replace(/\binset\b/gi, "").trim();

    // Extract color (rgb/rgba or hex or named)
    let colorStr: string | undefined;
    let rest = clean;
    const rgbaMatch = clean.match(/rgba?\([^)]+\)/);
    if (rgbaMatch) {
      colorStr = rgbaMatch[0];
      rest = clean.replace(rgbaMatch[0], "").trim();
    } else {
      // Try hex color at start or end
      const hexMatch = clean.match(/(#[0-9a-fA-F]{3,8})/);
      if (hexMatch) {
        colorStr = hexMatch[1];
        rest = clean.replace(hexMatch[1], "").trim();
      }
    }

    // Parse numeric values (px units)
    const nums = rest.match(/-?[\d.]+px/g)?.map(s => parseFloat(s)) ?? [];
    const offsetX = nums[0] ?? 0;
    const offsetY = nums[1] ?? 0;
    const blur = nums[2] ?? 0;
    const spread = nums[3] ?? 0;
    const color = parseColor(colorStr);

    shadows.push({ offsetX, offsetY, blur, spread, color, inset });
  }

  return shadows;
}

// ── Conic gradient color interpolation ──────────────────────────────

/** Interpolate color at position t [0..1] along conic gradient stops. */
function interpolateConicColor(
  t: number,
  stops: GradientStop[],
  repeating = false,
): ParsedColor {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
  const maxOffset = stops[stops.length - 1].offset;
  if (repeating && maxOffset > 0 && maxOffset < 0.999999) {
    t = ((t % maxOffset) + maxOffset) % maxOffset;
  }
  if (t <= stops[0].offset) return stops[0].color;
  if (t >= stops[stops.length - 1].offset) return stops[stops.length - 1].color;

  // Find the two stops that t falls between
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].offset && t <= stops[i + 1].offset) {
      const range = stops[i + 1].offset - stops[i].offset;
      const f = range > 0 ? (t - stops[i].offset) / range : 0;
      const c0 = stops[i].color;
      const c1 = stops[i + 1].color;
      return {
        r: Math.round(c0.r + (c1.r - c0.r) * f),
        g: Math.round(c0.g + (c1.g - c0.g) * f),
        b: Math.round(c0.b + (c1.b - c0.b) * f),
        a: c0.a + (c1.a - c0.a) * f,
      };
    }
  }
  return stops[stops.length - 1].color;
}

// ── Resource tracking ───────────────────────────────────────────────

interface GStateDef { name: string; ca: number; CA: number; }

interface ShadingDef {
  name: string;
  type: 2 | 3;          // 2 = axial, 3 = radial
  coords: number[];     // in PDF coordinates
  stops: { offset: number; r: number; g: number; b: number }[];
}

interface ImageDef {
  name: string;
  data: Uint8Array;
  width: number;
  height: number;
  filter: string | null; // "DCTDecode" for JPEG, null for raw RGB
  softMask?: Uint8Array;
}

// ── PDF-Lite Writer ─────────────────────────────────────────────────

/** Bezier approximation constant for quarter-circle arcs. */
const KAPPA = 0.5522847498;

/** Options for the PDF writer. */
export type PDFWriterOptions = {
  /** Page width in mm (default A4 = 210). */
  pageWidth?: number;
  /** Page height in mm (default A4 = 297). */
  pageHeight?: number;
  /** Downloaded @font-face assets used by extracted text. */
  fontAssets?: FontAssetCollection;
  /**
   * When true, OTF/WOFF/WOFF2 font assets are converted to TrueType via the
   * optional `fonteditor-core` dependency before PDF embedding.
   * Defaults to false.
   */
  useFontEditorCore?: boolean;
  /** Map of CSS font-family name → TTF file bytes. */
  customFonts?: Map<string, Uint8Array>;
  /** TTF file bytes for a default Unicode-capable font. */
  defaultFont?: Uint8Array;
  /** Scale factor applied to page dimensions. */
  zoom?: number;
};

export class PDFWriter implements Writer<PdfDocument> {
  private ops: string[] = [];
  private pageWidthPt: number;
  private pageHeightPt: number;

  // Resource tracking
  private fontMap = new Map<string, string>();  // standard PDF font name → resource name (F1, …)
  private fontCounter = 0;
  private gstates: GStateDef[] = [];
  private shadings: ShadingDef[] = [];
  private shadingCounter = 0;
  private images: ImageDef[] = [];
  private imageCounter = 0;

  // Custom TrueType fonts: selector/family key → one or more parsed TTF subsets
  private customFonts = new Map<string, RegisteredCustomFont[]>();
  private customFontIndex = new Map<string, RegisteredCustomFont>();
  private customFontIdCounter = 0;
  // Track which characters (Unicode code points) are used per custom font (PostScript name)
  private customFontUsedChars = new Map<string, Set<number>>();
  // Default font for Unicode text that can't be encoded in WinAnsi
  private defaultFont: ParsedTTF | null = null;
  private fontAssets?: FontAssetCollection;
  private fontAssetsRegistered = false;
  private useFontEditorCore = false;

  /**
   * @param optionsOrPageWidth Options object, or page width in mm (positional form).
   * @param pageHeight Page height in mm (positional form).
   * @param customFonts Map of CSS font-family name → TTF file bytes (positional form).
   * @param defaultFont TTF file bytes for a default Unicode-capable font (positional form).
   * @param zoom Scale factor applied to page dimensions (positional form).
   */
  constructor(optionsOrPageWidth?: PDFWriterOptions | number, pageHeight?: number, customFonts?: Map<string, Uint8Array>, defaultFont?: Uint8Array, zoom?: number) {
    if (typeof optionsOrPageWidth === "object" && optionsOrPageWidth !== null && !(optionsOrPageWidth instanceof Map)) {
      const opts = optionsOrPageWidth;
      const z = opts.zoom ?? 1;
      this.pageWidthPt = (opts.pageWidth ?? 210) * z * 2.835;
      this.pageHeightPt = (opts.pageHeight ?? 297) * z * 2.835;
      this.fontAssets = opts.fontAssets;
      this.useFontEditorCore = opts.useFontEditorCore ?? false;
      if (opts.customFonts) {
        for (const [family, data] of opts.customFonts) {
          this.registerCustomFont(family, data);
        }
      }
      if (opts.defaultFont) {
        this.defaultFont = parseTTF(opts.defaultFont);
      }
    } else {
      const pw = (optionsOrPageWidth as number | undefined) ?? 210;
      const ph = pageHeight ?? 297;
      const z = zoom ?? 1;
      this.pageWidthPt = pw * z * 2.835;
      this.pageHeightPt = ph * z * 2.835;
      this.fontAssets = undefined;
      if (customFonts) {
        for (const [family, data] of customFonts) {
          this.registerCustomFont(family, data);
        }
      }
      if (defaultFont) {
        this.defaultFont = parseTTF(defaultFont);
      }
    }
  }

  async begin(): Promise<void> {
    await this.ensureFontAssetsRegistered();

    this.ops = [];
    this.fontMap.clear();
    this.fontCounter = 0;
    this.gstates = [];
    this.shadings = [];
    this.shadingCounter = 0;
    this.images = [];
    this.imageCounter = 0;
    this.customFontUsedChars.clear();
  }

  // ── Coordinate helpers ──────────────────────────────────────────

  /** Convert px X to PDF pt (same direction). */
  private ptX(px: number): number { return px * 0.75; }

  /** Convert px Y to PDF pt (flipped: PDF Y=0 is bottom). */
  private ptY(px: number): number { return this.pageHeightPt - px * 0.75; }

  // ── Font helpers ────────────────────────────────────────────────

  private async ensureFontAssetsRegistered(): Promise<void> {
    if (this.fontAssetsRegistered || !this.fontAssets || this.fontAssets.faces.length === 0) return;

    for (const face of this.fontAssets.faces) {
      const source = choosePdfFontSource(face);
      if (!source) continue;
      if (source.format !== "ttf" && !this.useFontEditorCore) continue;

      try {
        const fontData = source.format === "ttf"
          ? source.data
          : await convertFontToTrueType(source.data, source.format);
        this.registerCustomFont(face.family, fontData, {
          weight: face.weight,
          style: face.style,
        });
      } catch {
        // Keep best-effort behavior when conversion fails.
      }
    }

    this.fontAssetsRegistered = true;
  }

  private registerCustomFont(
    family: string,
    data: Uint8Array,
    descriptors?: { weight?: string; style?: string },
  ): void {
    const parsed = parseTTF(data);
    const record: RegisteredCustomFont = {
      id: `CF${++this.customFontIdCounter}`,
      pdfName: `${parsed.postScriptName}-${this.customFontIdCounter}`,
      parsed,
    };
    this.customFontIndex.set(record.id, record);
    const directKeys = [family, parsed.familyName, parsed.postScriptName];
    if (descriptors) {
      for (const key of directKeys) {
        if (!key) continue;
        this.addCustomFontCandidate(buildCustomFontKey(key, descriptors.weight, descriptors.style), record);
      }
    }

    for (const key of [family, parsed.familyName, parsed.postScriptName]) {
      const normalized = normalizeFontFamilyName(key);
      if (!normalized) continue;
      this.addCustomFontCandidate(normalized, record);
    }
  }

  private addCustomFontCandidate(key: string, record: RegisteredCustomFont): void {
    const existing = this.customFonts.get(key);
    if (existing) {
      if (!existing.some((candidate) => candidate.id === record.id)) {
        existing.push(record);
      }
      return;
    }

    this.customFonts.set(key, [record]);
  }

  private getCustomFontForFamily(family: string, weight: string | undefined, style: string | undefined): RegisteredCustomFont | null {
    const exactMatches = this.customFonts.get(buildCustomFontKey(family, weight, style)) ?? [];
    const familyMatches = this.customFonts.get(normalizeFontFamilyName(family)) ?? [];
    return exactMatches[0] ?? familyMatches[0] ?? null;
  }

  private getCustomFontCandidates(family: string, weight: string | undefined, style: string | undefined): RegisteredCustomFont[] {
    const seen = new Set<string>();
    const candidates: RegisteredCustomFont[] = [];
    for (const record of [
      ...(this.customFonts.get(buildCustomFontKey(family, weight, style)) ?? []),
      ...(this.customFonts.get(normalizeFontFamilyName(family)) ?? []),
    ]) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      candidates.push(record);
    }
    return candidates;
  }

  /** Map CSS font family + weight to a standard PDF font name (or custom font ID). */
  private mapToPdfFont(family: string, weight: string | undefined, style: string | undefined): string {
    const standardWeight = mapFontWeight(weight);
    for (const token of parseFontFamilies(family)) {
      const customFont = this.getCustomFontForFamily(token, weight, style);
      if (customFont) {
        return `custom:${customFont.id}`;
      }

      if (token === "symbol") {
        return "Symbol";
      }
      if (
        token === "wingdings"
        || token === "wingding"
        || token === "zapfdingbats"
        || token === "zapf dingbats"
        || token.includes("dingbats")
      ) {
        return "ZapfDingbats";
      }
      if (token.includes("courier") || token.includes("mono") || token === "monospace" || token === "ui-monospace") {
        return standardWeight === "bold" ? "Courier-Bold" : "Courier";
      }
      if (token.includes("times") || (token.includes("serif") && !token.includes("sans"))) {
        return standardWeight === "bold" ? "Times-Bold" : "Times-Roman";
      }
      if (
        token === "sans-serif"
        || token === "ui-sans-serif"
        || token === "system-ui"
        || token === "-apple-system"
        || token.includes("sans")
        || token.includes("arial")
        || token.includes("helvetica")
        || token.includes("roboto")
        || token.includes("inter")
        || token.includes("segoe ui")
        || token.includes("tahoma")
      ) {
        return standardWeight === "bold" ? "Helvetica-Bold" : "Helvetica";
      }
    }

    return standardWeight === "bold" ? "Helvetica-Bold" : "Helvetica";
  }

  /** Check whether a parsed font has glyphs for all characters in the text.
   *  Iterates by full Unicode code points to correctly handle surrogate pairs (emoji etc.). */
  private fontHasAllChars(parsed: ParsedTTF, text: string): boolean {
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      const gid = parsed.cmap.get(code);
      if (gid === undefined || gid === 0) return false;
    }
    return true;
  }

  /**
   * Resolve the font to use for a given text string.
   * If the text needs Unicode and a default font is available, use it.
   * Falls back through all available custom fonts if the primary choice
   * doesn't have the needed glyphs.
   */
  private resolveFont(family: string, weight: string | undefined, style: string | undefined, text: string): string {
    const families = parseFontFamilies(family);
    for (const token of families) {
      for (const record of this.getCustomFontCandidates(token, weight, style)) {
        if (this.fontHasAllChars(record.parsed, text)) {
          return `custom:${record.id}`;
        }
      }
    }

    const mapped = this.mapToPdfFont(family, weight, style);
    // If it's already a custom font, check it has the glyphs
    if (this.isCustomFont(mapped)) {
      const data = this.getCustomFontData(mapped);
      if (data && this.fontHasAllChars(data, text)) return mapped;
      // Fall through to find a font with the needed glyphs
    }
    // If text can be encoded in WinAnsi, use the mapped standard font
    if (!needsUnicodeFont(text)) return mapped;
    // Try the default font first
    if (this.defaultFont && this.fontHasAllChars(this.defaultFont, text)) {
      return `custom:${this.defaultFont.postScriptName}`;
    }
    // Search all custom fonts for one that has the needed glyphs
    for (const record of this.getUniqueCustomFonts()) {
      if (this.fontHasAllChars(record.parsed, text)) {
        return `custom:${record.id}`;
      }
    }
    // Last resort: use default font even if incomplete, or mapped standard font
    if (this.defaultFont) return `custom:${this.defaultFont.postScriptName}`;
    return mapped;
  }

  /** Check if a PDF font name is a symbolic font (no WinAnsi encoding). */
  private isSymbolicFont(pdfFontName: string): boolean {
    return pdfFontName === "ZapfDingbats" || pdfFontName === "Symbol";
  }

  /** Check if a PDF font name refers to a custom TrueType font. */
  private isCustomFont(pdfFontName: string): boolean {
    return pdfFontName.startsWith("custom:");
  }

  private getUniqueCustomFonts(): RegisteredCustomFont[] {
    return [...this.customFontIndex.values()];
  }

  /** Get the ascent ratio (ascent / unitsPerEm) for a PDF font. */
  private getFontAscentRatio(pdfFontName: string): number {
    // Custom TrueType fonts: use actual parsed metrics
    const parsed = this.getCustomFontData(pdfFontName);
    if (parsed) {
      return parsed.ascent / parsed.unitsPerEm;
    }
    // Standard PDF font ascent values (per 1000 em units)
    const standardAscents: Record<string, number> = {
      "Helvetica":      0.718,
      "Helvetica-Bold": 0.718,
      "Times-Roman":    0.683,
      "Times-Bold":     0.683,
      "Courier":        0.629,
      "Courier-Bold":   0.629,
      "ZapfDingbats":   0.820,
      "Symbol":         0.800,
    };
    return standardAscents[pdfFontName] ?? 0.75;
  }

  /** Estimate the width of a rendered text run in PDF points. */
  private measureTextWidthPt(pdfFontName: string, text: string, fontSize: number): number | null {
    const parsed = this.getCustomFontData(pdfFontName);
    if (parsed) {
      let advanceWidth = 0;
      for (const ch of text) {
        const codePoint = ch.codePointAt(0)!;
        const glyphId = parsed.cmap.get(codePoint) ?? 0;
        advanceWidth += parsed.glyphWidths.get(glyphId) ?? parsed.unitsPerEm;
      }
      return (advanceWidth / parsed.unitsPerEm) * fontSize;
    }

    if (pdfFontName === "Courier" || pdfFontName === "Courier-Bold") {
      return [...text].length * fontSize * 0.6;
    }

    return null;
  }

  /** Fit monospaced and embedded text runs to the extracted top-edge width when metrics differ. */
  private getTextHorizontalScale(style: Style, pdfFontName: string, text: string, fontSize: number, quad: Quad): number | null {
    const measuredWidth = this.measureTextWidthPt(pdfFontName, text, fontSize);
    if (!measuredWidth || measuredWidth <= 0) return null;

    const dx = quad[1].x - quad[0].x;
    const dy = quad[1].y - quad[0].y;
    const targetWidth = pxToPt(Math.sqrt(dx * dx + dy * dy));
    if (targetWidth <= 0) return null;

    const scale = (targetWidth / measuredWidth) * 100;
    if (!Number.isFinite(scale) || Math.abs(scale - 100) < 2) return null;

    const fontFamily = style.fontFamily?.toLowerCase() ?? "";
    const isMonospaceLike = /mono|monaspace|consolas|menlo|courier/.test(fontFamily) || pdfFontName.startsWith("Courier");
    if (!isMonospaceLike && !this.isCustomFont(pdfFontName)) return null;

    return Math.max(50, Math.min(200, scale));
  }

  private getCustomFontRecord(pdfFontName: string): RegisteredCustomFont | null {
    if (!pdfFontName.startsWith("custom:")) return null;
    return this.customFontIndex.get(pdfFontName.slice(7)) ?? null;
  }

  private getCustomFontData(pdfFontName: string): ParsedTTF | null {
    const record = this.getCustomFontRecord(pdfFontName);
    if (record) return record.parsed;

    const psName = pdfFontName.startsWith("custom:") ? pdfFontName.slice(7) : "";
    // Check the default font
    if (this.defaultFont && this.defaultFont.postScriptName === psName) {
      return this.defaultFont;
    }
    return null;
  }

  private getCustomFontPdfName(pdfFontName: string): string | null {
    const record = this.getCustomFontRecord(pdfFontName);
    if (record) return record.pdfName;

    if (pdfFontName.startsWith("custom:") && this.defaultFont && this.defaultFont.postScriptName === pdfFontName.slice(7)) {
      return this.defaultFont.postScriptName;
    }

    return null;
  }

  /** Get or create a font resource name for the given PDF font. */
  private getFontResName(pdfFontName: string): string {
    let name = this.fontMap.get(pdfFontName);
    if (!name) {
      name = `F${++this.fontCounter}`;
      this.fontMap.set(pdfFontName, name);
    }
    return name;
  }

  /**
   * Encode text for a custom TrueType font.
   * For symbol fonts: returns escaped single-byte string (for use in parentheses).
   * For CID fonts: returns hex string of 4-digit glyph IDs (for use in angle brackets).
   * Also tracks used characters for width tables and ToUnicode.
   */
  private encodeCustomText(text: string, pdfFontName: string): string {
    const parsed = this.getCustomFontData(pdfFontName);
    if (!parsed) return "";
    const fontKey = pdfFontName.slice(7);

    // Track used characters
    let usedChars = this.customFontUsedChars.get(fontKey);
    if (!usedChars) {
      usedChars = new Set<number>();
      this.customFontUsedChars.set(fontKey, usedChars);
    }

    if (parsed.isSymbolFont) {
      // Symbol font: single-byte encoding, use raw byte values
      let out = "";
      for (const ch of text) {
        const charCode = ch.codePointAt(0)!;
        usedChars.add(charCode);
        const byte = charCode & 0xFF;
        if (byte === 0x28 || byte === 0x29 || byte === 0x5C) {
          // Escape ( ) and backslash
          out += "\\" + String.fromCharCode(byte);
        } else if (byte >= 0x20 && byte < 0x7F) {
          out += String.fromCharCode(byte);
        } else {
          out += "\\" + byte.toString(8).padStart(3, "0");
        }
      }
      return out;
    } else {
      // CID font: encode as hex glyph IDs (iterate by code points for surrogate pair support)
      let hex = "";
      for (const ch of text) {
        const charCode = ch.codePointAt(0)!;
        usedChars.add(charCode);
        const glyphId = parsed.cmap.get(charCode) ?? 0;
        hex += glyphId.toString(16).padStart(4, "0").toUpperCase();
      }
      return hex;
    }
  }

  // ── GState helpers ──────────────────────────────────────────────

  /** Get or create an ExtGState resource name for the given opacity values. */
  private getGStateResName(fillOpacity: number, strokeOpacity: number): string {
    const existing = this.gstates.find(g => g.ca === fillOpacity && g.CA === strokeOpacity);
    if (existing) return existing.name;
    const name = `GS${this.gstates.length + 1}`;
    this.gstates.push({ name, ca: fillOpacity, CA: strokeOpacity });
    return name;
  }

  // ── Path helpers ────────────────────────────────────────────────

  /** Emit polygon path (4 points) in PDF coordinates. */
  private emitQuadPath(points: Quad): void {
    const x0 = pn(this.ptX(points[0].x)), y0 = pn(this.ptY(points[0].y));
    const x1 = pn(this.ptX(points[1].x)), y1 = pn(this.ptY(points[1].y));
    const x2 = pn(this.ptX(points[2].x)), y2 = pn(this.ptY(points[2].y));
    const x3 = pn(this.ptX(points[3].x)), y3 = pn(this.ptY(points[3].y));
    this.ops.push(`${x0} ${y0} m`, `${x1} ${y1} l`, `${x2} ${y2} l`, `${x3} ${y3} l`, "h");
  }

  /** Emit a rounded-rectangle path in PDF coordinates. */
  private emitRoundedRectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): void {
    // (x,y) = top-left in PDF coords, h goes downward (y - h = bottom)
    const krx = rx * KAPPA;
    const kry = ry * KAPPA;
    const b = y - h; // bottom

    this.ops.push(`${pn(x + rx)} ${pn(y)} m`);
    // Top edge
    this.ops.push(`${pn(x + w - rx)} ${pn(y)} l`);
    // Top-right corner
    this.ops.push(`${pn(x + w - rx + krx)} ${pn(y)} ${pn(x + w)} ${pn(y - kry)} ${pn(x + w)} ${pn(y - ry)} c`);
    // Right edge
    this.ops.push(`${pn(x + w)} ${pn(b + ry)} l`);
    // Bottom-right corner
    this.ops.push(`${pn(x + w)} ${pn(b + ry - kry)} ${pn(x + w - rx + krx)} ${pn(b)} ${pn(x + w - rx)} ${pn(b)} c`);
    // Bottom edge
    this.ops.push(`${pn(x + rx)} ${pn(b)} l`);
    // Bottom-left corner
    this.ops.push(`${pn(x + rx - krx)} ${pn(b)} ${pn(x)} ${pn(b + ry - kry)} ${pn(x)} ${pn(b + ry)} c`);
    // Left edge
    this.ops.push(`${pn(x)} ${pn(y - ry)} l`);
    // Top-left corner
    this.ops.push(`${pn(x)} ${pn(y - ry + kry)} ${pn(x + rx - krx)} ${pn(y)} ${pn(x + rx)} ${pn(y)} c`);
    this.ops.push("h");
  }

  /** Emit a polygon/polyline path in PDF coordinates. */
  private emitPolygonPath(points: Point[], closed: boolean): void {
    if (points.length === 0) return;

    this.ops.push(`${pn(this.ptX(points[0].x))} ${pn(this.ptY(points[0].y))} m`);
    for (let i = 1; i < points.length; i++) {
      this.ops.push(`${pn(this.ptX(points[i].x))} ${pn(this.ptY(points[i].y))} l`);
    }
    if (closed) this.ops.push("h");
  }

  /** Emit a compound path made of multiple subpaths in PDF coordinates. */
  private emitCompoundPath(subpaths: NonNullable<Style["pathSubpaths"]>): void {
    for (const subpath of subpaths) {
      if (subpath.points.length === 0) continue;

      this.ops.push(`${pn(this.ptX(subpath.points[0].x))} ${pn(this.ptY(subpath.points[0].y))} m`);
      for (let index = 1; index < subpath.points.length; index += 1) {
        this.ops.push(`${pn(this.ptX(subpath.points[index].x))} ${pn(this.ptY(subpath.points[index].y))} l`);
      }
      if (subpath.closed) this.ops.push("h");
    }
  }

  private emitRoundedQuadPath(points: Quad, radius: number, cornerShapes?: Style["cornerShapes"]): void {
    const segs = roundedQuadPath(points, radius, cornerShapes);
    for (const segment of segs) {
      switch (segment.type) {
        case "M":
          this.ops.push(`${pn(this.ptX(segment.x))} ${pn(this.ptY(segment.y))} m`);
          break;
        case "L":
          this.ops.push(`${pn(this.ptX(segment.x))} ${pn(this.ptY(segment.y))} l`);
          break;
        case "Q": {
          const idx = segs.indexOf(segment);
          const prev = idx > 0 ? segs[idx - 1] : segs[0];
          const px = this.ptX(prev.x);
          const py = this.ptY(prev.y);
          const cx = this.ptX(segment.cx);
          const cy = this.ptY(segment.cy);
          const ex = this.ptX(segment.x);
          const ey = this.ptY(segment.y);
          const c1x = px + (2 / 3) * (cx - px);
          const c1y = py + (2 / 3) * (cy - py);
          const c2x = ex + (2 / 3) * (cx - ex);
          const c2y = ey + (2 / 3) * (cy - ey);
          this.ops.push(`${pn(c1x)} ${pn(c1y)} ${pn(c2x)} ${pn(c2y)} ${pn(ex)} ${pn(ey)} c`);
          break;
        }
      }
    }
    this.ops.push("h");
  }

  /** Emit an axis-aligned rectangle path in PDF coordinates. */
  private emitRectPath(x: number, y: number, w: number, h: number): void {
    const bottom = y - h;
    this.ops.push(
      `${pn(x)} ${pn(y)} m`,
      `${pn(x + w)} ${pn(y)} l`,
      `${pn(x + w)} ${pn(bottom)} l`,
      `${pn(x)} ${pn(bottom)} l`,
      "h",
    );
  }

  /** Emit an ellipse path in PDF coordinates using cubic Beziers. */
  private emitEllipsePath(cx: number, cy: number, rx: number, ry: number): void {
    const centerX = this.ptX(cx);
    const centerY = this.ptY(cy);
    const radiusX = pxToPt(rx);
    const radiusY = pxToPt(ry);
    const ox = radiusX * KAPPA;
    const oy = radiusY * KAPPA;

    this.ops.push(`${pn(centerX + radiusX)} ${pn(centerY)} m`);
    this.ops.push(`${pn(centerX + radiusX)} ${pn(centerY - oy)} ${pn(centerX + ox)} ${pn(centerY - radiusY)} ${pn(centerX)} ${pn(centerY - radiusY)} c`);
    this.ops.push(`${pn(centerX - ox)} ${pn(centerY - radiusY)} ${pn(centerX - radiusX)} ${pn(centerY - oy)} ${pn(centerX - radiusX)} ${pn(centerY)} c`);
    this.ops.push(`${pn(centerX - radiusX)} ${pn(centerY + oy)} ${pn(centerX - ox)} ${pn(centerY + radiusY)} ${pn(centerX)} ${pn(centerY + radiusY)} c`);
    this.ops.push(`${pn(centerX + ox)} ${pn(centerY + radiusY)} ${pn(centerX + radiusX)} ${pn(centerY + oy)} ${pn(centerX + radiusX)} ${pn(centerY)} c`);
    this.ops.push("h");
  }

  /** Apply rectangular clip bounds and CSS clip-path shapes before painting. */
  private emitClip(style: Style, bounds: ClipPathBounds): void {
    if (style.clipQuads?.length) {
      for (const clipQuad of style.clipQuads) {
        this.emitPolygonPath(clipQuad.points, true);
        this.ops.push("W n");
      }
    }

    const clip = style.clipBounds;
    if (clip) {
      const x = this.ptX(clip.x);
      const y = this.ptY(clip.y);
      const w = pxToPt(clip.w);
      const h = pxToPt(clip.h);
      const radius = Math.min(clip.radius, clip.w / 2, clip.h / 2);
      if (radius > 0) {
        const r = pxToPt(radius);
        this.emitRoundedRectPath(x, y, w, h, r, r);
      } else {
        this.emitRectPath(x, y, w, h);
      }
      this.ops.push("W n");
    }

    const clipShape = parseClipPathShape(style.clipPath, bounds);
    if (!clipShape) return;

    switch (clipShape.kind) {
      case "inset": {
        const x = this.ptX(clipShape.x);
        const y = this.ptY(clipShape.y);
        const w = pxToPt(clipShape.w);
        const h = pxToPt(clipShape.h);
        if (clipShape.rx > 0 || clipShape.ry > 0) {
          this.emitRoundedRectPath(x, y, w, h, pxToPt(clipShape.rx), pxToPt(clipShape.ry));
        } else {
          this.emitRectPath(x, y, w, h);
        }
        break;
      }
      case "ellipse":
        this.emitEllipsePath(clipShape.cx, clipShape.cy, clipShape.rx, clipShape.ry);
        break;
      case "polygon":
        this.emitPolygonPath(clipShape.points, true);
        break;
      case "path":
        this.emitCompoundPath(clipShape.subpaths);
        break;
    }

    this.ops.push(clipShape.fillRule === "evenodd" ? "W* n" : "W n");
  }

  private emitImageBorderRadiusClip(quad: Quad, style: Style): void {
    const topEdge = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    const leftEdge = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    const radius = parseBorderRadius(style.borderRadius, topEdge, leftEdge);
    if (!radius) return;

    if (isAxisAlignedRect(quad) && !style.cornerShapes) {
      const bounds = getQuadBounds(quad);
      const x = this.ptX(bounds.x);
      const y = this.ptY(bounds.y);
      const w = pxToPt(bounds.w);
      const h = pxToPt(bounds.h);
      const rx = pxToPt(Math.min(radius.rx, bounds.w / 2));
      const ry = pxToPt(Math.min(radius.ry, bounds.h / 2));
      this.emitRoundedRectPath(x, y, w, h, rx, ry);
    } else {
      this.emitRoundedQuadPath(quad, Math.min(radius.rx, radius.ry), style.cornerShapes);
    }

    this.ops.push("W n");
  }

  // ── Style helpers ───────────────────────────────────────────────

  /** Set fill color (RGB 0–1). */
  private setFill(c: ParsedColor): void {
    this.ops.push(`${pn(c.r / 255)} ${pn(c.g / 255)} ${pn(c.b / 255)} rg`);
  }

  /** Set stroke color (RGB 0–1). */
  private setStroke(c: ParsedColor): void {
    this.ops.push(`${pn(c.r / 255)} ${pn(c.g / 255)} ${pn(c.b / 255)} RG`);
  }

  /** Set line width in pt. */
  private setLineWidth(pt: number): void {
    this.ops.push(`${pn(pt)} w`);
  }

  private setDashStyle(style: string, widthPx: number): void {
    if (style === "dashed") {
      const dash = pxToPt(widthPx * 3);
      this.ops.push(`[${pn(dash)} ${pn(dash)}] 0 d`);
      return;
    }
    if (style === "dotted") {
      const dot = pxToPt(widthPx);
      this.ops.push(`[${pn(dot)} ${pn(dot)}] 0 d`);
      this.ops.push("1 J");
      return;
    }
    this.ops.push("[] 0 d");
  }

  private emitOutlinePath(points: Quad, style: Style, outline: RenderedOutline): void {
    const elW = Math.abs(points[1].x - points[0].x);
    const elH = Math.abs(points[3].y - points[0].y);
    const padding = outline.offset + outline.width / 2;
    const radius = parseBorderRadius(style.borderRadius, elW, elH);

    if (isAxisAlignedRect(points) && !style.cornerShapes) {
      const minX = Math.min(points[0].x, points[1].x, points[2].x, points[3].x) - padding;
      const minY = Math.min(points[0].y, points[1].y, points[2].y, points[3].y) - padding;
      const width = elW + padding * 2;
      const height = elH + padding * 2;
      const left = this.ptX(minX);
      const top = this.ptY(minY);
      if (radius) {
        const rx = Math.min(Math.max(radius.rx + padding, 0), width / 2);
        const ry = Math.min(Math.max(radius.ry + padding, 0), height / 2);
        this.emitRoundedRectPath(left, top, pxToPt(width), pxToPt(height), pxToPt(rx), pxToPt(ry));
      } else {
        this.emitRectPath(left, top, pxToPt(width), pxToPt(height));
      }
      return;
    }

    if (radius) {
      const rounded = roundedQuadPath(points, Math.min(radius.rx, radius.ry), style.cornerShapes);
      for (const segment of rounded) {
        switch (segment.type) {
          case "M":
            this.ops.push(`${pn(this.ptX(segment.x))} ${pn(this.ptY(segment.y))} m`);
            break;
          case "L":
            this.ops.push(`${pn(this.ptX(segment.x))} ${pn(this.ptY(segment.y))} l`);
            break;
          case "Q": {
            const segments = rounded;
            const index = segments.indexOf(segment);
            const prev = index > 0 ? segments[index - 1] : segments[0];
            const px = this.ptX(prev.x);
            const py = this.ptY(prev.y);
            const cx = this.ptX(segment.cx);
            const cy = this.ptY(segment.cy);
            const ex = this.ptX(segment.x);
            const ey = this.ptY(segment.y);
            const c1x = px + (2 / 3) * (cx - px);
            const c1y = py + (2 / 3) * (cy - py);
            const c2x = ex + (2 / 3) * (cx - ex);
            const c2y = ey + (2 / 3) * (cy - ey);
            this.ops.push(`${pn(c1x)} ${pn(c1y)} ${pn(c2x)} ${pn(c2y)} ${pn(ex)} ${pn(ey)} c`);
            break;
          }
        }
      }
      this.ops.push("h");
      return;
    }

    this.emitQuadPath(points);
  }

  private drawOutline(points: Quad, style: Style, outline: RenderedOutline): void {
    this.ops.push("q");
    const strokeOpacity = (style.opacity ?? 1) * outline.color.a;
    if (strokeOpacity < 1) {
      const gsName = this.getGStateResName(1, strokeOpacity);
      this.ops.push(`/${gsName} gs`);
    }
    this.setStroke(outline.color);
    this.setLineWidth(pxToPt(outline.width));
    this.setDashStyle(outline.style, outline.width);
    this.emitOutlinePath(points, style, outline);
    this.ops.push("S");
    this.ops.push("Q");
  }

  /**
   * Apply fill/stroke style operators and return the paint operator.
   * Returns null if the shape is fully transparent.
   */
  private applyStyleOps(style: Style): "S" | "f" | "f*" | "B" | "B*" | null {
    const fillColor = parseVisibleColor(style.fill);
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;

    const hasFill = fillColor !== null;
    const hasStroke = strokeColor !== null && strokeWidth > 0;

    if (!hasFill && !hasStroke) return null;

    const opacity = style.opacity ?? 1;
    const fillOpacity = hasFill ? opacity * (fillColor?.a ?? 1) : 1;
    const strokeOpacity = hasStroke ? opacity * (strokeColor?.a ?? 1) : 1;
    if (fillOpacity < 1 || strokeOpacity < 1) {
      const gsName = this.getGStateResName(
        fillOpacity,
        strokeOpacity,
      );
      this.ops.push(`/${gsName} gs`);
    }

    if (fillColor) this.setFill(fillColor);
    if (hasStroke) {
      this.setStroke(strokeColor!);
      this.setLineWidth(pxToPt(strokeWidth));
    } else {
      this.setStroke({ r: 0, g: 0, b: 0, a: 1 });
      this.setLineWidth(pxToPt(0.5));
    }

    const evenOdd = style.fillRule === "evenodd";
    if (hasFill && hasStroke) return evenOdd ? "B*" : "B";
    if (hasFill) return evenOdd ? "f*" : "f";
    return "S";
  }

  // ── Drawing methods ─────────────────────────────────────────────

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    const hasBoxShadows = !!style.boxShadow && style.boxShadow !== "none";

    // Draw outer box shadows before the element itself.
    if (hasBoxShadows) {
      this.drawBoxShadows(points, style, "outer");
    }

    const outline = getVisibleOutline(style);

    const gradients = parseGradients(style.backgroundImage);
    if (gradients.length > 0) {
      this.drawGradientPolygon(points, gradients, style);
      if (hasBoxShadows) this.drawBoxShadows(points, style, "inset");
      if (outline) this.drawOutline(points, style, outline);
      return;
    }

    // Check if we need per-side border drawing (mixed colors/widths/styles)
    const mixed = this.hasMixedBorders(style);

    const clipBounds = getQuadBounds(points);

    this.ops.push("q");
    this.emitClip(style, clipBounds);

    if (mixed) {
      // Draw fill only first (no stroke from applyStyleOps)
      const fillColor = parseVisibleColor(style.fill);
      if (fillColor) {
        const fillOpacity = (style.opacity ?? 1) * fillColor.a;
        if (fillOpacity < 1) {
          const gsName = this.getGStateResName(fillOpacity, 1);
          this.ops.push(`/${gsName} gs`);
        }
        this.setFill(fillColor);
        this.emitQuadPath(points);
        this.ops.push("f");
      }
      // Draw each border side independently
      this.drawPerSideBorders(points, style);
      if (hasBoxShadows) this.drawBoxShadows(points, style, "inset");
      if (outline) this.drawOutline(points, style, outline);
      this.ops.push("Q");
      return;
    }

    const paintOp = this.applyStyleOps(style);
    if (!paintOp && !outline && !hasBoxShadows) { this.ops.push("Q"); return; }

    if (paintOp) {
      const elW = Math.abs(points[1].x - points[0].x);
      const elH = Math.abs(points[3].y - points[0].y);
      const radius = parseBorderRadius(style.borderRadius, elW, elH);
      if (radius && isAxisAlignedRect(points) && !style.cornerShapes) {
        const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
        const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
        const w = pxToPt(elW);
        const h = pxToPt(elH);
        const rx = pxToPt(Math.min(radius.rx, elW / 2));
        const ry = pxToPt(Math.min(radius.ry, elH / 2));
        this.emitRoundedRectPath(left, top, w, h, rx, ry);
      } else if (radius && (!isAxisAlignedRect(points) || style.cornerShapes)) {
        // Non-axis-aligned quad (or axis-aligned with corner-shape) with border-radius
        const r = Math.min(radius.rx, radius.ry);
        const segs = roundedQuadPath(points, r, style.cornerShapes);
        for (const s of segs) {
          switch (s.type) {
            case "M":
              this.ops.push(`${pn(this.ptX(s.x))} ${pn(this.ptY(s.y))} m`);
              break;
            case "L":
              this.ops.push(`${pn(this.ptX(s.x))} ${pn(this.ptY(s.y))} l`);
              break;
            case "Q": {
              const segsArr = segs;
              const idx = segsArr.indexOf(s);
              const prev = idx > 0 ? segsArr[idx - 1] : segs[0];
              const px = this.ptX(prev.x);
              const py = this.ptY(prev.y);
              const cx = this.ptX(s.cx);
              const cy = this.ptY(s.cy);
              const ex = this.ptX(s.x);
              const ey = this.ptY(s.y);
              const c1x = px + (2 / 3) * (cx - px);
              const c1y = py + (2 / 3) * (cy - py);
              const c2x = ex + (2 / 3) * (cx - ex);
              const c2y = ey + (2 / 3) * (cy - ey);
              this.ops.push(`${pn(c1x)} ${pn(c1y)} ${pn(c2x)} ${pn(c2y)} ${pn(ex)} ${pn(ey)} c`);
              break;
            }
          }
        }
        this.ops.push("h");
      } else {
        this.emitQuadPath(points);
      }

      this.ops.push(paintOp);
    }

    if (hasBoxShadows) this.drawBoxShadows(points, style, "inset");
    if (outline) this.drawOutline(points, style, outline);
    this.ops.push("Q");
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

  /** Draw each border side independently in PDF. */
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

    const opacity = style.opacity ?? 1;

    for (const side of sides) {
      const color = parseVisibleColor(side.color);
      const w = side.width ? parseFloat(side.width) : 0;
      if (!color || w <= 0 || !side.borderStyle || side.borderStyle === "none" || side.borderStyle === "hidden") continue;

      this.ops.push("q");
      const strokeOpacity = opacity * color.a;
      if (strokeOpacity < 1) {
        const gsName = this.getGStateResName(1, strokeOpacity);
        this.ops.push(`/${gsName} gs`);
      }
      this.setStroke(color);
      this.setLineWidth(pxToPt(w));

      // Dash pattern
      if (side.borderStyle === "dashed") {
        const d = pxToPt(w * 3);
        this.ops.push(`[${pn(d)} ${pn(d)}] 0 d`);
      } else if (side.borderStyle === "dotted") {
        const d = pxToPt(w);
        this.ops.push(`[${pn(d)} ${pn(d)}] 0 d`);
        this.ops.push("1 J"); // round line cap
      } else {
        this.ops.push("[] 0 d"); // solid
      }

      if (side.borderStyle === "double" && w >= 3) {
        const lineW = Math.max(1, w / 3);
        this.setLineWidth(pxToPt(lineW));
        const dx = side.to.x - side.from.x;
        const dy = side.to.y - side.from.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const nx = -dy / len;
          const ny = dx / len;
          const off = w / 3;
          // Outer line
          this.ops.push(`${pn(this.ptX(side.from.x - nx * off))} ${pn(this.ptY(side.from.y - ny * off))} m`);
          this.ops.push(`${pn(this.ptX(side.to.x - nx * off))} ${pn(this.ptY(side.to.y - ny * off))} l`);
          this.ops.push("S");
          // Inner line
          this.ops.push(`${pn(this.ptX(side.from.x + nx * off))} ${pn(this.ptY(side.from.y + ny * off))} m`);
          this.ops.push(`${pn(this.ptX(side.to.x + nx * off))} ${pn(this.ptY(side.to.y + ny * off))} l`);
          this.ops.push("S");
        }
      } else {
        this.ops.push(`${pn(this.ptX(side.from.x))} ${pn(this.ptY(side.from.y))} m`);
        this.ops.push(`${pn(this.ptX(side.to.x))} ${pn(this.ptY(side.to.y))} l`);
        this.ops.push("S");
      }

      this.ops.push("Q");
    }
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    if (points.length < 2) return;

    const clipBounds = getPointBounds(points);

    this.ops.push("q");
    this.emitClip(style, clipBounds);
    const paintOp = this.applyStyleOps(style);
    if (!paintOp) { this.ops.push("Q"); return; }

    if (style.pathSubpaths?.length) {
      this.emitCompoundPath(style.pathSubpaths);
    } else {
      this.emitPolygonPath(points, closed);
    }

    this.ops.push(paintOp);
    this.ops.push("Q");
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    if (style.textTransform) {
      switch (style.textTransform) {
        case "uppercase": text = text.toUpperCase(); break;
        case "lowercase": text = text.toLowerCase(); break;
        case "capitalize": text = text.replace(/(^|\s)\S/g, c => c.toUpperCase()); break;
      }
    }

    // Derive font size: use quad height as the authoritative rendered size,
    // since style.fontSize may reflect an unscaled coordinate system (e.g. SVG in <img>).
    const quadHeight = Math.sqrt(
      (quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2
    );
    const styleFontSize = parseFontSize(style.fontSize);
    const quadFontSize = quadHeight > 0 ? pxToPt(quadHeight) : styleFontSize;
    const fontSize = Math.min(styleFontSize, quadFontSize);
    const fontWeight = style.fontWeight;
    const fontStyle = style.fontStyle;
    const fontFamily = style.fontFamily?.replace(/['"]/g, "") || "Helvetica";
    const pdfFontName = this.resolveFont(fontFamily, fontWeight, fontStyle, text);
    const fontRes = this.getFontResName(pdfFontName);

    const textColor = parseVisibleColor(style.color) ?? parseVisibleColor(style.fill);
    const r = textColor ? textColor.r / 255 : 0;
    const g = textColor ? textColor.g / 255 : 0;
    const b = textColor ? textColor.b / 255 : 0;

    // Compute rotation from quad top edge
    const dxScreen = quad[1].x - quad[0].x;
    const dyScreen = quad[1].y - quad[0].y;
    const anglePdf = Math.atan2(-dyScreen, dxScreen); // negative because Y is flipped

    // Baseline position: offset from the extracted text quad.
    // The quad already matches Firefox's live text client rect, so scale the ascent
    // against the extracted quad height rather than reapplying source line-height math.
    const quadHeightPt = pxToPt(quadHeight);
    const ascentRatio = this.getFontAscentRatio(pdfFontName);
    const baselineOffset = ascentRatio * quadHeightPt;

    const sinA = Math.sin(anglePdf);
    const cosA = Math.cos(anglePdf);
    const bx = this.ptX(quad[0].x) + sinA * baselineOffset;
    const by = this.ptY(quad[0].y) - cosA * baselineOffset;
    const clipBounds = getQuadBounds(quad);

    this.ops.push("q");
    this.emitClip(style, clipBounds);

    const opacity = (style.opacity ?? 1) * (textColor?.a ?? 1);
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.ops.push("BT");
    this.ops.push(`${pn(r)} ${pn(g)} ${pn(b)} rg`);
    this.ops.push(`/${fontRes} ${pn(fontSize)} Tf`);
    const horizontalScale = this.getTextHorizontalScale(style, pdfFontName, text, fontSize, quad);
    if (horizontalScale !== null) {
      this.ops.push(`${pn(horizontalScale)} Tz`);
    }

    if (Math.abs(anglePdf) > 0.01) {
      // Use text matrix for rotation
      this.ops.push(`${pn(cosA)} ${pn(sinA)} ${pn(-sinA)} ${pn(cosA)} ${pn(bx)} ${pn(by)} Tm`);
    } else {
      this.ops.push(`${pn(bx)} ${pn(by)} Td`);
    }

    const escaped = this.isCustomFont(pdfFontName)
      ? this.encodeCustomText(text, pdfFontName)
      : this.isSymbolicFont(pdfFontName) ? escapePdfSymbolic(text) : escapePdfText(text);

    const customData = this.getCustomFontData(pdfFontName);
    if (this.isCustomFont(pdfFontName) && customData && !customData.isSymbolFont) {
      // CID font: use hex string <...>
      this.ops.push(`<${escaped}> Tj`);
    } else {
      this.ops.push(`(${escaped}) Tj`);
    }
    this.ops.push("ET");
    this.ops.push("Q");

    // Text decorations: underline, line-through, overline
    const dec = style.textDecoration;
    if (dec && dec !== "none" && (dec.includes("underline") || dec.includes("line-through") || dec.includes("overline"))) {
      // Compute the text line extent in PDF coordinates
      const topEdgePx = Math.sqrt(dxScreen * dxScreen + dyScreen * dyScreen);
      const lineWidthPt = Math.max(0.5, fontSize / 14);

      this.ops.push("q");
      this.emitClip(style, clipBounds);
      this.ops.push(`${pn(r)} ${pn(g)} ${pn(b)} RG`);
      this.ops.push(`${pn(lineWidthPt)} w`);

      if (dec.includes("underline")) {
        // Underline: slightly below baseline
        const underlineOffset = baselineOffset + fontSize * 0.15;
        const ux = this.ptX(quad[0].x) + sinA * underlineOffset;
        const uy = this.ptY(quad[0].y) - cosA * underlineOffset;
        const ex = ux + cosA * pxToPt(topEdgePx);
        const ey = uy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(ux)} ${pn(uy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      if (dec.includes("line-through")) {
        // Line-through: ~40% above baseline (middle of x-height)
        const strikeOffset = baselineOffset - fontSize * 0.3;
        const sx = this.ptX(quad[0].x) + sinA * strikeOffset;
        const sy = this.ptY(quad[0].y) - cosA * strikeOffset;
        const ex = sx + cosA * pxToPt(topEdgePx);
        const ey = sy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(sx)} ${pn(sy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      if (dec.includes("overline")) {
        // Overline: near top of text
        const overlineOffset = baselineOffset - fontSize * 0.85;
        const ox = this.ptX(quad[0].x) + sinA * overlineOffset;
        const oy = this.ptY(quad[0].y) - cosA * overlineOffset;
        const ex = ox + cosA * pxToPt(topEdgePx);
        const ey = oy + sinA * pxToPt(topEdgePx);
        this.ops.push(`${pn(ox)} ${pn(oy)} m ${pn(ex)} ${pn(ey)} l S`);
      }
      this.ops.push("Q");
    }
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    const imgName = `Im${++this.imageCounter}`;

    const decoded = decodeDataUrl(dataUrl);

    if (decoded?.mimeType === "image/png") {
      const png = decodePng(decoded.data);
      if (png) {
        const channels = splitRasterChannels(png);
        const filteredChannels = applySupportedImageColorFilters(channels.rgb, style.filter, channels.alphaMask);
        this.images.push({
          name: imgName,
          data: filteredChannels.rgb,
          width: png.width,
          height: png.height,
          filter: null,
          softMask: filteredChannels.alphaMask,
        });
      } else if (rgbData) {
        const filteredRgb = applySupportedImageColorFilters(new Uint8Array(rgbData), style.filter).rgb;
        this.images.push({
          name: imgName,
          data: filteredRgb,
          width,
          height,
          filter: null,
        });
      } else {
        return;
      }
    } else if (decoded?.mimeType === "image/gif") {
      const gif = decodeGif(decoded.data);
      if (gif) {
        const channels = splitRasterChannels(gif);
        const filteredChannels = applySupportedImageColorFilters(channels.rgb, style.filter, channels.alphaMask);
        this.images.push({
          name: imgName,
          data: filteredChannels.rgb,
          width: gif.width,
          height: gif.height,
          filter: null,
          softMask: filteredChannels.alphaMask,
        });
      } else if (rgbData) {
        const filteredRgb = applySupportedImageColorFilters(new Uint8Array(rgbData), style.filter).rgb;
        this.images.push({
          name: imgName,
          data: filteredRgb,
          width,
          height,
          filter: null,
        });
      } else {
        return;
      }
    } else if (rgbData) {
      // Use raw RGB pixel data (lossless, no compression artifacts)
      const filteredRgb = applySupportedImageColorFilters(new Uint8Array(rgbData), style.filter).rgb;
      this.images.push({
        name: imgName,
        data: filteredRgb,
        width,
        height,
        filter: null,
      });
    } else {
      // Decode the data URL to raw bytes
      if (!decoded) return;
      if (decoded.mimeType === "image/jpeg") {
        // JPEG — embed directly with DCTDecode
        this.images.push({
          name: imgName,
          data: decoded.data,
          width,
          height,
          filter: "DCTDecode",
        });
      } else {
        // Non-JPEG (PNG, etc.) — cannot embed raw file bytes in PDF without matching filter.
        // Skip this image; the extraction pipeline should provide rgbData for most cases.
        return;
      }
    }

    // Compute affine transform from unit square to PDF quad coordinates.
    // Image XObject renders in unit square (0,0)-(1,0)-(1,1)-(0,1).
    // Map: (0,0)→bottomLeft, (1,0)→bottomRight, (0,1)→topLeft
    // quad: [topLeft, topRight, bottomRight, bottomLeft]
    const tl = { x: this.ptX(quad[0].x), y: this.ptY(quad[0].y) };
    const tr = { x: this.ptX(quad[1].x), y: this.ptY(quad[1].y) };
    const br = { x: this.ptX(quad[2].x), y: this.ptY(quad[2].y) };
    const bl = { x: this.ptX(quad[3].x), y: this.ptY(quad[3].y) };
    const a = br.x - bl.x, b = br.y - bl.y; // (1,0) - (0,0)
    const c = tl.x - bl.x, d = tl.y - bl.y; // (0,1) - (0,0)
    const e = bl.x, f = bl.y;                // (0,0) origin

    const clipBounds = getQuadBounds(quad);

    this.ops.push("q");
    this.emitClip(style, clipBounds);
    this.emitImageBorderRadiusClip(quad, style);

    const opacity = style.opacity ?? 1;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.ops.push(`${pn(a)} ${pn(b)} ${pn(c)} ${pn(d)} ${pn(e)} ${pn(f)} cm`);
    this.ops.push(`/${imgName} Do`);
    this.ops.push("Q");
  }

  async end(): Promise<PdfDocument> {
    const doc = new PdfDocument();

    // ── Create font objects ────────────────────────────────────────
    const fontDict = new PdfDictionary();
    for (const [pdfFontName, resName] of this.fontMap) {
      if (this.isCustomFont(pdfFontName)) {
        // TrueType font embedding
        const parsed = this.getCustomFontData(pdfFontName);
        if (!parsed) continue;
        const pdfBaseName = this.getCustomFontPdfName(pdfFontName);
        const usedChars = this.customFontUsedChars.get(pdfFontName.slice(7)) ?? new Set<number>();
        if (parsed.isSymbolFont) {
          // Simple TrueType embedding for symbol fonts (better compatibility)
          const fontRef = this.createSimpleTrueTypeFont(doc, parsed, usedChars, pdfBaseName ?? parsed.postScriptName);
          fontDict.set(resName, fontRef);
        } else {
          // CID font embedding for Unicode fonts
          const fontRef = this.createCIDFont(doc, parsed, usedChars, pdfBaseName ?? parsed.postScriptName);
          fontDict.set(resName, fontRef);
        }
      } else {
        // Standard Type1 font
        const font = PdfFont.fromStandardFont(pdfFontName as any);
        font.resourceName = resName;
        doc.add(font);
        fontDict.set(resName, font.reference);
      }
    }

    // ── Create ExtGState objects ───────────────────────────────────
    const gsDict = new PdfDictionary();
    for (const gs of this.gstates) {
      const d = new PdfDictionary();
      d.set("Type", new PdfName("ExtGState"));
      d.set("ca", new PdfNumber(gs.ca));
      d.set("CA", new PdfNumber(gs.CA));
      const obj = new PdfIndirectObject({ content: d });
      doc.add(obj);
      gsDict.set(gs.name, obj.reference);
    }

    // ── Create Shading objects ─────────────────────────────────────
    const shadingDict = new PdfDictionary();
    for (const sh of this.shadings) {
      const d = new PdfDictionary();
      d.set("ShadingType", new PdfNumber(sh.type));
      d.set("ColorSpace", new PdfName("DeviceRGB"));
      d.set("Coords", new PdfArray(sh.coords.map(c => new PdfNumber(c))));
      d.set("Function", this.buildColorFunction(sh.stops));
      d.set("Extend", new PdfArray([new PdfBoolean(true), new PdfBoolean(true)]));
      const obj = new PdfIndirectObject({ content: d });
      doc.add(obj);
      shadingDict.set(sh.name, obj.reference);
    }

    // ── Resources dictionary ───────────────────────────────────────
    const resourcesDict = new PdfDictionary();
    if (this.fontMap.size > 0) resourcesDict.set("Font", fontDict);
    if (this.gstates.length > 0) resourcesDict.set("ExtGState", gsDict);
    if (this.shadings.length > 0) resourcesDict.set("Shading", shadingDict);

    // ── Create Image XObject entries ──────────────────────────────
    if (this.images.length > 0) {
      const xobjectDict = new PdfDictionary();
      for (const img of this.images) {
        const imgDict = new PdfDictionary();
        imgDict.set("Type", new PdfName("XObject"));
        imgDict.set("Subtype", new PdfName("Image"));
        imgDict.set("Width", new PdfNumber(img.width));
        imgDict.set("Height", new PdfNumber(img.height));
        imgDict.set("ColorSpace", new PdfName("DeviceRGB"));
        imgDict.set("BitsPerComponent", new PdfNumber(8));
        if (img.filter) imgDict.set("Filter", new PdfName(img.filter));

        if (img.softMask) {
          const maskDict = new PdfDictionary();
          maskDict.set("Type", new PdfName("XObject"));
          maskDict.set("Subtype", new PdfName("Image"));
          maskDict.set("Width", new PdfNumber(img.width));
          maskDict.set("Height", new PdfNumber(img.height));
          maskDict.set("ColorSpace", new PdfName("DeviceGray"));
          maskDict.set("BitsPerComponent", new PdfNumber(8));

          const maskObj = new PdfIndirectObject({
            content: new PdfStream({ header: maskDict, binary: img.softMask }),
          });
          doc.add(maskObj);
          imgDict.set("SMask", maskObj.reference);
        }

        const imgObj = new PdfIndirectObject({
          content: new PdfStream({ header: imgDict, binary: img.data }),
        });
        doc.add(imgObj);
        xobjectDict.set(img.name, imgObj.reference);
      }
      resourcesDict.set("XObject", xobjectDict);
    }

    const resources = new PdfIndirectObject({ content: resourcesDict });
    doc.add(resources);

    // ── Content stream ─────────────────────────────────────────────
    const contentStream = new PdfIndirectObject({
      content: new PdfStream({
        header: new PdfDictionary(),
        original: this.ops.join("\n"),
      }),
    });
    doc.add(contentStream);

    // ── Page ───────────────────────────────────────────────────────
    const page = new PdfPage();
    page.mediaBox = [0, 0, this.pageWidthPt, this.pageHeightPt];
    page.contents = contentStream.reference;
    page.resources = resources.reference;
    doc.add(page);

    // ── Pages ──────────────────────────────────────────────────────
    const pages = new PdfPages();
    pages.kids = new PdfArray([page.reference]);
    pages.count = 1;
    page.parent = pages;
    doc.add(pages);

    // ── Catalog ────────────────────────────────────────────────────
    const catalogDict = new PdfDictionary();
    catalogDict.set("Type", new PdfName("Catalog"));
    catalogDict.set("Pages", pages.reference);
    const catalog = new PdfIndirectObject({ content: catalogDict });
    doc.add(catalog);

    doc.trailerDict.set("Root", catalog.reference);
    return doc;
  }

  // ── Simple TrueType Font creation (for Symbol fonts) ─────────

  /**
   * Create a simple TrueType font with embedded data for symbol fonts.
   * This is more compatible with PDF viewers than CIDFontType2 for single-byte fonts.
   */
  private createSimpleTrueTypeFont(
    doc: PdfDocument,
    parsed: ParsedTTF,
    usedChars: Set<number>,
    pdfName: string,
  ): PdfReference {
    const psName = pdfName;
    const scale = 1000 / parsed.unitsPerEm;

    // 1. Embedded font stream (FontFile2)
    const fontStreamHeader = new PdfDictionary();
    fontStreamHeader.set("Length1", new PdfNumber(parsed.rawData.length));
    const fontStreamObj = new PdfIndirectObject({
      content: new PdfStream({ header: fontStreamHeader, binary: parsed.rawData }),
    });
    doc.add(fontStreamObj);

    // 2. FontDescriptor
    const fdDict = new PdfDictionary();
    fdDict.set("Type", new PdfName("FontDescriptor"));
    fdDict.set("FontName", new PdfName(psName));
    fdDict.set("Flags", new PdfNumber(parsed.flags));
    fdDict.set("FontBBox", new PdfArray(parsed.bbox.map(n => new PdfNumber(Math.round(n * scale)))));
    fdDict.set("ItalicAngle", new PdfNumber(parsed.italicAngle));
    fdDict.set("Ascent", new PdfNumber(Math.round(parsed.ascent * scale)));
    fdDict.set("Descent", new PdfNumber(Math.round(parsed.descent * scale)));
    fdDict.set("CapHeight", new PdfNumber(Math.round(parsed.ascent * scale * 0.8)));
    fdDict.set("StemV", new PdfNumber(80));
    fdDict.set("FontFile2", fontStreamObj.reference);
    const fdObj = new PdfIndirectObject({ content: fdDict });
    doc.add(fdObj);

    // 3. Build Widths array for FirstChar..LastChar
    // For symbol fonts, character bytes map to glyphs through the font's cmap.
    // Determine FirstChar and LastChar from used characters.
    let firstChar = 255, lastChar = 0;
    for (const charCode of usedChars) {
      const byte = charCode & 0xFF;
      if (byte < firstChar) firstChar = byte;
      if (byte > lastChar) lastChar = byte;
    }
    if (firstChar > lastChar) { firstChar = 32; lastChar = 255; }

    const widths: number[] = [];
    for (let i = firstChar; i <= lastChar; i++) {
      const glyphId = parsed.cmap.get(i) ?? 0;
      const rawWidth = parsed.glyphWidths.get(glyphId) ?? 0;
      widths.push(Math.round(rawWidth * scale));
    }

    // 4. Simple TrueType font dictionary
    const fontDict = new PdfDictionary();
    fontDict.set("Type", new PdfName("Font"));
    fontDict.set("Subtype", new PdfName("TrueType"));
    fontDict.set("BaseFont", new PdfName(psName));
    fontDict.set("FirstChar", new PdfNumber(firstChar));
    fontDict.set("LastChar", new PdfNumber(lastChar));
    fontDict.set("Widths", new PdfArray(widths.map(w => new PdfNumber(w))));
    fontDict.set("FontDescriptor", fdObj.reference);
    // No Encoding for symbolic fonts — uses font's built-in cmap

    const fontObj = new PdfIndirectObject({ content: fontDict });
    doc.add(fontObj);

    return fontObj.reference;
  }

  // ── CID Font creation ──────────────────────────────────────────

  /**
   * Create a Type0 composite font with embedded TrueType data for PDF.
   * Returns the PdfReference for the Type0 font dictionary.
   */
  private createCIDFont(
    doc: PdfDocument,
    parsed: ParsedTTF,
    usedChars: Set<number>,
    pdfName: string,
  ): PdfReference {
    const psName = pdfName;
    const scale = 1000 / parsed.unitsPerEm;

    // 1. Embedded font stream (FontFile2) — full TTF data
    const fontStreamHeader = new PdfDictionary();
    fontStreamHeader.set("Length1", new PdfNumber(parsed.rawData.length));
    const fontStreamObj = new PdfIndirectObject({
      content: new PdfStream({ header: fontStreamHeader, binary: parsed.rawData }),
    });
    doc.add(fontStreamObj);

    // 2. FontDescriptor
    const fdDict = new PdfDictionary();
    fdDict.set("Type", new PdfName("FontDescriptor"));
    fdDict.set("FontName", new PdfName(psName));
    fdDict.set("Flags", new PdfNumber(parsed.flags));
    fdDict.set("FontBBox", new PdfArray(parsed.bbox.map(n => new PdfNumber(Math.round(n * scale)))));
    fdDict.set("ItalicAngle", new PdfNumber(parsed.italicAngle));
    fdDict.set("Ascent", new PdfNumber(Math.round(parsed.ascent * scale)));
    fdDict.set("Descent", new PdfNumber(Math.round(parsed.descent * scale)));
    fdDict.set("CapHeight", new PdfNumber(Math.round(parsed.ascent * scale * 0.8)));
    fdDict.set("StemV", new PdfNumber(80));
    fdDict.set("FontFile2", fontStreamObj.reference);
    const fdObj = new PdfIndirectObject({ content: fdDict });
    doc.add(fdObj);

    // 3. Build width array /W for used glyphs
    //    Format: [gid [width] gid [width] ...]
    const wItems: { serialize(): string }[] = [];
    const usedGlyphs = new Map<number, number>(); // glyphId → width in 1/1000 units
    for (const charCode of usedChars) {
      const gid = parsed.cmap.get(charCode) ?? 0;
      if (gid === 0) continue;
      const rawWidth = parsed.glyphWidths.get(gid) ?? 0;
      usedGlyphs.set(gid, Math.round(rawWidth * scale));
    }
    // Sort glyph IDs for deterministic output
    const sortedGids = Array.from(usedGlyphs.keys()).sort((a, b) => a - b);
    for (const gid of sortedGids) {
      wItems.push(new PdfNumber(gid));
      wItems.push(new PdfArray([new PdfNumber(usedGlyphs.get(gid)!)]));
    }

    // 4. CIDFont (CIDFontType2)
    const cidDict = new PdfDictionary();
    cidDict.set("Type", new PdfName("Font"));
    cidDict.set("Subtype", new PdfName("CIDFontType2"));
    cidDict.set("BaseFont", new PdfName(psName));
    const cidSysInfo = new PdfDictionary();
    cidSysInfo.set("Registry", { serialize: () => "(Adobe)" } as any);
    cidSysInfo.set("Ordering", { serialize: () => "(Identity)" } as any);
    cidSysInfo.set("Supplement", new PdfNumber(0));
    cidDict.set("CIDSystemInfo", cidSysInfo);
    cidDict.set("FontDescriptor", fdObj.reference);
    cidDict.set("DW", new PdfNumber(1000));
    if (wItems.length > 0) cidDict.set("W", new PdfArray(wItems));
    cidDict.set("CIDToGIDMap", new PdfName("Identity"));
    const cidObj = new PdfIndirectObject({ content: cidDict });
    doc.add(cidObj);

    // 5. ToUnicode CMap (enables copy-paste of text from PDF)
    const toUnicodeCMap = this.buildToUnicodeCMap(parsed, usedChars);
    const toUnicodeHeader = new PdfDictionary();
    const toUnicodeObj = new PdfIndirectObject({
      content: new PdfStream({ header: toUnicodeHeader, original: toUnicodeCMap }),
    });
    doc.add(toUnicodeObj);

    // 6. Type0 composite font (top-level)
    const type0Dict = new PdfDictionary();
    type0Dict.set("Type", new PdfName("Font"));
    type0Dict.set("Subtype", new PdfName("Type0"));
    type0Dict.set("BaseFont", new PdfName(psName));
    type0Dict.set("Encoding", new PdfName("Identity-H"));
    type0Dict.set("DescendantFonts", new PdfArray([cidObj.reference]));
    type0Dict.set("ToUnicode", toUnicodeObj.reference);
    const type0Obj = new PdfIndirectObject({ content: type0Dict });
    doc.add(type0Obj);

    return type0Obj.reference;
  }

  /**
   * Build a ToUnicode CMap stream for a CID font.
   * Maps glyph IDs back to Unicode code points for text extraction/copy.
   */
  private buildToUnicodeCMap(parsed: ParsedTTF, usedChars: Set<number>): string {
    // Build glyph ID → Unicode mapping for used characters
    const gidToUnicode = new Map<number, number>();
    for (const charCode of usedChars) {
      const gid = parsed.cmap.get(charCode) ?? 0;
      if (gid !== 0) gidToUnicode.set(gid, charCode);
    }

    const sortedGids = Array.from(gidToUnicode.keys()).sort((a, b) => a - b);

    // Split into chunks of 100 (PDF limit per beginbfchar block)
    const lines: string[] = [];
    lines.push("/CIDInit /ProcSet findresource begin");
    lines.push("12 dict begin");
    lines.push("begincmap");
    lines.push("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def");
    lines.push("/CMapName /Adobe-Identity-UCS def");
    lines.push("/CMapType 2 def");
    lines.push("1 begincodespacerange");
    lines.push("<0000> <FFFF>");
    lines.push("endcodespacerange");

    for (let i = 0; i < sortedGids.length; i += 100) {
      const chunk = sortedGids.slice(i, i + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const gid of chunk) {
        const uni = gidToUnicode.get(gid)!;
        lines.push(`<${gid.toString(16).padStart(4, "0").toUpperCase()}> <${uni.toString(16).padStart(4, "0").toUpperCase()}>`);
      }
      lines.push("endbfchar");
    }

    lines.push("endcmap");
    lines.push("CMapName currentdict /CMap defineresource pop");
    lines.push("end");
    lines.push("end");
    return lines.join("\n");
  }

  // ── Gradient drawing ────────────────────────────────────────────

  private emitPolygonPaintPath(points: Quad, style: Style): void {
    const elW = Math.abs(points[1].x - points[0].x);
    const elH = Math.abs(points[3].y - points[0].y);
    const radius = parseBorderRadius(style.borderRadius, elW, elH);
    if (radius && isAxisAlignedRect(points) && !style.cornerShapes) {
      const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
      const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
      const w = pxToPt(elW);
      const h = pxToPt(elH);
      const rx = pxToPt(Math.min(radius.rx, elW / 2));
      const ry = pxToPt(Math.min(radius.ry, elH / 2));
      this.emitRoundedRectPath(left, top, w, h, rx, ry);
    } else if (radius && (!isAxisAlignedRect(points) || style.cornerShapes)) {
      const r = Math.min(radius.rx, radius.ry);
      const segs = roundedQuadPath(points, r, style.cornerShapes);
      for (const s of segs) {
        switch (s.type) {
          case "M":
            this.ops.push(`${pn(this.ptX(s.x))} ${pn(this.ptY(s.y))} m`);
            break;
          case "L":
            this.ops.push(`${pn(this.ptX(s.x))} ${pn(this.ptY(s.y))} l`);
            break;
          case "Q": {
            const segsArr = segs;
            const idx = segsArr.indexOf(s);
            const prev = idx > 0 ? segsArr[idx - 1] : segs[0];
            const px = this.ptX(prev.x);
            const py = this.ptY(prev.y);
            const cx = this.ptX(s.cx);
            const cy = this.ptY(s.cy);
            const ex = this.ptX(s.x);
            const ey = this.ptY(s.y);
            const c1x = px + (2 / 3) * (cx - px);
            const c1y = py + (2 / 3) * (cy - py);
            const c2x = ex + (2 / 3) * (cx - ex);
            const c2y = ey + (2 / 3) * (cy - ey);
            this.ops.push(`${pn(c1x)} ${pn(c1y)} ${pn(c2x)} ${pn(c2y)} ${pn(ex)} ${pn(ey)} c`);
            break;
          }
        }
      }
      this.ops.push("h");
    } else {
      this.emitQuadPath(points);
    }
  }

  private drawSolidBackgroundPolygon(points: Quad, style: Style, fillColor: ParsedColor): void {
    this.ops.push("q");

    const opacity = (style.opacity ?? 1) * fillColor.a;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.emitClip(style, getQuadBounds(points));
    this.setFill(fillColor);
    this.emitPolygonPaintPath(points, style);
    this.ops.push("f");
    this.ops.push("Q");
  }

  private drawGradientStroke(points: Quad, style: Style): void {
    const strokeColor = parseVisibleColor(style.stroke);
    const strokeWidth = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
    if (!strokeColor || strokeWidth <= 0) return;

    this.ops.push("q");
    const strokeOpacity = (style.opacity ?? 1) * strokeColor.a;
    if (strokeOpacity < 1) {
      const gsName = this.getGStateResName(1, strokeOpacity);
      this.ops.push(`/${gsName} gs`);
    }
    this.emitClip(style, getQuadBounds(points));
    this.setStroke(strokeColor);
    this.setLineWidth(pxToPt(strokeWidth));
    this.emitPolygonPaintPath(points, style);
    this.ops.push("S");
    this.ops.push("Q");
  }

  private drawGradientPolygon(points: Quad, gradients: ParsedGradient[], style: Style): void {
    const fillColor = parseVisibleColor(style.backgroundColor);
    if (fillColor) {
      this.drawSolidBackgroundPolygon(points, style, fillColor);
    }

    for (let index = gradients.length - 1; index >= 0; index--) {
      this.drawSingleGradientLayer(points, gradients[index], style);
    }

    this.drawGradientStroke(points, style);
  }

  private drawSingleGradientLayer(points: Quad, gradient: ParsedGradient, style: Style): void {

    // Conic gradients need a completely different approach (sector fills)
    if (gradient.type === "conic") {
      this.drawConicGradient(points, gradient, style);
      return;
    }

    // Compute bounding box in PDF coords
    const xs = points.map(p => this.ptX(p.x));
    const ys = points.map(p => this.ptY(p.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Register shading
    const shName = `SH${++this.shadingCounter}`;
    const resolvedStops = gradient.repeating
      ? expandRepeatingGradientStops(gradient.stops, (sortedStops) => ({
        offset: 1,
        color: interpolateConicColor(1, [...sortedStops], true),
      }))
      : gradient.stops;
    const gradientOpacity = this.getUniformGradientOpacity(resolvedStops);
    const stops = resolvedStops.map(s => ({
      offset: s.offset,
      r: s.color.r,
      g: s.color.g,
      b: s.color.b,
    }));

    let coords: number[];
    let shadingType: 2 | 3;

    if (gradient.type === "linear") {
      const A = gradient.angleDeg * Math.PI / 180;
      const halfDiag = Math.sqrt(w * w + h * h) / 2;
      const dx = Math.sin(A) * halfDiag;
      const dy = Math.cos(A) * halfDiag;
      coords = [cx - dx, cy - dy, cx + dx, cy + dy];
      shadingType = 2;
    } else {
      const r = Math.max(w, h) / 2;
      coords = [cx, cy, 0, cx, cy, r];
      shadingType = 3;
    }

    this.shadings.push({ name: shName, type: shadingType, coords, stops });

    // Save state, set opacity, clip, shade, restore
    this.ops.push("q");

    const opacity = (style.opacity ?? 1) * gradientOpacity;
    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.emitClip(style, getQuadBounds(points));

    // Clip path
    this.emitPolygonPaintPath(points, style);
    this.ops.push("W n");   // clip + discard path

    // Paint shading
    this.ops.push(`/${shName} sh`);
    this.ops.push("Q");
  }

  private getUniformGradientOpacity(stops: GradientStop[]): number {
    if (stops.length === 0) return 1;
    const firstAlpha = stops[0].color.a;
    for (let index = 1; index < stops.length; index += 1) {
      if (Math.abs(stops[index].color.a - firstAlpha) > 0.001) {
        return 1;
      }
    }
    return firstAlpha;
  }

  /** Build a PDF color function dictionary for gradient stops. */
  private buildColorFunction(stops: { offset: number; r: number; g: number; b: number }[]): PdfDictionary {
    if (stops.length === 2) {
      return this.buildType2Function(stops[0], stops[1]);
    }

    // Multi-stop: Type 3 stitching function
    const subFuncs: PdfDictionary[] = [];
    const bounds: number[] = [];
    const encode: number[] = [];

    for (let i = 0; i < stops.length - 1; i++) {
      subFuncs.push(this.buildType2Function(stops[i], stops[i + 1]));
      if (i > 0) bounds.push(stops[i].offset);
      encode.push(0, 1);
    }

    const func = new PdfDictionary();
    func.set("FunctionType", new PdfNumber(3));
    func.set("Domain", new PdfArray([new PdfNumber(0), new PdfNumber(1)]));
    func.set("Functions", new PdfArray(subFuncs));
    func.set("Bounds", new PdfArray(bounds.map(b => new PdfNumber(b))));
    func.set("Encode", new PdfArray(encode.map(e => new PdfNumber(e))));
    return func;
  }

  /** Build a Type 2 (exponential interpolation) function for two colors. */
  private buildType2Function(
    c0: { r: number; g: number; b: number },
    c1: { r: number; g: number; b: number },
  ): PdfDictionary {
    const func = new PdfDictionary();
    func.set("FunctionType", new PdfNumber(2));
    func.set("Domain", new PdfArray([new PdfNumber(0), new PdfNumber(1)]));
    func.set("C0", new PdfArray([new PdfNumber(c0.r / 255), new PdfNumber(c0.g / 255), new PdfNumber(c0.b / 255)]));
    func.set("C1", new PdfArray([new PdfNumber(c1.r / 255), new PdfNumber(c1.g / 255), new PdfNumber(c1.b / 255)]));
    func.set("N", new PdfNumber(1));
    return func;
  }

  // ── Box-shadow rendering ──────────────────────────────────────────

  /**
   * Parse and draw CSS box-shadow(s) behind a polygon.
   * Each shadow is drawn as a filled shape offset from the element.
   * Inset shadows are drawn as clipped even-odd frames for axis-aligned boxes.
   * Blur is approximated with multiple expanding semi-transparent layers.
   */
  private drawBoxShadows(points: Quad, style: Style, mode: "all" | "outer" | "inset" = "all"): void {
    const shadows = parseBoxShadow(style.boxShadow!);
    const clipBounds = getQuadBounds(points);
    const axisAlignedBounds = isAxisAlignedRect(points) && !style.cornerShapes ? getQuadBounds(points) : null;
    const axisAlignedRadius = axisAlignedBounds ? parseBorderRadius(style.borderRadius, axisAlignedBounds.w, axisAlignedBounds.h) : null;
    for (const shadow of shadows) {
      if (mode === "outer" && shadow.inset) continue;
      if (mode === "inset" && !shadow.inset) continue;

      const { offsetX, offsetY, blur, spread, color } = shadow;
      if (!color || color.a <= 0) continue;
      const elementOpacity = style.opacity ?? 1;

      if (shadow.inset) {
        if (!axisAlignedBounds) continue;

        const clipLeft = this.ptX(axisAlignedBounds.x);
        const clipTop = this.ptY(axisAlignedBounds.y);
        const clipW = pxToPt(axisAlignedBounds.w);
        const clipH = pxToPt(axisAlignedBounds.h);
        const clipRx = axisAlignedRadius ? pxToPt(Math.min(axisAlignedRadius.rx, axisAlignedBounds.w / 2)) : 0;
        const clipRy = axisAlignedRadius ? pxToPt(Math.min(axisAlignedRadius.ry, axisAlignedBounds.h / 2)) : 0;
        const layers = blur > 0 ? 3 : 1;
        const pad = Math.max(blur, 50) + Math.abs(spread) + Math.max(Math.abs(offsetX), Math.abs(offsetY)) + 100;

        for (let i = layers; i >= 1; i--) {
          const expand = blur > 0 ? (blur * i) / layers : 0;
          const layerA = blur > 0
            ? (color.a / layers) * (1 - (i - 1) / layers) * elementOpacity
            : color.a * elementOpacity;
          if (layerA <= 0) continue;

          const innerX = axisAlignedBounds.x + spread + offsetX + expand;
          const innerY = axisAlignedBounds.y + spread + offsetY + expand;
          const innerW = axisAlignedBounds.w - spread * 2 - expand * 2;
          const innerH = axisAlignedBounds.h - spread * 2 - expand * 2;

          this.ops.push("q");
          this.emitClip(style, clipBounds);
          if (axisAlignedRadius) {
            this.emitRoundedRectPath(clipLeft, clipTop, clipW, clipH, clipRx, clipRy);
          } else {
            this.emitRectPath(clipLeft, clipTop, clipW, clipH);
          }
          this.ops.push("W n");

          if (layerA < 1) {
            const gsName = this.getGStateResName(layerA, layerA);
            this.ops.push(`/${gsName} gs`);
          }

          this.setFill(color);
          this.emitRectPath(
            this.ptX(axisAlignedBounds.x - pad),
            this.ptY(axisAlignedBounds.y - pad),
            pxToPt(axisAlignedBounds.w + pad * 2),
            pxToPt(axisAlignedBounds.h + pad * 2),
          );

          if (innerW > 0 && innerH > 0) {
            const innerLeft = this.ptX(innerX);
            const innerTop = this.ptY(innerY);
            const innerWidthPt = pxToPt(innerW);
            const innerHeightPt = pxToPt(innerH);
            if (axisAlignedRadius) {
              this.emitRoundedRectPath(
                innerLeft,
                innerTop,
                innerWidthPt,
                innerHeightPt,
                pxToPt(Math.min(axisAlignedRadius.rx, innerW / 2)),
                pxToPt(Math.min(axisAlignedRadius.ry, innerH / 2)),
              );
            } else {
              this.emitRectPath(innerLeft, innerTop, innerWidthPt, innerHeightPt);
            }
          }

          this.ops.push("f*");
          this.ops.push("Q");
        }
        continue;
      }

      // Expand the quad by spread and offset
      const sx = spread; // spread in all directions
      const expanded: Quad = [
        { x: points[0].x - sx + offsetX, y: points[0].y - sx + offsetY },
        { x: points[1].x + sx + offsetX, y: points[1].y - sx + offsetY },
        { x: points[2].x + sx + offsetX, y: points[2].y + sx + offsetY },
        { x: points[3].x - sx + offsetX, y: points[3].y + sx + offsetY },
      ];
      if (blur <= 0) {
        // Sharp shadow: single filled quad
        this.ops.push("q");
        this.emitClip(style, clipBounds);
        const a = color.a * elementOpacity;
        if (a < 1) {
          const gsName = this.getGStateResName(a, a);
          this.ops.push(`/${gsName} gs`);
        }
        this.setFill(color);

        const shadowElW = Math.abs(expanded[1].x - expanded[0].x);
        const shadowElH = Math.abs(expanded[3].y - expanded[0].y);
        const radius = parseBorderRadius(style.borderRadius, shadowElW, shadowElH);
        if (radius && isAxisAlignedRect(expanded)) {
          const left = this.ptX(Math.min(expanded[0].x, expanded[1].x));
          const top = this.ptY(Math.min(expanded[0].y, expanded[3].y));
          const w = pxToPt(shadowElW);
          const h = pxToPt(shadowElH);
          const rx = pxToPt(Math.min(radius.rx, shadowElW / 2));
          const ry = pxToPt(Math.min(radius.ry, shadowElH / 2));
          this.emitRoundedRectPath(left, top, w, h, rx, ry);
        } else {
          this.emitQuadPath(expanded);
        }
        this.ops.push("f");
        this.ops.push("Q");
      } else {
        // Blurred shadow: draw 3 graduated layers to approximate Gaussian blur
        const layers = 3;
        for (let i = layers; i >= 1; i--) {
          const expand = (blur * i) / layers;
          const layerQuad: Quad = [
            { x: expanded[0].x - expand, y: expanded[0].y - expand },
            { x: expanded[1].x + expand, y: expanded[1].y - expand },
            { x: expanded[2].x + expand, y: expanded[2].y + expand },
            { x: expanded[3].x - expand, y: expanded[3].y + expand },
          ];
          // Opacity decreases as we go further out
          const layerA = (color.a / layers) * (1 - (i - 1) / layers) * elementOpacity;
          if (layerA <= 0) continue;

          this.ops.push("q");
          this.emitClip(style, clipBounds);
          const gsName = this.getGStateResName(layerA, layerA);
          this.ops.push(`/${gsName} gs`);
          this.setFill(color);

          const shadowElW = Math.abs(layerQuad[1].x - layerQuad[0].x);
          const shadowElH = Math.abs(layerQuad[3].y - layerQuad[0].y);
          const radius = parseBorderRadius(style.borderRadius, shadowElW, shadowElH);
          if (radius && isAxisAlignedRect(layerQuad)) {
            const left = this.ptX(Math.min(layerQuad[0].x, layerQuad[1].x));
            const top = this.ptY(Math.min(layerQuad[0].y, layerQuad[1].y));
            const w = pxToPt(shadowElW);
            const h = pxToPt(shadowElH);
            const rx = pxToPt(Math.min(radius.rx + expand, w / 2));
            const ry = pxToPt(Math.min(radius.ry + expand, h / 2));
            this.emitRoundedRectPath(left, top, w, h, rx, ry);
          } else {
            this.emitQuadPath(layerQuad);
          }

          this.ops.push("f");
          this.ops.push("Q");
        }
      }
    }
  }

  // ── Conic gradient rendering ──────────────────────────────────────

  /**
   * Emulate a conic gradient by drawing many narrow pie-slice sectors.
   * PDF doesn't support conic gradients natively, so we subdivide
   * 360° into small sectors, each filled with the interpolated color.
   */
  private drawConicGradient(points: Quad, gradient: ConicGradient, style: Style): void {
    const xs = points.map(p => this.ptX(p.x));
    const ys = points.map(p => this.ptY(p.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const r = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2) / 2;

    const opacity = style.opacity ?? 1;
    const stops = gradient.repeating
      ? expandRepeatingGradientStops(gradient.stops, (sortedStops) => ({
        offset: 1,
        color: interpolateConicColor(1, [...sortedStops], true),
      }))
      : gradient.stops;
    const fromRad = gradient.fromAngleDeg * Math.PI / 180;

    // Number of sectors (more = smoother)
    const SECTORS = 72;
    const sectorAngle = (2 * Math.PI) / SECTORS;

    this.ops.push("q");

    if (opacity < 1) {
      const gsName = this.getGStateResName(opacity, opacity);
      this.ops.push(`/${gsName} gs`);
    }

    this.emitClip(style, getQuadBounds(points));

    // Set clip path to the polygon shape
    const conicElW = Math.abs(points[1].x - points[0].x);
    const conicElH = Math.abs(points[3].y - points[0].y);
    const radius = parseBorderRadius(style.borderRadius, conicElW, conicElH);
    if (radius && isAxisAlignedRect(points)) {
      const left = this.ptX(Math.min(points[0].x, points[1].x, points[2].x, points[3].x));
      const top = this.ptY(Math.min(points[0].y, points[1].y, points[2].y, points[3].y));
      const rw = pxToPt(conicElW);
      const rh = pxToPt(conicElH);
      const rx = pxToPt(Math.min(radius.rx, conicElW / 2));
      const ry = pxToPt(Math.min(radius.ry, conicElH / 2));
      this.emitRoundedRectPath(left, top, rw, rh, rx, ry);
    } else {
      this.emitQuadPath(points);
    }
    this.ops.push("W n"); // clip

    for (let i = 0; i < SECTORS; i++) {
      // CSS conic gradient: 0 = top (12 o'clock), clockwise
      // PDF coordinates: angles measure from 3 o'clock, counter-clockwise
      const t = (i + 0.5) / SECTORS; // normalized position [0..1]
      const color = interpolateConicColor(t, stops, gradient.repeating);

      // Sector angles in PDF space:
      // CSS 0° = top = PDF 90°, CSS goes clockwise = PDF counter-clockwise
      const cssAngle1 = fromRad + i * sectorAngle;
      const cssAngle2 = fromRad + (i + 1) * sectorAngle;
      // Convert: PDF_angle = 90° - CSS_angle (since CSS is clockwise, PDF is counter-clockwise)
      const pdfA1 = Math.PI / 2 - cssAngle1;
      const pdfA2 = Math.PI / 2 - cssAngle2;

      // Draw pie sector: center → arc edge → center
      const x1 = cx + r * Math.cos(pdfA1);
      const y1 = cy + r * Math.sin(pdfA1);
      const x2 = cx + r * Math.cos(pdfA2);
      const y2 = cy + r * Math.sin(pdfA2);

      this.ops.push(`${pn(color.r / 255)} ${pn(color.g / 255)} ${pn(color.b / 255)} rg`);
      this.ops.push(`${pn(cx)} ${pn(cy)} m`);
      this.ops.push(`${pn(x1)} ${pn(y1)} l`);
      this.ops.push(`${pn(x2)} ${pn(y2)} l`);
      this.ops.push("h f");
    }

    this.ops.push("Q");
  }
}
