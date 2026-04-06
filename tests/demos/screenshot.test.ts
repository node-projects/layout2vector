import { test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("screenshot comprehensive PDF", async ({ page }) => {
  const viewerPath = path.resolve(__dirname, "../output/viewer.html");
  await page.goto(`file://${viewerPath}`);
  // Wait for all PDFs to render
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll("canvas");
    return Array.from(canvases).every(c => c.width > 50);
  }, { timeout: 15000 });

  // Screenshot each PDF section
  const names = ["borders", "comprehensive", "stacking", "svg"];
  for (const name of names) {
    const canvas = page.locator(`#c_${name}`);
    await canvas.screenshot({ path: path.resolve(__dirname, `../output/${name}-screenshot.png`) });
    console.log(`Saved ${name}-screenshot.png`);
  }
});
