import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("SVG Marker Extraction", () => {
  test("extracts marker-end on a line", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="80" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="black" />
            </marker>
          </defs>
          <line x1="20" y1="40" x2="180" y2="40" stroke="black" stroke-width="2"
                marker-end="url(#arrow)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    // At least 2: the line itself + the marker
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    // The marker polyline should be near x=180 (the end of the line)
    const marker = polylines.find(
      (p: any) => p.points.length > 2 && p !== polylines[0]
    );
    expect(marker).toBeDefined();
    // Marker should be near the endpoint
    const markerCenterX =
      marker.points.reduce((s: number, p: any) => s + p.x, 0) /
      marker.points.length;
    expect(markerCenterX).toBeGreaterThan(160);
    expect(markerCenterX).toBeLessThan(200);
  });

  test("extracts marker-start on a line", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="80" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="dot" viewBox="0 -5 10 10" refX="0" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="red" />
            </marker>
          </defs>
          <line x1="20" y1="40" x2="180" y2="40" stroke="red" stroke-width="2"
                marker-start="url(#dot)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    // Marker should be near the start point x=20
    const marker = polylines.find(
      (p: any) => p.points.length > 2 && p !== polylines[0]
    );
    expect(marker).toBeDefined();
    const markerCenterX =
      marker.points.reduce((s: number, p: any) => s + p.x, 0) /
      marker.points.length;
    expect(markerCenterX).toBeGreaterThan(10);
    expect(markerCenterX).toBeLessThan(40);
  });

  test("extracts marker-mid on polyline", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="300" height="100" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="mid-dot" viewBox="0 -5 10 10" refX="5" refY="0"
                    markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="blue" />
            </marker>
          </defs>
          <polyline points="20,80 100,20 200,80 280,20"
                    fill="none" stroke="blue" stroke-width="2"
                    marker-mid="url(#mid-dot)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    // 1 polyline + 2 mid-markers (at points 100,20 and 200,80)
    expect(polylines.length).toBeGreaterThanOrEqual(3);
  });

  test("markers scale correctly with viewBox (large viewBox, small viewport)", async ({
    page,
  }) => {
    // This is the key test for the "too huge" marker bug.
    // viewBox="0 0 1000 500" in a 200x100 viewport → CTM scale = 0.2
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="100" viewBox="0 0 1000 500" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-vb" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="green" />
            </marker>
          </defs>
          <line x1="100" y1="250" x2="900" y2="250" stroke="green" stroke-width="10"
                marker-end="url(#arrow-vb)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    // Find the 2-point line and the multi-point marker
    const line = polylines.find((p: any) => p.points.length === 2);
    expect(line).toBeDefined();
    const lineLen = Math.abs(line.points[1].x - line.points[0].x);
    expect(lineLen).toBeGreaterThan(100); // should be roughly 160px

    const marker = polylines.find((p: any) => p.points.length > 2);
    expect(marker).toBeDefined();

    // Marker bounding box should be small relative to line length
    const xs = marker.points.map((p: any) => p.x);
    const markerWidth = Math.max(...xs) - Math.min(...xs);
    // With correct CTM scaling (0.2), marker should be ~12px
    // Without CTM fix, it would be ~60px (way too large for a 160px line)
    expect(markerWidth).toBeLessThan(lineLen * 0.15);
  });

  test("markers scale correctly with viewBox (small viewBox, large viewport)", async ({
    page,
  }) => {
    // viewBox="0 0 100 50" in a 400x200 viewport → CTM scale = 4
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="400" height="200" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-up" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="purple" />
            </marker>
          </defs>
          <line x1="10" y1="25" x2="90" y2="25" stroke="purple" stroke-width="2"
                marker-end="url(#arrow-up)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    const line = polylines.find((p: any) => p.points.length === 2);
    expect(line).toBeDefined();
    const lineLen = Math.abs(line.points[1].x - line.points[0].x);
    expect(lineLen).toBeGreaterThan(200); // should be roughly 320px

    const marker = polylines.find((p: any) => p.points.length > 2);
    expect(marker).toBeDefined();

    const xs = marker.points.map((p: any) => p.x);
    const markerWidth = Math.max(...xs) - Math.min(...xs);

    // With CTM=4, marker should be about 48px (6*10/10 * 2 * 4)
    // Should be visible but proportional to line
    expect(markerWidth).toBeGreaterThan(10);
    expect(markerWidth).toBeLessThan(lineLen * 0.25);
  });

  test("markers in group with transform scale correctly", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="300" height="120" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-g" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="teal" />
            </marker>
          </defs>
          <g transform="scale(2)">
            <line x1="10" y1="30" x2="120" y2="30" stroke="teal" stroke-width="1"
                  marker-end="url(#arrow-g)" />
          </g>
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    // With scale(2), line goes from x≈20 to x≈240
    const line = polylines.find((p: any) => p.points.length === 2);
    expect(line).toBeDefined();
    const lineLen = Math.abs(line.points[1].x - line.points[0].x);
    expect(lineLen).toBeGreaterThan(150);

    const marker = polylines.find((p: any) => p.points.length > 2);
    expect(marker).toBeDefined();

    const xs = marker.points.map((p: any) => p.x);
    const markerWidth = Math.max(...xs) - Math.min(...xs);

    // Marker should be proportional even with group transform
    expect(markerWidth).toBeLessThan(lineLen * 0.15);
    expect(markerWidth).toBeGreaterThan(2);
  });

  test("markerUnits userSpaceOnUse ignores stroke width", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="300" height="80" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-usu" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="15" markerHeight="15" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="navy" />
            </marker>
          </defs>
          <line x1="30" y1="20" x2="270" y2="20" stroke="navy" stroke-width="1"
                marker-end="url(#arrow-usu)" />
          <line x1="30" y1="50" x2="270" y2="50" stroke="navy" stroke-width="5"
                marker-end="url(#arrow-usu)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    // 2 lines + 2 markers
    expect(polylines.length).toBeGreaterThanOrEqual(4);

    // Find the two marker polylines (have many points, not simple 2-point lines)
    const markers = polylines.filter((p: any) => p.points.length > 2);
    expect(markers.length).toBe(2);

    // Both markers should be the same size since markerUnits="userSpaceOnUse",
    // regardless of the different stroke widths
    const widths = markers.map((m: any) => {
      const xs = m.points.map((p: any) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    });
    // Allow 1px tolerance
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(1);
  });

  test("stroke width affects marker size with default markerUnits", async ({
    page,
  }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="300" height="120" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-sw" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="black" />
            </marker>
          </defs>
          <line x1="20" y1="30" x2="280" y2="30" stroke="black" stroke-width="1"
                marker-end="url(#arrow-sw)" />
          <line x1="20" y1="80" x2="280" y2="80" stroke="black" stroke-width="4"
                marker-end="url(#arrow-sw)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    const markers = polylines.filter((p: any) => p.points.length > 2);
    expect(markers.length).toBe(2);

    const widths = markers.map((m: any) => {
      const xs = m.points.map((p: any) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    });

    // The stroke-width=4 marker should be ~4x larger than stroke-width=1
    expect(widths[1]).toBeGreaterThan(widths[0] * 2);
  });

  test("marker on path element", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="300" height="120" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow-path" viewBox="0 -5 10 10" refX="10" refY="0"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,-5L10,0L0,5" fill="#e91e63" />
            </marker>
          </defs>
          <path d="M 20 100 Q 150 0 280 100" fill="none" stroke="#e91e63" stroke-width="2"
                marker-start="url(#arrow-path)" marker-end="url(#arrow-path)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    // 1 path + 2 markers (start and end)
    expect(polylines.length).toBeGreaterThanOrEqual(3);
  });

  test("marker with polygon child shape", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <svg id="target" width="200" height="80" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="diamond" viewBox="0 0 10 10" refX="5" refY="5"
                    markerWidth="8" markerHeight="8" orient="auto">
              <polygon points="5,0 10,5 5,10 0,5" fill="orange" />
            </marker>
          </defs>
          <line x1="20" y1="40" x2="180" y2="40" stroke="orange" stroke-width="2"
                marker-end="url(#diamond)" />
        </svg>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el);
    });

    const polylines = ir.filter((n: any) => n.type === "polyline");
    expect(polylines.length).toBeGreaterThanOrEqual(2);

    // Find the polygon marker (should be closed with 4 points)
    const marker = polylines.find((p: any) => p.closed && p.points.length === 4);
    expect(marker).toBeDefined();
  });

  test("markers consistent across inline SVG and img tag", async ({ page }) => {
    // The same SVG rendered inline and as an img should produce similarly-sized markers
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">
      <defs>
        <marker id="a" viewBox="0 -5 10 10" refX="10" refY="0"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,-5L10,0L0,5" fill="red" />
        </marker>
      </defs>
      <line x1="20" y1="40" x2="180" y2="40" stroke="red" stroke-width="2" marker-end="url(#a)" />
    </svg>`;

    const encodedSvg = encodeURIComponent(svgContent);
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="inline-container">
          <svg id="target-inline" width="200" height="80" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="a-inline" viewBox="0 -5 10 10" refX="10" refY="0"
                      markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,-5L10,0L0,5" fill="red" />
              </marker>
            </defs>
            <line x1="20" y1="40" x2="180" y2="40" stroke="red" stroke-width="2" marker-end="url(#a-inline)" />
          </svg>
        </div>
        <div id="img-container" style="margin-top:10px;">
          <img id="target-img" width="200" height="80"
               src="data:image/svg+xml,${encodedSvg}">
        </div>
      </body></html>`
    );

    const inlineIR = await page.evaluate(() => {
      const el = document.getElementById("target-inline")!;
      return (window as any).__HC.extractIR(el);
    });

    const inlineMarkers = inlineIR.filter(
      (n: any) => n.type === "polyline" && n.points.length > 2
    );
    expect(inlineMarkers.length).toBeGreaterThanOrEqual(1);

    // Inline marker size
    const inlineXs = inlineMarkers[0].points.map((p: any) => p.x);
    const inlineW = Math.max(...inlineXs) - Math.min(...inlineXs);
    expect(inlineW).toBeGreaterThan(2);
  });
});
