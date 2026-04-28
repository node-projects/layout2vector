/**
 * Demo conversion tests.
 * Loads each demo HTML file in a real browser, extracts the IR,
 * and converts to both DXF and PDF output files.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertPageToAllWriters, getProjectOutputDir } from "./demo-conversion.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const demosDir = path.resolve(__dirname, "..", "demos");

// Discover all demo HTML files
const demoFiles = fs
  .readdirSync(demosDir)
  .filter((f) => f.endsWith(".html"))
  .sort();

for (const demoFile of demoFiles) {
  const name = path.basename(demoFile, ".html");
  const convertFormControls = name === "form-controls" || name === "form2" || name === "github" || name === "google" || name === "test8";
  const isolateRemoteRuntime = name === "bild";
  const isRemoteHeavyDemo = name === "bild" || name === "github";
  const walkIframes = name === "bild" ? false : undefined;

  test(`convert demo: ${name}`, async ({ page, browserName }) => {
    const timeoutMs = isRemoteHeavyDemo
      ? browserName === "firefox"
        ? name === "bild"
          ? 420_000
          : 240_000
        : name === "bild"
          ? 300_000
          : 180_000
      : 120_000;
    // Complex pages with large remote-backed fixtures need more time,
    // especially on Firefox which loads resources differently.
    test.setTimeout(timeoutMs);

    const projectOutputDir = getProjectOutputDir(browserName);

    // Load demo HTML
    const htmlContent = fs.readFileSync(
      path.join(demosDir, demoFile),
      "utf-8"
    );

    // Use goto with file URL so relative paths (e.g. img src) resolve correctly
    const fileUrl = pathToFileURL(path.join(demosDir, demoFile)).href;
    if (isolateRemoteRuntime) {
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = request.url();
        const isRemote = /^https?:/i.test(url);
        const isRemoteSubframe = request.isNavigationRequest()
          && request.frame() !== page.mainFrame()
          && isRemote;
        const isRemoteScript = isRemote
          && (request.resourceType() === "script"
            || request.resourceType() === "fetch"
            || request.resourceType() === "xhr"
            || /\.m?js(?:[?#].*)?$/i.test(url));

        if (isRemoteSubframe || isRemoteScript) {
          await route.abort();
          return;
        }

        await route.continue();
      });
    }
    await page.goto(fileUrl, { waitUntil: "load" });

    // Copy HTML to output dir (and any referenced subdirectories)
    fs.writeFileSync(path.join(projectOutputDir, demoFile), htmlContent, "utf-8");
    const svgsDir = path.join(demosDir, "svgs");
    const svgsOutDir = path.join(projectOutputDir, "svgs");
    if (fs.existsSync(svgsDir) && !fs.existsSync(svgsOutDir)) {
      fs.cpSync(svgsDir, svgsOutDir, { recursive: true });
    }

    // Copy PNG files referenced by demo HTML files
    for (const file of fs.readdirSync(demosDir)) {
      if (file.endsWith(".png")) {
        const src = path.join(demosDir, file);
        const dest = path.join(projectOutputDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
    }

    for (const file of fs.readdirSync(demosDir)) {
      if (file.endsWith(".ttf") || file.endsWith(".otf")) {
        const src = path.join(demosDir, file);
        const dest = path.join(projectOutputDir, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
    }

    const summary = await convertPageToAllWriters({
      page,
      name,
      outputDir: projectOutputDir,
      convertFormControls,
      walkIframes,
      skipPng: name === "bild" && browserName === "firefox",
      dumpIR: name === "comprehensive" || name === "images" || name === "test4" || name === "github" || name === "github-glow",
      fontDirectory: demosDir,
    });

    console.log(
      `  \u2713 ${name}: ${summary.irCount} IR nodes \u2192 DXF (${summary.fileSizes.dxf} bytes), PDF (${summary.fileSizes.pdf} bytes), PNG (${summary.fileSizes.png !== null ? summary.fileSizes.png + " bytes" : "skipped"}), SVG (${summary.fileSizes.svg} bytes), HTML (${summary.fileSizes.html} bytes), EMF (${summary.fileSizes.emf} bytes), EMF+ (${summary.fileSizes.emfPlus} bytes), DWG (${summary.fileSizes.dwg} bytes), AcadDXF (${summary.fileSizes.acadDxf} bytes)`
    );
  });
}
