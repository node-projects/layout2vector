import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import { setupPage } from "../helpers.js";

function firstExisting(paths: string[]): string | null {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function loadSystemFontDataUrl(): string | null {
  const filePath = firstExisting([
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
  ]);
  if (!filePath) return null;

  const bytes = fs.readFileSync(filePath);
  return `data:font/ttf;base64,${bytes.toString("base64")}`;
}

const SYSTEM_FONT_DATA_URL = loadSystemFontDataUrl();

function createFontHtml(fontDataUrl: string): string {
  return `<html><head><style>
    @font-face {
      font-family: "HC Test Font";
      src: url("${fontDataUrl}") format("truetype");
      font-style: normal;
      font-weight: 400;
    }
    body { margin: 0; }
    #target {
      margin: 8px;
      color: rgb(12, 34, 56);
      font-family: "HC Test Font", sans-serif;
      font-size: 32px;
      line-height: 1;
    }
  </style></head><body><div id="target">A</div></body></html>`;
}

test.describe("Font assets", () => {
  test("collects used @font-face assets and emits them in HTML and SVG writers", async ({ page }) => {
    test.skip(!SYSTEM_FONT_DATA_URL, "No usable system TTF font found on this machine.");

    await setupPage(page, createFontHtml(SYSTEM_FONT_DATA_URL!));

    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      const target = document.getElementById("target")!;
      const { ir, fontAssets } = await (window as any).__HC.extractIRWithAssets(target, {
        includeFonts: true,
      });

      const htmlWriter = new (window as any).__HC.HTMLWriter({
        width: 64,
        height: 64,
        fontAssets,
        fontMode: { type: "inline" },
      });
      const html = await (window as any).__HC.renderIR(ir, htmlWriter);

      const svgWriter = new (window as any).__HC.SVGWriter({
        width: 64,
        height: 64,
        fontAssets,
        fontMode: { type: "external", basePath: "fonts" },
      });
      const svg = await (window as any).__HC.renderIR(ir, svgWriter);

      return {
        fontCount: fontAssets?.faces?.length ?? 0,
        html,
        svg,
        svgFontFiles: Array.from(svgWriter.fontFiles.keys()),
      };
    });

    expect(result.fontCount).toBeGreaterThan(0);
    expect(result.html).toContain("@font-face");
    expect(result.html).toContain("data:font/ttf;base64,");
    expect(result.svg).toContain("@font-face");
    expect(result.svg).toContain('fonts/font1.ttf');
    expect(result.svgFontFiles).toContain("fonts/font1.ttf");
  });

  test("rasterizes collected webfont text nodes into image IR for unsupported writers", async ({ page }) => {
    test.skip(!SYSTEM_FONT_DATA_URL, "No usable system TTF font found on this machine.");

    await setupPage(page, createFontHtml(SYSTEM_FONT_DATA_URL!));

    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      const target = document.getElementById("target")!;
      const { ir, fontAssets } = await (window as any).__HC.extractIRWithAssets(target, {
        includeFonts: true,
      });
      const rasterized = await (window as any).__HC.rasterizeFontTextNodes(ir, fontAssets);

      return {
        originalTypes: ir.map((node: any) => node.type),
        rasterTypes: rasterized.map((node: any) => node.type),
        imageDataUrl: rasterized.find((node: any) => node.type === "image")?.dataUrl ?? null,
      };
    });

    expect(result.originalTypes).toContain("text");
    expect(result.rasterTypes).toContain("image");
    expect(result.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});