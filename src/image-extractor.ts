/**
 * Image element extraction.
 * Handles <img> tags: SVG images are converted to vector geometry,
 * raster images are embedded as data URLs.
 */
import type { Quad, IRNode, Options, Style } from "./types.js";
import { extractSVGSubtree } from "./svg-extractor.js";
import { getElementQuad } from "./geometry.js";

/**
 * Cache for image rasterization results, keyed by source URL + dimensions.
 * Avoids re-rasterizing the same image when multiple elements reference it.
 * Cleared at the start of each extractIR() run.
 */
const imageDataCache = new Map<string, { dataUrl: string; rgbData?: number[] } | null>();

/** Cache for SVG content strings, keyed by source URL. Avoids repeated sync XHR or base64 decoding. */
const svgContentCache = new Map<string, string | null>();

/** Pre-fetched image elements for canvas drawing (keyed by original src URL). */
const preloadedImageElems = new Map<string, HTMLImageElement>();
/** Pre-fetched URL mappings: original URL → data URL. Populated by preloadImages without modifying the page. */
const preloadedUrlMap = new Map<string, string>();

/** Clear the image rasterization cache. Called at the start of each extraction run. */
export function clearImageCache(): void {
  imageDataCache.clear();
  svgContentCache.clear();
  preloadedImageElems.clear();
  preloadedUrlMap.clear();
}

/** Check if an element is an <img> element. */
export function isImageElement(el: Element): el is HTMLImageElement {
  return el.tagName.toLowerCase() === "img";
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

  // Pre-fetch <img> elements — populate caches without modifying the DOM
  for (const el of allElements) {
    if (el.tagName !== "IMG") continue;
    const img = el as HTMLImageElement;
    const src = img.currentSrc || img.src;
    if (!src) continue;
    if (src.startsWith("data:")) {
      // Data URL images may not be decoded yet — force decode so
      // canvas.drawImage works synchronously during extraction.
      try {
        await img.decode();
      } catch {
        // img.decode() may fail for small images in some browsers.
        // Create a pre-decoded copy for canvas drawing (no DOM mutation).
        try {
          const tmpImg = new Image();
          tmpImg.src = src;
          await new Promise<void>((resolve, reject) => {
            tmpImg.onload = () => resolve();
            tmpImg.onerror = () => reject(new Error("load failed"));
            if (tmpImg.complete && tmpImg.naturalWidth > 0) resolve();
          });
          preloadedImageElems.set(src, tmpImg);
        } catch { /* give up */ }
      }
      continue;
    }
    // External URL — fetch and cache as data URL (do NOT modify img.src)
    try {
      const resp = await fetch(src);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const dataUrl = await blobToDataUrl(blob);
      preloadedUrlMap.set(src, dataUrl);
      // Pre-decode into an Image element for canvas drawing
      const tmpImg = new Image();
      tmpImg.src = dataUrl;
      try { await tmpImg.decode(); } catch { /* ignore */ }
      preloadedImageElems.set(src, tmpImg);
    } catch {
      // Network error — sync XHR fallback will be attempted during extraction
    }
  }

  // Pre-fetch background-image URLs (including inside shadow DOM).
  // Populate caches without modifying element styles.
  for (const el of allElements) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    const urlMatch = bg.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];

    // External URL (not a data URL) — fetch and cache
    if (!url.startsWith("data:")) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const dataUrl = await blobToDataUrl(blob);
        preloadedUrlMap.set(url, dataUrl);
        // Pre-decode into an Image element so rasterToRendered can draw it synchronously
        const tmpImg = new Image();
        tmpImg.src = dataUrl;
        try { await tmpImg.decode(); } catch { /* ignore */ }
        preloadedImageElems.set(dataUrl, tmpImg);
      } catch { /* network error — sync XHR fallback during extraction */ }
      continue;
    }

    // Data URL PNG/WebP — pre-decode and convert to JPEG for PDF compat
    if (!url.startsWith("data:image/png") && !url.startsWith("data:image/webp")) continue;
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // Skip JPEG conversion for very small images (JPEG block size is 8×8,
      // converting smaller images produces severe artifacts)
      if (img.naturalWidth <= 16 && img.naturalHeight <= 16) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const jpegUrl = canvas.toDataURL("image/jpeg", 0.92);
      preloadedUrlMap.set(url, jpegUrl);
    } catch { /* ignore */ }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
export function extractBackgroundImage(
  el: Element,
  style: Style,
  globalIndex: number,
  _options: Options
): IRNode[] {
  const bg = style.backgroundImage;
  if (!bg || bg === "none") return [];

  // Extract the URL from url("...") or url('...') or url(...)
  // Use separate patterns: quoted (allows parens inside) vs unquoted
  const urlMatch = bg.match(/url\s*\(\s*"([^"]+)"\s*\)/) ||
                   bg.match(/url\s*\(\s*'([^']+)'\s*\)/) ||
                   bg.match(/url\s*\(\s*([^)]+)\s*\)/);
  if (!urlMatch) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  // Use untransformed dimensions for the image's natural size
  const htmlEl = el as HTMLElement;
  const w = htmlEl.offsetWidth || Math.abs(quad[1].x - quad[0].x);
  const h = htmlEl.offsetHeight || Math.abs(quad[3].y - quad[0].y);

  let url = urlMatch[1];

  // Resolve from preloaded cache (external URLs fetched during preloadImages)
  const cachedUrl = preloadedUrlMap.get(url);
  if (cachedUrl) url = cachedUrl;

  // If it's already a data URL, try to rasterize directly
  if (url.startsWith("data:image/")) {
    // For SVG data URLs, try vector extraction first
    if (url.startsWith("data:image/svg+xml")) {
      const svgContent = decodeBgSvgDataUrl(url);
      if (svgContent) {
        const svgNodes = convertBgSvgToGeometry(svgContent, el, quad, globalIndex, _options);
        if (svgNodes.length > 0) return svgNodes;
      }
    }
    // Raster data URL — re-render at target size with nearest-neighbor scaling
    const rendered = rasterToRendered(url, Math.round(w), Math.round(h));
    return [{
      type: "image",
      quad,
      dataUrl: rendered?.dataUrl ?? url,
      width: Math.round(w),
      height: Math.round(h),
      rgbData: rendered?.rgbData,
      style,
      zIndex: globalIndex,
    }];
  }

  // For external SVG URLs, try vector conversion first
  if (isSvgSource(url)) {
    const svgContent = extractSvgContent(url);
    if (svgContent) {
      const svgNodes = convertBgSvgToGeometry(svgContent, el, quad, globalIndex, _options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize below
  }

  // For external URLs, rasterize via canvas using a temporary img element
  const dataUrl = rasterizeBackgroundImage(el, w, h);
  if (!dataUrl) return [];

  return [{
    type: "image",
    quad,
    dataUrl,
    width: Math.round(w),
    height: Math.round(h),
    style,
    zIndex: globalIndex,
  }];
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
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const rgba = imageData.data;
      const rgb: number[] = new Array(pixels * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        const a = rgba[i + 3] / 255;
        rgb[j] = Math.round(rgba[i] * a + 255 * (1 - a));
        rgb[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
        rgb[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
      }
      return { dataUrl: pngUrl, rgbData: rgb };
    }
    return { dataUrl: pngUrl };
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
      return decodeURIComponent(dataUrl.slice(commaIndex + 1));
    }
  } catch {
    // Decode error
  }
  return null;
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
        node.points = node.points.map(remap);
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
  // Check the SVG root's style attribute
  const rootStyle = svgEl.getAttribute("style") ?? "";
  if (/fill-rule\s*:\s*evenodd/i.test(rootStyle)) return true;
  // Check descendant elements
  for (const el of Array.from(svgEl.querySelectorAll("*"))) {
    if (el.getAttribute("fill-rule") === "evenodd") return true;
    const style = el.getAttribute("style") ?? "";
    if (/fill-rule\s*:\s*evenodd/i.test(style)) return true;
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
  if (usesEvenOddFillRule(parsedSvg)) return [];

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

/**
 * Rasterize an element's background image by drawing it onto a canvas.
 * Uses a temporary Image element loaded synchronously via XHR.
 */
function rasterizeBackgroundImage(el: Element, elWidth: number, elHeight: number): string | null {
  const w = Math.round(elWidth) || 1;
  const h = Math.round(elHeight) || 1;
  const cs = getComputedStyle(el);
  const bgImage = cs.backgroundImage;
  const urlMatch = bgImage.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/);
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const cacheKey = `bgRaster|${url.length}|${w}|${h}|${url.slice(0, 100)}`;
  if (imageDataCache.has(cacheKey)) {
    return imageDataCache.get(cacheKey)?.dataUrl ?? null;
  }

  const result = rasterizeBackgroundImageUncached(url, w, h);
  imageDataCache.set(cacheKey, result ? { dataUrl: result } : null);
  return result;
}

function rasterizeBackgroundImageUncached(url: string, w: number, h: number): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Synchronous fetch for same-origin images
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.responseType = "blob";
      xhr.send();
      if (xhr.status === 200) {
        // Convert blob to data URL synchronously via canvas
        const img = new Image();
        const blobUrl = URL.createObjectURL(xhr.response);
        img.src = blobUrl;
        // If the image is cached, it may be available immediately
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(blobUrl);
          return canvas.toDataURL("image/jpeg", 0.92);
        }
        URL.revokeObjectURL(blobUrl);
      }
    } catch {
      // Cross-origin or network error
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract geometry or image data from an <img> element.
 * - SVG images: converted to vector geometry (polygon/polyline/text IR nodes)
 * - Raster images: emitted as `image` IR nodes with embedded data URL
 */
export function extractImageGeometry(
  el: HTMLImageElement,
  style: Style,
  globalIndex: number,
  options: Options
): IRNode[] {
  const src = el.currentSrc || el.src;
  if (!src) return [];

  // Check for a pre-fetched version of this image (from preloadImages)
  const preloadedEl = preloadedImageElems.get(src);
  const drawEl: HTMLImageElement = preloadedEl ?? el;

  // Skip images that haven't loaded or are broken.
  // For data URL images, naturalWidth may be 0 if the browser hasn't decoded yet,
  // but the data URL itself is still usable as image source.
  const isDataUrl = src.startsWith("data:image/");
  if (!isDataUrl && !preloadedEl && (!el.complete || el.naturalWidth === 0)) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  // Adjust quad for object-fit: contain/cover
  const adjustedQuad = adjustQuadForObjectFit(el, quad);

  // Try converting SVG images to vector geometry
  if (isSvgSource(src)) {
    const svgContent = extractSvgContent(src);
    if (svgContent) {
      const svgNodes = convertSvgToGeometry(svgContent, el, adjustedQuad, globalIndex, options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize SVG via canvas (below)
  }

  // Raster image: render to canvas at display size for consistent output
  const displayW = Math.round(Math.sqrt((adjustedQuad[1].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[1].y - adjustedQuad[0].y) ** 2)) || el.width || 1;
  const displayH = Math.round(Math.sqrt((adjustedQuad[3].x - adjustedQuad[0].x) ** 2 + (adjustedQuad[3].y - adjustedQuad[0].y) ** 2)) || el.height || 1;
  const renderW = Math.min(displayW, 2048);
  const renderH = Math.min(displayH, 2048);

  let dataUrl: string | null = null;
  let rgbData: number[] | undefined;

  // Check cache for previously rasterized result of the same source at same dimensions
  const imgCacheKey = `img|${src.length}|${renderW}|${renderH}|${src.slice(0, 100)}`;
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
  const natW = drawEl.naturalWidth || 0;
  const natH = drawEl.naturalHeight || 0;
  const isSmallSource = natW > 0 && natH > 0 && (natW <= 16 || natH <= 16);
  const disableSmoothing = isPixelated || isSmallSource || renderW <= 16 || renderH <= 16;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = renderW;
    canvas.height = renderH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // First draw without white background to check for transparency
      // (only when the browser actually decoded the image — natW > 0)
      if (disableSmoothing) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(drawEl, 0, 0, renderW, renderH);

      if (natW > 0 && natH > 0) {
        // Check if the image has any visible (non-transparent) content
        const probeData = ctx.getImageData(0, 0, renderW, renderH).data;
        let hasVisibleContent = false;
        for (let i = 3; i < probeData.length; i += 4) {
          if (probeData[i] > 0) { hasVisibleContent = true; break; }
        }
        if (!hasVisibleContent) {
          // Image is fully transparent — skip it
          imageDataCache.set(imgCacheKey, null);
          return [];
        }
      }

      // Now composite onto white background for JPEG export
      ctx.clearRect(0, 0, renderW, renderH);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, renderW, renderH);
      if (disableSmoothing) ctx.imageSmoothingEnabled = false;
      ctx.drawImage(drawEl, 0, 0, renderW, renderH);

      // Check if drawImage actually produced content (Firefox headless bug:
      // data URL PNGs may not render to canvas at all)
      let canvasWorked = true;
      if (isDataUrl && src.startsWith("data:image/png") && drawEl.naturalWidth === 0) {
        const probe = ctx.getImageData(0, 0, 1, 1).data;
        if (probe[0] === 255 && probe[1] === 255 && probe[2] === 255) {
          canvasWorked = false;
        }
      }

      if (canvasWorked) {
        dataUrl = canvas.toDataURL("image/jpeg", 0.92);

        // Extract raw RGB for lossless PDF embedding (small images only)
        const pixels = renderW * renderH;
        if (pixels <= 250000) {
          const imageData = ctx.getImageData(0, 0, renderW, renderH);
          const rgba = imageData.data;
          rgbData = new Array(pixels * 3);
          for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
            rgbData[j] = rgba[i];
            rgbData[j + 1] = rgba[i + 1];
            rgbData[j + 2] = rgba[i + 2];
          }
        }
      }
    }
  } catch { /* canvas tainted */ }

  // Fallback for Firefox headless: decode PNG data URL manually
  if (!dataUrl && isDataUrl && src.startsWith("data:image/png")) {
    const decoded = decodePngDataUrl(src);
    if (decoded) {
      // Check if decoded image is fully transparent
      let hasAlpha = false;
      for (let i = 3; i < decoded.rgba.length; i += 4) {
        if (decoded.rgba[i] > 0) { hasAlpha = true; break; }
      }
      if (!hasAlpha) {
        imageDataCache.set(imgCacheKey, null);
        return []; // fully transparent image
      }
      // Put the decoded pixels into a canvas at rendered size to generate a JPEG data URL
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
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, renderW, renderH);
            if (disableSmoothing) ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tmpCanvas, 0, 0, renderW, renderH);
            dataUrl = canvas.toDataURL("image/jpeg", 0.92);
            // Extract raw RGB for PDF at render size
            const pixels = renderW * renderH;
            if (pixels <= 250000) {
              const renderedData = ctx.getImageData(0, 0, renderW, renderH);
              const rgba = renderedData.data;
              rgbData = new Array(pixels * 3);
              for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
                rgbData[j] = rgba[i];
                rgbData[j + 1] = rgba[i + 1];
                rgbData[j + 2] = rgba[i + 2];
              }
            }
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
    dataUrl = getImageDataUrl(drawEl);
    if (!dataUrl) dataUrl = src;
    if (!dataUrl) {
      imageDataCache.set(imgCacheKey, null);
      return [];
    }
  }

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
 * Adjust a quad for CSS object-fit: contain.
 * When object-fit: contain is set, the image is scaled to fit within the
 * element box while maintaining aspect ratio, centered in the box.
 */
function adjustQuadForObjectFit(el: HTMLImageElement, quad: Quad): Quad {
  const objectFit = getComputedStyle(el).objectFit;
  if (objectFit !== "contain" && objectFit !== "scale-down") return quad;

  const natW = el.naturalWidth;
  const natH = el.naturalHeight;
  if (!natW || !natH) return quad;

  // Compute the element box dimensions from the quad edges
  const boxW = Math.sqrt((quad[1].x - quad[0].x) ** 2 + (quad[1].y - quad[0].y) ** 2);
  const boxH = Math.sqrt((quad[3].x - quad[0].x) ** 2 + (quad[3].y - quad[0].y) ** 2);
  if (boxW === 0 || boxH === 0) return quad;

  const imgAspect = natW / natH;
  const boxAspect = boxW / boxH;

  // If aspect ratios match closely, no adjustment needed
  if (Math.abs(imgAspect - boxAspect) < 0.01) return quad;

  // Compute the fitted image size
  let fitW: number, fitH: number;
  if (imgAspect > boxAspect) {
    // Image is wider than box: fit width, shrink height
    fitW = boxW;
    fitH = boxW / imgAspect;
  } else {
    // Image is taller than box: fit height, shrink width
    fitH = boxH;
    fitW = boxH * imgAspect;
  }

  // Compute centering offsets as fractions
  const offsetU = (boxW - fitW) / (2 * boxW); // fraction along top edge
  const offsetV = (boxH - fitH) / (2 * boxH); // fraction along left edge
  const endU = 1 - offsetU;
  const endV = 1 - offsetV;

  // Interpolate quad corners to get the fitted sub-quad
  // quad: [topLeft, topRight, bottomRight, bottomLeft]
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  const tl = lerp(lerp(quad[0], quad[1], offsetU), lerp(quad[3], quad[2], offsetU), offsetV);
  const tr = lerp(lerp(quad[0], quad[1], endU), lerp(quad[3], quad[2], endU), offsetV);
  const br = lerp(lerp(quad[0], quad[1], endU), lerp(quad[3], quad[2], endU), endV);
  const bl = lerp(lerp(quad[0], quad[1], offsetU), lerp(quad[3], quad[2], offsetU), endV);

  return [tl, tr, br, bl] as Quad;
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

/** Extract SVG markup from a data URL or fetch it synchronously. Results are cached. */
function extractSvgContent(src: string): string | null {
  const cached = svgContentCache.get(src);
  if (cached !== undefined) return cached;

  let result: string | null = null;
  if (src.startsWith("data:image/svg+xml")) {
    result = decodeSvgDataUrl(src);
  } else {
    // Try synchronous XHR for same-origin SVG URLs
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", src, false);
      xhr.send();
      if (xhr.status === 200 && xhr.responseText.includes("<svg")) {
        result = xhr.responseText;
      }
    } catch {
      // Cross-origin or network error — fall through to rasterize
    }
  }

  svgContentCache.set(src, result);
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
      return decodeURIComponent(dataUrl.slice(commaIndex + 1));
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
  if (usesEvenOddFillRule(parsedSvg)) return [];

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
function getImageDataUrl(img: HTMLImageElement): string | null {
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
    return fetchImageAsDataUrl(src);
  }
}

/**
 * Fetch an image URL synchronously and return it as a data URL.
 * Used as fallback when canvas.toDataURL fails due to cross-origin tainting.
 */
function fetchImageAsDataUrl(url: string): string | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    // Synchronous XHR doesn't support responseType="arraybuffer",
    // so override the charset to get raw binary data as a string
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send();
    if (xhr.status === 200 || xhr.status === 0) {
      const raw = xhr.responseText;
      // Detect MIME type from magic bytes
      let mime = "image/png";
      if (raw.charCodeAt(0) === 0xFF && raw.charCodeAt(1) === 0xD8) mime = "image/jpeg";
      else if (raw.charCodeAt(0) === 0x47 && raw.charCodeAt(1) === 0x49) mime = "image/gif";
      // Convert raw binary string to base64
      let binary = "";
      for (let i = 0; i < raw.length; i++) {
        binary += String.fromCharCode(raw.charCodeAt(i) & 0xFF);
      }
      return `data:${mime};base64,${btoa(binary)}`;
    }
  } catch {
    // Network error
  }
  return null;
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
    const rawData = inflateSync(compressed);
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

/**
 * Synchronous zlib inflate (decompress). Handles the zlib wrapper (2-byte header)
 * and the raw deflate stream. Minimal implementation sufficient for PNG IDAT chunks.
 */
function inflateSync(data: Uint8Array): Uint8Array | null {
  // Skip zlib header (2 bytes: CMF + FLG)
  if (data.length < 6) return null;
  const cmf = data[0];
  if ((cmf & 0x0F) !== 8) return null; // not deflate
  let pos = 2;

  const output: number[] = [];

  // Read bits LSB-first
  let bitBuf = 0;
  let bitCount = 0;

  function readBits(n: number): number {
    while (bitCount < n) {
      if (pos >= data.length) return -1;
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return val;
  }

  function readHuffman(lengths: number[], maxBits: number): number {
    // Build lookup table
    const counts = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) counts[l]++;
    const offsets = new Array(maxBits + 2).fill(0);
    for (let i = 1; i <= maxBits; i++) offsets[i + 1] = offsets[i] + counts[i];
    const symbols = new Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) symbols[offsets[lengths[i]]++] = i;
    }

    // Decode one symbol
    let code = 0, first = 0, idx = 0;
    for (let len = 1; len <= maxBits; len++) {
      code |= readBits(1);
      const count = counts[len];
      if (code < first + count) return symbols[idx + code - first];
      idx += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  }

  // fixed Huffman tables
  const fixedLitLen: number[] = [];
  for (let i = 0; i <= 143; i++) fixedLitLen.push(8);
  for (let i = 144; i <= 255; i++) fixedLitLen.push(9);
  for (let i = 256; i <= 279; i++) fixedLitLen.push(7);
  for (let i = 280; i <= 287; i++) fixedLitLen.push(8);
  const fixedDist: number[] = new Array(32).fill(5);

  const lenBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const lenExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const distBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const distExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

  let bfinal = 0;
  while (!bfinal) {
    bfinal = readBits(1);
    const btype = readBits(2);

    if (btype === 0) {
      // Stored block
      bitBuf = 0; bitCount = 0; // align to byte
      const len = data[pos] | (data[pos + 1] << 8); pos += 4; // len + nlen
      for (let i = 0; i < len; i++) output.push(data[pos++]);
    } else {
      let litLenLens: number[];
      let distLens: number[];

      if (btype === 1) {
        litLenLens = fixedLitLen;
        distLens = fixedDist;
      } else if (btype === 2) {
        // Dynamic Huffman
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const codeLenOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const codeLenLens = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) codeLenLens[codeLenOrder[i]] = readBits(3);

        const allLens: number[] = [];
        while (allLens.length < hlit + hdist) {
          const sym = readHuffman(codeLenLens, 7);
          if (sym < 16) {
            allLens.push(sym);
          } else if (sym === 16) {
            const rep = readBits(2) + 3;
            const val = allLens[allLens.length - 1] || 0;
            for (let i = 0; i < rep; i++) allLens.push(val);
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            for (let i = 0; i < rep; i++) allLens.push(0);
          } else if (sym === 18) {
            const rep = readBits(7) + 11;
            for (let i = 0; i < rep; i++) allLens.push(0);
          }
        }
        litLenLens = allLens.slice(0, hlit);
        distLens = allLens.slice(hlit, hlit + hdist);
      } else {
        return null; // invalid block type
      }

      // Decode symbols
      while (true) {
        const sym = readHuffman(litLenLens, 15);
        if (sym < 0) return null;
        if (sym === 256) break; // end of block
        if (sym < 256) {
          output.push(sym);
        } else {
          // Length/distance pair
          const lenIdx = sym - 257;
          const length = lenBase[lenIdx] + readBits(lenExtra[lenIdx]);
          const distSym = readHuffman(distLens, 15);
          if (distSym < 0) return null;
          const distance = distBase[distSym] + readBits(distExtra[distSym]);
          if (distance > output.length) return null; // invalid back-reference
          for (let i = 0; i < length; i++) {
            output.push(output[output.length - distance]);
          }
        }
      }
    }
  }

  return new Uint8Array(output);
}
