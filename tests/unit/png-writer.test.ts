import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("PNG Writer Output", () => {
  test("produces a valid PNG data URL for a simple element", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:50px;background:red;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(100, 50);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
    // Verify it's a non-trivial PNG (more than just the header)
    const base64 = result.split(",")[1];
    expect(base64.length).toBeGreaterThan(100);
  });

  test("renders text into PNG", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:blue;">
          <p style="color:white;font-size:14px;margin:10px;">Hello PNG</p>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
      const writer = new (window as any).__HC.PNGWriter(200, 100);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return {
        dataUrl: pngResult.toDataURL(),
        irCount: ir.length,
        hasText: ir.some((n: any) => n.type === "text"),
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.irCount).toBeGreaterThan(0);
    expect(result.hasText).toBe(true);
  });

  test("renders polylines and filled shapes", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target">
          <svg width="200" height="200" viewBox="0 0 200 200">
            <rect x="10" y="10" width="80" height="80" fill="green" stroke="black" stroke-width="2"/>
            <circle cx="150" cy="50" r="40" fill="orange"/>
            <polyline points="10,180 50,120 90,180" fill="none" stroke="blue" stroke-width="3"/>
          </svg>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(200, 200);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return {
        dataUrl: pngResult.toDataURL(),
        irCount: ir.length,
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.irCount).toBeGreaterThan(0);
  });

  test("handles rounded rectangles", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:150px;height:80px;background:#4CAF50;border-radius:15px;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(150, 80);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  test("handles gradients", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:linear-gradient(to right, red, blue);"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(200, 100);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  test("supports scale parameter for high-DPI output", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:50px;background:purple;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });

      // 1x
      const writer1x = new (window as any).__HC.PNGWriter(100, 50, 1);
      const result1x = (window as any).__HC.renderIR(ir, writer1x);
      await result1x.finalize();
      const dataUrl1x = result1x.toDataURL();

      // 2x
      const writer2x = new (window as any).__HC.PNGWriter(100, 50, 2);
      const result2x = (window as any).__HC.renderIR(ir, writer2x);
      await result2x.finalize();
      const dataUrl2x = result2x.toDataURL();

      return {
        size1x: dataUrl1x.length,
        size2x: dataUrl2x.length,
      };
    });

    // 2x should produce a larger PNG (more pixels)
    expect(result.size2x).toBeGreaterThan(result.size1x);
  });

  test("toBytes returns valid PNG bytes", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:50px;height:50px;background:green;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(50, 50);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const bytes = pngResult.toBytes();
      // Check PNG magic number: 137 80 78 71 13 10 26 10
      return {
        length: bytes.length,
        magic: [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]],
      };
    });

    expect(result.length).toBeGreaterThan(0);
    // PNG magic number
    expect(result.magic).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("handles transparent elements correctly", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:100px;">
          <div style="width:80px;height:80px;background:rgba(255,0,0,0.5);"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(100, 100);
      const pngResult = (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
  });
});
