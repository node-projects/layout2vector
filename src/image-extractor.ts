/**
 * Image element extraction.
 * Handles <img> tags: SVG images are converted to vector geometry,
 * raster images are embedded as data URLs.
 */
import type { Quad, IRNode, Options, Style } from "./types.js";
import { extractSVGSubtree } from "./svg-extractor.js";

/** Check if an element is an <img> element. */
export function isImageElement(el: Element): el is HTMLImageElement {
  return el.tagName.toLowerCase() === "img";
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
  const urlMatch = bg.match(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/);
  if (!urlMatch) return [];

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return [];

  const quad: Quad = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];

  const url = urlMatch[1];

  // If it's already a data URL, try to rasterize directly
  if (url.startsWith("data:image/")) {
    // For SVG data URLs, try vector extraction first
    if (url.startsWith("data:image/svg+xml")) {
      const svgContent = decodeBgSvgDataUrl(url);
      if (svgContent) {
        const svgNodes = convertBgSvgToGeometry(svgContent, el, rect, globalIndex, _options);
        if (svgNodes.length > 0) return svgNodes;
      }
    }
    // Raster data URL — use directly
    return [{
      type: "image",
      quad,
      dataUrl: url,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      style,
      zIndex: globalIndex,
    }];
  }

  // For external SVG URLs, try vector conversion first
  if (isSvgSource(url)) {
    const svgContent = extractSvgContent(url);
    if (svgContent) {
      const svgNodes = convertBgSvgToGeometry(svgContent, el, rect, globalIndex, _options);
      if (svgNodes.length > 0) return svgNodes;
    }
    // Fallback: rasterize below
  }

  // For external URLs, rasterize via canvas using a temporary img element
  const dataUrl = rasterizeBackgroundImage(el, rect);
  if (!dataUrl) return [];

  return [{
    type: "image",
    quad,
    dataUrl,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    style,
    zIndex: globalIndex,
  }];
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
 * Get the element's rendered quad (4 corners) in screen coordinates.
 * Uses getBoxQuads if available, otherwise falls back to bounding rect.
 */
function getElementScreenQuad(el: Element): Quad {
  if ("getBoxQuads" in el && typeof (el as any).getBoxQuads === "function") {
    try {
      const quads: DOMQuad[] = (el as any).getBoxQuads({ box: "border" });
      if (quads.length > 0) {
        const q = quads[0];
        return [
          { x: q.p1.x, y: q.p1.y },
          { x: q.p2.x, y: q.p2.y },
          { x: q.p3.x, y: q.p3.y },
          { x: q.p4.x, y: q.p4.y },
        ];
      }
    } catch { /* fall through */ }
  }
  const r = el.getBoundingClientRect();
  return [
    { x: r.left, y: r.top },
    { x: r.right, y: r.top },
    { x: r.right, y: r.bottom },
    { x: r.left, y: r.bottom },
  ];
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

/** Convert background SVG to vector geometry. */
function convertBgSvgToGeometry(
  svgContent: string,
  el: Element,
  elRect: DOMRect,
  globalIndex: number,
  options: Options
): IRNode[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, "image/svg+xml");
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

  // Get the element's actual screen quad (includes CSS transforms)
  const targetQuad = getElementScreenQuad(el);

  // Place temp SVG at (0,0) with the element's untransformed dimensions.
  // No CSS transform — we'll remap the extracted points to the target quad afterwards.
  const htmlEl = el as HTMLElement;
  const w = htmlEl.offsetWidth || elRect.width;
  const h = htmlEl.offsetHeight || elRect.height;

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
function rasterizeBackgroundImage(el: Element, rect: DOMRect): string | null {
  try {
    const canvas = document.createElement("canvas");
    const w = Math.round(rect.width) || 1;
    const h = Math.round(rect.height) || 1;
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

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return [];

  const quad: Quad = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];

  // Try converting SVG images to vector geometry
  if (isSvgSource(src)) {
    const svgContent = extractSvgContent(src);
    if (svgContent) {
      const svgNodes = convertSvgToGeometry(svgContent, el, rect, globalIndex, options);
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
  imgRect: DOMRect,
  globalIndex: number,
  options: Options
): IRNode[] {
  // Parse SVG in a safe document context
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgContent, "image/svg+xml");
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

  // Get the actual screen quad of the <img> element (includes CSS transforms)
  const targetQuad = getElementScreenQuad(imgEl);

  // Place temp SVG at (0,0) with the <img>'s untransformed dimensions
  const w = imgEl.offsetWidth || imgRect.width;
  const h = imgEl.offsetHeight || imgRect.height;

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

  // If already a raster data URL, use it directly
  if (src.startsWith("data:image/") && !src.startsWith("data:image/svg")) {
    return src;
  }

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
    // Cross-origin tainted canvas — return original src as fallback
    return src;
  }
}
