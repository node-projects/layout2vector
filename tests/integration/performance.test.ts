/**
 * Performance benchmark tests.
 * Measures IR extraction time (browser-side) and export time (Node-side).
 * Run with:  npx playwright test tests/integration/performance.test.ts
 */
import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";
import { DXFWriter } from "../../src/writers/dxf-writer.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode } from "../../src/types.js";

/**
 * Generate a complex HTML page with many elements for benchmarking.
 */
function generateComplexHTML(elementCount: number): string {
  const divs: string[] = [];
  for (let i = 0; i < elementCount; i++) {
    const r = (i * 37) % 256, g = (i * 73) % 256, b = (i * 113) % 256;
    const x = (i % 20) * 50, y = Math.floor(i / 20) * 30;
    divs.push(`<div style="position:absolute;left:${x}px;top:${y}px;width:40px;height:20px;background:rgb(${r},${g},${b});border:1px solid rgb(${b},${r},${g});border-radius:3px;font-size:10px;overflow:hidden;">Item ${i}</div>`);
  }
  return `<html><body style="margin:0;padding:0;">
    <div id="root" style="position:relative;width:1000px;height:${Math.ceil(elementCount / 20) * 30 + 30}px;">
      ${divs.join("\n")}
    </div>
  </body></html>`;
}

/**
 * Generate HTML with SVG content for benchmarking SVG extraction.
 */
function generateSVGHTML(shapeCount: number): string {
  const shapes: string[] = [];
  for (let i = 0; i < shapeCount; i++) {
    const x = (i % 20) * 50 + 5, y = Math.floor(i / 20) * 40 + 5;
    const r = (i * 37) % 256, g = (i * 73) % 256, b = (i * 113) % 256;
    if (i % 3 === 0) {
      shapes.push(`<rect x="${x}" y="${y}" width="30" height="20" fill="rgb(${r},${g},${b})" stroke="rgb(${b},${r},${g})" stroke-width="1"/>`);
    } else if (i % 3 === 1) {
      shapes.push(`<circle cx="${x + 15}" cy="${y + 10}" r="10" fill="rgb(${r},${g},${b})"/>`);
    } else {
      shapes.push(`<path d="M${x},${y + 20} L${x + 15},${y} L${x + 30},${y + 20} Z" fill="rgb(${r},${g},${b})"/>`);
    }
  }
  return `<html><body style="margin:0;">
    <div id="root">
      <svg width="1000" height="${Math.ceil(shapeCount / 20) * 40 + 40}" xmlns="http://www.w3.org/2000/svg">
        ${shapes.join("\n")}
      </svg>
    </div>
  </body></html>`;
}

/**
 * Generate HTML with lots of text for benchmarking text extraction.
 */
function generateTextHTML(paragraphCount: number): string {
  const paras: string[] = [];
  const sampleText = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
  for (let i = 0; i < paragraphCount; i++) {
    paras.push(`<p style="font-size:12px;margin:2px 0;width:400px;">${sampleText} (${i})</p>`);
  }
  return `<html><body style="margin:0;">
    <div id="root" style="width:400px;">
      ${paras.join("\n")}
    </div>
  </body></html>`;
}

const ITERATIONS = 7;
const WARMUP = 2;

function bestOf(times: number[]): number {
  return Math.min(...times.slice(WARMUP));
}

test.describe("Performance benchmarks", () => {

  test("IR extraction: 200 HTML elements", async ({ page }) => {
    await setupPage(page, generateComplexHTML(200));

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const result = await page.evaluate(async () => {
        const el = document.getElementById("root")!;
        const start = performance.now();
        const ir = await (window as any).__HC.extractIR(el, {
          boxType: "border",
          includeText: true,
        });
        const elapsed = performance.now() - start;
        return { elapsed, nodeCount: ir.length };
      });
      times.push(result.elapsed);
      console.log(`  IR extraction iter ${iter + 1}: ${result.elapsed.toFixed(1)}ms (${result.nodeCount} nodes)`);
    }
    const best = bestOf(times);
    console.log(`  IR extraction best: ${best.toFixed(1)}ms`);
  });

  test("IR extraction: 100 SVG shapes", async ({ page }) => {
    await setupPage(page, generateSVGHTML(100));

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const result = await page.evaluate(async () => {
        const el = document.getElementById("root")!;
        const start = performance.now();
        const ir = await (window as any).__HC.extractIR(el, {
          boxType: "border",
          includeText: true,
        });
        const elapsed = performance.now() - start;
        return { elapsed, nodeCount: ir.length };
      });
      times.push(result.elapsed);
      console.log(`  SVG extraction iter ${iter + 1}: ${result.elapsed.toFixed(1)}ms (${result.nodeCount} nodes)`);
    }
    const best = bestOf(times);
    console.log(`  SVG extraction best: ${best.toFixed(1)}ms`);
  });

  test("IR extraction: 100 text paragraphs", async ({ page }) => {
    await setupPage(page, generateTextHTML(100));

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const result = await page.evaluate(async () => {
        const el = document.getElementById("root")!;
        const start = performance.now();
        const ir = await (window as any).__HC.extractIR(el, {
          boxType: "border",
          includeText: true,
        });
        const elapsed = performance.now() - start;
        return { elapsed, nodeCount: ir.length };
      });
      times.push(result.elapsed);
      console.log(`  Text extraction iter ${iter + 1}: ${result.elapsed.toFixed(1)}ms (${result.nodeCount} nodes)`);
    }
    const best = bestOf(times);
    console.log(`  Text extraction best: ${best.toFixed(1)}ms`);
  });

  test("Export: PDF writer with 500 nodes", async ({ page }) => {
    await setupPage(page, generateComplexHTML(200));

    const ir: IRNode[] = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    console.log(`  IR nodes for PDF export: ${ir.length}`);

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const writer = new PDFWriter({ pageWidth: 300, pageHeight: 400 });
      const start = performance.now();
      const doc = await renderIR(ir, writer);
      await doc.finalize();
      const bytes = doc.toBytes();
      const elapsed = performance.now() - start;
      times.push(elapsed);
      console.log(`  PDF export iter ${iter + 1}: ${elapsed.toFixed(1)}ms (${bytes.length} bytes)`);
    }
    const best = bestOf(times);
    console.log(`  PDF export best: ${best.toFixed(1)}ms`);
  });

  test("Export: DXF writer with 500 nodes", async ({ page }) => {
    await setupPage(page, generateComplexHTML(200));

    const ir: IRNode[] = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    console.log(`  IR nodes for DXF export: ${ir.length}`);

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const writer = new DXFWriter({ maxY: 1000 });
      const start = performance.now();
      const dxf = await renderIR(ir, writer);
      const elapsed = performance.now() - start;
      times.push(elapsed);
      console.log(`  DXF export iter ${iter + 1}: ${elapsed.toFixed(1)}ms (${dxf.length} chars)`);
    }
    const best = bestOf(times);
    console.log(`  DXF export best: ${best.toFixed(1)}ms`);
  });

  test("Export: HTML writer with 500 nodes", async ({ page }) => {
    await setupPage(page, generateComplexHTML(200));

    const ir: IRNode[] = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    console.log(`  IR nodes for HTML export: ${ir.length}`);

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const writer = new HTMLWriter({ width: 1000, height: 800 });
      const start = performance.now();
      const html = await renderIR(ir, writer);
      const elapsed = performance.now() - start;
      times.push(elapsed);
      console.log(`  HTML export iter ${iter + 1}: ${elapsed.toFixed(1)}ms (${html.length} chars)`);
    }
    const best = bestOf(times);
    console.log(`  HTML export best: ${best.toFixed(1)}ms`);
  });

  test("Export: SVG writer with 500 nodes", async ({ page }) => {
    await setupPage(page, generateComplexHTML(200));

    const ir: IRNode[] = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    console.log(`  IR nodes for SVG export: ${ir.length}`);

    const times: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const writer = new SVGWriter({ width: 1000, height: 800 });
      const start = performance.now();
      const svg = await renderIR(ir, writer);
      const elapsed = performance.now() - start;
      times.push(elapsed);
      console.log(`  SVG export iter ${iter + 1}: ${elapsed.toFixed(1)}ms (${svg.length} chars)`);
    }
    const best = bestOf(times);
    console.log(`  SVG export best: ${best.toFixed(1)}ms`);
  });
});
