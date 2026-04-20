import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("SVG Geometry Extraction", () => {
  test("extracts SVG rect", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="80" height="60" fill="blue" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    // Find the rect polygon (80x60)
    const rectPolygon = polygons.find((p: any) => {
      const w = Math.abs(p.points[1].x - p.points[0].x);
      const h = Math.abs(p.points[3].y - p.points[0].y);
      return Math.abs(w - 80) < 2 && Math.abs(h - 60) < 2;
    });
    expect(rectPolygon).toBeDefined();
  });

  test("extracts SVG circle as polyline", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <circle cx="100" cy="100" r="50" fill="red" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);

    // Circle should be closed and have multiple points
    const circle = polylines.find((p: any) => p.closed && p.points.length > 10);
    expect(circle).toBeDefined();
  });

  test("extracts SVG line", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <line x1="10" y1="10" x2="190" y2="190" stroke="black" stroke-width="2" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);

    const line = polylines.find((p: any) => p.points.length === 2);
    expect(line).toBeDefined();
  });

  test("extracts SVG path by sampling", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <path d="M 10 10 L 100 10 L 100 100 Z" fill="green" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);
    // Path should have many sampled points
    expect(polylines[0].points.length).toBeGreaterThan(2);
  });

  test("extracts SVG text", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <text x="10" y="50" font-size="20">SVG Text</text>
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeText: true });
    });

    const texts = ir.filter((n: any) => n.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts[0].text).toContain("SVG Text");
  });

  test("extracts SVG polygon", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <polygon points="100,10 40,198 190,78 10,78 160,198" fill="purple" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);
    expect(polylines[0].closed).toBe(true);
    expect(polylines[0].points.length).toBe(5);
  });

  test("extracts SVG ellipse", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="100" cy="100" rx="80" ry="40" fill="yellow" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);
    expect(polylines[0].closed).toBe(true);
    expect(polylines[0].points.length).toBeGreaterThan(10);
  });

  test("applies SVG transforms via CTM", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <g transform="translate(50, 50)">
            <rect x="0" y="0" width="40" height="30" fill="orange" />
          </g>
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    // The rect should be translated by (50,50)
    const rect = polygons.find((p: any) => {
      const w = Math.abs(p.points[1].x - p.points[0].x);
      return Math.abs(w - 40) < 2;
    });
    expect(rect).toBeDefined();
    // Top-left should be around (50, 50)
    expect(rect.points[0].x).toBeCloseTo(50, 0);
    expect(rect.points[0].y).toBeCloseTo(50, 0);
  });

  test("propagates parent opacity to SVG text", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <g opacity="0.5">
            <text x="10" y="50" font-size="20">Half opacity</text>
          </g>
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeText: true });
    });

    const texts = ir.filter((n: any) => n.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts[0].text).toContain("Half opacity");
    // Opacity should be 0.5 (inherited from parent <g>)
    expect(texts[0].style.opacity).toBeCloseTo(0.5, 1);
  });

  test("multiplies nested parent opacities in SVG", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <g opacity="0.5">
            <g opacity="0.4">
              <rect x="10" y="10" width="50" height="50" fill="red" />
            </g>
          </g>
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);
    // Effective opacity: 0.5 * 0.4 = 0.2
    // Find the red rect (skip the SVG root's HTML box which has transparent fill)
    const redRect = polygons.find((p: any) => p.style.fill && p.style.fill !== "rgba(0, 0, 0, 0)" && p.style.fill !== "transparent");
    expect(redRect).toBeTruthy();
    expect(redRect!.style.opacity).toBeCloseTo(0.2, 1);
  });

  test("detects closed SVG paths", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
          <path d="M 10 10 L 100 10 L 100 100 Z" fill="green" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(1);
    expect(polylines[0].closed).toBe(true);
  });

  test("extracts multi-subpath SVG paths as a compound polyline", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="80" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 10 H70 V50 H10 Z M110 20 H170 V40 H110 Z" fill="rgb(145, 152, 161)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    const compound = polylines.find((polyline: any) => polyline.style?.pathSubpaths?.length === 2);
    expect(compound).toBeDefined();
    expect(compound.closed).toBe(true);
    expect(compound.style.pathSubpaths.every((subpath: any) => subpath.closed)).toBe(true);
  });

  test("extracts relative moveto SVG subpaths as a compound polyline", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="220" height="80" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 10 H70 V50 H10 Z m100 10 h60 v20 h-60 z" fill="rgb(145, 152, 161)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    const compound = polylines.find((polyline: any) => polyline.style?.pathSubpaths?.length === 2);
    expect(compound).toBeDefined();
    expect(compound.style.pathSubpaths[1].points[0].x).toBeGreaterThan(100);
    expect(compound.style.pathSubpaths.every((subpath: any) => subpath.closed)).toBe(true);
  });
});
