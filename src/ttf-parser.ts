/**
 * Minimal TrueType font parser for PDF embedding.
 * Extracts cmap (character→glyph ID), glyph widths, and the raw font program
 * needed for embedding as a CIDFont in PDF.
 */

/** Parsed TrueType font data for PDF embedding. */
export interface ParsedTTF {
  /** Font family name from the name table. */
  familyName: string;
  /** PostScript name from the name table. */
  postScriptName: string;
  /** Units per em from the head table. */
  unitsPerEm: number;
  /** Font bounding box [xMin, yMin, xMax, yMax] in font units. */
  bbox: [number, number, number, number];
  /** Ascent in font units (from OS/2 or hhea table). */
  ascent: number;
  /** Descent in font units (negative, from OS/2 or hhea table). */
  descent: number;
  /** Italic angle from post table. */
  italicAngle: number;
  /** Flags for the font descriptor. */
  flags: number;
  /** True if the font uses Symbol encoding (single-byte, e.g. Wingdings). */
  isSymbolFont: boolean;
  /** Character code → glyph ID mapping (from cmap). */
  cmap: Map<number, number>;
  /** Glyph ID → advance width mapping (from hmtx). */
  glyphWidths: Map<number, number>;
  /** The full raw TTF file data for embedding. */
  rawData: Uint8Array;
}

/** Read a big-endian uint16 from a DataView. */
function u16(dv: DataView, offset: number): number {
  return dv.getUint16(offset, false);
}

/** Read a big-endian int16 from a DataView. */
function i16(dv: DataView, offset: number): number {
  return dv.getInt16(offset, false);
}

/** Read a big-endian uint32 from a DataView. */
function u32(dv: DataView, offset: number): number {
  return dv.getUint32(offset, false);
}

/** Read a big-endian 16.16 fixed-point number. */
function fixed32(dv: DataView, offset: number): number {
  return dv.getInt32(offset, false) / 65536;
}

interface TableEntry {
  tag: string;
  offset: number;
  length: number;
}

function readTableDirectory(dv: DataView): Map<string, TableEntry> {
  const numTables = u16(dv, 4);
  const tables = new Map<string, TableEntry>();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(
      dv.getUint8(off), dv.getUint8(off + 1),
      dv.getUint8(off + 2), dv.getUint8(off + 3)
    );
    tables.set(tag, {
      tag,
      offset: u32(dv, off + 8),
      length: u32(dv, off + 12),
    });
  }
  return tables;
}

/** Parse the 'head' table for unitsPerEm and bounding box. */
function parseHead(dv: DataView, table: TableEntry) {
  const off = table.offset;
  return {
    unitsPerEm: u16(dv, off + 18),
    xMin: i16(dv, off + 36),
    yMin: i16(dv, off + 38),
    xMax: i16(dv, off + 40),
    yMax: i16(dv, off + 42),
    indexToLocFormat: i16(dv, off + 50),
  };
}

/** Parse the 'hhea' table for ascent/descent and numHMetrics. */
function parseHhea(dv: DataView, table: TableEntry) {
  const off = table.offset;
  return {
    ascent: i16(dv, off + 4),
    descent: i16(dv, off + 6),
    numHMetrics: u16(dv, off + 34),
  };
}

/** Parse the 'OS/2' table for ascent/descent if available. */
function parseOS2(dv: DataView, table: TableEntry) {
  const off = table.offset;
  return {
    sTypoAscender: i16(dv, off + 68),
    sTypoDescender: i16(dv, off + 70),
  };
}

/** Parse the 'post' table for italic angle. */
function parsePost(dv: DataView, table: TableEntry) {
  const off = table.offset;
  return {
    italicAngle: fixed32(dv, off + 4),
  };
}

/** Parse 'hmtx' table for glyph advance widths. */
function parseHmtx(dv: DataView, table: TableEntry, numHMetrics: number, numGlyphs: number): Map<number, number> {
  const off = table.offset;
  const widths = new Map<number, number>();
  let lastWidth = 0;

  for (let i = 0; i < numHMetrics; i++) {
    const advanceWidth = u16(dv, off + i * 4);
    widths.set(i, advanceWidth);
    lastWidth = advanceWidth;
  }

  // Remaining glyphs share the last advance width
  for (let i = numHMetrics; i < numGlyphs; i++) {
    widths.set(i, lastWidth);
  }

  return widths;
}

/** Parse the 'maxp' table for numGlyphs. */
function parseMaxp(dv: DataView, table: TableEntry) {
  return { numGlyphs: u16(dv, table.offset + 4) };
}

/** Parse the 'name' table for font names. */
function parseName(dv: DataView, table: TableEntry): { familyName: string; postScriptName: string } {
  const off = table.offset;
  const count = u16(dv, off + 2);
  const stringOffset = off + u16(dv, off + 4);

  let familyName = "Unknown";
  let postScriptName = "Unknown";

  for (let i = 0; i < count; i++) {
    const recOff = off + 6 + i * 12;
    const platformID = u16(dv, recOff);
    const nameID = u16(dv, recOff + 6);
    const length = u16(dv, recOff + 8);
    const strOff = stringOffset + u16(dv, recOff + 10);

    // nameID 1 = Family, nameID 6 = PostScript name
    if (nameID !== 1 && nameID !== 6) continue;

    let str = "";
    if (platformID === 3 || platformID === 0) {
      // Unicode (UTF-16BE)
      for (let j = 0; j < length; j += 2) {
        str += String.fromCharCode(u16(dv, strOff + j));
      }
    } else if (platformID === 1) {
      // Mac Roman
      for (let j = 0; j < length; j++) {
        str += String.fromCharCode(dv.getUint8(strOff + j));
      }
    }

    if (str) {
      if (nameID === 1) familyName = str;
      if (nameID === 6) postScriptName = str;
    }
  }

  return { familyName, postScriptName };
}

/**
 * Parse the 'cmap' table — extract character code → glyph ID mapping.
 * Supports format 0 (byte), format 4 (segment) and format 12 (32-bit).
 * Handles Microsoft Symbol encoding (platform 3and encoding 0) where chars are
 * at 0xF0xx — these are remapped to 0x00xx so callers can use plain Unicode.
 */
function parseCmap(dv: DataView, table: TableEntry): { cmap: Map<number, number>; isSymbol: boolean } {
  const off = table.offset;
  const numSubtables = u16(dv, off + 2);
  const cmap = new Map<number, number>();

  // Rank subtables by preference: Windows UCS-2 > Windows Symbol > Unicode > Mac Roman
  let bestOffset = -1;
  let bestPriority = 0;
  let isSymbolEncoding = false;

  for (let i = 0; i < numSubtables; i++) {
    const subOff = off + 4 + i * 8;
    const platformID = u16(dv, subOff);
    const encodingID = u16(dv, subOff + 2);
    const subtableOffset = off + u32(dv, subOff + 4);

    let priority = 0;
    if (platformID === 3 && encodingID === 1) priority = 4; // Windows UCS-2 (best)
    else if (platformID === 0 && encodingID <= 4) priority = 3; // Unicode BMP
    else if (platformID === 3 && encodingID === 0) priority = 2; // Windows Symbol
    else if (platformID === 1 && encodingID === 0) priority = 1; // Mac Roman

    if (priority > bestPriority) {
      bestPriority = priority;
      bestOffset = subtableOffset;
      isSymbolEncoding = (platformID === 3 && encodingID === 0);
      if (priority === 4) break; // can't do better
    }
  }

  if (bestOffset < 0) return { cmap, isSymbol: false };

  const format = u16(dv, bestOffset);

  if (format === 0) {
    // Format 0: Simple byte encoding table (256 entries)
    for (let i = 0; i < 256; i++) {
      const glyphId = dv.getUint8(bestOffset + 6 + i);
      if (glyphId !== 0) {
        cmap.set(i, glyphId);
      }
    }
  } else if (format === 4) {
    // Format 4: Segment mapping to delta values
    const segCount = u16(dv, bestOffset + 6) / 2;
    const endCodes: number[] = [];
    const startCodes: number[] = [];
    const idDeltas: number[] = [];
    const idRangeOffsets: number[] = [];

    for (let i = 0; i < segCount; i++) {
      endCodes.push(u16(dv, bestOffset + 14 + i * 2));
    }
    // +2 for reservedPad
    const startCodesOff = bestOffset + 14 + segCount * 2 + 2;
    for (let i = 0; i < segCount; i++) {
      startCodes.push(u16(dv, startCodesOff + i * 2));
    }
    const idDeltasOff = startCodesOff + segCount * 2;
    for (let i = 0; i < segCount; i++) {
      idDeltas.push(i16(dv, idDeltasOff + i * 2));
    }
    const idRangeOffsetsOff = idDeltasOff + segCount * 2;
    for (let i = 0; i < segCount; i++) {
      idRangeOffsets.push(u16(dv, idRangeOffsetsOff + i * 2));
    }

    for (let seg = 0; seg < segCount; seg++) {
      const start = startCodes[seg];
      const end = endCodes[seg];
      if (start === 0xFFFF) break;

      for (let charCode = start; charCode <= end; charCode++) {
        let glyphId: number;
        if (idRangeOffsets[seg] === 0) {
          glyphId = (charCode + idDeltas[seg]) & 0xFFFF;
        } else {
          const glyphIdAddr = idRangeOffsetsOff + seg * 2 + idRangeOffsets[seg] + (charCode - start) * 2;
          glyphId = u16(dv, glyphIdAddr);
          if (glyphId !== 0) {
            glyphId = (glyphId + idDeltas[seg]) & 0xFFFF;
          }
        }
        if (glyphId !== 0) {
          cmap.set(charCode, glyphId);
        }
      }
    }
  } else if (format === 12) {
    // Format 12: Segmented coverage (32-bit)
    const nGroups = u32(dv, bestOffset + 12);
    for (let i = 0; i < nGroups; i++) {
      const groupOff = bestOffset + 16 + i * 12;
      const startCharCode = u32(dv, groupOff);
      const endCharCode = u32(dv, groupOff + 4);
      const startGlyphId = u32(dv, groupOff + 8);
      for (let c = startCharCode; c <= endCharCode; c++) {
        cmap.set(c, startGlyphId + (c - startCharCode));
      }
    }
  }

  // For Microsoft Symbol encoding, remap 0xF0xx → 0x00xx so callers
  // can look up glyphs using plain Unicode code points.
  if (isSymbolEncoding) {
    const remapped = new Map<number, number>();
    for (const [charCode, glyphId] of cmap) {
      if (charCode >= 0xF000 && charCode <= 0xF0FF) {
        remapped.set(charCode & 0xFF, glyphId);
      } else {
        remapped.set(charCode, glyphId);
      }
    }
    // Keep both original and remapped for maximum compatibility
    for (const [charCode, glyphId] of cmap) {
      remapped.set(charCode, glyphId);
    }
    return { cmap: remapped, isSymbol: true };
  }

  return { cmap, isSymbol: false };
}

/**
 * Parse a TrueType font file.
 * Returns the data needed for PDF embedding.
 */
export function parseTTF(data: Uint8Array): ParsedTTF {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables = readTableDirectory(dv);

  const headTable = tables.get("head");
  const hheaTable = tables.get("hhea");
  const hmtxTable = tables.get("hmtx");
  const maxpTable = tables.get("maxp");
  const nameTable = tables.get("name");
  const cmapTable = tables.get("cmap");
  const postTable = tables.get("post");
  const os2Table = tables.get("OS/2");

  if (!headTable || !hheaTable || !hmtxTable || !maxpTable || !cmapTable) {
    throw new Error("Missing required TTF tables");
  }

  const head = parseHead(dv, headTable);
  const hhea = parseHhea(dv, hheaTable);
  const maxp = parseMaxp(dv, maxpTable);
  const names = nameTable ? parseName(dv, nameTable) : { familyName: "Unknown", postScriptName: "Unknown" };
  const post = postTable ? parsePost(dv, postTable) : { italicAngle: 0 };
  const { cmap, isSymbol } = parseCmap(dv, cmapTable);
  const glyphWidths = parseHmtx(dv, hmtxTable, hhea.numHMetrics, maxp.numGlyphs);

  // Use OS/2 ascent/descent if available, otherwise hhea
  let ascent = hhea.ascent;
  let descent = hhea.descent;
  if (os2Table) {
    const os2 = parseOS2(dv, os2Table);
    if (os2.sTypoAscender !== 0 || os2.sTypoDescender !== 0) {
      ascent = os2.sTypoAscender;
      descent = os2.sTypoDescender;
    }
  }
  // Ensure descent is negative (some fonts store it incorrectly as positive)
  if (descent > 0) descent = -descent;

  // Font flags: symbolic if no standard encoding
  const flags = 4; // Symbolic

  return {
    familyName: names.familyName,
    postScriptName: names.postScriptName.replace(/\s+/g, ""),
    unitsPerEm: head.unitsPerEm,
    bbox: [head.xMin, head.yMin, head.xMax, head.yMax],
    ascent,
    descent,
    italicAngle: post.italicAngle,
    flags,
    isSymbolFont: isSymbol,
    cmap,
    glyphWidths,
    rawData: data,
  };
}
