/**
 * Demo conversion tests.
 * Loads each demo HTML file in a real browser, extracts the IR,
 * and converts to both DXF and PDF output files.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

    // Use goto with file URL so relative paths (e.g. img src) resolve correctly
    const fileUrl = pathToFileURL(path.join(demosDir, demoFile)).href;
    await page.goto(fileUrl, { waitUntil: "load" });

    // Copy HTML to output dir (and any referenced subdirectories)
    fs.writeFileSync(path.join(outputDir, demoFile), htmlContent, "utf-8");
    const svgsDir = path.join(demosDir, "svgs");
    const svgsOutDir = path.join(outputDir, "svgs");
    if (fs.existsSync(svgsDir) && !fs.existsSync(svgsOutDir)) {
      fs.cpSync(svgsDir, svgsOutDir, { recursive: true });
    }

    // Inject polyfill + library via helpers
    const { injectBoxQuadsPolyfill, injectLibrary } = await import(
      "../helpers.js"
    );
    await injectBoxQuadsPolyfill(page);
    await injectLibrary(page);

    // Pre-convert file:// URLs to data URLs (file:// taints canvas and blocks XHR in Chromium)
    // Collect all image src and background-image URLs from the page
    const fileUrls: string[] = await page.evaluate(() => {
      const urls: string[] = [];
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (img.src && !img.src.startsWith("data:")) urls.push(img.src);
      }
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") {
          const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (m && m[1] && !m[1].startsWith("data:")) urls.push(m[1]);
        }
      }
      return [...new Set(urls)];
    });
    const dataUrlMap: Record<string, string> = {};
    for (const src of fileUrls) {
      try {
        const filePath = src.startsWith("file:///") ? fileURLToPath(src) : src;
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mime = ext === ".svg" ? "image/svg+xml"
            : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".gif" ? "image/gif" : "image/png";
          dataUrlMap[src] = `data:${mime};base64,${buf.toString("base64")}`;
        }
      } catch { /* skip */ }
    }
    if (Object.keys(dataUrlMap).length > 0) {
      await page.evaluate((map) => {
        // Replace <img> src attributes
        for (const img of Array.from(document.querySelectorAll("img"))) {
          if (map[img.src]) img.src = map[img.src];
        }
        // Replace CSS background-image url() values
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || bg === "none") continue;
          const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (m && m[1] && map[m[1]]) {
            (el as HTMLElement).style.backgroundImage = `url("${map[m[1]]}")`;
          }
        }
      }, dataUrlMap);
    }

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

    // Compute bounding box of all IR nodes to determine output dimensions.
    // Coordinates are root-relative, so the extent of the content defines the viewport.
    let maxX = 0, maxY = 0;
    for (const node of ir) {
      const pts: Array<{ x: number; y: number }> =
        node.type === "polygon" || node.type === "polyline" ? node.points
        : node.type === "text" || node.type === "image" ? node.quad
        : [];
      for (const p of pts) {
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const viewport = { width: Math.ceil(maxX) || 1, height: Math.ceil(maxY) || 1 };

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
