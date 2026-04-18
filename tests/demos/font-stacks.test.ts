import { expect, test } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { injectBoxQuadsPolyfill, injectLibrary } from "../helpers.js";
import { renderIR } from "../../src/pipeline.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import type { IRNode, Quad } from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const demoUrl = pathToFileURL(path.join(__dirname, "font-stacks.html")).href;

function isAxisAligned(quad: Quad): boolean {
  const epsilon = 0.01;
  return (
    Math.abs(quad[0].y - quad[1].y) < epsilon &&
    Math.abs(quad[1].x - quad[2].x) < epsilon &&
    Math.abs(quad[2].y - quad[3].y) < epsilon &&
    Math.abs(quad[3].x - quad[0].x) < epsilon
  );
}

function quadAngleDegrees(quad: Quad): number {
  return Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x) * (180 / Math.PI);
}

function expectQuadClose(actual: Quad, expected: Quad, digits = 1): void {
  for (let index = 0; index < actual.length; index++) {
    expect(actual[index].x).toBeCloseTo(expected[index].x, digits);
    expect(actual[index].y).toBeCloseTo(expected[index].y, digits);
  }
}

function getQuoteLineNodes(ir: IRNode[]): Array<Extract<IRNode, { type: "text" }>> {
  const quoteLines = new Set([
    "Native quads carry rotated text geometry,",
    "so transformed runs can keep their live layout",
    "when the browser exposes `getBoxQuads()`",
    "directly.",
  ]);

  return ir
    .filter((node): node is Extract<IRNode, { type: "text" }> => node.type === "text" && quoteLines.has(node.text))
    .sort((left, right) => left.quad[0].y - right.quad[0].y);
}

test("font stack demo keeps transformed text quads and writer font stacks in firefox", async ({ page, browserName }) => {
  test.skip(browserName !== "firefox", "Uses Firefox native getBoxQuads for transformed text coverage.");

  await page.goto(demoUrl, { waitUntil: "load" });
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  const ir: IRNode[] = await page.evaluate(async () => {
    const root = document.getElementById("root") ?? document.body;
    return (window as any).__HC.extractIR(root, {
      boxType: "border",
      includeText: true,
      includeImages: true,
      textMeasurement: "auto",
    });
  });

  const headline = ir.find(
    (node): node is Extract<IRNode, { type: "text" }> => node.type === "text" && node.text === "Editorial Systems",
  );
  expect(headline).toBeDefined();
  expect(headline!.style.fontFamily).toContain("Mona Sans");
  expect(headline!.style.fontFamily).toContain("Segoe UI");
  expect(isAxisAligned(headline!.quad)).toBe(false);

  const vertical = ir.find(
    (node): node is Extract<IRNode, { type: "text" }> => node.type === "text" && node.text === "RTL SIGNAL",
  );
  expect(vertical).toBeDefined();
  expect(vertical!.style.fontFamily).toContain("Segoe UI");
  expect(quadAngleDegrees(vertical!.quad)).toBeGreaterThan(95);
  expect(quadAngleDegrees(vertical!.quad)).toBeLessThan(97);

  const nativeVerticalQuad = await page.evaluate(() => {
    const textNode = document.querySelector(".vertical-tag")?.firstChild as (Text & {
      getBoxQuads?: () => DOMQuad[];
    }) | null;
    const quad = textNode?.getBoxQuads?.()?.[0];
    if (!quad) return null;

    return [quad.p2, quad.p3, quad.p4, quad.p1].map((point) => ({ x: point.x, y: point.y }));
  });

  expect(nativeVerticalQuad).not.toBeNull();
  expectQuadClose(vertical!.quad, nativeVerticalQuad as Quad);

  const ribbon = ir.find(
    (node): node is Extract<IRNode, { type: "text" }> => node.type === "text" && node.text === "VARIABLE CADENCE",
  );
  expect(ribbon).toBeDefined();
  expect(isAxisAligned(ribbon!.quad)).toBe(false);

  const quoteLines = getQuoteLineNodes(ir);
  expect(quoteLines).toHaveLength(4);
  expect(quoteLines.slice(0, -1).every((line) => line.style.textAlign === "justify")).toBe(true);
  expect(quoteLines.at(-1)?.style.textAlign).toBeUndefined();

  const viewport = await page.evaluate(() => {
    const root = document.getElementById("root") ?? document.body;
    const rootElement = root as Element & {
      getBoxQuads?: (options?: { box?: "border" | "content" }) => DOMQuad[];
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    };

    const quads = rootElement.getBoxQuads?.({ box: "border" }) ?? [];
    if (quads.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const quad of quads) {
        for (const point of [quad.p1, quad.p2, quad.p3, quad.p4]) {
          if (point.x < minX) minX = point.x;
          if (point.y < minY) minY = point.y;
          if (point.x > maxX) maxX = point.x;
          if (point.y > maxY) maxY = point.y;
        }
      }

      return {
        width: Math.ceil(Math.max(maxX - minX, rootElement.scrollWidth, rootElement.clientWidth)) || 1,
        height: Math.ceil(Math.max(maxY - minY, rootElement.scrollHeight, rootElement.clientHeight)) || 1,
      };
    }

    const rect = root.getBoundingClientRect();
    return {
      width: Math.ceil(Math.max(rect.width, rootElement.scrollWidth, rootElement.clientWidth)) || 1,
      height: Math.ceil(Math.max(rect.height, rootElement.scrollHeight, rootElement.clientHeight)) || 1,
    };
  });

  const svg = await renderIR(ir, new SVGWriter({ width: viewport.width, height: viewport.height }));
  const html = await renderIR(ir, new HTMLWriter({ width: viewport.width, height: viewport.height }));

  expect(svg).toContain("Mona Sans");
  expect(svg).toContain("Segoe UI");
  expect(svg).toContain("font-family=");
  expect(svg).toContain("letter-spacing=");
  expect(svg).toContain('stroke="rgba(18, 53, 91, 0.14)"');
  expect(svg).toContain("RTL SIGNAL");
  expect(svg).toMatch(/RTL SIGNAL<\/text>/);
  expect(svg).toMatch(/transform="matrix\(-0\.1,0\.99,-0\.99,-0\.1|transform="matrix\(-0\.1,0\.99,-1,-0\.1/);
  expect(svg).toMatch(/<text[^>]*transform="matrix\([^"]+\)"[^>]*>VARIABLE CADENCE<\/text>/);
  expect((svg.match(/lengthAdjust="spacing"/g) ?? []).length).toBe(3);

  expect(html).toContain("Mona Sans");
  expect(html).toContain("Segoe UI");
  expect(html).toContain("font-family:");
  expect(html).toContain("letter-spacing:");
  expect(html).toContain("outline:2px solid rgba(18, 53, 91, 0.14)");
  expect(html).toContain("RTL SIGNAL");
  expect(html).toContain("transform:matrix(");
  expect(html).toMatch(/RTL SIGNAL<\/div>/);
  expect((html.match(/text-align:justify;text-align-last:justify/g) ?? []).length).toBe(3);
  expect(html).not.toMatch(/position:relative;left:-\d/);
  expect((html.match(/position:absolute;left:56px;top:286\.5px;width:590px;height:613\.5px;overflow:hidden;border-radius:28px/g) ?? []).length).toBe(1);
  expect((html.match(/position:absolute;left:674px;top:286\.5px;width:590px;height:613\.5px;overflow:hidden;border-radius:28px/g) ?? []).length).toBe(1);
});