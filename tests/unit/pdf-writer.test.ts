import { expect, test } from "@playwright/test";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode, Quad } from "../../src/types.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";

const chipQuad: Quad = [
  { x: 0, y: 0 },
  { x: 42.2833, y: 0 },
  { x: 42.2833, y: 18.7667 },
  { x: 0, y: 18.7667 },
];

const textQuad: Quad = [
  { x: 4.7667, y: 2.3833 },
  { x: 37.5167, y: 2.3833 },
  { x: 37.5167, y: 16.3833 },
  { x: 4.7667, y: 16.3833 },
];

function createCodeChipNodes(): IRNode[] {
  return [
    {
      type: "polygon",
      points: chipQuad,
      style: {
        fill: "rgba(101, 108, 118, 0.2)",
        borderRadius: "6px",
      },
      zIndex: 0,
    },
    {
      type: "text",
      quad: textQuad,
      text: "TOP_N",
      style: {
        color: "rgb(36, 41, 46)",
        fontSize: "11.9px",
        fontFamily: "Monaspace Neon, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace",
      },
      zIndex: 1,
    },
  ];
}

function createOversizedPillNodes(): IRNode[] {
  return [{
    type: "polygon",
    points: [
      { x: 10, y: 10 },
      { x: 150, y: 10 },
      { x: 150, y: 45 },
      { x: 10, y: 45 },
    ],
    style: {
      fill: "rgba(255, 255, 255, 0.76)",
      borderRadius: "999px",
    },
    zIndex: 0,
  }];
}

function createOutlinedPillNodes(): IRNode[] {
  return [{
    type: "polygon",
    points: [
      { x: 10, y: 10 },
      { x: 150, y: 10 },
      { x: 150, y: 45 },
      { x: 10, y: 45 },
    ],
    style: {
      fill: "rgba(255, 255, 255, 0.76)",
      borderRadius: "999px",
      outlineColor: "rgb(10, 20, 30)",
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineOffset: "3px",
    },
    zIndex: 0,
  }];
}

test.describe("PDF writer regressions", () => {
  test("preserves rgba fill alpha and fits extracted monospace text widths", async () => {
    const writer = new PDFWriter({ pageWidth: 20, pageHeight: 20 });
    const pdf = await renderIR(createCodeChipNodes(), writer);

    await pdf.finalize();
    const content = Buffer.from(pdf.toBytes()).toString("latin1");

    expect(content).toContain("/ca 0.2");
    expect(content).toContain("TOP_N");
    expect(content).toMatch(/\bTz\b/);
  });

  test("scales oversized pill radii without collapsing rounded rectangles into ellipses", async () => {
    const writer = new PDFWriter({ pageWidth: 60, pageHeight: 60 });
    const pdf = await renderIR(createOversizedPillNodes(), writer);

    await pdf.finalize();
    const content = Buffer.from(pdf.toBytes()).toString("latin1");

    expect(content).toMatch(/20\.625 162\.6 m\s+99\.375 162\.6 l/);
    expect(content).not.toMatch(/59\.0625 162\.6 m\s+59\.0625 162\.6 l/);
  });

  test("emits outline stroke operations for pill shapes", async () => {
    const writer = new PDFWriter({ pageWidth: 60, pageHeight: 60 });
    const pdf = await renderIR(createOutlinedPillNodes(), writer);

    await pdf.finalize();
    const content = Buffer.from(pdf.toBytes()).toString("latin1");

    expect(content).toContain("0.0392 0.0784 0.1176 RG");
    expect(content).toContain("1.5 w");
    expect(content).toMatch(/20\.625 165\.6 m\s+99\.375 165\.6 l/);
  });
});