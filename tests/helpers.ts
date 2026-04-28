/// <reference types="node" />

/**
 * Shared test utilities for browser-based tests.
 * Bundles the library source for injection into Playwright pages.
 */
import { type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Inject the html-converter library into a Playwright page.
 * This bundles the current source modules into a single IIFE that exposes
 * window.__HC with the browser-facing library API.
 */
export async function injectLibrary(page: Page): Promise<void> {
  const bundleResult = buildSync({
    stdin: {
      contents: `
        import { extractIR, renderIR } from "../src/pipeline.ts";
        import {
          traverseDOM,
          flattenStackingOrder,
          extractStyle,
          isVisible,
          createsStackingContext,
          isSVGElement,
          isSVGRoot,
        } from "../src/traversal.ts";
        import { extractHTMLGeometry } from "../src/extractors/html-extractor.ts";
        import { extractSVGSubtree } from "../src/extractors/svg-extractor.ts";
        import {
          extractImageGeometry,
          isImageElement,
          hasBackgroundImage,
          extractBackgroundImage,
          preloadImages,
        } from "../src/extractors/image-extractor.ts";
        import { isMathMLRoot, isMathMLElement, extractMathMLFeatures } from "../src/extractors/mathml-extractor.ts";
        import { extractPseudoElements, parseCSSContentValue } from "../src/extractors/pseudo-extractor.ts";
        import { CanvasWriter } from "../src/writers/canvas-writer.ts";
        import { ImageWriter, ImageResult } from "../src/writers/image-writer.ts";

        window.__HC = {
          extractIR,
          renderIR,
          traverseDOM,
          flattenStackingOrder,
          extractStyle,
          isVisible,
          createsStackingContext,
          isSVGElement,
          isSVGRoot,
          extractHTMLGeometry,
          extractSVGSubtree,
          extractImageGeometry,
          isImageElement,
          hasBackgroundImage,
          extractBackgroundImage,
          preloadImages,
          isMathMLRoot,
          isMathMLElement,
          extractMathMLFeatures,
          extractPseudoElements,
          parseCSSContentValue,
          CanvasWriter,
          PNGWriter: ImageWriter,
          PNGResult: ImageResult,
          ImageWriter,
          ImageResult,
        };
      `,
      loader: "ts",
      resolveDir: __dirname,
      sourcefile: "inject-library.ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    external: ["@chenglou/pretext"],
  });

  const script = bundleResult.outputFiles[0].text;

  await page.addScriptTag({ content: script });

  // Inject @chenglou/pretext for pretext text measurement mode
  const pretextEntry = path.resolve(
    __dirname, "..", "node_modules", "@chenglou", "pretext", "dist", "layout.js"
  );
  if (fs.existsSync(pretextEntry)) {
    const pretextResult = buildSync({
      entryPoints: [pretextEntry],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__pretextBundle",
      platform: "browser",
    });
    const pretextScript = pretextResult.outputFiles[0].text;
    await page.addScriptTag({
      content: `${pretextScript}\nwindow.__pretext = __pretextBundle;`,
    });
  }
}

/**
 * Inject the getBoxQuads polyfill from 'get-box-quads-polyfill' into the page.
 * Uses addPolyfill(window) as documented.
 * ONLY used in tests — never bundled in production.
 */
export async function injectBoxQuadsPolyfill(page: Page): Promise<void> {
  // Firefox has native getBoxQuads — skip the polyfill
  const browserName = page.context().browser()?.browserType().name();
  if (browserName === "firefox") return;

  // Read the polyfill source from node_modules
  const polyfillPath = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "get-box-quads-polyfill",
    "getBoxQuads.js"
  );

  let polyfillContent = fs.readFileSync(polyfillPath, "utf-8");
  // Strip ESM exports so it works as a plain script
  polyfillContent = polyfillContent.replace(/^export\s+/gm, "");

  // Inject polyfill and call addPolyfill(window)
  await page.addScriptTag({
    content: `${polyfillContent}\naddPolyfill(window);`,
  });
}

/** Set up a page with the library and polyfill injected. */
export async function setupPage(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: "load" });
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);
}
