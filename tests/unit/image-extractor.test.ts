import { test, expect, type Page } from "@playwright/test";
import { setupPage } from "../helpers.js";

// A 1x1 red pixel JPEG as base64 data URL
const RED_PIXEL_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

// A 2x2 red PNG as base64 data URL (canvas-generated for Firefox compatibility)
const RED_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC";

// A simple SVG as data URL
const SVG_CIRCLE_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>');

// SVG as UTF-8 data URL (URL-encoded)
const SVG_RECT_DATA_URL =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="blue"/></svg>');

test.describe("Image Extraction", () => {
  test("extracts raster image (JPEG data URL) as image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad).toBeDefined();
    expect(imageNode.width).toBeGreaterThan(0);
    expect(imageNode.height).toBeGreaterThan(0);

    // Quad should be approximately 100x100
    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(100, 0);
    expect(bl.y - tl.y).toBeCloseTo(100, 0);
  });

  test("extracts raster image (PNG data URL) as image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_PNG}" style="width:80px;height:60px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad[1].x - imageNode.quad[0].x).toBeCloseTo(80, 0);
    expect(imageNode.quad[3].y - imageNode.quad[0].y).toBeCloseTo(60, 0);
  });

  test("converts SVG data URL (base64) to vector geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SVG_CIRCLE_DATA_URL}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG circle should be converted to polyline geometry, not an image node
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");

    // Should have vector geometry from the circle
    expect(polylineNodes.length).toBeGreaterThan(0);
    // Should NOT have a raster image node (SVG was converted)
    expect(imageNodes.length).toBe(0);
  });

  test("converts SVG data URL (UTF-8 encoded) to vector geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SVG_RECT_DATA_URL}" style="width:200px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG rect should be converted to polygon geometry
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polygonNodes = ir.filter((n: any) => n.type === "polygon");

    expect(polygonNodes.length).toBeGreaterThan(0);
    expect(imageNodes.length).toBe(0);
  });

  test("does NOT extract images when includeImages is false/unset", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: false,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("default (no includeImages option) does not extract images", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("skips broken/unloaded images gracefully", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="data:image/png;base64,INVALID" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // Should not crash; broken images are skipped
    const imageNodes = ir.filter((n: any) => n.type === "image");
    // Broken image — naturalWidth is 0
    expect(imageNodes.length).toBe(0);
  });

  test("extracts multiple images in a container", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="root">
          <img src="${RED_PIXEL_JPEG}" style="width:50px;height:50px;" />
          <img src="${RED_PIXEL_PNG}" style="width:75px;height:75px;" />
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(2);
  });

  test("image IR node has correct structure", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:120px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();

    // Validate IR node structure
    expect(imageNode.type).toBe("image");
    expect(imageNode.quad).toHaveLength(4);
    expect(imageNode.quad[0]).toHaveProperty("x");
    expect(imageNode.quad[0]).toHaveProperty("y");
    expect(typeof imageNode.dataUrl).toBe("string");
    expect(typeof imageNode.width).toBe("number");
    expect(typeof imageNode.height).toBe("number");
    expect(typeof imageNode.zIndex).toBe("number");
    expect(imageNode.style).toBeDefined();
  });

  test("isImageElement utility works", async ({ page }) => {
    await setupPage(
      page,
      `<html><body>
        <img id="img" src="${RED_PIXEL_JPEG}" />
        <div id="div">not an image</div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const hc = (window as any).__HC;
      const img = document.getElementById("img")!;
      const div = document.getElementById("div")!;
      return {
        imgIsImage: hc.isImageElement(img),
        divIsImage: hc.isImageElement(div),
      };
    });

    expect(result.imgIsImage).toBe(true);
    expect(result.divIsImage).toBe(false);
  });

  test("extracts CSS background-image url() as image IR node", async ({ page }) => {
    const RED_PIXEL_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQIW2P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==";

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:120px;height:80px;background-image:url('${RED_PIXEL_DATA_URL}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad).toBeDefined();

    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(120, 0);
    expect(bl.y - tl.y).toBeCloseTo(80, 0);
  });

  test("extracts CSS background-image SVG data URL as vector geometry", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="blue"/></svg>');

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:100px;background-image:url('${SVG_BG}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG background should produce polygon geometry (from rect), not an image node
    const polygonNodes = ir.filter((n: any) => n.type === "polygon");
    // Should have at least the element's own polygon + the SVG rect polygon
    expect(polygonNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("does NOT extract background-image when includeImages is false", async ({ page }) => {
    const RED_PIXEL_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQIW2P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==";

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:100px;background-image:url('${RED_PIXEL_DATA_URL}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: false,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("hasBackgroundImage utility works", async ({ page }) => {
    await setupPage(
      page,
      `<html><body>
        <div id="bg" style="background-image:url('data:image/png;base64,AAAA');width:10px;height:10px;"></div>
        <div id="grad" style="background-image:linear-gradient(red,blue);width:10px;height:10px;"></div>
        <div id="none" style="width:10px;height:10px;"></div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const hc = (window as any).__HC;
      return {
        bgHasImage: hc.hasBackgroundImage({ backgroundImage: "url('data:image/png;base64,AAAA')" }),
        gradHasImage: hc.hasBackgroundImage({ backgroundImage: "linear-gradient(red, blue)" }),
        noneHasImage: hc.hasBackgroundImage({ backgroundImage: "none" }),
        emptyHasImage: hc.hasBackgroundImage({}),
      };
    });

    expect(result.bgHasImage).toBe(true);
    expect(result.gradHasImage).toBe(false);
    expect(result.noneHasImage).toBe(false);
    expect(result.emptyHasImage).toBe(false);
  });

  test("SVG with root evenodd + multi-subpath paths is rasterized (MultipleSignalLamp)", async ({ page }) => {
    // MultipleSignalLamp SVG: root has fill-rule:evenodd, paths have multiple subpaths (M commands)
    // => evenodd matters for rendering, so it must be rasterized, not vectorized
    const MULTI_SUBPATH_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" style="fill-rule:evenodd;clip-rule:evenodd;">' +
      '<path d="M303,100C398,100 475,183 475,286C475,388 398,471 303,471C208,471 131,388 131,286C131,183 208,100 303,100Z' +
      'M181,178C158,207 145,245 145,286C145,327 158,364 181,394L289,286L181,178Z" style="fill:rgb(6,0,0);"/>' +
      '</svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${MULTI_SUBPATH_SVG}" style="width:120px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeImages: true, includeText: false });
    });

    // Should be rasterized as image (not vector), because evenodd + multi-subpath
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");
    expect(imageNodes.length).toBeGreaterThan(0);
    expect(polylineNodes.length).toBe(0);
  });

  test("SVG with root evenodd + simple shapes is vectorized (PhotoelectricProximitySensor)", async ({ page }) => {
    // SVG with fill-rule:evenodd on root but only simple shapes (single-subpath paths, rect, ellipse)
    // => evenodd doesn't matter, safe to vectorize
    const SIMPLE_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 200" style="fill-rule:evenodd;clip-rule:evenodd;">' +
      '<ellipse cx="400" cy="110" rx="85" ry="78" style="fill:none;stroke:black;stroke-width:7px;"/>' +
      '<path d="M141,101L141,104L5,101L141,98L141,101L305,101L305,101L141,101Z"/>' +
      '<rect x="4" y="5" width="4" height="190"/>' +
      '</svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SIMPLE_SVG}" style="width:200px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeImages: true, includeText: false });
    });

    // Should be vectorized (polygon/polyline), NOT rasterized
    const vectorNodes = ir.filter((n: any) => n.type === "polygon" || n.type === "polyline");
    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(vectorNodes.length).toBeGreaterThan(0);
    expect(imageNodes.length).toBe(0);
  });

  test("SVG in img tag produces geometry at correct position", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div style="height:50px;"></div>
        <img id="target" src="${SVG_CIRCLE_DATA_URL}" style="width:100px;height:100px;display:block;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // The SVG geometry should be positioned below the 50px spacer
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");
    if (polylineNodes.length > 0) {
      // At least some points should be below y=50
      const hasPointsBelowSpacer = polylineNodes.some((n: any) =>
        n.points.some((p: any) => p.y >= 50)
      );
      expect(hasPointsBelowSpacer).toBe(true);
    }
  });
});
