/**
 * Image element extraction.
 * Handles <img> tags: SVG images are converted to vector geometry,
 * raster images are embedded as data URLs.
 */
import type { Quad, IRNode, Options, Style } from "./types.js";
import { extractSVGSubtree } from "./svg-extractor.js";
import { getElementQuad } from "./geometry.js";

/** Check if an element is an <img> element. */
export function isImageElement(el: Element): el is HTMLImageElement {
  return el.tagName.toLowerCase() === "img";
}

/**
 * Pre-convert all <img> elements under a root to inline data URLs.
 * This is necessary when images are loaded from file:// or cross-origin URLs,
 * because canvas.toDataURL() will fail with a tainted canvas error.
 * Must be called (and awaited) before extractIR().
 */
export async function preloadImages(root: Element): Promise<void> {
  const imgs = root.querySelectorAll("img");
  for (const img of Array.from(imgs)) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:")) continue;
    try {
      const resp = await fetch(src);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const dataUrl = await blobToDataUrl(blob);
      img.src = dataUrl;
    } catch {
      // Network error — leave as-is
    }
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

  const url = urlMatch[1];

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
  if (dataUrl.startsWith("data:image/jpeg")) return { dataUrl };
  try {
    const img = new Image();
    img.src = dataUrl;
    if (!img.complete || img.naturalWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w || img.naturalWidth || 1;
    canvas.height = h || img.naturalHeight || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngUrl = canvas.toDataURL("image/png");

    // Extract raw RGB for lossless PDF embedding (small images only)
    const pixels = canvas.width * canvas.height;
    if (pixels <= 250000) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const rgba = imageData.data;
      const rgb: number[] = new Array(pixels * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
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
  try {
    const canvas = document.createElement("canvas");
    const w = Math.round(elWidth) || 1;
    const h = Math.round(elHeight) || 1;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Use html2canvas-style approach: draw the element's computed background
    // We rely on the browser having already loaded the image
    // Create a temp element with the same background and draw to canvas
    const cs = getComputedStyle(el);
    const tempDiv = document.createElement("div");
    tempDiv.style.position = "fixed";
    tempDiv.style.left = "-9999px";
    tempDiv.style.top = "-9999px";
    tempDiv.style.width = `${w}px`;
    tempDiv.style.height = `${h}px`;
    tempDiv.style.backgroundImage = cs.backgroundImage;
    tempDiv.style.backgroundSize = cs.backgroundSize || "cover";
    tempDiv.style.backgroundPosition = cs.backgroundPosition || "center";
    tempDiv.style.backgroundRepeat = cs.backgroundRepeat || "no-repeat";
    document.body.appendChild(tempDiv);

    // Extract URL and try to draw via Image
    const bgImage = cs.backgroundImage;
    const urlMatch = bgImage.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/);
    document.body.removeChild(tempDiv);

    if (!urlMatch) return null;
    const url = urlMatch[1];

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

  // Skip images that haven't loaded or are broken
  if (!el.complete || el.naturalWidth === 0) return [];

  const quad = getElementQuad(el);
  if (!quad) return [];

  // Try converting SVG images to vector geometry
  if (isSvgSource(src)) {
    const svgContent = extractSvgContent(src);
    if (svgContent) {
      const svgNodes = convertSvgToGeometry(svgContent, el, quad, globalIndex, options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize SVG via canvas (below)
  }

  // Raster image: get data URL via canvas
  const dataUrl = getImageDataUrl(el);
  if (!dataUrl) return [];

  return [{
    type: "image",
    quad,
    dataUrl,
    width: el.naturalWidth || el.width,
    height: el.naturalHeight || el.height,
    style,
    zIndex: globalIndex,
  }];
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

/** Extract SVG markup from a data URL or fetch it synchronously. */
function extractSvgContent(src: string): string | null {
  if (src.startsWith("data:image/svg+xml")) {
    return decodeSvgDataUrl(src);
  }

  // Try synchronous XHR for same-origin SVG URLs
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", src, false);
    xhr.send();
    if (xhr.status === 200 && xhr.responseText.includes("<svg")) {
      return xhr.responseText;
    }
  } catch {
    // Cross-origin or network error — fall through to rasterize
  }

  return null;
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

  // Always render through canvas to get a JPEG data URL,
  // which is what the PDF writer (DCTDecode) expects.
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
