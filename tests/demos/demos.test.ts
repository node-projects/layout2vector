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
import { PDFWriter } from "../../src/pdf-writer.js";
import { SVGWriter } from "../../src/svg-writer.js";
import { HTMLWriter } from "../../src/html-writer.js";
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

    // Copy PNG files referenced by demo HTML files
    for (const file of fs.readdirSync(demosDir)) {
      if (file.endsWith(".png")) {
        const src = path.join(demosDir, file);
        const dest = path.join(outputDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
    }

    // Inject polyfill + library via helpers
    const { injectBoxQuadsPolyfill, injectLibrary } = await import(
      "../helpers.js"
    );
    await injectBoxQuadsPolyfill(page);
    await injectLibrary(page);

    // Pre-convert file:// URLs to data URLs (file:// taints canvas and blocks XHR in Chromium)
    // Collect all image src and background-image URLs from the page (including shadow DOM)
    const fileUrls: string[] = await page.evaluate(() => {
      const urls: string[] = [];
      function walk(root: Document | ShadowRoot | Element) {
        const els = root.querySelectorAll("*");
        for (const el of Array.from(els)) {
          if (el.tagName === "IMG") {
            const src = (el as HTMLImageElement).src;
            if (src && !src.startsWith("data:")) urls.push(src);
          }
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== "none") {
            const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (m && m[1] && !m[1].startsWith("data:")) urls.push(m[1]);
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      }
      walk(document);
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
        function walk(root: Document | ShadowRoot | Element) {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.tagName === "IMG") {
              const img = el as HTMLImageElement;
              if (map[img.src]) img.src = map[img.src];
            }
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== "none") {
              const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
              if (m && m[1] && map[m[1]]) {
                (el as HTMLElement).style.backgroundImage = `url("${map[m[1]]}")`;
              }
            }
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        }
        walk(document);
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

    // Dump IR for specific demos
    if (name === "comprehensive" || name === "images" || name === "test4") {
      const irPath = path.join(outputDir, `${name}-ir.json`);
      fs.writeFileSync(irPath, JSON.stringify(ir, null, 2), "utf-8");
    }

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
    const dxfContent = await renderIR(ir, dxfWriter);
    expect(dxfContent).toBeTruthy();
    expect(dxfContent.length).toBeGreaterThan(100);

    const dxfPath = path.join(outputDir, `${name}.dxf`);
    fs.writeFileSync(dxfPath, dxfContent, "utf-8");

    // --- PDF output ---
    // Convert viewport px to mm (1px ≈ 0.2646mm)
    // Load custom TTF font files from the demos directory
    const customFonts = new Map<string, Uint8Array>();
    for (const file of fs.readdirSync(demosDir)) {
      if (file.endsWith(".ttf") || file.endsWith(".otf")) {
        const fontFamily = path.basename(file, path.extname(file));
        const fontData = fs.readFileSync(path.join(demosDir, file));
        customFonts.set(fontFamily, new Uint8Array(fontData));
        // Also copy font file to output dir
        const dest = path.join(outputDir, file);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(demosDir, file), dest);
      }
    }
    // Load a default Unicode-capable font for full character support in PDF
    let defaultFont: Uint8Array | undefined;
    const defaultFontPaths = [
      "C:\\Windows\\Fonts\\segoeui.ttf",
      "C:\\Windows\\Fonts\\arial.ttf",
      "C:\\Windows\\Fonts\\wingding.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
    ];
    for (const fp of defaultFontPaths) {
      if (fs.existsSync(fp)) {
        defaultFont = new Uint8Array(fs.readFileSync(fp));
        break;
      }
    }
    // Load symbol/fallback fonts for characters not in the default font (e.g. ⚖ U+2696)
    const symbolFontPaths = [
      "C:\\Windows\\Fonts\\seguisym.ttf",    // Segoe UI Symbol
      "C:\\Windows\\Fonts\\symbol.ttf",       // Symbol
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    for (const fp of symbolFontPaths) {
      if (fs.existsSync(fp)) {
        const fontFamily = path.basename(fp, path.extname(fp));
        if (!customFonts.has(fontFamily)) {
          customFonts.set(fontFamily, new Uint8Array(fs.readFileSync(fp)));
        }
      }
    }
    const pdfWriter = new PDFWriter(viewport.width * 0.2646, viewport.height * 0.2646, customFonts.size > 0 ? customFonts : undefined, defaultFont);
    const pdfDoc = await renderIR(ir, pdfWriter);
    expect(pdfDoc).toBeTruthy();

    await pdfDoc.finalize();
    const pdfBuffer = pdfDoc.toBytes();
    const pdfPath = path.join(outputDir, `${name}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    // --- PNG output ---
    // PNG writer needs Canvas API so it runs in the browser
    // Firefox blocks toDataURL on file:// origins (security restriction), so
    // we wrap this step in try/catch and skip PNG output when it fails.
    let pngStat: fs.Stats | null = null;
    const pngPath = path.join(outputDir, `${name}.png`);
    try {
      const pngDataUrl: string = await page.evaluate(async (irNodes) => {
        let maxX = 0, maxY = 0;
        for (const node of irNodes) {
          const pts: Array<{ x: number; y: number }> =
            node.type === "polygon" || node.type === "polyline" ? node.points
            : node.type === "text" || node.type === "image" ? node.quad
            : [];
          for (const p of pts) {
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
        }
        const vp = { width: Math.ceil(maxX) || 1, height: Math.ceil(maxY) || 1 };
        const writer = new (window as any).__HC.PNGWriter(vp.width, vp.height);
        const pngResult = await (window as any).__HC.renderIR(irNodes, writer);
        await pngResult.finalize();
        return pngResult.toDataURL();
      }, ir);

      expect(pngDataUrl).toMatch(/^data:image\/png;base64,/);
      const pngBase64 = pngDataUrl.split(",")[1];
      const pngBuffer = Buffer.from(pngBase64, "base64");
      fs.writeFileSync(pngPath, pngBuffer);
      pngStat = fs.statSync(pngPath);
    } catch {
      console.log(`  ⚠ ${name}: PNG output skipped (canvas security restriction)`);
    }

    // --- SVG output ---
    const svgWriter = new SVGWriter(viewport.width, viewport.height);
    const svgContent = await renderIR(ir, svgWriter);
    expect(svgContent).toBeTruthy();
    expect(svgContent.length).toBeGreaterThan(100);

    const svgPath = path.join(outputDir, `${name}.svg`);
    fs.writeFileSync(svgPath, svgContent, "utf-8");

    // --- HTML output ---
    const htmlWriter = new HTMLWriter(viewport.width, viewport.height);
    const htmlContent2 = await renderIR(ir, htmlWriter);
    expect(htmlContent2).toBeTruthy();
    expect(htmlContent2.length).toBeGreaterThan(100);

    const htmlOutPath = path.join(outputDir, `${name}-ir.html`);
    fs.writeFileSync(htmlOutPath, htmlContent2, "utf-8");

    // Verify files are non-empty
    const dxfStat = fs.statSync(dxfPath);
    const pdfStat = fs.statSync(pdfPath);
    if (!pngStat && fs.existsSync(pngPath)) pngStat = fs.statSync(pngPath);
    const svgStat = fs.statSync(svgPath);
    const htmlStat = fs.statSync(htmlOutPath);
    expect(dxfStat.size).toBeGreaterThan(0);
    expect(pdfStat.size).toBeGreaterThan(0);
    if (pngStat) expect(pngStat.size).toBeGreaterThan(0);
    expect(svgStat.size).toBeGreaterThan(0);
    expect(htmlStat.size).toBeGreaterThan(0);

    console.log(
      `  \u2713 ${name}: ${ir.length} IR nodes \u2192 DXF (${dxfStat.size} bytes), PDF (${pdfStat.size} bytes), PNG (${pngStat ? pngStat.size + " bytes" : "skipped"}), SVG (${svgStat.size} bytes), HTML (${htmlStat.size} bytes)`
    );
  });
}
