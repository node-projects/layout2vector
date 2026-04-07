/**
 * Tests that all extracted IR coordinates are relative to the root element,
 * not the page origin. Covers every node type: polygon (HTML box), text,
 * polyline (SVG shapes), and image.
 */
import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

/** Extract IR from #root inside a page with given body style offset. */
async function extractWithOffset(
  page: any,
  innerHtml: string,
  bodyStyle = "margin:0;padding:0;"
) {
  await setupPage(
    page,
    `<html><body style="${bodyStyle}">${innerHtml}</body></html>`
  );
  return page.evaluate(() => {
    const el = document.getElementById("root")!;
    return (window as any).__HC.extractIR(el, {
      boxType: "border",
      includeText: true,
      includeImages: true,
    });
  });
}

test.describe("Root-relative coordinates", () => {
  test("HTML polygon coordinates start at (0,0) for the root element", async ({
    page,
  }) => {
    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:200px;top:150px;width:100px;height:80px;border:1px solid black;">
        <div style="width:40px;height:30px;background:red;margin:10px;"></div>
      </div>`
    );

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(2);

    // The root element's box should start at (0, 0)
    const rootPoly = polygons[0];
    expect(rootPoly.points[0].x).toBeCloseTo(0, 0);
    expect(rootPoly.points[0].y).toBeCloseTo(0, 0);
    // Bottom-right should be ~(102, 82) (100+2*1px border, 80+2*1px border)
    expect(rootPoly.points[2].x).toBeCloseTo(102, 0);
    expect(rootPoly.points[2].y).toBeCloseTo(82, 0);

    // The child div at margin:10px inside the border should be at ~(11, 11)
    const childPoly = polygons[1];
    expect(childPoly.points[0].x).toBeCloseTo(11, 0);
    expect(childPoly.points[0].y).toBeCloseTo(11, 0);
    expect(childPoly.points[2].x).toBeCloseTo(51, 0);
    expect(childPoly.points[2].y).toBeCloseTo(41, 0);
  });

  test("coordinates are the same regardless of root position on page", async ({
    page,
  }) => {
    // Extract with root at (50, 30)
    const ir1 = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:50px;top:30px;width:100px;height:80px;">
        <div style="width:40px;height:20px;background:red;"></div>
      </div>`
    );

    // Extract with root at (300, 200)
    const ir2 = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:300px;top:200px;width:100px;height:80px;">
        <div style="width:40px;height:20px;background:red;"></div>
      </div>`
    );

    // Same number of nodes
    expect(ir1.length).toBe(ir2.length);

    // All coordinates should be identical (both relative to root)
    for (let i = 0; i < ir1.length; i++) {
      const n1 = ir1[i];
      const n2 = ir2[i];
      expect(n1.type).toBe(n2.type);
      if (n1.type === "polygon") {
        for (let j = 0; j < 4; j++) {
          expect(n1.points[j].x).toBeCloseTo(n2.points[j].x, 1);
          expect(n1.points[j].y).toBeCloseTo(n2.points[j].y, 1);
        }
      }
    }
  });

  test("text node coordinates are root-relative", async ({ page }) => {
    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:120px;top:90px;width:200px;height:100px;font-size:16px;">
        <span>Hello</span>
      </div>`
    );

    const texts = ir.filter((n: any) => n.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);

    // Text quad top-left should be near (0, 0), not (120, 90)
    const t = texts[0];
    expect(t.quad[0].x).toBeLessThan(10);
    expect(t.quad[0].y).toBeLessThan(20);
    // Should not be at the absolute page position
    expect(t.quad[0].x).not.toBeCloseTo(120, -1);
    expect(t.quad[0].y).not.toBeCloseTo(90, -1);
  });

  test("SVG polyline coordinates are root-relative", async ({ page }) => {
    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:100px;top:80px;width:200px;height:150px;">
        <svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="50" height="30" fill="green" stroke="black" />
          <circle cx="150" cy="75" r="25" fill="none" stroke="red" />
          <line x1="10" y1="100" x2="190" y2="100" stroke="blue" />
        </svg>
      </div>`
    );

    // SVG shapes should be polylines/polygons with coords relative to root
    const polygons = ir.filter((n: any) => n.type === "polygon");
    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polygons.length).toBeGreaterThanOrEqual(1); // rect
    expect(polylines.length).toBeGreaterThanOrEqual(2); // circle + line

    // The SVG rect at (10,10)-(60,40) in SVG coords.
    // In screen coords, the SVG starts at root's (0,0), so rect should be near (10,10).
    const svgRect = polygons.find(
      (p: any) => p.points[0].x > 5 && p.points[0].x < 15
    );
    expect(svgRect).toBeTruthy();
    expect(svgRect.points[0].x).toBeCloseTo(10, 0);
    expect(svgRect.points[0].y).toBeCloseTo(10, 0);
    // Not at absolute page coords (110, 90)
    expect(svgRect.points[0].x).not.toBeCloseTo(110, -1);

    // The line at y=100 should be relative (not at 180)
    const line = polylines.find((p: any) => {
      const midY = (p.points[0].y + p.points[p.points.length - 1].y) / 2;
      return Math.abs(midY - 100) < 5;
    });
    expect(line).toBeTruthy();
    expect(line.points[0].x).toBeCloseTo(10, 0);
    expect(line.points[0].y).toBeCloseTo(100, 0);
  });

  test("image coordinates are root-relative", async ({ page }) => {
    // Use a 1x1 red pixel data URL to avoid file:// issues
    const redPixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:150px;top:100px;width:200px;height:200px;">
        <img src="${redPixel}" style="width:60px;height:40px;margin:20px;" />
      </div>`
    );

    const images = ir.filter((n: any) => n.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(1);

    // Image should be at ~(20, 20) relative to root, not (170, 120)
    const img = images[0];
    expect(img.quad[0].x).toBeCloseTo(20, 0);
    expect(img.quad[0].y).toBeCloseTo(20, 0);
    expect(img.quad[2].x).toBeCloseTo(80, 0);
    expect(img.quad[2].y).toBeCloseTo(60, 0);
  });

  test("nested offset: body margin + root position", async ({ page }) => {
    // Body has default margin (8px), root is at (50, 40) from body
    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:50px;top:40px;width:100px;height:60px;background:red;">
        <div style="width:30px;height:20px;background:blue;"></div>
      </div>`,
      "margin:8px;"
    );

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(2);

    // Root box starts at (0,0) regardless of body margin + absolute position
    expect(polygons[0].points[0].x).toBeCloseTo(0, 0);
    expect(polygons[0].points[0].y).toBeCloseTo(0, 0);
  });

  test("background-image SVG coordinates are root-relative", async ({
    page,
  }) => {
    // Use an inline SVG data URL as background-image
    const svgDataUrl =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="none" stroke="black"/></svg>'
      );

    const ir = await extractWithOffset(
      page,
      `<div id="root" style="position:absolute;left:200px;top:150px;width:200px;height:100px;">
        <div style="width:80px;height:60px;margin:10px;background-image:url('${svgDataUrl}');background-size:contain;"></div>
      </div>`
    );

    // The background SVG should produce geometry (polygon for the rect)
    // All coords should be root-relative (within the root's 200x100 area)
    const allNodes = ir.filter(
      (n: any) => n.type === "polygon" || n.type === "polyline"
    );
    for (const node of allNodes) {
      const points = node.points || node.quad;
      for (const p of points) {
        // Coords should be within root bounds (0..200, 0..100), not at page position (200+, 150+)
        expect(p.x).toBeLessThanOrEqual(201);
        expect(p.y).toBeLessThanOrEqual(101);
        expect(p.x).toBeGreaterThanOrEqual(-1);
        expect(p.y).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});
