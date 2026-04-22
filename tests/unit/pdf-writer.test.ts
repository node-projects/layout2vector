import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode, Quad } from "../../src/types.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";

const RED_PIXEL_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xFFFFFFFF;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(data.length, 0);

  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 0);

  return Buffer.concat([lengthBytes, typeBytes, Buffer.from(data), crcBytes]);
}

function createTransparentPngDataUrl(): string {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const rawScanlines = Buffer.from([
    0,
    255, 0, 0, 255,
    0, 0, 0, 0,
    0,
    0, 0, 0, 0,
    255, 0, 0, 255,
  ]);
  const idat = deflateSync(rawScanlines);
  const pngBytes = Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${pngBytes.toString("base64")}`;
}

const TRANSPARENT_PIXEL_PNG = createTransparentPngDataUrl();

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

  test("clips rounded images before drawing JPEG XObjects", async () => {
    const writer = new PDFWriter({ pageWidth: 60, pageHeight: 60 });
    const pdf = await renderIR([{
      type: "image",
      quad: [
        { x: 10, y: 10 },
        { x: 42, y: 10 },
        { x: 42, y: 42 },
        { x: 10, y: 42 },
      ],
      dataUrl: RED_PIXEL_JPEG,
      width: 1,
      height: 1,
      style: {
        borderRadius: "50%",
      },
      zIndex: 0,
    } satisfies IRNode], writer);

    await pdf.finalize();
    const ops = ((writer as any).ops as string[]).join("\n");

    expect(ops).toContain("/Im1 Do");
    expect(ops).toContain("W n");
    expect(ops.match(/\bc\b/g)?.length ?? 0).toBe(4);
  });

  test("uses a soft mask for transparent PNG images even when rgbData is present", async () => {
    const writer = new PDFWriter({ pageWidth: 30, pageHeight: 30 });
    const pdf = await renderIR([{
      type: "image",
      quad: [
        { x: 5, y: 5 },
        { x: 21, y: 5 },
        { x: 21, y: 21 },
        { x: 5, y: 21 },
      ],
      dataUrl: TRANSPARENT_PIXEL_PNG,
      width: 2,
      height: 2,
      rgbData: [
        255, 0, 0,
        255, 255, 255,
        255, 255, 255,
        255, 0, 0,
      ],
      style: {},
      zIndex: 0,
    } satisfies IRNode], writer);

    await pdf.finalize();
    const content = Buffer.from(pdf.toBytes()).toString("latin1");

    expect(content).toContain("/SMask");
    expect(content).toContain("/ColorSpace /DeviceGray");
    expect(content.match(/\/Subtype \/Image/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});