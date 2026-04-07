import { test } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("diag svg-files", async ({ page }) => {
  const fileUrl = pathToFileURL(path.join(__dirname, "svg-files.html")).href;
  await page.goto(fileUrl, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");

  const { injectBoxQuadsPolyfill, injectLibrary } = await import("../helpers.js");
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  // Test bg-image extraction directly
  const bgTest = await page.evaluate(() => {
    const hc = (window as any).__HC;
    const bgDivs = document.querySelectorAll('div[style*="background-image"]');
    const results: any[] = [];
    for (const div of Array.from(bgDivs).slice(0, 2)) {
      const cs = getComputedStyle(div);
      const style = hc.extractStyle(cs);
      const nodes = hc.extractBackgroundImage(div, style, 0, { includeImages: true, boxType: "border" });
      results.push({ nodeCount: nodes.length, types: nodes.map((n: any) => n.type) });
    }
    return results;
  });
  console.log("BG extraction:", JSON.stringify(bgTest));

  const ir = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    return (window as any).__HC.extractIR(root, {
      includeImages: true,
      includeText: true,
      boxType: "border",
    });
  });

  const types: Record<string, number> = {};
  for (const n of ir as any[]) {
    types[n.type] = (types[n.type] || 0) + 1;
  }
  console.log("IR node types:", JSON.stringify(types));
  console.log("Total:", ir.length);

  const images = (ir as any[]).filter((n: any) => n.type === "image");
  console.log("Images:", images.length);
  for (const img of images) {
    console.log(`  image ${img.width}x${img.height} dataUrl=${img.dataUrl?.substring(0, 60)}...`);
  }
});
