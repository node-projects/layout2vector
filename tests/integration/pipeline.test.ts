import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode, Writer } from "../../src/types.js";

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

  test("end-to-end: zero-size overflow clips descendants", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:220px;height:120px;background:#fff;">
          <div style="position:absolute;left:10px;top:20px;width:0;height:0;overflow:hidden;">
            <a id="target" style="display:block;width:110px;height:44px;border:2px solid rgba(255, 255, 255, 0.16);color:rgb(10, 10, 10);font:16px/1 Arial, sans-serif;white-space:nowrap;">Hidden link</a>
          </div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const clippedBox = ir.find((node: any) =>
      node.type === "polygon" &&
      node.style.borderLeftWidth === "2px" &&
      node.style.clipBounds?.w === 0 &&
      node.style.clipBounds?.h === 0
    );
    const clippedText = ir.find((node: any) =>
      node.type === "text" &&
      node.text.includes("Hidden")
    );

    expect(clippedBox).toBeDefined();
    expect(clippedBox.style.clipBounds).toMatchObject({
      x: 10,
      y: 20,
      w: 0,
      h: 0,
    });
    expect(clippedText).toBeDefined();
    expect(clippedText.style.clipBounds).toMatchObject({
      x: 10,
      y: 20,
      w: 0,
      h: 0,
    });
  });

  test("end-to-end: overflow scroll and auto clip descendants like a static viewport", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:240px;height:140px;background:#fff;">
          <div style="position:absolute;left:10px;top:20px;width:60px;height:40px;overflow:scroll;">
            <div id="scroll-child" style="position:absolute;left:0;top:60px;width:20px;height:20px;background:rgb(255, 0, 0);"></div>
          </div>
          <div style="position:absolute;left:110px;top:20px;width:60px;height:40px;overflow:auto;">
            <div id="auto-child" style="position:absolute;left:0;top:60px;width:20px;height:20px;background:rgb(0, 0, 255);"></div>
          </div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
    });

    const scrollChild = ir.find((node: any) =>
      node.type === "polygon" &&
      node.style.fill === "rgb(255, 0, 0)"
    );
    const autoChild = ir.find((node: any) =>
      node.type === "polygon" &&
      node.style.fill === "rgb(0, 0, 255)"
    );

    expect(scrollChild).toBeDefined();
    expect(scrollChild.style.clipBounds).toMatchObject({
      x: 10,
      y: 20,
      w: 60,
      h: 40,
    });

    expect(autoChild).toBeDefined();
    expect(autoChild.style.clipBounds).toMatchObject({
      x: 110,
      y: 20,
      w: 60,
      h: 40,
    });

    const calls: string[] = [];
    const writer: Writer<string> = {
      begin: async () => {},
      drawPolygon: async (_points, style) => { calls.push(style.fill ?? "polygon"); },
      drawPolyline: async () => { calls.push("polyline"); },
      drawText: async (_quad, text) => { calls.push(`text:${text}`); },
      drawImage: async () => { calls.push("image"); },
      end: async () => calls.join(","),
    };

    await renderIR([scrollChild as IRNode, autoChild as IRNode], writer);
    expect(calls).toEqual([]);
  });

  test("renderIR skips nodes that are fully outside their clip bounds", async () => {
    const calls: string[] = [];
    const writer: Writer<string> = {
      begin: async () => {},
      drawPolygon: async () => { calls.push("polygon"); },
      drawPolyline: async () => { calls.push("polyline"); },
      drawText: async (_quad, text) => { calls.push(`text:${text}`); },
      drawImage: async () => { calls.push("image"); },
      end: async () => calls.join(","),
    };

    const nodes: IRNode[] = [
      {
        type: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        style: { fill: "rgb(255, 0, 0)" },
        zIndex: 0,
      },
      {
        type: "text",
        quad: [
          { x: 30, y: 0 },
          { x: 90, y: 0 },
          { x: 90, y: 20 },
          { x: 30, y: 20 },
        ],
        text: "Visible",
        style: { color: "rgb(0, 0, 0)" },
        zIndex: 1,
      },
      {
        type: "polygon",
        points: [
          { x: 40, y: 40 },
          { x: 80, y: 40 },
          { x: 80, y: 80 },
          { x: 40, y: 80 },
        ],
        style: {
          fill: "rgb(0, 0, 255)",
          clipBounds: { x: 10, y: 10, w: 0, h: 0, radius: 0 },
        },
        zIndex: 2,
      },
      {
        type: "text",
        quad: [
          { x: 100, y: 40 },
          { x: 180, y: 40 },
          { x: 180, y: 60 },
          { x: 100, y: 60 },
        ],
        text: "Hidden",
        style: {
          color: "rgb(0, 0, 0)",
          clipBounds: { x: 10, y: 10, w: 0, h: 0, radius: 0 },
        },
        zIndex: 3,
      },
    ];

    await renderIR(nodes, writer);

    expect(calls).toEqual(["polygon", "text:Visible"]);
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

  test("end-to-end: same-origin iframe traversal is opt-in and clipped to the iframe viewport", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:320px;height:220px;background:#f4f4f4;">
          <iframe
            id="preview"
            style="position:absolute;left:40px;top:30px;width:160px;height:100px;border:8px solid #111;border-radius:14px;background:white;"
            srcdoc="<!doctype html><html><body style='margin:0;background:#fff7d6;overflow:hidden;'><div id='inner' style='position:absolute;left:20px;top:16px;width:60px;height:30px;background:rgb(255, 0, 0);'></div></body></html>"
          ></iframe>
        </div>
      </body></html>`
    );

    await page.waitForFunction(() => {
      const iframe = document.getElementById("preview") as HTMLIFrameElement | null;
      return iframe?.contentDocument?.readyState === "complete";
    });

    const [withoutIframes, withIframes] = await Promise.all([
      page.evaluate(() => {
        const el = document.getElementById("root")!;
        return (window as any).__HC.extractIR(el, { includeText: false, walkIframes: false });
      }),
      page.evaluate(() => {
        const el = document.getElementById("root")!;
        return (window as any).__HC.extractIR(el, { includeText: false, walkIframes: true });
      }),
    ]);

    expect(withIframes.length).toBeGreaterThan(withoutIframes.length);

    const findInnerPolygon = (nodes: any[]) => {
      return nodes
        .filter((node) => node.type === "polygon")
        .find((node) => {
          const xs = node.points.map((point: { x: number }) => point.x);
          const ys = node.points.map((point: { y: number }) => point.y);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const width = Math.max(...xs) - minX;
          const height = Math.max(...ys) - minY;
          return (
            Math.abs(minX - 68) < 1 &&
            Math.abs(minY - 54) < 1 &&
            Math.abs(width - 60) < 1 &&
            Math.abs(height - 30) < 1
          );
        });
    };

    const innerWithoutTraversal = findInnerPolygon(withoutIframes);
    const innerWithTraversal = findInnerPolygon(withIframes);

    expect(innerWithoutTraversal).toBeUndefined();
    expect(innerWithTraversal).toBeDefined();
    expect(innerWithTraversal.style.clipBounds).toMatchObject({
      x: 48,
      y: 38,
      w: 160,
      h: 100,
    });
    expect(innerWithTraversal.style.clipQuads).toHaveLength(1);
    expect(innerWithTraversal.style.clipQuads[0]).toMatchObject({
      radius: 14,
      points: [
        { x: 48, y: 38 },
        { x: 208, y: 38 },
        { x: 208, y: 138 },
        { x: 48, y: 138 },
      ],
    });
  });

  test("end-to-end: transformed iframes map descendant geometry through the iframe viewport", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:360px;height:260px;background:#f4f4f4;">
          <iframe
            id="preview"
            style="position:absolute;left:40px;top:30px;width:160px;height:100px;border:8px solid #111;transform:rotate(11deg) scale(1.05);transform-origin:top left;background:white;"
            srcdoc="<!doctype html><html><body style='margin:0;background:#fff7d6;'><div id='inner' style='position:absolute;left:20px;top:16px;width:60px;height:30px;background:rgb(255, 0, 0);'></div></body></html>"
          ></iframe>
        </div>
      </body></html>`
    );

    await page.waitForFunction(() => {
      const iframe = document.getElementById("preview") as HTMLIFrameElement | null;
      return iframe?.contentDocument?.readyState === "complete";
    });

    const { ir, contentQuad } = await page.evaluate(async () => {
      const root = document.getElementById("root")!;
      const iframe = document.getElementById("preview") as HTMLIFrameElement & {
        getBoxQuads?: (options?: { box?: string }) => Array<{ p1: { x: number; y: number }; p2: { x: number; y: number }; p3: { x: number; y: number }; p4: { x: number; y: number } }>;
      };
      const quad = iframe.getBoxQuads?.({ box: "content" })?.[0];
      return {
        ir: await (window as any).__HC.extractIR(root, { includeText: false, walkIframes: true }),
        contentQuad: quad ? {
          p1: { x: quad.p1.x, y: quad.p1.y },
          p2: { x: quad.p2.x, y: quad.p2.y },
          p4: { x: quad.p4.x, y: quad.p4.y },
        } : null,
      };
    });

    expect(contentQuad).not.toBeNull();

    const mapViewportPoint = (x: number, y: number) => ({
      x: contentQuad!.p1.x + ((contentQuad!.p2.x - contentQuad!.p1.x) * x) / 160 + ((contentQuad!.p4.x - contentQuad!.p1.x) * y) / 100,
      y: contentQuad!.p1.y + ((contentQuad!.p2.y - contentQuad!.p1.y) * x) / 160 + ((contentQuad!.p4.y - contentQuad!.p1.y) * y) / 100,
    });

    const expectedPoints = [
      mapViewportPoint(20, 16),
      mapViewportPoint(80, 16),
      mapViewportPoint(80, 46),
      mapViewportPoint(20, 46),
    ];

    const target = ir
      .filter((node: any) => node.type === "polygon")
      .find((node: any) => {
        if (node.points.length !== 4) return false;
        return node.points.every((point: { x: number; y: number }, index: number) => {
          return (
            Math.abs(point.x - expectedPoints[index].x) < 1.5 &&
            Math.abs(point.y - expectedPoints[index].y) < 1.5
          );
        });
      });

    expect(target).toBeDefined();
    expect(target.style.clipQuads).toHaveLength(1);
    const clipQuad = target.style.clipQuads[0];
    expect(clipQuad.radius).toBeCloseTo(0, 5);
    [contentQuad!.p1, contentQuad!.p2, contentQuad!.p4].forEach((point, index) => {
      const clipPoint = [clipQuad.points[0], clipQuad.points[1], clipQuad.points[3]][index];
      expect(clipPoint.x).toBeCloseTo(point.x, 1);
      expect(clipPoint.y).toBeCloseTo(point.y, 1);
    });
  });
});
