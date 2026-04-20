import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertPageToAllWriters, getProjectOutputDir } from "./demo-conversion.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const demoUrl = pathToFileURL(path.join(__dirname, "video.html")).href;

type ImageNode = {
  type: "image";
  width: number;
  height: number;
  dataUrl: string;
  quad: Array<{ x: number; y: number }>;
};

test("video demo exports the first frame across writers", async ({ page, browserName }) => {
  test.setTimeout(120_000);

  await page.goto(demoUrl, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const state = document.documentElement.dataset.demoReady;
    return state && state !== "pending";
  }, undefined, { timeout: 15_000 });

  const readyState = await page.evaluate(() => document.documentElement.dataset.demoReady);
  expect(readyState).toBe("ready");

  const outputDir = getProjectOutputDir(browserName);
  const summary = await convertPageToAllWriters({
    page,
    name: "video-e2e",
    outputDir,
    dumpIR: true,
  });

  expect(summary.fileSizes.dxf).toBeGreaterThan(100);
  expect(summary.fileSizes.pdf).toBeGreaterThan(100);
  expect(summary.fileSizes.svg).toBeGreaterThan(100);
  expect(summary.fileSizes.html).toBeGreaterThan(100);
  expect(summary.fileSizes.emf).toBeGreaterThan(80);
  expect(summary.fileSizes.emfPlus).toBeGreaterThan(80);
  expect(summary.fileSizes.dwg).toBeGreaterThan(100);
  expect(summary.fileSizes.acadDxf).toBeGreaterThan(100);

  const irPath = path.join(outputDir, "video-e2e-ir.json");
  const ir = JSON.parse(fs.readFileSync(irPath, "utf-8")) as Array<{ type: string }>;
  const imageNodes = ir.filter((node): node is ImageNode => node.type === "image");

  expect(imageNodes).toHaveLength(1);
  expect(imageNodes[0].width).toBeGreaterThan(300);
  expect(imageNodes[0].height).toBeGreaterThan(160);
  expect(imageNodes[0].dataUrl.startsWith("data:image/")).toBeTruthy();
});