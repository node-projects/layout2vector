import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("Full Pipeline: DOM → IR → Writer", () => {
  test("end-to-end: simple div produces complete IR", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="root" style="width:300px;height:200px;background:#eee;">
          <div style="width:100px;height:50px;background:red;margin:10px;"></div>
          <div style="width:150px;height:75px;background:blue;margin:10px;">
            <span style="color:white;font-size:14px;">Test Text</span>
          </div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    expect(ir.length).toBeGreaterThan(0);

    const polygons = ir.filter((n: any) => n.type === "polygon");
    const texts = ir.filter((n: any) => n.type === "text");

    // Should have polygons for root + 2 children (at minimum)
    expect(polygons.length).toBeGreaterThanOrEqual(3);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts[0].text).toContain("Test Text");
  });

  test("end-to-end: mixed HTML + SVG", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div style="width:200px;height:100px;background:lightblue;"></div>
          <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
            <rect x="10" y="10" width="80" height="60" fill="green" />
            <circle cx="150" cy="50" r="30" fill="red" />
          </svg>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    expect(ir.length).toBeGreaterThan(0);

    // Should have HTML polygons and SVG shapes
    const polygons = ir.filter((n: any) => n.type === "polygon");
    const polylines = ir.filter((n: any) => n.type === "polyline");

    expect(polygons.length).toBeGreaterThanOrEqual(2); // HTML div + SVG rect
    expect(polylines.length).toBeGreaterThanOrEqual(1); // SVG circle
  });

  test("end-to-end: stacking contexts in correct order", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:300px;height:300px;">
          <div id="back" style="position:absolute;z-index:1;top:0;left:0;width:200px;height:200px;background:red;"></div>
          <div id="front" style="position:absolute;z-index:2;top:50px;left:50px;width:200px;height:200px;background:blue;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // The IR is ordered by paint order, so 'back' (z:1) should come before 'front' (z:2)
    // Both should be polygons with 200x200 dimensions
    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(2);

    // IR zIndex values should be monotonically non-decreasing
    for (let i = 1; i < ir.length; i++) {
      expect(ir[i].zIndex).toBeGreaterThanOrEqual(ir[i - 1].zIndex);
    }
  });

  test("end-to-end: IR is deterministic", async ({ page }) => {
    const html = `<html><body style="margin:0;">
      <div id="root" style="width:200px;height:200px;">
        <div style="width:100px;height:50px;background:red;"></div>
        <div style="width:100px;height:50px;background:blue;"></div>
      </div>
    </body></html>`;

    await setupPage(page, html);

    const ir1 = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // Run again on same page
    const ir2 = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // Should produce identical results
    expect(ir1).toEqual(ir2);
  });
});
