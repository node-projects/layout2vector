import { test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("diag raster bg-image", async ({ page }) => {
  const htmlContent = fs.readFileSync(
    path.join(__dirname, "bg-image-transform.html"), "utf-8"
  );
  await page.setContent(htmlContent, { waitUntil: "load" });

  const { injectBoxQuadsPolyfill, injectLibrary } = await import("../helpers.js");
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  // Check the raster bg-image element specifically
  const info = await page.evaluate(() => {
    const items = document.querySelectorAll('.section');
    const rasterSection = items[items.length - 1]; // last section
    const div = rasterSection?.querySelector('.row .item div:first-child');
    if (!div) return { error: "element not found" };
    const cs = getComputedStyle(div);
    const hc = (window as any).__HC;
    const style = hc.extractStyle(cs);
    return {
      bgImage: cs.backgroundImage?.substring(0, 80),
      styleBgImage: style.backgroundImage?.substring(0, 80),
      hasBg: hc.hasBackgroundImage(style),
      transform: cs.transform,
      rect: div.getBoundingClientRect(),
    };
  });
  console.log("Raster bg element:", JSON.stringify(info, null, 2));

  // Extract full IR and look for image nodes
  const ir = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    return (window as any).__HC.extractIR(root, {
      includeImages: true,
      includeText: true,
      boxType: "border",
    });
  });

  const imageNodes = ir.filter((n: any) => n.type === "image");
  console.log(`Image nodes: ${imageNodes.length}`);
  for (const n of imageNodes) {
    console.log(`  IMAGE ${n.width}x${n.height} quad=[(${n.quad[0].x.toFixed(1)},${n.quad[0].y.toFixed(1)}),(${n.quad[1].x.toFixed(1)},${n.quad[1].y.toFixed(1)}),(${n.quad[2].x.toFixed(1)},${n.quad[2].y.toFixed(1)}),(${n.quad[3].x.toFixed(1)},${n.quad[3].y.toFixed(1)})]`);
  }
});
