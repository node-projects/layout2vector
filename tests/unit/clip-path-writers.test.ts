import { expect, test } from "@playwright/test";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode, Quad } from "../../src/types.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";
import { EMFWriter } from "../../src/writers/emf-writer.js";

const triangleClipPath = "polygon(50% 0%, 100% 100%, 0% 100%)";

function createPolygonNodes(clipPath: string): IRNode[] {
  const points: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  return [{
    type: "polygon",
    points,
    style: {
      fill: "#ff0000",
      clipPath,
    },
    zIndex: 0,
  }];
}

function createCompoundPathNodes(): IRNode[] {
  const outer = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ];
  const inner = [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 30, y: 30 },
    { x: 10, y: 30 },
  ];

  return [{
    type: "polyline",
    points: [...outer, ...inner],
    closed: true,
    style: {
      fill: "#999999",
      fillRule: "evenodd",
      pathSubpaths: [
        { points: outer, closed: true },
        { points: inner, closed: true },
      ],
    },
    zIndex: 0,
  }];
}

function listEmfRecordTypes(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: number[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || offset + size > bytes.byteLength) break;
    types.push(type);
    offset += size;
    if (type === 0x000E) break;
  }

  return types;
}

test.describe("Writer clip-path support", () => {
  test("HTML writer emits CSS clip-path wrappers", async () => {
    const writer = new HTMLWriter({ width: 100, height: 100 });
    const html = await renderIR(createPolygonNodes(triangleClipPath), writer);

    expect(html).toContain(`clip-path:${triangleClipPath}`);
  });

  test("SVG writer emits clipPath defs for polygon clips", async () => {
    const writer = new SVGWriter({ width: 100, height: 100 });
    const svg = await renderIR(createPolygonNodes(triangleClipPath), writer);

    expect(svg).toMatch(/clip-path="url\(#clip\d+\)"/);
    expect(svg).toContain("<path d=\"M50,0 L100,100 L0,100 Z\"");
  });

  test("HTML writer keeps compound path subpaths in one SVG path", async () => {
    const writer = new HTMLWriter({ width: 40, height: 40 });
    const html = await renderIR(createCompoundPathNodes(), writer);

    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain('M0,0 L40,0 L40,40 L0,40 Z M10,10 L30,10 L30,30 L10,30 Z');
  });

  test("SVG writer keeps compound path subpaths in one path element", async () => {
    const writer = new SVGWriter({ width: 40, height: 40 });
    const svg = await renderIR(createCompoundPathNodes(), writer);

    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('M0,0 L40,0 L40,40 L0,40 Z M10,10 L30,10 L30,30 L10,30 Z');
  });

  test("PDF writer emits clip operators for clip-path shapes", async () => {
    const writer = new PDFWriter({ pageWidth: 26.46, pageHeight: 26.46 });
    const pdf = await renderIR(createPolygonNodes(triangleClipPath), writer);

    await pdf.finalize();
    const content = Buffer.from(pdf.toBytes()).toString("latin1");

    expect(content).toContain("W n");
  });

  test("EMF writer emits path-based clip records for clip-path shapes", async () => {
    const writer = new EMFWriter({ width: 100, height: 100 });
    const emfBytes = await renderIR(createPolygonNodes(triangleClipPath), writer);
    const recordTypes = listEmfRecordTypes(emfBytes);

    expect(recordTypes).toContain(0x003B);
    expect(recordTypes).toContain(0x003C);
    expect(recordTypes).toContain(0x0043);
  });
});