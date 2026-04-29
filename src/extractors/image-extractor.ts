/**
 * Image and video element extraction.
 * Handles <img> tags: simple SVG images may be converted to vector geometry,
 * while effected/clipped SVGs and raster images are embedded as image nodes.
 */
import type { Quad, IRNode, Options, Style } from "../types.js";
import { extractSVGSubtree } from "./svg-extractor.js";
import { getElementQuad } from "../geometry.js";
import { inflateZlibSync } from "../shared/zlib-inflate.js";

/**
 * Cache for image rasterization results, keyed by source URL + dimensions.
 * Avoids re-rasterizing the same image when multiple elements reference it.
 * Cleared at the start of each extractIR() run.
 */
const imageDataCache = new Map<string, { dataUrl: string; rgbData?: number[] } | null>();

/** Cache for decoded SVG content strings, keyed by source URL. */
const svgContentCache = new Map<string, string | null>();

/** Cache for parsed intrinsic SVG sizes used during raster fallback. */
const svgIntrinsicSizeCache = new Map<string, { width: number; height: number } | null>();

/** Pre-fetched image elements for canvas drawing (keyed by original src URL). */
const preloadedImageElems = new Map<string, HTMLImageElement>();
/** Pre-fetched URL mappings: original URL → data URL. Populated by preloadImages without modifying the page. */
const preloadedUrlMap = new Map<string, string>();
/** In-flight async image loads keyed by the source/cache slot they populate. */
const imageLoadTasks = new Map<string, Promise<void>>();
const PRELOAD_CONCURRENCY = 8;
const IMAGE_FETCH_TIMEOUT_MS = 12000;
const IMAGE_DECODE_TIMEOUT_MS = 8000;
const VIDEO_READY_TIMEOUT_MS = 8000;
const VIDEO_SEEK_TIMEOUT_MS = 3000;

/** Clear the image rasterization cache. Called at the start of each extraction run. */
export function clearImageCache(): void {
  imageDataCache.clear();
  svgContentCache.clear();
  svgIntrinsicSizeCache.clear();
  preloadedImageElems.clear();
  preloadedUrlMap.clear();
  imageLoadTasks.clear();
}

/** Check if an element is an <img> element. */
export function isImageElement(el: Element): el is HTMLImageElement {
  return el.tagName.toLowerCase() === "img";
}

/** Check if an element is a <canvas> element. */
export function isCanvasElement(el: Element): el is HTMLCanvasElement {
  return el.tagName.toLowerCase() === "canvas";
}

/** Check if an element is a <video> element. */
export function isVideoElement(el: Element): el is HTMLVideoElement {
  return el.tagName.toLowerCase() === "video";
}

/**
 * Pre-fetch all external image URLs under a root into internal caches.
 * This enables extractIR() to embed images that are loaded from cross-origin
 * or file:// URLs without tainting the canvas.
 * Does NOT modify the page DOM — all results are stored in module-level caches.
 * Called automatically by extractIR() when includeImages is true.
 */
export async function preloadImages(root: Element): Promise<void> {
  // Collect all elements including those inside shadow DOM
  const allElements: Element[] = [];
  function walkDOM(node: Element | ShadowRoot | Document) {
    const els = node.querySelectorAll("*");
    for (const el of Array.from(els)) {
      allElements.push(el);
      if (el.shadowRoot) walkDOM(el.shadowRoot);
    }
  }
  walkDOM(root.shadowRoot ?? root);
  // Include root itself
  allElements.unshift(root);

  const imageSources = new Set<string>();
  const cssImageUrls = new Set<string>();

  // Pre-fetch <img> elements — populate caches without modifying the DOM
  for (const el of allElements) {
    if (el.tagName !== "IMG") continue;
    const img = el as HTMLImageElement;
    const src = img.currentSrc || img.src;
    if (!src) continue;
    imageSources.add(src);
  }

  // Pre-fetch CSS images (backgrounds, masks, and pseudo-element assets).
  for (const el of allElements) {
    for (const cs of getPreloadableStyles(el)) {
      for (const url of collectCssImageUrls(cs)) {
        cssImageUrls.add(url);
      }
    }
  }

  await Promise.all([
    mapWithConcurrency([...imageSources], PRELOAD_CONCURRENCY, ensureImageElementSourceReady),
    mapWithConcurrency([...cssImageUrls], PRELOAD_CONCURRENCY, preloadCssImageUrl),
  ]);
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
}

function getConfiguredTimeout(name: string, fallbackMs: number): number {
  const configured = (globalThis as Record<string, unknown>)[name];
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : fallbackMs;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function runImageLoadTask(key: string, load: () => Promise<void>): Promise<void> {
  const existing = imageLoadTasks.get(key);
  if (existing) return existing;

  const task = load().finally(() => {
    imageLoadTasks.delete(key);
  });
  imageLoadTasks.set(key, task);
  return task;
}

async function waitForImageDecode(img: HTMLImageElement): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutId = globalThis.setTimeout(() => {
      finishReject(new Error("image load timed out"));
    }, getConfiguredTimeout("__HC_IMAGE_DECODE_TIMEOUT_MS", IMAGE_DECODE_TIMEOUT_MS));

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onLoad = () => {
      finishResolve();
    };
    const onError = () => {
      finishReject(new Error("load failed"));
    };

    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);

    if (img.complete) {
      if (img.naturalWidth > 0) {
        finishResolve();
      } else {
        finishReject(new Error("load failed"));
      }
      return;
    }

    try {
      void img.decode().then(() => {
        if (img.naturalWidth > 0) finishResolve();
      }).catch(() => {
        // Some browsers reject decode() while still dispatching load/error events.
      });
    } catch {
      // Ignore decode() availability/usage errors and rely on events + timeout.
    }
  });
}

async function createDecodedImage(src: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = src;
    await waitForImageDecode(img);
    return img;
  } catch {
    return null;
  }
}

async function fetchExternalImageDataUrl(url: string): Promise<string | null> {
  const cached = preloadedUrlMap.get(url);
  if (cached?.startsWith("data:image/")) return cached;

  try {
    const resp = await fetchWithTimeout(
      url,
      getConfiguredTimeout("__HC_IMAGE_FETCH_TIMEOUT_MS", IMAGE_FETCH_TIMEOUT_MS),
      {
        redirect: "follow",
      }
    );
    if (!resp.ok) return null;
    const blob = await resp.blob();
    let dataUrl = await blobToDataUrl(blob);
    if (!dataUrl.startsWith("data:image/svg+xml") && isSvgUrl(url)) {
      const raw = await blob.text();
      if (raw.includes("<svg")) {
        dataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(raw)));
      }
    }
    return dataUrl;
  } catch {
    return null;
  }
}

async function ensureImageElementSourceReady(src: string): Promise<void> {
  if (!src) return;

  if (src.startsWith("data:")) {
    if (!src.startsWith("data:image/") || preloadedImageElems.has(src)) return;

    await runImageLoadTask(`img-data:${src}`, async () => {
      if (preloadedImageElems.has(src)) return;
      const decoded = await createDecodedImage(src);
      if (decoded) preloadedImageElems.set(src, decoded);
    });
    return;
  }

  if (preloadedImageElems.has(src) && preloadedUrlMap.has(src)) return;

  await runImageLoadTask(`img:${src}`, async () => {
    if (preloadedImageElems.has(src) && preloadedUrlMap.has(src)) return;

    const dataUrl = preloadedUrlMap.get(src) ?? await fetchExternalImageDataUrl(src);
    if (!dataUrl) return;

    preloadedUrlMap.set(src, dataUrl);
    const decoded = await createDecodedImage(dataUrl);
    if (!decoded) return;

    preloadedImageElems.set(src, decoded);
    if (!preloadedImageElems.has(dataUrl)) {
      preloadedImageElems.set(dataUrl, decoded);
    }
  });
}

function getPreloadableStyles(el: Element): CSSStyleDeclaration[] {
  const styles = [getComputedStyle(el)];
  for (const pseudo of ["::before", "::after"] as const) {
    try {
      styles.push(getComputedStyle(el, pseudo));
    } catch {
      // Ignore pseudo-style lookup failures for unusual or disconnected nodes.
    }
  }
  return styles;
}

function collectCssImageUrls(cs: CSSStyleDeclaration): string[] {
  const urls = new Set<string>();
  for (const value of [
    cs.backgroundImage,
    cs.getPropertyValue("mask-image"),
    cs.getPropertyValue("-webkit-mask-image"),
  ]) {
    if (!value || value === "none") continue;
    const url = extractCssUrlValue(value);
    if (url) urls.add(url);
  }
  return [...urls];
}

async function preloadCssImageUrl(url: string): Promise<void> {
  if (!url) return;

  if (url.startsWith("data:")) {
    if (!url.startsWith("data:image/")) return;
    if (preloadedImageElems.has(url)) return;

    await runImageLoadTask(`css-data:${url}`, async () => {
      if (preloadedImageElems.has(url)) return;
      const decoded = await createDecodedImage(url);
      if (decoded) preloadedImageElems.set(url, decoded);
    });
    return;
  }

  const cachedUrl = preloadedUrlMap.get(url);
  if (cachedUrl) {
    if (cachedUrl.startsWith("data:image/") && !preloadedImageElems.has(cachedUrl)) {
      await runImageLoadTask(`css-decoded:${cachedUrl}`, async () => {
        if (preloadedImageElems.has(cachedUrl)) return;
        const decoded = await createDecodedImage(cachedUrl);
        if (decoded) preloadedImageElems.set(cachedUrl, decoded);
      });
    }
    return;
  }

  await runImageLoadTask(`css:${url}`, async () => {
    if (preloadedUrlMap.has(url)) return;

    const dataUrl = await fetchExternalImageDataUrl(url);
    if (!dataUrl) return;

    preloadedUrlMap.set(url, dataUrl);
    if (!dataUrl.startsWith("data:image/")) return;

    const decoded = await createDecodedImage(dataUrl);
    if (decoded) preloadedImageElems.set(dataUrl, decoded);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function extractCssUrlValue(value: string): string | null {
  const urlIndex = value.search(/url\s*\(/i);
  if (urlIndex < 0) return null;

  let index = value.indexOf("(", urlIndex) + 1;
  while (index < value.length && /\s/.test(value[index])) index++;
  if (index >= value.length) return null;

  const quote = value[index] === '"' || value[index] === "'" ? value[index++] : null;
  let result = "";
  let escaped = false;

  for (; index < value.length; index++) {
    const ch = value[index];
    if (escaped) {
      result += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote ? ch === quote : ch === ")") {
      return decodeCssEscapes(result.trim());
    }
    result += ch;
  }

  return null;
}

/** Check if an element has a CSS background-image with a url(). */
export function hasBackgroundImage(style: Style): boolean {
  const bg = style.backgroundImage;
  if (!bg || bg === "none") return false;
  return /url\s*\(/.test(bg);
}

/**
 * Extract a background-image url() as an image IR node.
 * Rasterizes the element's background to a canvas to capture the rendered result.
 */
export async function extractBackgroundImage(
  el: Element,
  style: Style,
  globalIndex: number,
  _options: Options
): Promise<IRNode[]> {
  const bg = style.backgroundImage;
  if (!bg || bg === "none") return [];

  const parsedUrl = extractCssUrlValue(bg);
  if (!parsedUrl) return [];

  await preloadCssImageUrl(parsedUrl);

  const quad = getElementQuad(el);
  if (!quad) return [];

  // Use untransformed dimensions for the image's natural size
  const htmlEl = el as HTMLElement;
  const w = htmlEl.offsetWidth || Math.abs(quad[1].x - quad[0].x);
  const h = htmlEl.offsetHeight || Math.abs(quad[3].y - quad[0].y);

  let url = parsedUrl;
  const originalUrl = url;
  const preferVectorSvg = !requiresRasterSvgImage(style);

  // Resolve from preloaded cache (external URLs fetched during preloadImages)
  const cachedUrl = preloadedUrlMap.get(url);
  if (cachedUrl) url = cachedUrl;

  // If it's already a data URL, try to rasterize directly
  if (url.startsWith("data:")) {
    // For SVG data URLs, try vector extraction first
    if (preferVectorSvg && url.startsWith("data:image/svg+xml")) {
      const svgContent = decodeBgSvgDataUrl(url);
      if (svgContent) {
        const svgNodes = convertBgSvgToGeometry(svgContent, el, quad, globalIndex, _options);
        if (svgNodes.length > 0) return svgNodes;
      }
    }
    // The original URL may be an SVG but the MIME was wrong in the data URL.
    // Check if the original URL looks like an SVG and try to extract content.
    if (preferVectorSvg && !url.startsWith("data:image/svg+xml") && isSvgSource(originalUrl)) {
      const svgContent = decodeBgSvgDataUrl(url) ?? extractSvgContent(originalUrl);
      if (svgContent && svgContent.includes("<svg")) {
        const svgNodes = convertBgSvgToGeometry(svgContent, el, quad, globalIndex, _options);
        if (svgNodes.length > 0) return svgNodes;
      }
    }
    if (url.startsWith("data:image/")) {
      const imageScale = _options.imageScale ?? 1;
      const rw = Math.min(Math.round(w * imageScale), 4096);
      const rh = Math.min(Math.round(h * imageScale), 4096);
      const rendered = renderBackgroundImage(el, url, rw, rh);
      if (!rendered) return [];
      return [{
        type: "image",
        quad,
        dataUrl: rendered.dataUrl,
        width: rw,
        height: rh,
        rgbData: rendered.rgbData,
        style,
        zIndex: globalIndex,
      }];
    }
  }

  // For external SVG URLs, try vector conversion first
  if (preferVectorSvg && (isSvgSource(url) || isSvgSource(originalUrl))) {
    const svgContent = extractSvgContent(url) ?? extractSvgContent(originalUrl);
    if (svgContent) {
      const svgNodes = convertBgSvgToGeometry(svgContent, el, quad, globalIndex, _options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize below
  }

  // For external URLs, rasterize via canvas using a temporary img element
  const imageScale = _options.imageScale ?? 1;
  const rasterW = Math.min(Math.round(w * imageScale), 4096);
  const rasterH = Math.min(Math.round(h * imageScale), 4096);
  const rendered = renderBackgroundImage(el, url, rasterW, rasterH);
  if (!rendered) return [];

  return [{
    type: "image",
    quad,
    dataUrl: rendered.dataUrl,
    width: rasterW,
    height: rasterH,
    rgbData: rendered.rgbData,
    style,
    zIndex: globalIndex,
  }];
}

export async function extractMaskedElementImage(
  el: Element,
  style: Style,
  globalIndex: number,
  options: Options
): Promise<IRNode[]> {
  const quad = getElementQuad(el);
  if (!quad) return [];

  const htmlEl = el as HTMLElement;
  const displayWidth = htmlEl.offsetWidth || Math.abs(quad[1].x - quad[0].x);
  const displayHeight = htmlEl.offsetHeight || Math.abs(quad[3].y - quad[0].y);
  if (displayWidth <= 0 || displayHeight <= 0) return [];

  const imageScale = options.imageScale ?? 1;
  const rasterWidth = Math.min(Math.round(displayWidth * imageScale), 4096);
  const rasterHeight = Math.min(Math.round(displayHeight * imageScale), 4096);
  const rendered = await renderMaskedElement(el, style, rasterWidth, rasterHeight);
  if (!rendered) return [];

  return [{
    type: "image",
    quad,
    dataUrl: rendered.dataUrl,
    width: rasterWidth,
    height: rasterHeight,
    rgbData: rendered.rgbData,
    style: getRasterizedMaskStyle(style),
    zIndex: globalIndex,
  }];
}

function getRasterizedMaskStyle(style: Style): Style {
  return {
    ...style,
    mask: undefined,
    backgroundImage: undefined,
  };
}

/**
 * Render a raster data URL onto a canvas (with nearest-neighbor scaling).
 * Returns a PNG data URL and optional raw RGB pixel data for lossless PDF embedding.
 */
function rasterToRendered(dataUrl: string, w: number, h: number): { dataUrl: string; rgbData?: number[] } | null {
  const cacheKey = `raster|${dataUrl.length}|${w}|${h}|${dataUrl.slice(0, 100)}`;
  const cached = imageDataCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = rasterToRenderedUncached(dataUrl, w, h);
  imageDataCache.set(cacheKey, result);
  return result;
}

type RasterInspection = {
  hasVisibleContent: boolean;
  hasTransparency: boolean;
  rgbData?: number[];
};

function inspectRasterImageData(imageData: ImageData, includeRgbData: boolean): RasterInspection {
  const rgba = imageData.data;
  const rgbData = includeRgbData ? new Array((rgba.length / 4) * 3) : undefined;
  let hasVisibleContent = false;
  let hasTransparency = false;

  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const alpha = rgba[i + 3];
    if (alpha > 0) hasVisibleContent = true;
    if (alpha < 255) hasTransparency = true;

    if (rgbData) {
      const opacity = alpha / 255;
      rgbData[j] = Math.round(rgba[i] * opacity + 255 * (1 - opacity));
      rgbData[j + 1] = Math.round(rgba[i + 1] * opacity + 255 * (1 - opacity));
      rgbData[j + 2] = Math.round(rgba[i + 2] * opacity + 255 * (1 - opacity));
    }
  }

  return { hasVisibleContent, hasTransparency, rgbData };
}

function rasterToRenderedUncached(dataUrl: string, w: number, h: number): { dataUrl: string; rgbData?: number[] } | null {
  try {
    // Use pre-decoded Image from preloadImages if available (ensures synchronous decode)
    const preloaded = preloadedImageElems.get(dataUrl);
    const img = preloaded ?? new Image();
    if (!preloaded) img.src = dataUrl;
    if (!img.complete || img.naturalWidth === 0) return null;

    // If JPEG and already at target size, use as-is (avoid re-encoding)
    if (dataUrl.startsWith("data:image/jpeg") && img.naturalWidth === w && img.naturalHeight === h) {
      return { dataUrl };
    }

    const canvas = document.createElement("canvas");
    canvas.width = w || img.naturalWidth || 1;
    canvas.height = h || img.naturalHeight || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    // Draw without white background to preserve transparency for SVG/HTML/PNG output
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngUrl = canvas.toDataURL("image/png");

    // Extract raw RGB for PDF embedding (alpha-blend onto white since PDF doesn't support alpha)
    const pixels = canvas.width * canvas.height;
    if (pixels <= 250000) {
      const inspection = inspectRasterImageData(ctx.getImageData(0, 0, canvas.width, canvas.height), true);
      return { dataUrl: pngUrl, rgbData: inspection.rgbData };
    }
    return { dataUrl: pngUrl };
  } catch {
    return null;
  }
}

function renderDataUrlWithSampling(
  dataUrl: string,
  w: number,
  h: number,
  disableSmoothing: boolean,
  sourceRect?: { x: number; y: number; width: number; height: number }
): { dataUrl: string; rgbData?: number[] } | null {
  try {
    const img = new Image();
    img.src = dataUrl;
    if (!img.complete || img.naturalWidth === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    if (disableSmoothing) ctx.imageSmoothingEnabled = false;
    drawObjectFitImage(ctx, img, w, h, sourceRect);

    const pixels = w * h;
    const inspection = inspectRasterImageData(ctx.getImageData(0, 0, w, h), pixels <= 250000);
    if (!inspection.hasVisibleContent) return null;

    const preserveTransparency = inspection.hasTransparency;
    const preserveLossless = preserveTransparency || disableSmoothing;
    return {
      dataUrl: preserveLossless ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92),
      rgbData: inspection.rgbData,
    };
  } catch {
    return null;
  }
}

/** Decode SVG content from a background-image data URL. */
function decodeBgSvgDataUrl(dataUrl: string): string | null {
  try {
    if (dataUrl.includes(";base64,")) {
      const base64 = dataUrl.split(";base64,")[1];
      return atob(base64);
    }
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex >= 0) {
      return decodeSvgDataPayload(dataUrl.slice(commaIndex + 1));
    }
  } catch {
    // Decode error
  }
  return null;
}

function decodeSvgDataPayload(payload: string): string {
  const cssDecoded = decodeCssEscapes(payload);
  try {
    return decodeURIComponent(cssDecoded);
  } catch {
    return cssDecoded;
  }
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \n\r\t\f])?/g, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/\\(.)/g, "$1");
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("%")) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSvgViewBoxSize(value: string | null): { width: number; height: number } | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  const width = parts[2];
  const height = parts[3];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function resolveSvgRasterSourceSize(src: string, boxWidth: number, boxHeight: number): { width: number; height: number } | null {
  const cacheKey = `${src}|${Math.round(boxWidth)}|${Math.round(boxHeight)}`;
  const cached = svgIntrinsicSizeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const svgContent = extractSvgContent(src);
  if (!svgContent) {
    svgIntrinsicSizeCache.set(cacheKey, null);
    return null;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(stripXmlPreamble(svgContent), "image/svg+xml");
    const parsedSvg = doc.documentElement;
    if (parsedSvg.tagName.toLowerCase() !== "svg" || parsedSvg.querySelector("parsererror")) {
      svgIntrinsicSizeCache.set(cacheKey, null);
      return null;
    }

    const widthAttr = parsedSvg.getAttribute("width")?.trim() ?? null;
    const heightAttr = parsedSvg.getAttribute("height")?.trim() ?? null;
    const viewBox = parseSvgViewBoxSize(parsedSvg.getAttribute("viewBox"));

    let result: { width: number; height: number } | null = null;
    if (widthAttr?.endsWith("%") && heightAttr?.endsWith("%")) {
      result = {
        width: Math.max(boxWidth, 1),
        height: Math.max(boxHeight, 1),
      };
    } else {
      const width = parseSvgLength(widthAttr);
      const height = parseSvgLength(heightAttr);
      if (width && height) {
        result = { width, height };
      } else if (viewBox && width) {
        result = { width, height: width * (viewBox.height / viewBox.width) };
      } else if (viewBox && height) {
        result = { width: height * (viewBox.width / viewBox.height), height };
      } else if (viewBox) {
        result = viewBox;
      }
    }

    svgIntrinsicSizeCache.set(cacheKey, result);
    return result;
  } catch {
    svgIntrinsicSizeCache.set(cacheKey, null);
    return null;
  }
}


/**
 * Remap points extracted from a temp SVG at (0,0,w,h) into the actual
 * element's screen quad using an affine transform.
 */
function remapIRNodes(nodes: IRNode[], w: number, h: number, targetQuad: Quad): void {
  // Affine mapping: normalized (u,v) in [0..1] → target quad
  // x' = tl.x + u * (tr.x - tl.x) + v * (bl.x - tl.x)
  // y' = tl.y + u * (tr.y - tl.y) + v * (bl.y - tl.y)
  const [tl, tr, _br, bl] = targetQuad;
  const dxU = tr.x - tl.x, dyU = tr.y - tl.y;
  const dxV = bl.x - tl.x, dyV = bl.y - tl.y;

  function remap(p: { x: number; y: number }): { x: number; y: number } {
    const u = w > 0 ? p.x / w : 0;
    const v = h > 0 ? p.y / h : 0;
    return {
      x: tl.x + u * dxU + v * dxV,
      y: tl.y + u * dyU + v * dyV,
    };
  }

  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        node.points = node.points.map(remap) as Quad;
        break;
      case "polyline":
        if (node.style.pathSubpaths?.length) {
          node.style.pathSubpaths = node.style.pathSubpaths.map((subpath) => ({
            ...subpath,
            points: subpath.points.map(remap),
          }));
          node.points = node.style.pathSubpaths.flatMap((subpath) => subpath.points);
        } else {
          node.points = node.points.map(remap);
        }
        break;
      case "text":
        node.quad = node.quad.map(remap) as Quad;
        break;
      case "image":
        node.quad = node.quad.map(remap) as Quad;
        break;
    }
  }
}

/** Strip XML declaration and DOCTYPE which cause DOMParser errors. */
function stripXmlPreamble(svg: string): string {
  return svg.replace(/<\?xml[^?]*\?>\s*/g, "").replace(/<!DOCTYPE[^>]*>\s*/g, "");
}

/**
 * Check if an SVG element tree uses fill-rule:evenodd anywhere.
 * Polyline sampling cannot represent sub-path boundaries needed for evenodd,
 * so these SVGs must be rasterized instead of vectorized.
 */
function usesEvenOddFillRule(svgEl: Element): boolean {
  // Check individual descendant elements for explicit fill-rule:evenodd.
  for (const el of Array.from(svgEl.querySelectorAll("*"))) {
    if (el.getAttribute("fill-rule") === "evenodd") return true;
    const style = el.getAttribute("style") ?? "";
    if (/fill-rule\s*:\s*evenodd/i.test(style)) return true;
  }

  // The root SVG's style may set fill-rule:evenodd as a CSS cascade default
  // (common in Serif Affinity/Illustrator exports). This only matters when
  // there are <path> elements with multiple subpaths (multiple M commands),
  // where the winding rule changes which regions are "inside". Simple shapes
  // (rect, ellipse, single-subpath paths) render identically with either rule.
  const rootStyle = svgEl.getAttribute("style") ?? "";
  if (/fill-rule\s*:\s*evenodd/i.test(rootStyle)) {
    for (const pathEl of Array.from(svgEl.querySelectorAll("path"))) {
      const d = pathEl.getAttribute("d") ?? "";
      const mCount = (d.match(/[Mm]/g) || []).length;
      if (mCount > 1) return true;
    }
  }
  return false;
}

/** Convert background SVG to vector geometry. */
function convertBgSvgToGeometry(
  svgContent: string,
  el: Element,
  targetQuad: Quad,
  globalIndex: number,
  options: Options
): IRNode[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(stripXmlPreamble(svgContent), "image/svg+xml");
  const parsedSvg = doc.documentElement;

  if (parsedSvg.tagName.toLowerCase() !== "svg") return [];
  if (parsedSvg.querySelector("parsererror")) return [];
  // SVGs with fill-rule:evenodd can't be accurately represented as polylines
  // unless the user explicitly opts in via svgToVector
  if (!options.svgToVector && usesEvenOddFillRule(parsedSvg)) return [];

  const tempSvg = document.importNode(parsedSvg, true) as unknown as SVGSVGElement;

  for (const script of Array.from(tempSvg.querySelectorAll("script"))) {
    script.remove();
  }
  for (const child of Array.from(tempSvg.querySelectorAll("*"))) {
    for (const attr of Array.from(child.attributes)) {
      if (attr.name.startsWith("on")) child.removeAttribute(attr.name);
    }
  }

  // Place temp SVG at (0,0) with the element's untransformed dimensions.
  // No CSS transform — we'll remap the extracted points to the target quad afterwards.
  const htmlEl = el as HTMLElement;
  const w = htmlEl.offsetWidth || Math.abs(targetQuad[1].x - targetQuad[0].x);
  const h = htmlEl.offsetHeight || Math.abs(targetQuad[3].y - targetQuad[0].y);

  tempSvg.style.position = "fixed";
  tempSvg.style.left = "0px";
  tempSvg.style.top = "0px";
  tempSvg.style.width = `${w}px`;
  tempSvg.style.height = `${h}px`;
  tempSvg.style.margin = "0";
  tempSvg.style.padding = "0";

  document.body.appendChild(tempSvg);

  try {
    const svgNodes = extractSVGSubtree(tempSvg, globalIndex, options);
    // Remap from temp SVG coord space (0,0,w,h) to the actual element's screen quad
    remapIRNodes(svgNodes, w, h, targetQuad);
    return svgNodes;
  } finally {
    document.body.removeChild(tempSvg);
  }
}

type BackgroundRepeatMode = {
  repeatX: boolean;
  repeatY: boolean;
};

type BackgroundPositionSpec = {
  type: "percent" | "px";
  value: number;
};

function renderBackgroundImage(
  el: Element,
  url: string,
  elWidth: number,
  elHeight: number
): { dataUrl: string; rgbData?: number[] } | null {
  const w = Math.round(elWidth) || 1;
  const h = Math.round(elHeight) || 1;
  const cs = getComputedStyle(el);
  const repeat = (cs.backgroundRepeat || "repeat").split(",")[0]?.trim().toLowerCase() || "repeat";
  const size = (cs.backgroundSize || "auto").split(",")[0]?.trim().toLowerCase() || "auto";
  const position = (cs.backgroundPosition || "0% 0%").split(",")[0]?.trim().toLowerCase() || "0% 0%";
  const attachment = (cs.backgroundAttachment || "scroll").split(",")[0]?.trim().toLowerCase() || "scroll";
  const cacheKey = `bgRender|${url.length}|${w}|${h}|${repeat}|${size}|${position}|${attachment}|${url.slice(0, 100)}`;
  const cached = imageDataCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = renderBackgroundImageUncached(el, url, w, h, repeat, size, position, attachment);
  imageDataCache.set(cacheKey, result);
  return result;
}

function parseBackgroundRepeat(value: string): BackgroundRepeatMode {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { repeatX: true, repeatY: true };

  const parseAxis = (token: string): boolean => token !== "no-repeat";

  if (tokens.length === 1) {
    switch (tokens[0]) {
      case "repeat-x":
        return { repeatX: true, repeatY: false };
      case "repeat-y":
        return { repeatX: false, repeatY: true };
      case "no-repeat":
        return { repeatX: false, repeatY: false };
      default:
        return { repeatX: true, repeatY: true };
    }
  }

  return {
    repeatX: parseAxis(tokens[0]),
    repeatY: parseAxis(tokens[1]),
  };
}

function parseBackgroundLengthToken(token: string | undefined, reference: number, scale: number): number | null {
  if (!token || token === "auto") return null;
  if (token.endsWith("%")) {
    const percentage = parseFloat(token);
    return Number.isFinite(percentage) ? (reference * percentage) / 100 : null;
  }
  const value = parseFloat(token);
  return Number.isFinite(value) ? value * scale : null;
}

function resolveBackgroundSize(
  value: string,
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
  scaleX: number,
  scaleY: number
): { width: number; height: number } {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens[0] === "auto" && (tokens[1] === undefined || tokens[1] === "auto"))) {
    return { width: imageWidth * scaleX, height: imageHeight * scaleY };
  }

  if (tokens[0] === "cover" || tokens[0] === "contain") {
    const scaledImageWidth = imageWidth * scaleX;
    const scaledImageHeight = imageHeight * scaleY;
    const scale = tokens[0] === "cover"
      ? Math.max(boxWidth / Math.max(scaledImageWidth, 1), boxHeight / Math.max(scaledImageHeight, 1))
      : Math.min(boxWidth / Math.max(scaledImageWidth, 1), boxHeight / Math.max(scaledImageHeight, 1));
    return {
      width: Math.max(1, scaledImageWidth * scale),
      height: Math.max(1, scaledImageHeight * scale),
    };
  }

  const resolvedWidth = parseBackgroundLengthToken(tokens[0], boxWidth, scaleX);
  const resolvedHeight = parseBackgroundLengthToken(tokens[1] ?? "auto", boxHeight, scaleY);
  const scaledImageWidth = imageWidth * scaleX;
  const scaledImageHeight = imageHeight * scaleY;

  if (resolvedWidth == null && resolvedHeight == null) {
    return { width: scaledImageWidth, height: scaledImageHeight };
  }
  if (resolvedWidth == null) {
    const height = Math.max(1, resolvedHeight ?? scaledImageHeight);
    const factor = scaledImageHeight > 0 ? height / scaledImageHeight : 1;
    return { width: Math.max(1, scaledImageWidth * factor), height };
  }
  if (resolvedHeight == null) {
    const width = Math.max(1, resolvedWidth);
    const factor = scaledImageWidth > 0 ? width / scaledImageWidth : 1;
    return { width, height: Math.max(1, scaledImageHeight * factor) };
  }

  return {
    width: Math.max(1, resolvedWidth),
    height: Math.max(1, resolvedHeight),
  };
}

function parseBackgroundPositionToken(token: string | undefined, axis: "x" | "y"): BackgroundPositionSpec {
  if (!token) return { type: "percent", value: axis === "x" ? 0 : 0 };

  switch (token) {
    case "left":
    case "top":
      return { type: "percent", value: 0 };
    case "center":
      return { type: "percent", value: 0.5 };
    case "right":
    case "bottom":
      return { type: "percent", value: 1 };
  }

  if (token.endsWith("%")) {
    const percentage = parseFloat(token);
    return { type: "percent", value: Number.isFinite(percentage) ? percentage / 100 : 0 };
  }

  const value = parseFloat(token);
  return { type: "px", value: Number.isFinite(value) ? value : 0 };
}

function resolveBackgroundPosition(value: string): { x: BackgroundPositionSpec; y: BackgroundPositionSpec } {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return {
      x: { type: "percent", value: 0 },
      y: { type: "percent", value: 0 },
    };
  }

  if (tokens.length === 1) {
    const token = tokens[0];
    if (token === "top" || token === "bottom") {
      return {
        x: { type: "percent", value: 0.5 },
        y: parseBackgroundPositionToken(token, "y"),
      };
    }
    return {
      x: parseBackgroundPositionToken(token, "x"),
      y: { type: "percent", value: 0.5 },
    };
  }

  return {
    x: parseBackgroundPositionToken(tokens[0], "x"),
    y: parseBackgroundPositionToken(tokens[1], "y"),
  };
}

function resolveBackgroundOffset(spec: BackgroundPositionSpec, boxSize: number, tileSize: number, scale: number): number {
  if (spec.type === "percent") return (boxSize - tileSize) * spec.value;
  return spec.value * scale;
}

function getRepeatStart(offset: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return offset;
  const remainder = offset % step;
  return remainder <= 0 ? remainder : remainder - step;
}

function renderBackgroundImageUncached(
  el: Element,
  url: string,
  w: number,
  h: number,
  repeatValue: string,
  sizeValue: string,
  positionValue: string,
  attachmentValue: string
): { dataUrl: string; rgbData?: number[] } | null {
  try {
    let source: CanvasImageSource | null = null;
    let sourceWidth = 0;
    let sourceHeight = 0;
    const htmlEl = el as HTMLElement;
    const cssBoxWidth = htmlEl.offsetWidth || w;
    const cssBoxHeight = htmlEl.offsetHeight || h;

    if (url.startsWith("data:image/png")) {
      const decoded = decodePngDataUrl(url);
      if (decoded) {
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = decoded.width;
        tmpCanvas.height = decoded.height;
        const tmpCtx = tmpCanvas.getContext("2d");
        if (tmpCtx) {
          const imgData = tmpCtx.createImageData(decoded.width, decoded.height);
          imgData.data.set(decoded.rgba);
          tmpCtx.putImageData(imgData, 0, 0);
          source = tmpCanvas;
          sourceWidth = decoded.width;
          sourceHeight = decoded.height;
        }
      }
    }

    if (!source) {
      const preloaded = preloadedImageElems.get(url);
      const img = preloaded ?? new Image();
      if (!preloaded) img.src = url;
      source = img;
      sourceWidth = img.naturalWidth || 0;
      sourceHeight = img.naturalHeight || 0;
      if (!sourceWidth || !sourceHeight || !img.complete) return null;
    }

    const svgSourceSize = resolveSvgRasterSourceSize(url, cssBoxWidth, cssBoxHeight);
    if (svgSourceSize) {
      sourceWidth = svgSourceSize.width;
      sourceHeight = svgSourceSize.height;
    }

    if (!source || sourceWidth === 0 || sourceHeight === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    
    const imageRendering = getComputedStyle(el).imageRendering || "";
    const isPixelated = imageRendering === "pixelated"
      || imageRendering === "crisp-edges"
      || imageRendering === "-moz-crisp-edges";
    const isSmallSource = sourceWidth > 0 && sourceHeight > 0 && (sourceWidth <= 16 || sourceHeight <= 16);
    const disableSmoothing = isPixelated || isSmallSource || w <= 16 || h <= 16;
    if (disableSmoothing) {
      ctx.imageSmoothingEnabled = false;
    }

    const scaleX = cssBoxWidth > 0 ? w / cssBoxWidth : 1;
    const scaleY = cssBoxHeight > 0 ? h / cssBoxHeight : 1;
    const repeat = parseBackgroundRepeat(repeatValue);
    const backgroundSize = resolveBackgroundSize(sizeValue, sourceWidth, sourceHeight, w, h, scaleX, scaleY);
    const position = resolveBackgroundPosition(positionValue);

    let offsetX = resolveBackgroundOffset(position.x, w, backgroundSize.width, scaleX);
    let offsetY = resolveBackgroundOffset(position.y, h, backgroundSize.height, scaleY);

    if (attachmentValue === "fixed") {
      const rect = el.getBoundingClientRect();
      offsetX -= rect.left * scaleX;
      offsetY -= rect.top * scaleY;
    }

    const xPositions = repeat.repeatX
      ? (() => {
        const positions: number[] = [];
        for (let x = getRepeatStart(offsetX, backgroundSize.width); x < w; x += backgroundSize.width) {
          positions.push(x);
        }
        return positions;
      })()
      : [offsetX];

    const yPositions = repeat.repeatY
      ? (() => {
        const positions: number[] = [];
        for (let y = getRepeatStart(offsetY, backgroundSize.height); y < h; y += backgroundSize.height) {
          positions.push(y);
        }
        return positions;
      })()
      : [offsetY];

    for (const y of yPositions) {
      for (const x of xPositions) {
        ctx.drawImage(source, x, y, backgroundSize.width, backgroundSize.height);
      }
    }

    const pixels = w * h;
    const inspection = inspectRasterImageData(ctx.getImageData(0, 0, w, h), pixels <= 250000);
    if (!inspection.hasVisibleContent) return null;

    const preserveTransparency = inspection.hasTransparency;
    const preserveRepeatedPattern = (repeat.repeatX || repeat.repeatY)
      && backgroundSize.width <= 64
      && backgroundSize.height <= 64;
    const preserveLossless = preserveTransparency || disableSmoothing || preserveRepeatedPattern;
    return {
      dataUrl: preserveLossless ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92),
      rgbData: inspection.rgbData,
    };
  } catch {
    return null;
  }
}

async function renderMaskedElement(
  el: Element,
  style: Style,
  w: number,
  h: number
): Promise<{ dataUrl: string; rgbData?: number[] } | null> {
  try {
    const cs = getComputedStyle(el);
    const maskImageValue = cs.getPropertyValue("mask-image") || cs.getPropertyValue("-webkit-mask-image") || "";
    if (!maskImageValue || maskImageValue === "none") return null;

    const maskSource = extractCssUrlValue(maskImageValue);
    if (!maskSource) return null;

    await preloadCssImageUrl(maskSource);

    const fillColor = resolveMaskFillColor(style, cs);
    if (!fillColor) return null;

    const resolvedSource = preloadedUrlMap.get(maskSource) ?? maskSource;
    const sizeValue = cs.getPropertyValue("mask-size") || cs.getPropertyValue("-webkit-mask-size") || "auto";
    const positionValue = cs.getPropertyValue("mask-position") || cs.getPropertyValue("-webkit-mask-position") || "50% 50%";
    const repeatValue = cs.getPropertyValue("mask-repeat") || cs.getPropertyValue("-webkit-mask-repeat") || "repeat";
    const attachmentValue = cs.getPropertyValue("mask-attachment") || cs.getPropertyValue("-webkit-mask-attachment") || "scroll";

    const htmlEl = el as HTMLElement;
    const cssBoxWidth = htmlEl.offsetWidth || w;
    const cssBoxHeight = htmlEl.offsetHeight || h;

    const preloaded = preloadedImageElems.get(resolvedSource);
    const img = preloaded ?? new Image();
    if (!preloaded) img.src = resolvedSource;
    if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return null;

    let sourceWidth = img.naturalWidth;
    let sourceHeight = img.naturalHeight;
    const svgSourceSize = resolveSvgRasterSourceSize(resolvedSource, cssBoxWidth, cssBoxHeight);
    if (svgSourceSize) {
      sourceWidth = svgSourceSize.width;
      sourceHeight = svgSourceSize.height;
    }
    if (sourceWidth === 0 || sourceHeight === 0) return null;

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = w;
    maskCanvas.height = h;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return null;

    const scaleX = cssBoxWidth > 0 ? w / cssBoxWidth : 1;
    const scaleY = cssBoxHeight > 0 ? h / cssBoxHeight : 1;
    const repeat = parseBackgroundRepeat(repeatValue);
    const maskSize = resolveBackgroundSize(sizeValue, sourceWidth, sourceHeight, w, h, scaleX, scaleY);
    const position = resolveBackgroundPosition(positionValue);

    let offsetX = resolveBackgroundOffset(position.x, w, maskSize.width, scaleX);
    let offsetY = resolveBackgroundOffset(position.y, h, maskSize.height, scaleY);

    if (attachmentValue === "fixed") {
      const rect = el.getBoundingClientRect();
      offsetX -= rect.left * scaleX;
      offsetY -= rect.top * scaleY;
    }

    const xPositions = repeat.repeatX
      ? (() => {
        const positions: number[] = [];
        for (let x = getRepeatStart(offsetX, maskSize.width); x < w; x += maskSize.width) {
          positions.push(x);
        }
        return positions;
      })()
      : [offsetX];

    const yPositions = repeat.repeatY
      ? (() => {
        const positions: number[] = [];
        for (let y = getRepeatStart(offsetY, maskSize.height); y < h; y += maskSize.height) {
          positions.push(y);
        }
        return positions;
      })()
      : [offsetY];

    for (const y of yPositions) {
      for (const x of xPositions) {
        maskCtx.drawImage(img, x, y, maskSize.width, maskSize.height);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0);

    const pixels = w * h;
    const inspection = inspectRasterImageData(ctx.getImageData(0, 0, w, h), pixels <= 250000);
    if (!inspection.hasVisibleContent) return null;

    return {
      dataUrl: inspection.hasTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92),
      rgbData: inspection.rgbData,
    };
  } catch {
    return null;
  }
}

function resolveMaskFillColor(style: Style, cs: CSSStyleDeclaration): string | null {
  for (const color of [style.fill, cs.backgroundColor, cs.color]) {
    if (isVisibleCssColor(color)) return color;
  }
  return null;
}

function isVisibleCssColor(color: string | undefined): color is string {
  if (!color || color === "transparent" || color === "none") return false;
  const rgbaMatch = color.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch?.[1] !== undefined && parseFloat(rgbaMatch[1]) <= 0) return false;
  if (color.startsWith("#") && color.length === 9 && parseInt(color.slice(7, 9), 16) === 0) return false;
  return true;
}

function requiresRasterSvgImage(style: Style): boolean {
  if (style.filter && style.filter !== "none") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  if (style.mask && style.mask !== "none") return true;
  if (style.clipPath && style.clipPath !== "none") return true;
  if (style.clipBounds) return true;
  if (style.clipQuads?.length) return true;
  return false;
}

/**
 * Extract geometry or image data from an <img> element.
 * - Simple SVG images: converted to vector geometry (polygon/polyline/text IR nodes)
 * - Effected/clipped SVGs and raster images: emitted as `image` IR nodes with embedded data URL
 */
export async function extractImageGeometry(
  el: HTMLImageElement,
  style: Style,
  globalIndex: number,
  options: Options
): Promise<IRNode[]> {
  const src = el.currentSrc || el.src;
  if (!src) return [];

  await ensureImageElementSourceReady(src);

  // Check for a pre-fetched version of this image (from preloadImages)
  const preloadedEl = preloadedImageElems.get(src);
  const drawEl: HTMLImageElement = preloadedEl ?? el;
  const natW = drawEl.naturalWidth || el.naturalWidth || 0;
  const natH = drawEl.naturalHeight || el.naturalHeight || 0;

  // Skip images that haven't loaded or are broken.
  // For data URL images, naturalWidth may be 0 if the browser hasn't decoded yet,
  // but the data URL itself is still usable as image source.
  const isDataUrl = src.startsWith("data:image/");
  if (!isDataUrl && !preloadedEl && (!el.complete || el.naturalWidth === 0)) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  // Adjust geometry and source sampling for object-fit / object-position.
  const objectFitPlan = getObjectFitPlan(el, quad, natW, natH);
  const adjustedQuad = objectFitPlan.quad;

  // Keep SVG <img> elements as image layers when CSS effects or clipping need to
  // apply to the image as a single composited unit.
  if (isSvgSource(src) && !objectFitPlan.sourceRect && !requiresRasterSvgImage(style)) {
    const svgContent = extractSvgContent(src);
    if (svgContent) {
      const svgNodes = convertSvgToGeometry(svgContent, el, adjustedQuad, globalIndex, options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize SVG via canvas (below)
  }

  // Raster image: render to canvas at display size (scaled by imageScale) for consistent output
  const imageScale = options.imageScale ?? 1;
  const displayW = Math.round(Math.sqrt((adjustedQuad[1].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[1].y - adjustedQuad[0].y) ** 2)) || el.width || 1;
  const displayH = Math.round(Math.sqrt((adjustedQuad[3].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[3].y - adjustedQuad[0].y) ** 2)) || el.height || 1;
  const renderW = Math.min(Math.round(displayW * imageScale), 4096);
  const renderH = Math.min(Math.round(displayH * imageScale), 4096);

  let dataUrl: string | null = null;
  let rgbData: number[] | undefined;

  // Check cache for previously rasterized result of the same source at same dimensions
  const cropKey = objectFitPlan.sourceRect
    ? `${objectFitPlan.sourceRect.x.toFixed(3)}|${objectFitPlan.sourceRect.y.toFixed(3)}|${objectFitPlan.sourceRect.width.toFixed(3)}|${objectFitPlan.sourceRect.height.toFixed(3)}`
    : "full";
  const imgCacheKey = `img|${src.length}|${renderW}|${renderH}|${cropKey}|${src.slice(0, 100)}`;
  const cachedImg = imageDataCache.get(imgCacheKey);
  if (cachedImg !== undefined) {
    if (cachedImg === null) return []; // previously determined to be transparent/empty
    return [{
      type: "image",
      quad: adjustedQuad,
      dataUrl: cachedImg.dataUrl,
      width: renderW,
      height: renderH,
      rgbData: cachedImg.rgbData,
      style,
      zIndex: globalIndex,
    }];
  }

  // Determine if we should use nearest-neighbor (pixelated) scaling
  const imageRendering = getComputedStyle(el).imageRendering || "";
  const isPixelated = imageRendering === "pixelated" || imageRendering === "crisp-edges" || imageRendering === "-moz-crisp-edges";
  const isSmallSource = natW > 0 && natH > 0 && (natW <= 16 || natH <= 16);
  const disableSmoothing = isPixelated || isSmallSource || renderW <= 16 || renderH <= 16;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = renderW;
    canvas.height = renderH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Draw without a background first so transparent small icons can stay transparent.
      if (disableSmoothing) ctx.imageSmoothingEnabled = false;
      drawObjectFitImage(ctx, drawEl, renderW, renderH, objectFitPlan.sourceRect);

      const pixels = renderW * renderH;
      const inspection = inspectRasterImageData(ctx.getImageData(0, 0, renderW, renderH), pixels <= 250000);

      if (natW > 0 && natH > 0) {
        if (!inspection.hasVisibleContent) {
          // Image is fully transparent — skip it
          imageDataCache.set(imgCacheKey, null);
          return [];
        }
      }

      // If the browser could not decode the image into the canvas, fall back below.
      const canvasWorked = inspection.hasVisibleContent;

      if (canvasWorked) {
        const preserveTransparency = inspection.hasTransparency;
        dataUrl = preserveTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
        rgbData = inspection.rgbData;
      }
    }
  } catch { /* canvas tainted */ }

  // Fallback for Firefox headless: decode PNG data URL manually
  if (!dataUrl && isDataUrl && src.startsWith("data:image/png")) {
    const decoded = decodePngDataUrl(src);
    if (decoded) {
      // Put the decoded pixels into a canvas at rendered size so small transparent
      // images can stay transparent in HTML/SVG/image writers while PDF/EMF still
      // get white-blended RGB data.
      try {
        const canvas = document.createElement("canvas");
        canvas.width = renderW;
        canvas.height = renderH;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          // First draw decoded pixels into a temp canvas at original size
          const tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = decoded.width;
          tmpCanvas.height = decoded.height;
          const tmpCtx = tmpCanvas.getContext("2d");
          if (tmpCtx) {
            const imgData = tmpCtx.createImageData(decoded.width, decoded.height);
            imgData.data.set(decoded.rgba);
            tmpCtx.putImageData(imgData, 0, 0);
            // Scale to render size
            if (disableSmoothing) ctx.imageSmoothingEnabled = false;
            drawObjectFitImage(ctx, tmpCanvas, renderW, renderH, objectFitPlan.sourceRect);
            const pixels = renderW * renderH;
            const inspection = inspectRasterImageData(ctx.getImageData(0, 0, renderW, renderH), pixels <= 250000);
            if (!inspection.hasVisibleContent) {
              imageDataCache.set(imgCacheKey, null);
              return [];
            }
            const preserveTransparency = inspection.hasTransparency;
            dataUrl = preserveTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
            rgbData = inspection.rgbData;
          }
        }
      } catch { /* fallback below */ }
    }
  }

  // Final fallback: use the original source
  // If the browser couldn't decode this image (naturalWidth===0) and our manual
  // decoder also failed, the image is unrenderable — skip it.
  if (!dataUrl) {
    if (isDataUrl && natW === 0 && natH === 0) {
      imageDataCache.set(imgCacheKey, null);
      return [];
    }
    dataUrl = await getImageDataUrl(drawEl);
    if (!dataUrl) dataUrl = src;
    if (!dataUrl) {
      imageDataCache.set(imgCacheKey, null);
      return [];
    }
  }

  // For inline SVG data URLs, keep the original payload so writers that can render
  // SVG natively preserve fidelity. For remote SVG sources, keep the resolved data URL
  // or raster fallback; reverting to the original URL re-taints downstream canvases.
  if (isSvgSource(src) && src.startsWith("data:image/svg+xml")) dataUrl = src;

  imageDataCache.set(imgCacheKey, { dataUrl, rgbData });
  return [{
    type: "image",
    quad: adjustedQuad,
    dataUrl,
    width: renderW,
    height: renderH,
    rgbData,
    style,
    zIndex: globalIndex,
  }];
}

/**
 * Extract the current bitmap of a <canvas> element as an image IR node.
 */
export function extractCanvasGeometry(
  el: HTMLCanvasElement,
  style: Style,
  globalIndex: number,
  options: Options
): IRNode[] {
  const natW = el.width || 0;
  const natH = el.height || 0;
  if (!natW || !natH) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  const objectFitPlan = getObjectFitPlan(el, quad, natW, natH);
  const adjustedQuad = objectFitPlan.quad;
  const imageScale = options.imageScale ?? 1;
  const displayW = Math.round(Math.sqrt((adjustedQuad[1].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[1].y - adjustedQuad[0].y) ** 2)) || natW || 1;
  const displayH = Math.round(Math.sqrt((adjustedQuad[3].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[3].y - adjustedQuad[0].y) ** 2)) || natH || 1;
  const renderW = Math.min(Math.round(displayW * imageScale), 4096);
  const renderH = Math.min(Math.round(displayH * imageScale), 4096);

  const imageRendering = getComputedStyle(el).imageRendering || "";
  const isPixelated = imageRendering === "pixelated" || imageRendering === "crisp-edges" || imageRendering === "-moz-crisp-edges";
  const isSmallSource = natW <= 16 || natH <= 16;
  const disableSmoothing = isPixelated || isSmallSource || renderW <= 16 || renderH <= 16;

  try {
    const sourceDataUrl = el.toDataURL("image/png");
    let rgbData: number[] | undefined;

    const sourceCtx = el.getContext("2d");
    if (sourceCtx && natW * natH <= 250000) {
      const inspection = inspectRasterImageData(sourceCtx.getImageData(0, 0, natW, natH), true);
      if (!inspection.hasVisibleContent) return [];
      rgbData = inspection.rgbData;
    }

    let dataUrl = sourceDataUrl;
    let width = natW;
    let height = natH;

    if (objectFitPlan.sourceRect || renderW !== natW || renderH !== natH) {
      const rendered = renderDataUrlWithSampling(sourceDataUrl, renderW, renderH, disableSmoothing, objectFitPlan.sourceRect);
      if (rendered) {
        dataUrl = rendered.dataUrl;
        width = renderW;
        height = renderH;
        rgbData = rendered.rgbData ?? rgbData;
      }
    }

    return [{
      type: "image",
      quad: adjustedQuad,
      dataUrl,
      width,
      height,
      rgbData,
      style,
      zIndex: globalIndex,
    }];
  } catch {
    return [];
  }
}

/**
 * Extract the first decoded frame of a <video> element as an image IR node.
 */
export async function extractVideoGeometry(
  el: HTMLVideoElement,
  style: Style,
  globalIndex: number,
  options: Options
): Promise<IRNode[]> {
  const src = getVideoSourceUrl(el);
  if (!src) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  const drawEl = await loadFirstVideoFrame(el, src);
  if (!drawEl) return [];

  try {
    const natW = drawEl.videoWidth || el.videoWidth || 0;
    const natH = drawEl.videoHeight || el.videoHeight || 0;
    if (!natW || !natH) return [];

    const objectFitPlan = getObjectFitPlan(el, quad, natW, natH);
    const adjustedQuad = objectFitPlan.quad;

    const imageScale = options.imageScale ?? 1;
    const displayW = Math.round(Math.sqrt((adjustedQuad[1].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[1].y - adjustedQuad[0].y) ** 2)) || natW || 1;
    const displayH = Math.round(Math.sqrt((adjustedQuad[3].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[3].y - adjustedQuad[0].y) ** 2)) || natH || 1;
    const renderW = Math.min(Math.round(displayW * imageScale), 4096);
    const renderH = Math.min(Math.round(displayH * imageScale), 4096);

    const cropKey = objectFitPlan.sourceRect
      ? `${objectFitPlan.sourceRect.x.toFixed(3)}|${objectFitPlan.sourceRect.y.toFixed(3)}|${objectFitPlan.sourceRect.width.toFixed(3)}|${objectFitPlan.sourceRect.height.toFixed(3)}`
      : "full";
    const videoCacheKey = `video|${src.length}|${renderW}|${renderH}|${cropKey}|${src.slice(0, 100)}`;
    const cachedVideo = imageDataCache.get(videoCacheKey);
    if (cachedVideo !== undefined) {
      if (cachedVideo === null) return [];
      return [{
        type: "image",
        quad: adjustedQuad,
        dataUrl: cachedVideo.dataUrl,
        width: renderW,
        height: renderH,
        rgbData: cachedVideo.rgbData,
        style,
        zIndex: globalIndex,
      }];
    }

    const imageRendering = getComputedStyle(el).imageRendering || "";
    const isPixelated = imageRendering === "pixelated" || imageRendering === "crisp-edges" || imageRendering === "-moz-crisp-edges";
    const isSmallSource = natW <= 16 || natH <= 16;
    const disableSmoothing = isPixelated || isSmallSource || renderW <= 16 || renderH <= 16;

    let dataUrl: string | null = null;
    let rgbData: number[] | undefined;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = renderW;
      canvas.height = renderH;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (disableSmoothing) ctx.imageSmoothingEnabled = false;
        drawObjectFitImage(ctx, drawEl, renderW, renderH, objectFitPlan.sourceRect);

        const pixels = renderW * renderH;
        const inspection = inspectRasterImageData(ctx.getImageData(0, 0, renderW, renderH), pixels <= 250000);
        if (!inspection.hasVisibleContent) {
          imageDataCache.set(videoCacheKey, null);
          return [];
        }

        const preserveTransparency = inspection.hasTransparency;
        dataUrl = preserveTransparency ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.92);
        rgbData = inspection.rgbData;
      }
    } catch { /* canvas tainted */ }

    if (!dataUrl) {
      imageDataCache.set(videoCacheKey, null);
      return [];
    }

    imageDataCache.set(videoCacheKey, { dataUrl, rgbData });
    return [{
      type: "image",
      quad: adjustedQuad,
      dataUrl,
      width: renderW,
      height: renderH,
      rgbData,
      style,
      zIndex: globalIndex,
    }];
  } finally {
    if (drawEl !== el) {
      disposeTemporaryVideo(drawEl);
    }
  }
}

type ObjectFitPlan = {
  quad: Quad;
  sourceRect?: { x: number; y: number; width: number; height: number };
};

type SourceRect = { x: number; y: number; width: number; height: number };

type AxisPosition =
  | { kind: "fraction"; value: number }
  | { kind: "start"; offset: number }
  | { kind: "center"; offset: number }
  | { kind: "end"; offset: number };

type ObjectPosition = { x: AxisPosition; y: AxisPosition };

/**
 * The extracted media geometry can differ from the element box when object-fit
 * does not stretch the content, and some modes also require source cropping.
 */
function getObjectFitPlan(
  el: Element,
  quad: Quad,
  natW: number,
  natH: number
): ObjectFitPlan {
  const computedStyle = getComputedStyle(el);
  const objectFit = computedStyle.objectFit;
  if (!natW || !natH) return { quad };

  const baseSourceRect = parseObjectViewBox(computedStyle.getPropertyValue("object-view-box"), natW, natH);
  const sourceNatW = baseSourceRect?.width ?? natW;
  const sourceNatH = baseSourceRect?.height ?? natH;
  const plan = getObjectFitPlanFromDimensions(quad, sourceNatW, sourceNatH, objectFit, computedStyle.objectPosition);
  const sourceRect = composeSourceRects(baseSourceRect, plan.sourceRect);

  return sourceRect ? { quad: plan.quad, sourceRect } : plan;
}

function getObjectFitPlanFromDimensions(
  quad: Quad,
  natW: number,
  natH: number,
  objectFit: string,
  objectPositionValue: string
): ObjectFitPlan {
  if (!natW || !natH) return { quad };

  const boxW = Math.sqrt((quad[1].x - quad[0].x) ** 2 + (quad[1].y - quad[0].y) ** 2);
  const boxH = Math.sqrt((quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2);
  if (boxW === 0 || boxH === 0) return { quad };

  const objectPosition = parseObjectPosition(objectPositionValue);
  const imgAspect = natW / natH;
  const boxAspect = boxW / boxH;

  if (objectFit === "cover") {
    if (Math.abs(imgAspect - boxAspect) < 0.01) return { quad };

    if (imgAspect > boxAspect) {
      const cropWidth = natH * boxAspect;
      const cropX = resolveAxisPosition(objectPosition.x, natW - cropWidth);
      return {
        quad,
        sourceRect: { x: cropX, y: 0, width: cropWidth, height: natH },
      };
    }

    const cropHeight = natW / boxAspect;
    const cropY = resolveAxisPosition(objectPosition.y, natH - cropHeight);
    return {
      quad,
      sourceRect: { x: 0, y: cropY, width: natW, height: cropHeight },
    };
  }

  if (objectFit === "contain") {
    return {
      quad: fitQuadWithinBox(quad, boxW, boxH, natW, natH, objectPosition),
    };
  }

  if (objectFit === "scale-down") {
    if (natW <= boxW && natH <= boxH) {
      return {
        quad: placeQuadInsideBox(quad, boxW, boxH, natW, natH, objectPosition),
      };
    }

    return {
      quad: fitQuadWithinBox(quad, boxW, boxH, natW, natH, objectPosition),
    };
  }

  if (objectFit === "none") {
    return {
      quad: placeQuadInsideBox(quad, boxW, boxH, natW, natH, objectPosition),
    };
  }

  return { quad };
}

function getVideoSourceUrl(el: HTMLVideoElement): string | null {
  const src = el.currentSrc || el.src;
  if (src) return src;
  const source = el.querySelector("source[src]") as HTMLSourceElement | null;
  return source?.src ?? null;
}

async function loadFirstVideoFrame(el: HTMLVideoElement, src: string): Promise<HTMLVideoElement | null> {
  const canUseOriginalElement = canReuseOriginalVideoElement(el, src);
  if (
    canUseOriginalElement &&
    el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    el.videoWidth > 0 &&
    el.videoHeight > 0 &&
    Math.abs(el.currentTime) < 0.001
  ) {
    return el;
  }

  const tempVideo = document.createElement("video");
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.preload = "auto";
  const crossOriginMode = getVideoCrossOriginMode(el, src);
  if (crossOriginMode) tempVideo.crossOrigin = crossOriginMode;
  tempVideo.src = src;

  try {
    await waitForVideoReady(tempVideo);
    if (!tempVideo.videoWidth || !tempVideo.videoHeight) {
      disposeTemporaryVideo(tempVideo);
      return null;
    }
    await seekVideoToStart(tempVideo);
    return tempVideo;
  } catch {
    disposeTemporaryVideo(tempVideo);
    return null;
  }
}

function canReuseOriginalVideoElement(el: HTMLVideoElement, src: string): boolean {
  if (el.crossOrigin) return true;
  return !isCrossOriginVideoSource(src);
}

function getVideoCrossOriginMode(el: HTMLVideoElement, src: string): "anonymous" | "use-credentials" | null {
  if (el.crossOrigin === "use-credentials") return "use-credentials";
  if (el.crossOrigin === "anonymous") return "anonymous";
  return isCrossOriginVideoSource(src) ? "anonymous" : null;
}

function isCrossOriginVideoSource(src: string): boolean {
  try {
    const url = new URL(src, document.baseURI);
    if (url.protocol === "data:" || url.protocol === "blob:") return false;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

async function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("video load timed out"));
    }, getConfiguredTimeout("__HC_VIDEO_READY_TIMEOUT_MS", VIDEO_READY_TIMEOUT_MS));

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("error", onError);
    };
    const onLoadedData = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("video load failed"));
    };

    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("error", onError);

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
      cleanup();
      resolve();
      return;
    }

    video.load();
  });
}

async function seekVideoToStart(video: HTMLVideoElement): Promise<void> {
  video.pause();
  if (Math.abs(video.currentTime) < 0.001 && !video.seeking) return;

  await new Promise<void>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, getConfiguredTimeout("__HC_VIDEO_SEEK_TIMEOUT_MS", VIDEO_SEEK_TIMEOUT_MS));

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      resolve();
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    try {
      video.currentTime = 0;
    } catch {
      cleanup();
      resolve();
      return;
    }

    if (Math.abs(video.currentTime) < 0.001 && !video.seeking) {
      cleanup();
      resolve();
    }
  });
}

function disposeTemporaryVideo(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    // ignore
  }

  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    // ignore
  }
}

function parseObjectPosition(value: string): ObjectPosition {
  const tokens = tokenizeCssValue(value);
  let x: AxisPosition | null = null;
  let y: AxisPosition | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    const nextToken = tokens[index + 1];

    if (isHorizontalPositionKeyword(token)) {
      const hasOffset = nextToken && isObjectPositionLength(nextToken);
      x = createKeywordAxisPosition(token, hasOffset ? nextToken : undefined);
      if (hasOffset) index += 1;
      continue;
    }

    if (isVerticalPositionKeyword(token)) {
      const hasOffset = nextToken && isObjectPositionLength(nextToken);
      y = createKeywordAxisPosition(token, hasOffset ? nextToken : undefined);
      if (hasOffset) index += 1;
      continue;
    }

    if (token === "center") {
      if (x === null) {
        x = { kind: "center", offset: 0 };
      } else if (y === null) {
        y = { kind: "center", offset: 0 };
      }
      continue;
    }

    if (!isObjectPositionLength(token)) continue;

    const axisValue = parseObjectPositionLength(token);
    if (x === null) {
      x = axisValue;
    } else if (y === null) {
      y = axisValue;
    }
  }

  return {
    x: x ?? { kind: "center", offset: 0 },
    y: y ?? { kind: "center", offset: 0 },
  };
}

function tokenizeCssValue(value: string): string[] {
  return value.trim().match(/(?:[a-z-]+\([^)]*\)|[^\s]+)/gi) ?? [];
}

function isHorizontalPositionKeyword(token: string): boolean {
  return token === "left" || token === "right" || token === "x-start" || token === "x-end";
}

function isVerticalPositionKeyword(token: string): boolean {
  return token === "top" || token === "bottom" || token === "y-start" || token === "y-end";
}

function isObjectPositionLength(token: string): boolean {
  return /^[-+]?\d*\.?\d+(?:[a-z%]+)?$/i.test(token);
}

function parseObjectPositionLength(token: string): AxisPosition {
  const value = token.toLowerCase();
  if (value.endsWith("%")) {
    const percent = parseFloat(value);
    return { kind: "fraction", value: Number.isNaN(percent) ? 0.5 : percent / 100 };
  }

  const numeric = parseFloat(value);
  return { kind: "start", offset: Number.isNaN(numeric) ? 0 : numeric };
}

function createKeywordAxisPosition(keyword: string, offsetToken?: string): AxisPosition {
  const offset = offsetToken ? parseFloat(offsetToken) : 0;
  const parsedOffset = Number.isNaN(offset) ? 0 : offset;

  switch (keyword) {
    case "left":
    case "top":
    case "x-start":
    case "y-start":
      return { kind: "start", offset: parsedOffset };
    case "right":
    case "bottom":
    case "x-end":
    case "y-end":
      return { kind: "end", offset: parsedOffset };
    default:
      return { kind: "center", offset: parsedOffset };
  }
}

function resolveAxisPosition(position: AxisPosition, freeSpace: number): number {
  switch (position.kind) {
    case "fraction":
      return freeSpace * position.value;
    case "start":
      return position.offset;
    case "end":
      return freeSpace - position.offset;
    case "center":
      return freeSpace / 2 + position.offset;
  }
}

function parseClipLength(token: string, reference: number): number {
  const value = token.trim().toLowerCase();
  if (!value) return 0;
  if (value.endsWith("%")) {
    return (parseFloat(value) / 100) * reference;
  }
  const numeric = parseFloat(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function expandInsetValues(values: string[]): [string, string, string, string] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0], values[1], values[2], values[3]];
}

function parseObjectViewBox(value: string, natW: number, natH: number): SourceRect | undefined {
  const raw = value.trim();
  if (!raw || raw === "none") return undefined;

  const inset = raw.match(/^inset\((.+)\)$/i);
  if (inset) {
    const [rawInsets] = inset[1].split(/\s+round\s+/i, 2);
    const values = rawInsets.trim().split(/\s+/).filter(Boolean);
    if (values.length === 0 || values.length > 4) return undefined;

    const [topToken, rightToken, bottomToken, leftToken] = expandInsetValues(values);
    return normalizeSourceRect({
      x: parseClipLength(leftToken, natW),
      y: parseClipLength(topToken, natH),
      width: natW - parseClipLength(leftToken, natW) - parseClipLength(rightToken, natW),
      height: natH - parseClipLength(topToken, natH) - parseClipLength(bottomToken, natH),
    }, natW, natH);
  }

  const xywh = raw.match(/^xywh\((.+)\)$/i);
  if (xywh) {
    const [rawRect] = xywh[1].split(/\s+round\s+/i, 2);
    const values = rawRect.trim().split(/\s+/).filter(Boolean);
    if (values.length < 4) return undefined;

    return normalizeSourceRect({
      x: parseClipLength(values[0], natW),
      y: parseClipLength(values[1], natH),
      width: parseClipLength(values[2], natW),
      height: parseClipLength(values[3], natH),
    }, natW, natH);
  }

  const rect = raw.match(/^rect\((.+)\)$/i);
  if (rect) {
    const values = rect[1].trim().split(/[\s,]+/).filter(Boolean);
    if (values.length < 4) return undefined;

    const top = parseClipLength(values[0], natH);
    const right = parseClipLength(values[1], natW);
    const bottom = parseClipLength(values[2], natH);
    const left = parseClipLength(values[3], natW);
    return normalizeSourceRect({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }, natW, natH);
  }

  return undefined;
}

function normalizeSourceRect(rect: SourceRect, natW: number, natH: number): SourceRect | undefined {
  const x = Math.max(0, Math.min(natW, rect.x));
  const y = Math.max(0, Math.min(natH, rect.y));
  const width = Math.max(0, Math.min(rect.width, natW - x));
  const height = Math.max(0, Math.min(rect.height, natH - y));
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function composeSourceRects(baseRect: SourceRect | undefined, cropRect: SourceRect | undefined): SourceRect | undefined {
  if (!baseRect) return cropRect;
  if (!cropRect) return baseRect;
  return {
    x: baseRect.x + cropRect.x,
    y: baseRect.y + cropRect.y,
    width: cropRect.width,
    height: cropRect.height,
  };
}

function fitQuadWithinBox(
  quad: Quad,
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  objectPosition: ObjectPosition
): Quad {
  const scale = Math.min(boxW / natW, boxH / natH);
  return placeQuadInsideBox(quad, boxW, boxH, natW * scale, natH * scale, objectPosition);
}

function placeQuadInsideBox(
  quad: Quad,
  boxW: number,
  boxH: number,
  renderW: number,
  renderH: number,
  objectPosition: ObjectPosition
): Quad {
  const offsetX = resolveAxisPosition(objectPosition.x, boxW - renderW);
  const offsetY = resolveAxisPosition(objectPosition.y, boxH - renderH);
  return subQuad(quad, offsetX / boxW, offsetY / boxH, (offsetX + renderW) / boxW, (offsetY + renderH) / boxH);
}

function subQuad(quad: Quad, startU: number, startV: number, endU: number, endV: number): Quad {
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  const tl = lerp(lerp(quad[0], quad[1], startU), lerp(quad[3], quad[2], startU), startV);
  const tr = lerp(lerp(quad[0], quad[1], endU), lerp(quad[3], quad[2], endU), startV);
  const br = lerp(lerp(quad[0], quad[1], endU), lerp(quad[3], quad[2], endU), endV);
  const bl = lerp(lerp(quad[0], quad[1], startU), lerp(quad[3], quad[2], startU), endV);

  return [tl, tr, br, bl] as Quad;
}

function drawObjectFitImage(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  renderW: number,
  renderH: number,
  sourceRect?: { x: number; y: number; width: number; height: number }
): void {
  if (sourceRect) {
    ctx.drawImage(source, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, renderW, renderH);
    return;
  }

  ctx.drawImage(source, 0, 0, renderW, renderH);
}

/**
 * Check if a URL path looks like an SVG file (ignoring data URLs). */
function isSvgUrl(src: string): boolean {
  try {
    const url = new URL(src, document.baseURI);
    return url.pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

/** Check if a source URL points to an SVG. */
function isSvgSource(src: string): boolean {
  if (src.startsWith("data:image/svg+xml")) return true;
  try {
    const url = new URL(src, document.baseURI);
    return url.pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

/** Extract SVG markup from a data URL or async preload caches. Results are cached. */
function extractSvgContent(src: string): string | null {
  const cached = svgContentCache.get(src);
  if (cached !== undefined) return cached;

  let result: string | null = null;
  if (src.startsWith("data:image/svg+xml")) {
    result = decodeSvgDataUrl(src);
  } else {
    const preloadedDataUrl = preloadedUrlMap.get(src);
    if (preloadedDataUrl?.startsWith("data:image/svg+xml")) {
      result = decodeSvgDataUrl(preloadedDataUrl);
    }
  }

  if (result !== null) svgContentCache.set(src, result);
  return result;
}

/** Decode SVG content from a data URL. */
function decodeSvgDataUrl(dataUrl: string): string | null {
  try {
    if (dataUrl.includes(";base64,")) {
      const base64 = dataUrl.split(";base64,")[1];
      return atob(base64);
    }
    // URL-encoded or UTF-8 data URL
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex >= 0) {
      return decodeSvgDataPayload(dataUrl.slice(commaIndex + 1));
    }
  } catch {
    // Decode error
  }
  return null;
}

/**
 * Convert SVG content to vector geometry by creating a temporary SVG element
 * and remapping extracted points to the <img> element's actual screen quad.
 */
function convertSvgToGeometry(
  svgContent: string,
  imgEl: HTMLImageElement,
  targetQuad: Quad,
  globalIndex: number,
  options: Options
): IRNode[] {
  // Parse SVG in a safe document context (strip XML preamble that causes parse errors)
  const parser = new DOMParser();
  const doc = parser.parseFromString(stripXmlPreamble(svgContent), "image/svg+xml");
  const parsedSvg = doc.documentElement;

  if (parsedSvg.tagName.toLowerCase() !== "svg") return [];
  // Check for parse errors
  if (parsedSvg.querySelector("parsererror")) return [];
  // SVGs with fill-rule:evenodd can't be accurately represented as polylines
  // unless the user explicitly opts in via svgToVector
  if (!options.svgToVector && usesEvenOddFillRule(parsedSvg)) return [];

  // Import the parsed SVG into the main document
  const tempSvg = document.importNode(parsedSvg, true) as unknown as SVGSVGElement;

  // Remove script elements and event handlers for safety
  for (const script of Array.from(tempSvg.querySelectorAll("script"))) {
    script.remove();
  }
  for (const el of Array.from(tempSvg.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
    }
  }

  // Place temp SVG at (0,0) with the <img>'s untransformed dimensions
  const w = imgEl.offsetWidth || Math.abs(targetQuad[1].x - targetQuad[0].x);
  const h = imgEl.offsetHeight || Math.abs(targetQuad[3].y - targetQuad[0].y);

  tempSvg.style.position = "fixed";
  tempSvg.style.left = "0px";
  tempSvg.style.top = "0px";
  tempSvg.style.width = `${w}px`;
  tempSvg.style.height = `${h}px`;
  tempSvg.style.margin = "0";
  tempSvg.style.padding = "0";

  document.body.appendChild(tempSvg);

  try {
    const svgNodes = extractSVGSubtree(tempSvg, globalIndex, options);
    // Remap from temp SVG coord space (0,0,w,h) to the actual element's screen quad
    remapIRNodes(svgNodes, w, h, targetQuad);
    return svgNodes;
  } finally {
    document.body.removeChild(tempSvg);
  }
}

/**
 * Get image data as a data URL.
 * Always converts to JPEG for broad writer compatibility.
 */
async function getImageDataUrl(img: HTMLImageElement): Promise<string | null> {
  const src = img.currentSrc || img.src;
  if (!src) return null;

  // For SVG data URLs, convert via canvas to get raster JPEG
  // For raster data URLs and external URLs, also render through canvas
  // to ensure the output is always JPEG (required by PDF DCTDecode).
  try {
    const canvas = document.createElement("canvas");
    const w = img.naturalWidth || img.width || 1;
    const h = img.naturalHeight || img.height || 1;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // White background for transparency handling
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    // Use nearest-neighbor for very small images to preserve pixel art
    if (w <= 16 || h <= 16) ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    // Cross-origin tainted canvas (e.g. file:// URLs) —
    // if the source is already a data URL, return it as-is
    if (src.startsWith("data:image/") && !src.startsWith("data:image/svg")) {
      return src;
    }
    const preloadedDataUrl = preloadedUrlMap.get(src);
    if (preloadedDataUrl?.startsWith("data:image/")) {
      return preloadedDataUrl;
    }
    return await fetchImageAsDataUrl(src);
  }
}

/**
 * Resolve an image URL from async preload caches.
 * When the source was not preloaded, return null and let callers fall back to the original URL.
 */
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  await ensureImageElementSourceReady(url);
  const preloadedDataUrl = preloadedUrlMap.get(url);
  return preloadedDataUrl?.startsWith("data:image/") ? preloadedDataUrl : null;
}

/**
 * Minimal PNG decoder for data URLs. Handles the subset of PNGs commonly used
 * in web pages (8-bit RGB/RGBA, non-interlaced). Falls back to null for
 * unsupported formats. Used when canvas.drawImage fails (Firefox headless bug).
 */
function decodePngDataUrl(dataUrl: string): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  try {
    const base64 = dataUrl.split(";base64,")[1];
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Verify PNG signature
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47) return null;

    // Parse IHDR
    let offset = 8; // skip signature
    const ihdrLen = readU32(bytes, offset); offset += 4;
    const ihdrType = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
    if (ihdrType !== "IHDR" || ihdrLen !== 13) return null;
    offset += 4;
    const width = readU32(bytes, offset); offset += 4;
    const height = readU32(bytes, offset); offset += 4;
    const bitDepth = bytes[offset++];
    const colorType = bytes[offset++];
    const compression = bytes[offset++];
    const filter = bytes[offset++];
    const interlace = bytes[offset++];
    offset += 4; // CRC

    if (bitDepth !== 8 || interlace !== 0 || compression !== 0 || filter !== 0) return null;
    // colorType: 0=gray, 2=RGB, 3=indexed, 4=gray+alpha, 6=RGBA
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1;
    if (channels < 0) return null; // indexed not supported

    // Collect all IDAT chunks
    const idatChunks: Uint8Array[] = [];
    while (offset < bytes.length) {
      const chunkLen = readU32(bytes, offset); offset += 4;
      const chunkType = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]); offset += 4;
      if (chunkType === "IDAT") {
        idatChunks.push(bytes.slice(offset, offset + chunkLen));
      } else if (chunkType === "IEND") {
        break;
      }
      offset += chunkLen + 4; // data + CRC
    }
    if (idatChunks.length === 0) return null;

    // Concatenate IDAT data
    const totalLen = idatChunks.reduce((s, c) => s + c.length, 0);
    const compressed = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of idatChunks) { compressed.set(chunk, pos); pos += chunk.length; }

    // Decompress zlib-wrapped IDAT data
    const rawData = inflateZlibSync(compressed);
    const bpp = channels; // bytes per pixel
    const rowBytes = width * bpp + 1; // +1 for filter byte
    if (!rawData || rawData.length < rowBytes) return null; // need at least 1 row

    const rgba = new Uint8ClampedArray(width * height * 4);
    const prev = new Uint8Array(width * bpp); // previous scanline

    for (let y = 0; y < height; y++) {
      const rowStart = y * rowBytes;
      if (rowStart + 1 + width * bpp > rawData.length) break; // truncated data — remaining rows stay transparent
      const filterType = rawData[rowStart];
      if (filterType > 4) break; // invalid filter byte — data is corrupt from here
      const row = rawData.slice(rowStart + 1, rowStart + 1 + width * bpp);

      // Apply PNG unfiltering
      for (let x = 0; x < row.length; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = (x >= bpp && y > 0) ? prev[x - bpp] : 0;
        switch (filterType) {
          case 0: break; // None
          case 1: row[x] = (row[x] + a) & 0xFF; break; // Sub
          case 2: row[x] = (row[x] + b) & 0xFF; break; // Up
          case 3: row[x] = (row[x] + ((a + b) >>> 1)) & 0xFF; break; // Average
          case 4: row[x] = (row[x] + paethPredictor(a, b, c)) & 0xFF; break; // Paeth
        }
      }
      prev.set(row);

      // Convert to RGBA
      for (let x = 0; x < width; x++) {
        const dstIdx = (y * width + x) * 4;
        if (channels === 1) {
          rgba[dstIdx] = rgba[dstIdx + 1] = rgba[dstIdx + 2] = row[x];
          rgba[dstIdx + 3] = 255;
        } else if (channels === 2) {
          rgba[dstIdx] = rgba[dstIdx + 1] = rgba[dstIdx + 2] = row[x * 2];
          rgba[dstIdx + 3] = row[x * 2 + 1];
        } else if (channels === 3) {
          rgba[dstIdx] = row[x * 3]; rgba[dstIdx + 1] = row[x * 3 + 1]; rgba[dstIdx + 2] = row[x * 3 + 2];
          rgba[dstIdx + 3] = 255;
        } else {
          rgba[dstIdx] = row[x * 4]; rgba[dstIdx + 1] = row[x * 4 + 1]; rgba[dstIdx + 2] = row[x * 4 + 2];
          rgba[dstIdx + 3] = row[x * 4 + 3];
        }
      }
    }

    return { width, height, rgba };
  } catch {
    return null;
  }
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

