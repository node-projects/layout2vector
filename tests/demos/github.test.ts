import { expect, test } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { roundedQuadPath } from "../../src/geometry.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode, Quad } from "../../src/types.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import { formatWriterNumber } from "../../src/writers/shared/writer-utils.js";
import { injectBoxQuadsPolyfill, injectLibrary } from "../helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const demoUrl = pathToFileURL(path.join(__dirname, "github.html")).href;

function roundedQuadToPath(points: Quad, radius: number): string {
  const segments = roundedQuadPath(points, radius);
  return segments.map((segment) => {
    switch (segment.type) {
      case "M":
        return `M${formatWriterNumber(segment.x)},${formatWriterNumber(segment.y)}`;
      case "L":
        return `L${formatWriterNumber(segment.x)},${formatWriterNumber(segment.y)}`;
      case "Q":
        return `Q${formatWriterNumber(segment.cx)},${formatWriterNumber(segment.cy)} ${formatWriterNumber(segment.x)},${formatWriterNumber(segment.y)}`;
    }
  }).join(" ") + " Z";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("github demo keeps the header avatar circular in firefox svg output", async ({ page, browserName }) => {
  test.skip(browserName !== "firefox", "Uses Firefox native getBoxQuads for the github demo regression case.");
  test.setTimeout(120_000);

  await page.goto(demoUrl, { waitUntil: "load" });
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  const ir: IRNode[] = await page.evaluate(() => {
    const root = document.getElementById("root") ?? document.body;
    return (window as any).__HC.extractIR(root, {
      boxType: "border",
      includeText: true,
      includeImages: true,
      convertFormControls: true,
      textMeasurement: "auto",
    });
  });

  const avatar = ir.find(
    (node): node is Extract<IRNode, { type: "image" }> =>
      node.type === "image" &&
      node.style.borderRadius === "50%" &&
      node.width === 32 &&
      node.height === 32 &&
      node.quad[0].y < 80,
  );

  expect(avatar).toBeDefined();

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
  const expectedClipPath = roundedQuadToPath(avatar!.quad, Math.min(avatar!.width, avatar!.height) / 2);
  const clipMatch = svg.match(
    new RegExp(
      `<clipPath id="(clip\\d+)" clipPathUnits="userSpaceOnUse"><path d="${escapeRegExp(expectedClipPath)}"/></clipPath>`,
    ),
  );

  expect(clipMatch).not.toBeNull();

  const x = formatWriterNumber(avatar!.quad[0].x);
  const y = formatWriterNumber(avatar!.quad[0].y);
  const width = formatWriterNumber(avatar!.width);
  const height = formatWriterNumber(avatar!.height);

  expect(svg).toMatch(
    new RegExp(
      `<g clip-path="url\\(#${clipMatch![1]}\\)"><use href="#imgSym\\d+" x="${x}" y="${y}" width="${width}" height="${height}"/></g>`,
    ),
  );
});