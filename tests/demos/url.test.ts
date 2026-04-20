import { test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  convertPageToAllWriters,
  ensureDirectory,
  getProjectOutputDir,
  outputNameFromUrl,
  sanitizeOutputName,
  stabilizePageForCapture,
} from "./demo-conversion.js";

const requestedUrl = process.env.HTML_CONVERTER_TEST_URL ?? process.env.npm_config_url;
const requestedName = process.env.HTML_CONVERTER_TEST_NAME ?? process.env.npm_config_name;

test("convert url to all writers", async ({ browser, browserName }) => {
  test.skip(
    !requestedUrl,
    "Set HTML_CONVERTER_TEST_URL or run npm run test:url --url=https://example.com",
  );
  test.setTimeout(180_000);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestedUrl!);
  } catch {
    throw new Error(`Invalid HTML_CONVERTER_TEST_URL: ${requestedUrl}`);
  }

  const outputName = sanitizeOutputName(requestedName || outputNameFromUrl(parsedUrl.href));
  const outputDir = path.join(getProjectOutputDir(browserName), "urls", outputName);
  ensureDirectory(outputDir);
  fs.writeFileSync(path.join(outputDir, "source-url.txt"), `${parsedUrl.href}\n`, "utf-8");

  const context = await browser.newContext({
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    await page.goto(parsedUrl.href, { waitUntil: "load", timeout: 120_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await stabilizePageForCapture(page);

    fs.writeFileSync(path.join(outputDir, `${outputName}.html`), await page.content(), "utf-8");

    const summary = await convertPageToAllWriters({
      page,
      name: outputName,
      outputDir,
      convertFormControls: true,
      dumpIR: true,
    });

    console.log(
      `  \u2713 ${parsedUrl.href}: ${summary.irCount} IR nodes \u2192 DXF (${summary.fileSizes.dxf} bytes), PDF (${summary.fileSizes.pdf} bytes), PNG (${summary.fileSizes.png !== null ? summary.fileSizes.png + " bytes" : "skipped"}), SVG (${summary.fileSizes.svg} bytes), HTML (${summary.fileSizes.html} bytes), EMF (${summary.fileSizes.emf} bytes), EMF+ (${summary.fileSizes.emfPlus} bytes), DWG (${summary.fileSizes.dwg} bytes), AcadDXF (${summary.fileSizes.acadDxf} bytes)`
    );
  } finally {
    await context.close();
  }
});