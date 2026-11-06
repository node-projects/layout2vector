import { test, expect } from "@playwright/test";
import { inflateRawSync } from "node:zlib";
import { DrawIOWriter } from "../../src/index.js";
import { renderIR } from "../../src/pipeline.js";
import type { Quad, Style } from "../../src/types.js";
import { setupPage } from "../helpers.js";

const quad: Quad = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }];

test("exports uncompressed XML with separate editable cells in paint order", async ({ page }) => {
  const output = await renderIR([
    { type: "polygon", points: quad, style: { fill: "#123456", borderRadius: "8px" }, zIndex: 0 },
    { type: "text", quad, text: 'A & <B> "quoted"\nGrüße 😀', style: { whiteSpace: "pre", color: "#000000", fontSize: "20px", fontWeight: "700", fontStyle: "italic", textDecoration: "underline" }, zIndex: 1,
      source: { id: 'a"&', xpath: "/html/body/p", originalType: "html" } },
    { type: "image", quad, dataUrl: "data:image/png;base64,aGVsbG8=", width: 100, height: 50, style: {}, zIndex: 2 },
  ], new DrawIOWriter({ width: 800, height: 600, pageName: 'Test & "Page"' }));
  const parsed = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return { errors: doc.querySelectorAll("parsererror").length,
      compressed: doc.documentElement.getAttribute("compressed"),
      name: doc.querySelector("diagram")?.getAttribute("name"),
      pageWidth: doc.querySelector("mxGraphModel")?.getAttribute("pageWidth"),
      cells: [...doc.querySelectorAll('mxCell[vertex="1"]')].map(c => ({
        id: c.id, value: c.getAttribute("value"), style: c.getAttribute("style"), sourceId: c.getAttribute("sourceId"),
        width: c.querySelector("mxGeometry")?.getAttribute("width"),
      })) };
  }, output);
  expect(parsed.errors).toBe(0);
  expect(parsed.compressed).toBe("false");
  expect(parsed.name).toBe('Test & "Page"');
  expect(parsed.pageWidth).toBe("800");
  expect(parsed.cells.map(c => c.id)).toEqual(["2", "3", "4"]);
  expect(parsed.cells[0].style).toContain("shape=rectangle;");
  expect(parsed.cells[0].style).toContain("arcSize=16;");
  expect(parsed.cells[1].value).toBe('A & <B> "quoted"\nGrüße 😀');
  expect(parsed.cells[1].style).toContain("fontStyle=7;");
  expect(parsed.cells[1].sourceId).toBe('a"&');
  expect(parsed.cells[2].style).toContain("image=data:image/png,aGVsbG8=;");
  expect(parsed.cells[2].width).toBe("100");
});

test("keeps polygon geometry in a native editable stencil and line waypoints as edges", async ({ page }) => {
  const writer = new DrawIOWriter();
  await writer.begin();
  await writer.drawPolyline([{ x: -10, y: 20 }, { x: 30, y: 25 }, { x: 15, y: 80 }], true,
    { fill: "rgba(255, 0, 0, 0.5)", stroke: "#000000", strokeWidth: "2", opacity: 0.6 });
  await writer.drawPolyline([{ x: 1, y: 2 }, { x: 30, y: 40 }, { x: 70, y: 80 }], false,
    { stroke: "#000000", strokeWidth: "2", strokeDasharray: "6 4" });
  const output = await writer.end();
  const stencilData = output.match(/shape=stencil\(([^)]+)\)/)![1];
  const stencil = decodeURIComponent(inflateRawSync(Buffer.from(stencilData, "base64")).toString());
  const result = await page.evaluate(({ output, stencil }) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(output, "application/xml");
    const shape = parser.parseFromString(stencil, "application/xml");
    return { errors: doc.querySelectorAll("parsererror").length + shape.querySelectorAll("parsererror").length,
      path: [...shape.querySelector("path")!.children].map(c => [c.tagName, c.getAttribute("x"), c.getAttribute("y")]),
      edge: doc.querySelector('mxCell[edge="1"]')?.outerHTML };
  }, { output, stencil });
  expect(result.errors).toBe(0);
  expect(result.path).toEqual([["move", "0", "0"], ["line", "40", "5"], ["line", "25", "60"], ["close", null, null]]);
  expect(output).toContain("fillOpacity=50;");
  expect(output).toContain("opacity=60;");
  expect(result.edge).toContain('as="sourcePoint"');
  expect(result.edge).toContain('x="30" y="40"');
  expect(result.edge).toContain("endArrow=none;");
  expect(result.edge).toContain("dashPattern=3 2;");
});

test("preserves compound paths and handles stencils larger than a DEFLATE stored block", async () => {
  const writer = new DrawIOWriter();
  await writer.begin();
  const points = Array.from({ length: 3000 }, (_, x) => ({ x, y: x % 5 }));
  await writer.drawPolyline(points, false, { fill: "#000000", pathSubpaths: [{ points, closed: true }, { points: quad, closed: false }] });
  const output = await writer.end();
  const stencil = decodeURIComponent(inflateRawSync(Buffer.from(output.match(/stencil\(([^)]+)\)/)![1], "base64")).toString());
  expect(stencil.match(/<move /g)).toHaveLength(2);
  expect(stencil.match(/<line /g)).toHaveLength(3002);
  expect(stencil.match(/<close\/>/g)).toHaveLength(1);
});

test("retains rotation and border sides, resets between exports, and validates page sizes", async () => {
  const writer = new DrawIOWriter();
  await writer.begin();
  const rotated: Quad = [{ x: 50, y: 0 }, { x: 50, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }];
  await writer.drawText(rotated, "hello", {});
  await writer.drawImage(rotated, "data:image/png;base64,AAAA", 100, 50, {});
  await writer.drawPolygon(quad, { borderTopColor: "#000000", borderTopWidth: "2px", borderTopStyle: "solid" });
  expect((await writer.end()).match(/rotation=90;/g)).toHaveLength(2);
  expect(await writer.end()).toContain('edge="1"');
  await writer.begin();
  await writer.drawText(quad, "new", {});
  const reset = await writer.end();
  expect(reset).toContain('id="2" value="new"');
  expect(reset).not.toContain("hello");
  await writer.begin();
  const borderStyle: Style = { stroke: "#000000", strokeWidth: "2px", opacity: 0.5 };
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    borderStyle[`border${side}Color`] = "#000000";
    borderStyle[`border${side}Width`] = "2px";
    borderStyle[`border${side}Style`] = "solid";
  }
  await writer.drawPolygon(quad, borderStyle);
  const uniform = await writer.end();
  expect(uniform).not.toContain('edge="1"');
  expect(uniform).toContain("strokeColor=#000000;");
  for (const width of [0, -1, NaN, Infinity]) expect(() => new DrawIOWriter({ width })).toThrow(/dimensions/);
});

test("exports a live DOM layout in the browser without Node APIs", async ({ page }) => {
  await setupPage(page, '<div id="layout" style="width:200px;height:100px;background:#ffeecc;border:2px solid black">Editable label<img width="20" height="20" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="></div>');
  const result = await page.evaluate(async () => {
    const api = (window as any).__HC;
    const ir = await api.extractIR(document.getElementById("layout"), { includeImages: true });
    const output = await api.renderIR(ir, new api.DrawIOWriter());
    const doc = new DOMParser().parseFromString(output, "application/xml");
    return { errors: doc.querySelectorAll("parsererror").length,
      cells: [...doc.querySelectorAll('mxCell[vertex="1"]')].map(c => ({ style: c.getAttribute("style"), value: c.getAttribute("value") })) };
  });
  expect(result.errors).toBe(0);
  expect(result.cells.some(c => c.style?.includes("shape=rectangle;"))).toBe(true);
  expect(result.cells.some(c => c.value?.includes("Editable label"))).toBe(true);
  expect(result.cells.some(c => c.style?.includes("shape=image;"))).toBe(true);
});

test("preserves the fill of an open SVG path", async () => {
  const writer = new DrawIOWriter();
  await writer.begin();
  await writer.drawPolyline(quad.slice(0, 3), false, { fill: "#ff0000" });
  const output = await writer.end();
  expect(output).toContain("shape=stencil(");
  expect(output).toContain("fillColor=#ff0000;");
  const stencil = decodeURIComponent(inflateRawSync(Buffer.from(output.match(/stencil\(([^)]+)\)/)![1], "base64")).toString());
  expect(stencil).not.toContain("<close/>");
});
