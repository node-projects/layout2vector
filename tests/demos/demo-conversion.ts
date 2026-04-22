import { expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { injectBoxQuadsPolyfill, injectLibrary } from "../helpers.js";
import { renderIR } from "../../src/pipeline.js";
import type { IRNode } from "../../src/types.js";
import { DXFWriter } from "../../src/writers/dxf-writer.js";
import { PDFWriter } from "../../src/writers/pdf-writer.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import { EMFWriter } from "../../src/writers/emf-writer.js";
import { EMFPlusWriter } from "../../src/writers/emfplus-writer.js";
import { AcadDXFWriter, DWGWriter } from "../../src/writers/acad-writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const outputRootDir = path.resolve(__dirname, "..", "output");

export interface ConvertPageToAllWritersOptions {
  page: Page;
  name: string;
  outputDir: string;
  convertFormControls?: boolean;
  dumpIR?: boolean;
  fontDirectory?: string;
}

export interface ConversionSummary {
  irCount: number;
  fileSizes: {
    dxf: number;
    pdf: number;
    png: number | null;
    svg: number;
    html: number;
    emf: number;
    emfPlus: number;
    dwg: number;
    acadDxf: number;
  };
  errors: {
    png: string | null;
  };
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDirectory(outputRootDir);

export function getProjectOutputDir(browserName: string): string {
  const projectOutputDir = browserName === "chromium"
    ? outputRootDir
    : path.join(outputRootDir, browserName);
  ensureDirectory(projectOutputDir);
  return projectOutputDir;
}

export function sanitizeOutputName(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return sanitized || "page";
}

const remoteIrImageCache = new Map<string, string | null>();

function guessImageMimeType(url: string): string {
  try {
    const { pathname } = new URL(url);
    const lowerPath = pathname.toLowerCase();
    if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
    if (lowerPath.endsWith(".gif")) return "image/gif";
    if (lowerPath.endsWith(".webp")) return "image/webp";
    if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  } catch {
    // Fall back to PNG below.
  }
  return "image/png";
}

async function resolveRemoteIrImageDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  const cached = remoteIrImageCache.get(url);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      remoteIrImageCache.set(url, null);
      return null;
    }

    const mimeType = (response.headers.get("content-type") || guessImageMimeType(url)).split(";")[0] || guessImageMimeType(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    remoteIrImageCache.set(url, dataUrl);
    return dataUrl;
  } catch {
    remoteIrImageCache.set(url, null);
    return null;
  }
}

async function inlineRemoteIrImages(nodes: IRNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.type !== "image") continue;
    if (node.dataUrl.startsWith("data:")) continue;

    const dataUrl = await resolveRemoteIrImageDataUrl(node.dataUrl);
    if (dataUrl) node.dataUrl = dataUrl;
  }
}

async function waitForDemoReadySignal(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.demoReady;
      return !state || state !== "pending";
    }, undefined, { timeout: 15_000 });
  } catch {
    // Most demos are static and do not provide a readiness signal.
  }
}

export async function stabilizePageForCapture(page: Page): Promise<void> {
  const wasPrepared = await page.evaluate(async () => {
    if ((window as any).__htmlConverterCapturePrepared) return true;
    (window as any).__htmlConverterCapturePrepared = true;

    const waitForFrames = (count: number) => new Promise<void>((resolve) => {
      const step = () => {
        if (count <= 0) {
          resolve();
          return;
        }
        count -= 1;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const maxScrollTop = Math.max(scrollingElement.scrollHeight - window.innerHeight, 0);
    const stepSize = Math.max(Math.floor(window.innerHeight * 0.8), 1);

    for (let top = 0; top < maxScrollTop; top += stepSize) {
      window.scrollTo(0, top);
      await waitForFrames(2);
    }

    window.scrollTo(0, maxScrollTop);
    await waitForFrames(2);
    window.scrollTo(0, 0);
    await waitForFrames(4);
    return false;
  });

  if (wasPrepared) return;

  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(
    () => Array.from(document.images).every((img) => img.complete),
    undefined,
    { timeout: 10_000 },
  ).catch(() => {});
}

export function outputNameFromUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    const pathname = url.pathname === "/" ? "" : url.pathname;
    return sanitizeOutputName(`${url.hostname}${pathname}`);
  } catch {
    return sanitizeOutputName(urlString);
  }
}

function collectNodePoints(node: IRNode): Array<{ x: number; y: number }> {
  if (node.type === "polygon" || node.type === "polyline") {
    return node.points;
  }
  if (node.type === "text" || node.type === "image") {
    return node.quad;
  }

  return [];
}

function computeIrBounds(ir: IRNode[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;

  for (const node of ir) {
    for (const point of collectNodePoints(node)) {
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  return {
    width: Math.ceil(maxX) || 1,
    height: Math.ceil(maxY) || 1,
  };
}

function loadPdfFonts(fontDirectory?: string): {
  customFonts: Map<string, Uint8Array>;
  defaultFont: Uint8Array | undefined;
} {
  const customFonts = new Map<string, Uint8Array>();

  if (fontDirectory && fs.existsSync(fontDirectory)) {
    for (const file of fs.readdirSync(fontDirectory)) {
      if (file.endsWith(".ttf") || file.endsWith(".otf")) {
        const fontFamily = path.basename(file, path.extname(file));
        const fontData = fs.readFileSync(path.join(fontDirectory, file));
        customFonts.set(fontFamily, new Uint8Array(fontData));
      }
    }
  }

  let defaultFont: Uint8Array | undefined;
  const defaultFontPaths = [
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\wingding.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
  ];
  for (const filePath of defaultFontPaths) {
    if (fs.existsSync(filePath)) {
      defaultFont = new Uint8Array(fs.readFileSync(filePath));
      break;
    }
  }

  const symbolFontPaths = [
    "C:\\Windows\\Fonts\\seguisym.ttf",
    "C:\\Windows\\Fonts\\symbol.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
  const wingdingsPaths = [
    "C:\\Windows\\Fonts\\wingding.ttf",
    "C:\\Windows\\Fonts\\WINGDING.TTF",
  ];
  for (const filePath of wingdingsPaths) {
    if (fs.existsSync(filePath) && !customFonts.has("wingdings")) {
      customFonts.set("wingdings", new Uint8Array(fs.readFileSync(filePath)));
      break;
    }
  }
  for (const filePath of symbolFontPaths) {
    if (fs.existsSync(filePath)) {
      const fontFamily = path.basename(filePath, path.extname(filePath));
      if (!customFonts.has(fontFamily)) {
        customFonts.set(fontFamily, new Uint8Array(fs.readFileSync(filePath)));
      }
    }
  }

  return { customFonts, defaultFont };
}

async function inlineLocalFileAssets(page: Page): Promise<void> {
  const fileUrls: string[] = await page.evaluate(() => {
    const urls: string[] = [];

    function walk(root: Document | ShadowRoot | Element) {
      const elements = root.querySelectorAll("*");
      for (const element of Array.from(elements)) {
        if (element.tagName === "IMG") {
          const src = (element as HTMLImageElement).src;
          if (src && !src.startsWith("data:")) {
            urls.push(src);
          }
        }
        const backgroundImage = getComputedStyle(element).backgroundImage;
        if (backgroundImage && backgroundImage !== "none") {
          const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
          if (match?.[1] && !match[1].startsWith("data:")) {
            urls.push(match[1]);
          }
        }
        if (element.shadowRoot) {
          walk(element.shadowRoot);
        }
      }
    }

    walk(document);
    return [...new Set(urls)];
  });

  const dataUrlMap: Record<string, string> = {};
  for (const src of fileUrls) {
    try {
      const filePath = src.startsWith("file:///") ? fileURLToPath(src) : src;
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = extension === ".svg" ? "image/svg+xml"
          : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
          : extension === ".gif" ? "image/gif"
          : "image/png";
        dataUrlMap[src] = `data:${mimeType};base64,${buffer.toString("base64")}`;
      }
    } catch {
      // Ignore non-local URLs that cannot be inlined from disk.
    }
  }

  if (Object.keys(dataUrlMap).length === 0) {
    return;
  }

  await page.evaluate((map) => {
    function walk(root: Document | ShadowRoot | Element) {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (element.tagName === "IMG") {
          const image = element as HTMLImageElement;
          if (map[image.src]) {
            image.src = map[image.src];
          }
        }

        const backgroundImage = getComputedStyle(element).backgroundImage;
        if (backgroundImage && backgroundImage !== "none") {
          const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
          if (match?.[1] && map[match[1]]) {
            (element as HTMLElement).style.backgroundImage = `url("${map[match[1]]}")`;
          }
        }

        if (element.shadowRoot) {
          walk(element.shadowRoot);
        }
      }
    }

    walk(document);
  }, dataUrlMap);
}

export async function convertPageToAllWriters(options: ConvertPageToAllWritersOptions): Promise<ConversionSummary> {
  const {
    page,
    name,
    outputDir,
    convertFormControls = false,
    dumpIR = false,
    fontDirectory,
  } = options;

  ensureDirectory(outputDir);

  await waitForDemoReadySignal(page);
  await stabilizePageForCapture(page);

  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  const walkIframes = await page.evaluate(() => document.querySelector("iframe") !== null);
  await inlineLocalFileAssets(page);

  const ir: IRNode[] = await page.evaluate(({ shouldConvertFormControls, shouldWalkIframes, shouldIncludeSourceMetadata }) => {
    const root = document.getElementById("root") ?? document.body;
    return (window as any).__HC.extractIR(root, {
      boxType: "border",
      includeText: true,
      includeImages: true,
      includeVideos: true,
      includeSourceMetadata: shouldIncludeSourceMetadata,
      convertFormControls: shouldConvertFormControls,
      walkIframes: shouldWalkIframes,
      textMeasurement: "auto",
    });
  }, {
    shouldConvertFormControls: convertFormControls,
    shouldWalkIframes: walkIframes,
    shouldIncludeSourceMetadata: dumpIR,
  });
  expect(ir.length).toBeGreaterThan(0);

  await inlineRemoteIrImages(ir);

  if (dumpIR) {
    fs.writeFileSync(path.join(outputDir, `${name}-ir.json`), JSON.stringify(ir, null, 2), "utf-8");
  }

  const viewport = await page.evaluate(() => {
    const root = document.getElementById("root") ?? document.body;
    const rootElement = root as Element & {
      getBoxQuads?: (options?: { box?: "border" | "content" }) => DOMQuad[];
    };

    const quads = rootElement.getBoxQuads?.({ box: "border" }) ?? [];
    if (quads.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const quad of quads) {
        for (const point of [quad.p1, quad.p2, quad.p3, quad.p4]) {
          if (point.x < minX) minX = point.x;
          if (point.y < minY) minY = point.y;
          if (point.x > maxX) maxX = point.x;
          if (point.y > maxY) maxY = point.y;
        }
      }

      const width = Math.ceil(Math.max(maxX - minX, root.scrollWidth, root.clientWidth));
      const height = Math.ceil(Math.max(maxY - minY, root.scrollHeight, root.clientHeight));
      return {
        width: width || 1,
        height: height || 1,
      };
    }

    const rect = root.getBoundingClientRect();
    return {
      width: Math.ceil(Math.max(rect.width, root.scrollWidth, root.clientWidth)) || 1,
      height: Math.ceil(Math.max(rect.height, root.scrollHeight, root.clientHeight)) || 1,
    };
  });

  const irBounds = computeIrBounds(ir);
  if (viewport.width <= 1 && irBounds.width > 0) viewport.width = irBounds.width;
  if (viewport.height <= 1 && irBounds.height > 0) viewport.height = irBounds.height;

  const dxfWriter = new DXFWriter(viewport.height);
  const dxfContent = await renderIR(ir, dxfWriter);
  expect(dxfContent).toBeTruthy();
  expect(dxfContent.length).toBeGreaterThan(100);
  const dxfPath = path.join(outputDir, `${name}.dxf`);
  fs.writeFileSync(dxfPath, dxfContent, "utf-8");

  for (const [relativePath, imageDataUrl] of dxfWriter.imageFiles) {
    const imagePath = path.join(outputDir, relativePath);
    ensureDirectory(path.dirname(imagePath));
    const base64Match = imageDataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (base64Match) {
      fs.writeFileSync(imagePath, Buffer.from(base64Match[1], "base64"));
    }
  }

  const { customFonts, defaultFont } = loadPdfFonts(fontDirectory);
  const pdfWriter = new PDFWriter(
    viewport.width * 0.2646,
    viewport.height * 0.2646,
    customFonts.size > 0 ? customFonts : undefined,
    defaultFont,
  );
  const pdfDoc = await renderIR(ir, pdfWriter);
  expect(pdfDoc).toBeTruthy();
  await pdfDoc.finalize();
  const pdfPath = path.join(outputDir, `${name}.pdf`);
  fs.writeFileSync(pdfPath, pdfDoc.toBytes());

  let pngSize: number | null = null;
  let pngError: string | null = null;
  const pngPath = path.join(outputDir, `${name}.png`);
  try {
    const pngDataUrl: string = await page.evaluate(async ({ irNodes, viewportSize }) => {
      const writer = new (window as any).__HC.PNGWriter(viewportSize.width, viewportSize.height);
      const pngResult = await (window as any).__HC.renderIR(irNodes, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    }, {
      irNodes: ir,
      viewportSize: viewport,
    });

    expect(pngDataUrl).toMatch(/^data:image\/png;base64,/);
    const pngBase64 = pngDataUrl.split(",")[1];
    fs.writeFileSync(pngPath, Buffer.from(pngBase64, "base64"));
    pngSize = fs.statSync(pngPath).size;
  } catch (error) {
    // PNG output can still be blocked by browser canvas security rules.
    pngError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    fs.writeFileSync(path.join(outputDir, `${name}-png-error.txt`), `${pngError}\n`, "utf-8");
  }

  const svgWriter = new SVGWriter(viewport.width, viewport.height);
  const svgContent = await renderIR(ir, svgWriter);
  expect(svgContent).toBeTruthy();
  expect(svgContent.length).toBeGreaterThan(100);
  const svgPath = path.join(outputDir, `${name}.svg`);
  fs.writeFileSync(svgPath, svgContent, "utf-8");

  const htmlWriter = new HTMLWriter(viewport.width, viewport.height);
  const htmlContent = await renderIR(ir, htmlWriter);
  expect(htmlContent).toBeTruthy();
  expect(htmlContent.length).toBeGreaterThan(100);
  const htmlPath = path.join(outputDir, `${name}-ir.html`);
  fs.writeFileSync(htmlPath, htmlContent, "utf-8");

  const emfWriter = new EMFWriter({ width: viewport.width, height: viewport.height });
  const emfBytes = await renderIR(ir, emfWriter);
  expect(emfBytes).toBeInstanceOf(Uint8Array);
  expect(emfBytes.length).toBeGreaterThan(80);
  const emfPath = path.join(outputDir, `${name}.emf`);
  fs.writeFileSync(emfPath, emfBytes);

  const emfPlusWriter = new EMFPlusWriter({ width: viewport.width, height: viewport.height });
  const emfPlusBytes = await renderIR(ir, emfPlusWriter);
  expect(emfPlusBytes).toBeInstanceOf(Uint8Array);
  expect(emfPlusBytes.length).toBeGreaterThan(80);
  const emfPlusPath = path.join(outputDir, `${name}-emfplus.emf`);
  fs.writeFileSync(emfPlusPath, emfPlusBytes);

  const dwgWriter = new DWGWriter({ maxY: viewport.height });
  const dwgBytes = await renderIR(ir, dwgWriter);
  expect(dwgBytes).toBeInstanceOf(Uint8Array);
  expect(dwgBytes.length).toBeGreaterThan(100);
  const dwgPath = path.join(outputDir, `${name}.dwg`);
  fs.writeFileSync(dwgPath, dwgBytes);

  const acadDxfWriter = new AcadDXFWriter({ maxY: viewport.height });
  const acadDxfBytes = await renderIR(ir, acadDxfWriter);
  expect(acadDxfBytes).toBeInstanceOf(Uint8Array);
  expect(acadDxfBytes.length).toBeGreaterThan(100);
  const acadDxfPath = path.join(outputDir, `${name}-acad.dxf`);
  fs.writeFileSync(acadDxfPath, acadDxfBytes);

  const dxfSize = fs.statSync(dxfPath).size;
  const pdfSize = fs.statSync(pdfPath).size;
  const svgSize = fs.statSync(svgPath).size;
  const htmlSize = fs.statSync(htmlPath).size;
  const emfSize = fs.statSync(emfPath).size;
  const emfPlusSize = fs.statSync(emfPlusPath).size;
  const dwgSize = fs.statSync(dwgPath).size;
  const acadDxfSize = fs.statSync(acadDxfPath).size;

  expect(dxfSize).toBeGreaterThan(0);
  expect(pdfSize).toBeGreaterThan(0);
  if (pngSize !== null) expect(pngSize).toBeGreaterThan(0);
  expect(svgSize).toBeGreaterThan(0);
  expect(htmlSize).toBeGreaterThan(0);
  expect(emfSize).toBeGreaterThan(0);
  expect(emfPlusSize).toBeGreaterThan(0);
  expect(dwgSize).toBeGreaterThan(0);
  expect(acadDxfSize).toBeGreaterThan(0);

  return {
    irCount: ir.length,
    fileSizes: {
      dxf: dxfSize,
      pdf: pdfSize,
      png: pngSize,
      svg: svgSize,
      html: htmlSize,
      emf: emfSize,
      emfPlus: emfPlusSize,
      dwg: dwgSize,
      acadDxf: acadDxfSize,
    },
    errors: {
      png: pngError,
    },
  };
}