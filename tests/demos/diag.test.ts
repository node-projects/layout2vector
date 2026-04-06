/**
 * Diagnostic: dump IR nodes for a demo file to understand what's being extracted.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { injectBoxQuadsPolyfill, injectLibrary } from "../helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("dump comprehensive IR", async ({ page }) => {
  const htmlContent = fs.readFileSync(
    path.resolve(__dirname, "..", "demos", "comprehensive.html"),
    "utf-8"
  );
  await page.setContent(htmlContent, { waitUntil: "load" });
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  const ir = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    return (window as any).__HC.extractIR(root, {
      boxType: "border",
      includeText: true,
    });
  });

  // Dump to file
  const output = JSON.stringify(ir, null, 2);
  fs.writeFileSync(
    path.resolve(__dirname, "..", "output", "comprehensive-ir.json"),
    output
  );

  console.log(`Total IR nodes: ${ir.length}`);
  for (const node of ir) {
    if (node.type === "text") {
      console.log(`  TEXT: "${node.text.substring(0, 60)}" fill=${node.style.fill} color=${node.style.color}`);
    } else if (node.type === "polygon") {
      const p = node.points;
      const w = Math.abs(p[1].x - p[0].x).toFixed(0);
      const h = Math.abs(p[3].y - p[0].y).toFixed(0);
      console.log(`  POLYGON: ${w}x${h} at (${p[0].x.toFixed(0)},${p[0].y.toFixed(0)}) fill=${node.style.fill} stroke=${node.style.stroke} borderRadius=${node.style.borderRadius}`);
    } else if (node.type === "polyline") {
      console.log(`  POLYLINE: ${node.points.length} pts closed=${node.closed} fill=${node.style.fill} stroke=${node.style.stroke}`);
    }
  }
});
