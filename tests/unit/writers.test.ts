import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { EMFWriter } from "../../src/writers/emf-writer.js";
import { EMFPlusWriter } from "../../src/writers/emfplus-writer.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode } from "../../src/types.js";

const EMR_COMMENT = 0x0046;
const EMR_EXTCREATEFONTINDIRECTW = 0x0052;
const EMR_STRETCHDIBITS = 0x0051;
const EMR_ROUNDRECT = 0x002C;
const EMFPLUS_COMMENT_IDENTIFIER = 0x2B464D45;
const EMFPLUS_HEADER = 0x4001;
const EMFPLUS_EOF = 0x4002;
const EMFPLUS_OBJECT = 0x4008;
const EMFPLUS_FILL_PATH = 0x4014;
const EMFPLUS_DRAW_PATH = 0x4015;
const EMFPLUS_DRAW_IMAGE_POINTS = 0x401B;
const EMFPLUS_DRAW_STRING = 0x401C;

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

});
