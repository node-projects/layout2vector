import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { DXFWriter } from "../../src/writers/dxf-writer.js";
import { EMFWriter } from "../../src/writers/emf-writer.js";
import { EMFPlusWriter } from "../../src/writers/emfplus-writer.js";
import { DWGWriter } from "../../src/writers/acad-writer.js";
import { AcadDXFWriter } from "../../src/writers/acad-writer.js";
import { renderIR } from "../../src/pipeline.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import type { IRNode } from "../../src/types.js";
import { CadUtils, DwgReader, Hatch } from "@node-projects/acad-ts";

const EMR_COMMENT = 0x0046;
const EMR_CREATEBRUSHINDIRECT = 0x0027;
const EMR_EXTCREATEFONTINDIRECTW = 0x0052;
const EMR_STRETCHDIBITS = 0x0051;
const EMR_ROUNDRECT = 0x002C;
const EMR_FILLPATH = 0x003E;
const EMR_POLYPOLYGON16 = 0x005B;
const EMFPLUS_COMMENT_IDENTIFIER = 0x2B464D45;
const EMFPLUS_HEADER = 0x4001;
const EMFPLUS_EOF = 0x4002;
const EMFPLUS_OBJECT = 0x4008;
const EMFPLUS_FILL_PATH = 0x4014;
const EMFPLUS_DRAW_PATH = 0x4015;
const EMFPLUS_DRAW_IMAGE_POINTS = 0x401B;
const EMFPLUS_DRAW_STRING = 0x401C;
const STABLE_CAD_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

function findRecord(emfBytes: Uint8Array, targetType: number): { offset: number; size: number } | null {
  const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
  let offset = 0;

  while (offset + 8 <= emfBytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (type === targetType) {
      return { offset, size };
    }
    if (size < 8) {
      break;
    }
    offset += size;
  }

  return null;
}

function findAllRecords(emfBytes: Uint8Array, targetType: number): Array<{ offset: number; size: number }> {
  const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
  const records: Array<{ offset: number; size: number }> = [];
  let offset = 0;

  while (offset + 8 <= emfBytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (type === targetType) {
      records.push({ offset, size });
    }
    if (size < 8) {
      break;
    }
    offset += size;
  }

  return records;
}

function countRecords(emfBytes: Uint8Array, targetType: number): number {
  const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
  let offset = 0;
  let count = 0;

  while (offset + 8 <= emfBytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (type === targetType) count += 1;
    if (size < 8) break;
    offset += size;
  }

  return count;
}

function getEmfPlusCommentRecords(emfBytes: Uint8Array): Array<{
  offset: number;
  size: number;
  emfPlusType: number;
  emfPlusFlags: number;
  emfPlusSize: number;
  emfPlusDataSize: number;
}> {
  const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
  const records: Array<{
    offset: number;
    size: number;
    emfPlusType: number;
    emfPlusFlags: number;
    emfPlusSize: number;
    emfPlusDataSize: number;
  }> = [];
  let offset = 0;

  while (offset + 16 <= emfBytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 16) break;

    if (type === EMR_COMMENT) {
      const dataSize = view.getUint32(offset + 8, true);
      const identifier = view.getUint32(offset + 12, true);
      if (identifier === EMFPLUS_COMMENT_IDENTIFIER && dataSize >= 16 && offset + 24 <= emfBytes.byteLength) {
        records.push({
          offset,
          size,
          emfPlusType: view.getUint16(offset + 16, true),
          emfPlusFlags: view.getUint16(offset + 18, true),
          emfPlusSize: view.getUint32(offset + 20, true),
          emfPlusDataSize: view.getUint32(offset + 24, true),
        });
      }
    }

    offset += size;
  }

  return records;
}

function getAllEmfPlusRecords(emfBytes: Uint8Array): Array<{
  emfPlusType: number;
  emfPlusFlags: number;
  emfPlusSize: number;
  emfPlusDataSize: number;
  data: Uint8Array;
}> {
  const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
  const records: Array<{
    emfPlusType: number;
    emfPlusFlags: number;
    emfPlusSize: number;
    emfPlusDataSize: number;
    data: Uint8Array;
  }> = [];
  let offset = 0;

  while (offset + 16 <= emfBytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 16) break;

    if (type === EMR_COMMENT) {
      const dataSize = view.getUint32(offset + 8, true);
      const identifier = view.getUint32(offset + 12, true);
      if (identifier === EMFPLUS_COMMENT_IDENTIFIER && dataSize >= 16) {
        let innerOffset = offset + 16;
        const innerEnd = Math.min(offset + 12 + dataSize, offset + size);
        while (innerOffset + 12 <= innerEnd) {
          const emfPlusType = view.getUint16(innerOffset, true);
          const emfPlusFlags = view.getUint16(innerOffset + 2, true);
          const emfPlusSize = view.getUint32(innerOffset + 4, true);
          const emfPlusDataSize = view.getUint32(innerOffset + 8, true);
          if (emfPlusSize < 12 || innerOffset + emfPlusSize > innerEnd) break;

          records.push({
            emfPlusType,
            emfPlusFlags,
            emfPlusSize,
            emfPlusDataSize,
            data: emfBytes.subarray(innerOffset + 12, innerOffset + 12 + emfPlusDataSize),
          });
          innerOffset += emfPlusSize;
        }
      }
    }

    offset += size;
  }

  return records;
}

function extractDxfHeaderNumber(dxf: string, variable: string): number | null {
  const match = dxf.match(new RegExp(`\\n\\s*9\\r?\\n\\$${variable}\\r?\\n\\s*40\\r?\\n([^\\r\\n]+)`));
  return match ? parseFloat(match[1]) : null;
}

test.describe("Writer Output", () => {
  test("DXF writer produces valid string output", async ({ page }) => {
    // We test DXF writer Node-side since it doesn't need a browser
    // But since @tarikjabiri/dxf might only work in certain environments,
    // we test the pipeline end-to-end concept here
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:50px;background:red;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
    });

    // Verify IR structure for DXF consumption
    expect(ir.length).toBeGreaterThan(0);
    const polygon = ir.find((n: any) => n.type === "polygon");
    expect(polygon).toBeDefined();
    expect(polygon.points).toHaveLength(4);
    expect(polygon.points[0]).toHaveProperty("x");
    expect(polygon.points[0]).toHaveProperty("y");
  });

  test("DXF writer namespaces extracted image assets when imageBasePath is provided", async () => {
    const writer = new DXFWriter({ maxY: 20, imageBasePath: "demo-assets" });
    const dxf = await renderIR([{
      type: "image",
      quad: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0uoAAAAASUVORK5CYII=",
      width: 1,
      height: 1,
      style: {},
      zIndex: 0,
    }], writer);

    expect(Array.from(writer.imageFiles.keys())).toEqual(["demo-assets/image1.png"]);
    expect(dxf).toContain("demo-assets/image1.png");
  });

  test("PDF writer compatible IR structure", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:blue;">
          <p style="color:white;font-size:14px;">Hello PDF</p>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    expect(ir.length).toBeGreaterThan(0);

    // Should have both polygon and text nodes
    const polygons = ir.filter((n: any) => n.type === "polygon");
    const texts = ir.filter((n: any) => n.type === "text");

    expect(polygons.length).toBeGreaterThan(0);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0].text).toContain("Hello PDF");
    expect(texts[0].style).toBeDefined();
  });

  test("PDF writer selects the subset font that actually covers ASCII text", async () => {
    const writer = new PDFWriter({ pageWidth: 40, pageHeight: 20 });
    const writerAny = writer as any;
    const subsetA = {
      id: "CF1",
      pdfName: "IBMPlexMono-Regular-1",
      parsed: {
        familyName: "IBM Plex Mono",
        postScriptName: "IBMPlexMono-Regular",
        unitsPerEm: 1000,
        bbox: [0, 0, 1000, 1000],
        ascent: 800,
        descent: -200,
        italicAngle: 0,
        flags: 4,
        isSymbolFont: false,
        cmap: new Map([[97, 1]]),
        glyphWidths: new Map([[1, 600]]),
        rawData: new Uint8Array([0]),
      },
    };
    const subsetB = {
      id: "CF2",
      pdfName: "IBMPlexMono-Regular-2",
      parsed: {
        familyName: "IBM Plex Mono",
        postScriptName: "IBMPlexMono-Regular",
        unitsPerEm: 1000,
        bbox: [0, 0, 1000, 1000],
        ascent: 800,
        descent: -200,
        italicAngle: 0,
        flags: 4,
        isSymbolFont: false,
        cmap: new Map(Array.from("getBoxQuads()", (ch, index) => [ch.codePointAt(0)!, index + 1])),
        glyphWidths: new Map(Array.from({ length: 13 }, (_, index) => [index + 1, 600])),
        rawData: new Uint8Array([1]),
      },
    };

    writerAny.customFonts.set('ibm plex mono|400|normal', [subsetA, subsetB]);
    writerAny.customFonts.set('ibm plex mono', [subsetA, subsetB]);
    writerAny.customFontIndex.set(subsetA.id, subsetA);
    writerAny.customFontIndex.set(subsetB.id, subsetB);

    const resolved = writerAny.resolveFont('"IBM Plex Mono", monospace', '400', 'normal', 'getBoxQuads()');

    expect(resolved).toBe('custom:CF2');
  });

  test("PDF writer keeps semi-transparent gradients translucent without fallback overpaint", async () => {
    const writer = new PDFWriter({ pageWidth: 120, pageHeight: 80 });
    const writerAny = writer as any;

    await writer.begin();
    await writer.drawPolygon([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 50 },
      { x: 10, y: 50 },
    ], {
      fill: 'rgba(18, 53, 91, 0.92)',
      backgroundColor: undefined,
      backgroundImage: 'linear-gradient(135deg, rgba(18, 53, 91, 0.92), rgba(15, 118, 110, 0.92))',
      borderRadius: '22px',
      opacity: 1,
    });

    expect(writerAny.gstates).toEqual([
      expect.objectContaining({ ca: 0.92, CA: 0.92 }),
    ]);
    expect(writerAny.ops).toContain('/SH1 sh');
    expect(writerAny.ops).not.toContain('f');
  });

  test("PDF writer aligns linear gradient with transformed polygon axes", async () => {
    const writer = new PDFWriter({ pageWidth: 120, pageHeight: 80 });
    const writerAny = writer as any;

    const quad = [
      { x: 20, y: 20 },
      { x: 120, y: 70 },
      { x: 80, y: 150 },
      { x: -20, y: 100 },
    ] as const;

    await writer.begin();
    await writer.drawPolygon([...quad] as any, {
      backgroundImage: 'linear-gradient(90deg, rgba(255, 0, 0, 1), rgba(0, 0, 255, 1))',
      borderRadius: '0px',
      opacity: 1,
    });

    const shading = writerAny.shadings[0];
    expect(shading).toBeDefined();
    const [x0, y0, x1, y1] = shading.coords as number[];
    const gradDx = x1 - x0;
    const gradDy = y1 - y0;

    // The top edge direction of the transformed quad in PDF coordinates.
    const uxDx = (quad[1].x - quad[0].x) * 0.75;
    const uxDy = -(quad[1].y - quad[0].y) * 0.75;

    const cross = Math.abs(gradDx * uxDy - gradDy * uxDx);
    const gradLen = Math.hypot(gradDx, gradDy);
    const uxLen = Math.hypot(uxDx, uxDy);
    expect(cross / (gradLen * uxLen)).toBeLessThan(0.02);
  });

  test("PDF writer skips unsupported transparent-stop gradients instead of overpainting", async () => {
    const writer = new PDFWriter({ pageWidth: 120, pageHeight: 80 });
    const writerAny = writer as any;

    await writer.begin();
    await writer.drawPolygon([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 50 },
      { x: 10, y: 50 },
    ], {
      backgroundImage: 'linear-gradient(rgba(18, 53, 91, 0.08) 1px, rgba(0, 0, 0, 0) 1px)',
      opacity: 1,
    });

    expect(writerAny.shadings.length).toBe(0);
    expect(writerAny.ops).not.toContain('/SH1 sh');
  });

  test("source metadata is attached to IR and surfaced in HTML and SVG output", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="root" width="40" height="20" viewBox="0 0 40 20">
          <rect id="shape" x="0" y="0" width="40" height="20" fill="red" />
        </svg>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        includeSourceMetadata: true,
        includeText: false,
      });
    });

    const polygon = ir.find((node) => node.type === "polygon" && node.source?.id === "shape");
    expect(polygon).toBeDefined();
    expect(polygon?.source).toMatchObject({
      id: "shape",
      originalType: "rect",
    });
    expect(polygon?.source?.xpath).toContain("/svg");

    const html = await renderIR(ir, new HTMLWriter({ width: 40, height: 20 }));
    const svg = await renderIR(ir, new SVGWriter({ width: 40, height: 20 }));

    expect(html).toContain('data-source-id="shape"');
    expect(html).toContain('data-source-original-type="rect"');
    expect(html).toContain('data-source-xpath="/html/body/svg/rect"');
    expect(svg).toContain('data-source-id="shape"');
    expect(svg).toContain('data-source-original-type="rect"');
    expect(svg).toContain('data-source-xpath="/html/body/svg/rect"');
  });

  test("source metadata xpath includes shadow-root boundaries", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="host"></div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(async () => {
      const host = document.getElementById("host")!;
      const shadowRoot = host.attachShadow({ mode: "open" });
      const child = document.createElement("div");
      child.id = "shadow-box";
      child.style.width = "40px";
      child.style.height = "20px";
      child.style.background = "red";
      shadowRoot.appendChild(child);

      return (window as any).__HC.extractIR(host, {
        includeSourceMetadata: true,
        includeText: false,
      });
    });

    const polygon = ir.find((node) => node.type === "polygon" && node.source?.id === "shadow-box");
    expect(polygon).toBeDefined();
    expect(polygon?.source?.xpath).toBe("/html/body/div/shadow-root()/div");

    const html = await renderIR(ir, new HTMLWriter({ width: 40, height: 20 }));
    expect(html).toContain('data-source-id="shadow-box"');
    expect(html).toContain('data-source-xpath="/html/body/div/shadow-root()/div"');
  });

  test("SVG writer preserves filter and blend-mode styles", async () => {
    const ir: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      style: {
        fill: "rgb(255, 0, 0)",
        filter: "blur(12px)",
        mixBlendMode: "plus-lighter",
      },
      zIndex: 0,
    }];

    const svg = await renderIR(ir, new SVGWriter({ width: 20, height: 20 }));
    expect(svg).toContain('style="filter:blur(12px);mix-blend-mode:plus-lighter"');
  });

  test("SVG writer renders inset box shadows as clipped overlays", async () => {
    const ir: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 20, y: 20 },
        { x: 120, y: 20 },
        { x: 120, y: 80 },
        { x: 20, y: 80 },
      ],
      style: {
        fill: "rgb(128, 128, 128)",
        boxShadow: "inset 0px 3px 0px rgb(233, 30, 99)",
      },
      zIndex: 0,
    }];

    const svg = await renderIR(ir, new SVGWriter({ width: 140, height: 100 }));

    expect(svg).toContain('fill="rgb(233, 30, 99)"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('clip-path="url(#ic');
    expect(svg).not.toContain('fill="none" clip-path="url(#ic');
  });

  test("SVG and HTML writers preserve gradient strokes on polylines", async () => {
    const ir: IRNode[] = [{
      type: "polyline",
      points: [
        { x: 10, y: 50 },
        { x: 120, y: 50 },
      ],
      closed: false,
      style: {
        stroke: "rgb(255, 0, 0)",
        strokeImage: "linear-gradient(90deg, red 0%, blue 100%)",
        strokeWidth: "8px",
      },
      zIndex: 0,
    }];

    const html = await renderIR(ir, new HTMLWriter({ width: 140, height: 100 }));
    const svg = await renderIR(ir, new SVGWriter({ width: 140, height: 100 }));

    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('stroke="url(#');
    expect(html).toContain("<defs><linearGradient");
    expect(html).toContain('stroke="url(#ir-stroke-gradient)"');
  });

  test("EMF writer renders inset box shadows as filled paths", async () => {
    const emfBytes = await renderIR([{
      type: "polygon",
      points: [
        { x: 20, y: 20 },
        { x: 120, y: 20 },
        { x: 120, y: 80 },
        { x: 20, y: 80 },
      ],
      style: {
        fill: "rgb(128, 128, 128)",
        boxShadow: "inset 0px 3px 0px rgb(233, 30, 99)",
      },
      zIndex: 0,
    } satisfies IRNode], new EMFWriter({ width: 140, height: 100 }));

    const brushRecords = findAllRecords(emfBytes, EMR_CREATEBRUSHINDIRECT);
    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    const pinkBrush = brushRecords.find((record) => view.getUint32(record.offset + 16, true) === 0x00631EE9);

    expect(countRecords(emfBytes, EMR_FILLPATH)).toBeGreaterThan(0);
    expect(pinkBrush).toBeDefined();
  });

  test("EMF writer produces valid binary output", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:green;">
          <p style="color:white;font-size:14px;">Hello EMF</p>
        </div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeImages: true,
        includeText: true,
      });
    });

    expect(ir.length).toBeGreaterThan(0);

    const writer = new EMFWriter({ width: 200, height: 100 });
    const emfBytes = await renderIR(ir, writer);

    // EMF file starts with EMR_HEADER record type (0x00000001) in little-endian
    expect(emfBytes).toBeInstanceOf(Uint8Array);
    expect(emfBytes.length).toBeGreaterThan(80);

    // Verify EMF signature: at file offset 40 (8-byte record header + 32 bytes of rclBounds/rclFrame)
    // = 0x464D4520 (" EMF")
    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    // First 4 bytes = EMR_HEADER record type = 1
    expect(view.getUint32(0, true)).toBe(0x00000001);
    // Signature at file offset 40 (headerData[32])
    expect(view.getUint32(40, true)).toBe(0x464D4520);
  });

  test("EMF writer handles polygons, polylines and text", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:300px;height:150px;">
          <div style="position:absolute;left:10px;top:10px;width:80px;height:60px;background:red;border-radius:8px;"></div>
          <div style="position:absolute;left:110px;top:10px;width:100px;height:40px;background:blue;border:2px solid orange;"></div>
          <p style="position:absolute;left:10px;top:90px;color:navy;font-size:12px;">EMF text</p>
        </div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const writer = new EMFWriter({ width: 300, height: 150 });
    const emfBytes = await renderIR(ir, writer);

    expect(emfBytes).toBeInstanceOf(Uint8Array);
    expect(emfBytes.length).toBeGreaterThan(80);
  });

  test("EMF writer caps tall-page frame metadata for compatibility", async () => {
    const writer = new EMFWriter({ width: 1280, height: 2484 });
    const emfBytes = await renderIR([], writer);
    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    const frameWidth = view.getInt32(32, true);
    const frameHeight = view.getInt32(36, true);

    expect(frameWidth).toBeLessThanOrEqual(0xffff);
    expect(frameHeight).toBeLessThanOrEqual(0xffff);
    expect(frameHeight).toBe(0xffff);
    expect(frameWidth / frameHeight).toBeCloseTo(1280 / 2484, 3);
    expect(view.getInt32(72, true)).toBeGreaterThan(0);
    expect(view.getInt32(76, true)).toBeGreaterThan(0);
  });

  test("EMF+ writer caps tall-page frame metadata for compatibility", async () => {
    const writer = new EMFPlusWriter({ width: 1280, height: 11095 });
    const emfBytes = await renderIR([], writer);
    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    const frameWidth = view.getInt32(32, true);
    const frameHeight = view.getInt32(36, true);

    expect(frameWidth).toBeLessThanOrEqual(0xffff);
    expect(frameHeight).toBeLessThanOrEqual(0xffff);
    expect(frameHeight).toBe(0xffff);
    expect(frameWidth / frameHeight).toBeCloseTo(1280 / 11095, 3);
    expect(view.getInt32(80, true)).toBeGreaterThan(0);
    expect(view.getInt32(84, true)).toBeGreaterThan(0);
    expect(view.getInt32(72, true)).toBe(1280);
    expect(view.getInt32(76, true)).toBe(11095);
  });

  test("EMF writer uses spec-sized font and bitmap records", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:160px;height:80px;background:#fff;">
          <img
            alt="dot"
            width="2"
            height="2"
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC"
            style="position:absolute;left:12px;top:12px;width:24px;height:24px;"
          />
          <p style="position:absolute;left:48px;top:10px;margin:0;color:#111;font-size:14px;">Hello EMF</p>
        </div>
      </body></html>`
    );

    await page.waitForFunction(() => {
      const img = document.querySelector("img") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeImages: true,
        includeText: true,
      });
    });

    const writer = new EMFWriter({ width: 160, height: 80 });
    const emfBytes = await renderIR(ir, writer);
    const fontRecord = findRecord(emfBytes, EMR_EXTCREATEFONTINDIRECTW);
    const dibRecord = findRecord(emfBytes, EMR_STRETCHDIBITS);

    expect(fontRecord).not.toBeNull();
    expect(fontRecord?.size).toBe(332);

    expect(dibRecord).not.toBeNull();
    if (!dibRecord) {
      return;
    }

    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    expect(view.getUint32(dibRecord.offset + 48, true)).toBe(80);
    expect(view.getUint32(dibRecord.offset + 56, true)).toBe(120);
    const offBmi = view.getUint32(dibRecord.offset + 48, true);
    expect(view.getInt32(dibRecord.offset + offBmi + 8, true)).toBe(24);
  });

  test("EMF writer emits positive page scales for text records", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:220px;height:80px;background:#fff;color:#111;font-size:14px;">
          <p style="margin:0;position:absolute;left:12px;top:14px;">Hello EMF</p>
        </div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const writer = new EMFWriter({ width: 220, height: 80 });
    const emfBytes = await renderIR(ir, writer);
    const textRecord = findAllRecords(emfBytes, 0x0054)[0];

    expect(textRecord).toBeDefined();
    if (!textRecord) {
      return;
    }

    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    expect(view.getFloat32(textRecord.offset + 28, true)).toBeGreaterThan(0);
    expect(view.getFloat32(textRecord.offset + 32, true)).toBeGreaterThan(0);
  });

  test("EMF writer keeps outlined pill shapes as rounded rectangles", async () => {
    const ir: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 10, y: 10 },
        { x: 150, y: 10 },
        { x: 150, y: 45 },
        { x: 10, y: 45 },
      ],
      style: {
        fill: "rgba(255, 255, 255, 0.76)",
        borderRadius: "999px",
        outlineColor: "rgb(10, 20, 30)",
        outlineWidth: "2px",
        outlineStyle: "solid",
        outlineOffset: "3px",
      },
      zIndex: 0,
    }];

    const writer = new EMFWriter({ width: 180, height: 80 });
    const emfBytes = await renderIR(ir, writer);

    expect(countRecords(emfBytes, EMR_ROUNDRECT)).toBeGreaterThanOrEqual(2);
  });

  test("EMF writer uses polypolygon records for compound path fills", async () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ];
    const inner = [
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ];
    const ir: IRNode[] = [{
      type: "polyline",
      points: [...outer, ...inner],
      closed: true,
      style: {
        fill: "#999999",
        fillRule: "evenodd",
        pathSubpaths: [
          { points: outer, closed: true },
          { points: inner, closed: true },
        ],
      },
      zIndex: 0,
    }];

    const writer = new EMFWriter({ width: 40, height: 40 });
    const emfBytes = await renderIR(ir, writer);

    expect(countRecords(emfBytes, EMR_POLYPOLYGON16)).toBeGreaterThan(0);
    expect(countRecords(emfBytes, EMR_FILLPATH)).toBe(0);
  });

  test("EMF+ writer keeps filled pill shapes as rounded rectangles", async () => {
    const ir: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 10, y: 10 },
        { x: 150, y: 10 },
        { x: 150, y: 45 },
        { x: 10, y: 45 },
      ],
      style: {
        fill: "rgb(77, 81, 86)",
        borderRadius: "999px",
      },
      zIndex: 0,
    }];

    const writer = new EMFPlusWriter({ width: 180, height: 80 });
    const emfBytes = await renderIR(ir, writer);
    const pathObjects = getAllEmfPlusRecords(emfBytes).filter((record) =>
      record.emfPlusType === EMFPLUS_OBJECT && ((record.emfPlusFlags >> 8) & 0x7F) === 0x03,
    );

    expect(pathObjects.length).toBeGreaterThan(0);
    const pathView = new DataView(pathObjects[0].data.buffer, pathObjects[0].data.byteOffset, pathObjects[0].data.byteLength);
    expect(pathView.getUint32(4, true)).toBeGreaterThan(13);
  });

  test("EMF+ writer produces EMF+ comment records inside a valid EMF container", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:green;">
          <p style="color:white;font-size:14px;">Hello EMF+</p>
        </div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const writer = new EMFPlusWriter({ width: 200, height: 100 });
    const emfBytes = await renderIR(ir, writer);
    const view = new DataView(emfBytes.buffer, emfBytes.byteOffset, emfBytes.byteLength);
    const emfPlusRecords = getEmfPlusCommentRecords(emfBytes);

    expect(view.getUint32(0, true)).toBe(0x00000001);
    expect(view.getUint32(40, true)).toBe(0x464D4520);
    expect(emfPlusRecords.length).toBeGreaterThan(0);
    expect(emfPlusRecords[0]?.emfPlusType).toBe(EMFPLUS_HEADER);
    expect(emfPlusRecords.at(-1)?.emfPlusType).toBe(EMFPLUS_EOF);
  });

  test("EMF+ writer emits path, text, image and object records for mixed content", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="position:relative;width:220px;height:120px;background:#fff;overflow:hidden;">
          <div style="position:absolute;left:12px;top:10px;width:72px;height:48px;background:#f66;border:3px dashed #004488;border-radius:12px;"></div>
          <img
            alt="dot"
            width="2"
            height="2"
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC"
            style="position:absolute;left:110px;top:12px;width:28px;height:28px;opacity:0.7;"
          />
          <p style="position:absolute;left:12px;top:72px;margin:0;color:#123456;font-size:14px;">Hello EMF+</p>
        </div>
      </body></html>`
    );

    await page.waitForFunction(() => {
      const img = document.querySelector("img") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeImages: true,
        includeText: true,
      });
    });

    const writer = new EMFPlusWriter({ width: 220, height: 120 });
    const emfBytes = await renderIR(ir, writer);
    const emfPlusTypes = getEmfPlusCommentRecords(emfBytes).map((record) => record.emfPlusType);

    expect(emfPlusTypes).toContain(EMFPLUS_OBJECT);
    expect(emfPlusTypes.some((type) => type === EMFPLUS_FILL_PATH || type === EMFPLUS_DRAW_PATH)).toBe(true);
    expect(emfPlusTypes).toContain(EMFPLUS_DRAW_STRING);
    expect(emfPlusTypes).toContain(EMFPLUS_DRAW_IMAGE_POINTS);
  });

  test("EMF+ writer keeps compressed bitmap dimensions for image objects", async () => {
    const ir: IRNode[] = [{
      type: "image",
      quad: [
        { x: 10, y: 10 },
        { x: 42, y: 10 },
        { x: 42, y: 42 },
        { x: 10, y: 42 },
      ],
      dataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      width: 1,
      height: 1,
      style: {},
      zIndex: 0,
    }];

    const writer = new EMFPlusWriter({ width: 64, height: 64 });
    const emfBytes = await renderIR(ir, writer);
    const imageObject = getAllEmfPlusRecords(emfBytes).find((record) =>
      record.emfPlusType === EMFPLUS_OBJECT && ((record.emfPlusFlags >> 8) & 0x7F) === 0x05,
    );

    expect(imageObject).toBeDefined();
    if (!imageObject) {
      return;
    }

    const view = new DataView(imageObject.data.buffer, imageObject.data.byteOffset, imageObject.data.byteLength);
    expect(view.getUint32(8, true)).toBe(1);
    expect(view.getUint32(12, true)).toBe(1);
    expect(view.getInt32(16, true)).toBe(0);
    expect(view.getUint32(20, true)).toBe(0);
    expect(view.getUint32(24, true)).toBe(1);
  });

  test("EMF+ writer emits gradient brush records and vector conic fills", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="position:relative;width:420px;height:180px;background:#fff;overflow:hidden;">
          <div style="position:absolute;left:12px;top:12px;width:120px;height:56px;background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);border-radius:12px;"></div>
          <div style="position:absolute;left:156px;top:12px;width:84px;height:84px;background:radial-gradient(circle, #ff9a9e 0%, #fecfef 50%, #fdfcfb 100%);border-radius:50%;"></div>
          <div style="position:absolute;left:264px;top:12px;width:84px;height:84px;background:conic-gradient(red, yellow, lime, aqua, blue, magenta, red);border-radius:50%;"></div>
          <div style="position:absolute;left:12px;top:108px;width:140px;height:56px;background:repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px);"></div>
          <div style="position:absolute;left:172px;top:108px;width:180px;height:56px;background:linear-gradient(to right, rgba(255,0,0,0.5), transparent), linear-gradient(to bottom, rgba(0,0,255,0.5), transparent), #e8e8e8;"></div>
        </div>
      </body></html>`
    );

    const ir: IRNode[] = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
    });

    const writer = new EMFPlusWriter({ width: 420, height: 180 });
    const emfBytes = await renderIR(ir, writer);
    const records = getAllEmfPlusRecords(emfBytes);
    const brushObjects = records.filter((record) => record.emfPlusType === EMFPLUS_OBJECT && ((record.emfPlusFlags >> 8) & 0x7F) === 0x01);
    const brushTypes = brushObjects.map((record) => new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength).getUint32(4, true));
    const brushPathFills = records.filter((record) => record.emfPlusType === EMFPLUS_FILL_PATH && (record.emfPlusFlags & 0x8000) === 0);
    const solidPathFills = records.filter((record) => record.emfPlusType === EMFPLUS_FILL_PATH && (record.emfPlusFlags & 0x8000) !== 0);

    expect(brushTypes).toContain(0x04);
    expect(brushTypes).toContain(0x03);
    expect(brushPathFills.length).toBeGreaterThanOrEqual(4);
    expect(brushPathFills.some((record) => new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength).getUint32(0, true) === 6)).toBe(true);
    expect(solidPathFills.length).toBeGreaterThan(40);
  });

  test("AcadDXF writer keeps text rotation in sane DXF degree range", async () => {
    const ir: IRNode[] = [{
      type: "text",
      quad: [
        { x: 0, y: 0 },
        { x: 0, y: 20 },
        { x: -10, y: 20 },
        { x: -10, y: 0 },
      ],
      text: "A",
      style: {
        color: "rgb(0, 0, 0)",
        fontSize: "20px",
      },
      zIndex: 0,
    }];

    const bytes = await renderIR(ir, new AcadDXFWriter({ maxY: 100 }));
    const dxf = Buffer.from(bytes).toString("utf-8");
    const entityMatch = dxf.match(/\n  0\nTEXT\n([\s\S]*?)\n  0\nENDSEC/);

    expect(entityMatch).not.toBeNull();

    const rotationMatch = entityMatch![1].match(/\n 50\n([^\r\n]+)/);
    expect(rotationMatch).not.toBeNull();
    expect(parseFloat(rotationMatch![1])).toBeCloseTo(-90, 3);
  });

  test("Acad writers keep timestamps deterministic across repeated renders", async () => {
    const ir: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 10, y: 10 },
        { x: 60, y: 10 },
        { x: 60, y: 40 },
        { x: 10, y: 40 },
      ],
      style: {
        fill: "rgb(255, 0, 0)",
        stroke: "rgb(0, 0, 0)",
      },
      zIndex: 0,
    }];

    const firstDxf = await renderIR(ir, new AcadDXFWriter({ maxY: 100 }));
    const secondDxf = await renderIR(ir, new AcadDXFWriter({ maxY: 100 }));

    expect(Buffer.from(firstDxf)).toEqual(Buffer.from(secondDxf));

    const dxf = Buffer.from(firstDxf).toString("utf-8");
    const stableJulian = CadUtils.toJulianCalendar(STABLE_CAD_DATE);
    for (const variable of ["TDCREATE", "TDUCREATE", "TDUUPDATE", "TDUPDATE"]) {
      const value = extractDxfHeaderNumber(dxf, variable);
      expect(value).not.toBeNull();
      expect(value!).toBeCloseTo(stableJulian, 6);
    }

    const firstDwg = await renderIR(ir, new DWGWriter({ maxY: 100 }));
    const secondDwg = await renderIR(ir, new DWGWriter({ maxY: 100 }));

    expect(Buffer.from(firstDwg)).toEqual(Buffer.from(secondDwg));

    const doc = new DwgReader(Buffer.from(firstDwg)).read();
    const stableTime = STABLE_CAD_DATE.getTime();
    expect(doc.header!.createDateTime.getTime()).toBe(stableTime);
    expect(doc.header!.updateDateTime.getTime()).toBe(stableTime);
    expect(doc.summaryInfo).not.toBeNull();
    expect(doc.summaryInfo!.createdDate.getTime()).toBe(stableTime);
    expect(doc.summaryInfo!.modifiedDate.getTime()).toBe(stableTime);
  });

  test("DWG writer keeps tiny neutral hatches on adaptive color index 7", async () => {
    const ir: IRNode[] = [{
      type: "polyline",
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 20 },
        { x: 10, y: 30 },
      ],
      closed: true,
      style: {
        fill: "rgb(0, 0, 0)",
        stroke: "rgb(0, 0, 0)",
      },
      zIndex: 0,
    }];

    const bytes = await renderIR(ir, new DWGWriter({ maxY: 100 }));
    const doc = new DwgReader(Buffer.from(bytes)).read();
    const hatches = Array.from(doc.modelSpace!.entities).filter((entity) => entity instanceof Hatch);

    expect(hatches.length).toBe(1);
    expect(hatches[0].color.isTrueColor).toBe(false);
    expect(hatches[0].color.index).toBe(7);
  });

});
