import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, "../output");

test("generate HTML and PDF previews", async ({ page }) => {
  test.setTimeout(120000);

  const htmlFiles = fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith("-ir.html"))
    .sort();
  const pdfFiles = fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith(".pdf"))
    .sort();

  expect(htmlFiles.length).toBeGreaterThan(0);
  expect(pdfFiles.length).toBeGreaterThan(0);

  for (const htmlFile of htmlFiles) {
    const name = path.basename(htmlFile, ".html");
    const htmlUrl = pathToFileURL(path.join(outputDir, htmlFile)).href;

    await page.goto(htmlUrl, { waitUntil: "commit" });
    await page.locator("body").waitFor({ state: "attached" });
    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete), { timeout: 10000 });
    await page.waitForFunction(() => {
      const root = document.documentElement;
      if (!root) return false;
      return Math.max(root.clientWidth, root.scrollWidth) > 0 && Math.max(root.clientHeight, root.scrollHeight) > 0;
    }, { timeout: 10000 });

    await page.screenshot({
      path: path.join(outputDir, `${name}-html-preview.png`),
      fullPage: true,
    });
  }

  await import("../../scripts/build-viewer.mjs");

  const viewerUrl = pathToFileURL(path.join(outputDir, "viewer.html")).href;
  await page.goto(viewerUrl);

  // Wait until every embedded PDF rendered into its canvas.
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll("canvas");
    return canvases.length > 0 && Array.from(canvases).every((canvas) => canvas.width > 50);
  }, { timeout: 15000 });

  for (const pdfFile of pdfFiles) {
    const name = path.basename(pdfFile, ".pdf");
    const canvas = page.locator(`#c_${name}`);
    await expect(canvas).toBeVisible();
    await canvas.screenshot({
      path: path.join(outputDir, `${name}-pdf-preview.png`),
    });
  }
});
