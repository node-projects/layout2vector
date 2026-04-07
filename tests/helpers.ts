/**
 * Shared test utilities for browser-based tests.
 * Bundles the library source for injection into Playwright pages.
 */
import { type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Read a source file from the src directory. */
function readSrc(filename: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, "..", "src", filename),
    "utf-8"
  );
}

/**
 * Inject the html-converter library into a Playwright page.
 * This bundles all source modules into a single IIFE that exposes
 * window.__HC with the full library API.
 */
export async function injectLibrary(page: Page): Promise<void> {
  // We build a bundle by concatenating the source files in dependency order,
  // stripping imports/exports, and wrapping in an IIFE.

  const typesSource = readSrc("types.ts");
  const traversalSource = readSrc("traversal.ts");
  const htmlExtractorSource = readSrc("html-extractor.ts");
  const svgExtractorSource = readSrc("svg-extractor.ts");
  const pipelineSource = readSrc("pipeline.ts");

  // Strip TypeScript import/export statements and type annotations for browser eval
  function stripTS(source: string): string {
    return source
      // Remove import lines
      .replace(/^import\s+.*$/gm, "")
      // Remove "export " prefix from declarations
      .replace(/^export\s+(type\s+)/gm, "$1")
      .replace(/^export\s+(interface\s+)/gm, "$1")
      .replace(/^export\s+(function\s+)/gm, "function ")
      .replace(/^export\s+(const\s+)/gm, "const ")
      .replace(/^export\s+(class\s+)/gm, "class ")
      .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, "")
      // Remove type-only constructs
      .replace(/^type\s+\w+\s*=\s*[^;]+;$/gm, "")
      .replace(/^interface\s+\w+\s*\{[\s\S]*?^\}/gm, "")
      // Remove type annotations from function params (simple cases)
      .replace(/:\s*(?:IRNode|Style|Options|Quad|Point|StackingNode|Writer<[^>]+>|CSSStyleDeclaration|string|number|boolean|void|Element|Text|SVG\w+)\[\]/g, "")
      .replace(/:\s*(?:IRNode|Style|Options|Quad|Point|StackingNode|Writer<[^>]+>|CSSStyleDeclaration|string|number|boolean|void|Element|Text|DOMMatrix)\s*(?=[,\)\{=])/g, "")
      // Remove return type annotations
      .replace(/\)\s*:\s*(?:IRNode|Style|Options|Quad|Point|StackingNode|void|boolean|string|number|DOMMatrix)\[\]\s*\{/g, ") {")
      .replace(/\)\s*:\s*(?:IRNode|Style|Options|Quad|Point|StackingNode|void|boolean|string|number|DOMMatrix)\s*\{/g, ") {");
  }

  // For browser injection, we'll compile to JS first via tsc and use the dist output
  // Actually, let's use a simpler approach: evaluate JavaScript directly

  // Build the library using tsc output if available, otherwise use stripped TS
  const distDir = path.resolve(__dirname, "..", "dist");

  let script: string;

  if (fs.existsSync(path.join(distDir, "index.js"))) {
    // Use compiled JS from dist
    const files = [
      "types.js",
      "geometry.js",
      "traversal.js",
      "html-extractor.js",
      "svg-extractor.js",
      "image-extractor.js",
      "pipeline.js",
      "png-writer.js",
    ];

    const modules: string[] = [];
    for (const file of files) {
      let content = fs.readFileSync(path.join(distDir, file), "utf-8");
      // Strip ESM imports/exports for browser IIFE
      content = content
        .replace(/^import\s+.*$/gm, "")
        .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, "")
        .replace(/^export\s+/gm, "");
      modules.push(`// --- ${file} ---\n${content}`);
    }

    script = `(function() {
${modules.join("\n\n")}

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
  PNGWriter,
  PNGResult,
};
})();`;
  } else {
    throw new Error(
      "Library must be built before running tests. Run: npm run build"
    );
  }

  await page.addScriptTag({ content: script });
}

/**
 * Inject the getBoxQuads polyfill from 'get-box-quads-polyfill' into the page.
 * Uses addPolyfill(window) as documented.
 * ONLY used in tests — never bundled in production.
 */
export async function injectBoxQuadsPolyfill(page: Page): Promise<void> {
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
