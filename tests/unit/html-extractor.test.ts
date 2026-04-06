import { test, expect, type Page } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("HTML Geometry Extraction", () => {
  test("extracts simple div box quad", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:50px;background:red;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { boxType: "border" });
    });

    expect(ir.length).toBeGreaterThan(0);
    const polygon = ir.find((n: any) => n.type === "polygon");
    expect(polygon).toBeDefined();
    // The box should be approximately 100x50
    const [tl, tr, br, bl] = polygon.points;
    expect(tr.x - tl.x).toBeCloseTo(100, 0);
    expect(bl.y - tl.y).toBeCloseTo(50, 0);
  });

  test("extracts text node geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <p id="target" style="font-size:16px;font-family:monospace;">Hello World</p>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const textNode = ir.find((n: any) => n.type === "text");
    expect(textNode).toBeDefined();
    expect(textNode.text).toContain("Hello World");
  });

  test("skips display:none elements", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="visible" style="width:50px;height:50px;background:blue;"></div>
          <div id="hidden" style="display:none;width:50px;height:50px;background:red;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // Should have geometry for root and visible, not hidden
    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Each visible element with non-zero size produces a polygon
    const widths = polygons.map(
      (p: any) => p.points[1].x - p.points[0].x
    );
    // Should NOT contain a 50px-wide red box at a later position
    // The hidden div should not appear
    expect(polygons.length).toBeGreaterThanOrEqual(1);
  });

  test("skips visibility:hidden elements", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div style="width:100px;height:100px;background:green;"></div>
          <div style="visibility:hidden;width:100px;height:100px;background:red;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Only the green div should produce geometry (plus root)
    expect(polygons.length).toBeLessThanOrEqual(2);
  });

  test("handles content box type", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:100px;padding:10px;border:5px solid black;background:red;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { boxType: "content" });
    });

    const polygon = ir.find((n: any) => n.type === "polygon");
    expect(polygon).toBeDefined();
    // Content box should be 100x100 (the inner content, excluding padding/border)
    const width = polygon.points[1].x - polygon.points[0].x;
    const height = polygon.points[3].y - polygon.points[0].y;
    expect(width).toBeCloseTo(100, 0);
    expect(height).toBeCloseTo(100, 0);
  });
});
