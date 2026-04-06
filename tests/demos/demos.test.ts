/**
 * Demo conversion tests.
 * Loads each demo HTML file in a real browser, extracts the IR,
 * and converts to both DXF and PDF output files.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setupPage } from "../helpers.js";
import { DXFWriter } from "../../src/dxf-writer.js";
import { PDFWriter } from "../../src/pdflite-writer.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode } from "../../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const demosDir = path.resolve(__dirname, "..", "demos");
const outputDir = path.resolve(__dirname, "..", "output");

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Discover all demo HTML files
const demoFiles = fs
  .readdirSync(demosDir)
  .filter((f) => f.endsWith(".html"))
  .sort();

for (const demoFile of demoFiles) {
  const name = path.basename(demoFile, ".html");

  test(`convert demo: ${name}`, async ({ page }) => {
    // Load demo HTML
    const htmlContent = fs.readFileSync(
      path.join(demosDir, demoFile),
      "utf-8"
    );

    await page.setContent(htmlContent, { waitUntil: "load" });

    // Copy HTML to output dir
    fs.writeFileSync(path.join(outputDir, demoFile), htmlContent, "utf-8");

    // Inject polyfill + library via helpers
    const { injectBoxQuadsPolyfill, injectLibrary } = await import(
      "../helpers.js"
    );
    await injectBoxQuadsPolyfill(page);
    await injectLibrary(page);

    // Extract IR in the browser
    const ir: IRNode[] = await page.evaluate(() => {
      const root = document.getElementById("root") ?? document.body;
      return (window as any).__HC.extractIR(root, {
        boxType: "border",
        includeText: true,
        includeImages: true,
      });
    });

    expect(ir.length).toBeGreaterThan(0);

    // Get page dimensions for DXF Y-flip
    const viewport = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    // --- DXF output ---
    const dxfWriter = new DXFWriter(viewport.height);
    const dxfContent = renderIR(ir, dxfWriter);
    expect(dxfContent).toBeTruthy();
    expect(dxfContent.length).toBeGreaterThan(100);

    const dxfPath = path.join(outputDir, `${name}.dxf`);
    fs.writeFileSync(dxfPath, dxfContent, "utf-8");

    // --- PDF output ---
    // Convert viewport px to mm (1px ≈ 0.2646mm)
    const pdfWriter = new PDFWriter(viewport.width * 0.2646, viewport.height * 0.2646);
    const pdfDoc = renderIR(ir, pdfWriter);
    expect(pdfDoc).toBeTruthy();

    await pdfDoc.finalize();
    const pdfBuffer = pdfDoc.toBytes();
    const pdfPath = path.join(outputDir, `${name}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Verify files are non-empty
    const dxfStat = fs.statSync(dxfPath);
    const pdfStat = fs.statSync(pdfPath);
    expect(dxfStat.size).toBeGreaterThan(0);
    expect(pdfStat.size).toBeGreaterThan(0);

    console.log(
      `  ✓ ${name}: ${ir.length} IR nodes → DXF (${dxfStat.size} bytes), PDF (${pdfStat.size} bytes)`
    );
  });
}
