import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("UI Rendering Tests", () => {
  test("flexbox layout", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="display:flex;width:300px;height:100px;">
          <div id="a" style="flex:1;background:red;"></div>
          <div id="b" style="flex:2;background:blue;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(2);

    // Item A should be ~100px wide (1/3), item B ~200px wide (2/3)
    const widths = polygons
      .map((p: any) => Math.round(p.points[1].x - p.points[0].x))
      .filter((w: number) => w > 0)
      .sort((a: number, b: number) => a - b);

    // Should have widths around 100 and 200
    expect(widths.some((w: number) => Math.abs(w - 100) < 5)).toBe(true);
    expect(widths.some((w: number) => Math.abs(w - 200) < 5)).toBe(true);
  });

  test("grid layout", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="display:grid;grid-template-columns:100px 200px;grid-template-rows:50px 50px;width:300px;">
          <div style="background:red;"></div>
          <div style="background:blue;"></div>
          <div style="background:green;"></div>
          <div style="background:yellow;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Should have at least 4 grid cells + root
    expect(polygons.length).toBeGreaterThanOrEqual(4);
  });

  test("inline text wrapping", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="width:100px;font-size:14px;line-height:1.5;">
          <span id="text">This is a long text that should wrap across multiple lines in the container.</span>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: true });
    });

    const texts = ir.filter((n: any) => n.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    // The text content should be captured
    const allText = texts.map((t: any) => t.text).join(" ");
    expect(allText).toContain("This is a long text");
  });

  test("CSS transforms", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="width:300px;height:300px;">
          <div id="rotated" style="transform:rotate(45deg);width:100px;height:100px;background:red;margin:100px;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    // With rotation, the quad points won't form an axis-aligned rectangle
    // The points should still be captured via getBoxQuads/getBoundingClientRect
  });

  test("nested layouts", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="width:400px;">
          <div style="display:flex;gap:10px;padding:10px;">
            <div style="flex:1;">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;">
                <div style="height:30px;background:red;"></div>
                <div style="height:30px;background:blue;"></div>
              </div>
            </div>
            <div style="flex:1;background:green;height:65px;"></div>
          </div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Should capture all nested elements
    expect(polygons.length).toBeGreaterThanOrEqual(3);
  });

  test("Shadow DOM", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="host" style="width:200px;height:100px;"></div>
        <script>
          const host = document.getElementById('host');
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<div style="width:100px;height:50px;background:red;"></div>';
        </script>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("host")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Should include the shadow DOM content
    expect(polygons.length).toBeGreaterThanOrEqual(1);

    // Should find a 100x50 polygon from the shadow content
    const shadowBox = polygons.find((p: any) => {
      const w = Math.abs(p.points[1].x - p.points[0].x);
      const h = Math.abs(p.points[3].y - p.points[0].y);
      return Math.abs(w - 100) < 2 && Math.abs(h - 50) < 2;
    });
    expect(shadowBox).toBeDefined();
  });

  test("SVG inside HTML", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="width:300px;padding:10px;background:#eee;">
          <h2 style="margin:0 0 10px;">Chart</h2>
          <svg width="280" height="100" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="280" height="100" fill="white" stroke="#ccc" />
            <rect x="10" y="60" width="40" height="40" fill="steelblue" />
            <rect x="60" y="30" width="40" height="70" fill="steelblue" />
            <rect x="110" y="10" width="40" height="90" fill="steelblue" />
          </svg>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: true });
    });

    // Should have HTML elements + SVG rects
    const polygons = ir.filter((n: any) => n.type === "polygon");
    expect(polygons.length).toBeGreaterThanOrEqual(4); // root div + 4 SVG rects
  });

  test("stacking contexts with z-index", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:300px;height:300px;">
          <div id="layer1" style="position:absolute;z-index:1;top:0;left:0;width:200px;height:200px;background:rgba(255,0,0,0.5);"></div>
          <div id="layer2" style="position:absolute;z-index:2;top:50px;left:50px;width:200px;height:200px;background:rgba(0,0,255,0.5);"></div>
          <div id="layer3" style="position:absolute;z-index:3;top:100px;left:100px;width:200px;height:200px;background:rgba(0,255,0,0.5);"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // IR z-indices should be in increasing order
    for (let i = 1; i < ir.length; i++) {
      expect(ir[i].zIndex).toBeGreaterThanOrEqual(ir[i - 1].zIndex);
    }
  });

  test("isolation:isolate creates stacking context", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;width:300px;height:200px;">
          <div id="isolated" style="isolation:isolate;width:200px;height:100px;background:red;">
            <div id="inner" style="position:relative;z-index:999;width:100px;height:50px;background:blue;"></div>
          </div>
          <div id="outside" style="position:relative;z-index:1;width:150px;height:75px;background:green;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);

      const isolated = tree.children.find(
        (c: any) => c.element.id === "isolated"
      );
      return {
        isolatedCreatesCtx: isolated?.createsStackingContext,
      };
    });

    expect(result.isolatedCreatesCtx).toBe(true);
  });
});
