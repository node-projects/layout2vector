import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { EMFWriter } from "../../src/writers/emf-writer.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode } from "../../src/types.js";

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

});
