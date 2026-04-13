/**
 * IR generation pipeline.
 * Traverses DOM → detects node type → extracts geometry → builds IR → flattens to render order.
 */
import type { IRNode, Options, Writer } from "./types.js";
import {
  traverseDOM,
  flattenStackingOrder,
  isSVGRoot,
  isSVGElement,
  type StackingNode,
} from "./traversal.js";
import { extractHTMLGeometry } from "./extractors/html-extractor.js";
import { extractSVGSubtree } from "./extractors/svg-extractor.js";
import { isImageElement, extractImageGeometry, hasBackgroundImage, extractBackgroundImage, clearImageCache, preloadImages } from "./extractors/image-extractor.js";
import { isMathMLRoot, extractMathMLFeatures } from "./extractors/mathml-extractor.js";
import { getElementOrigin } from "./geometry.js";

/**
 * Extract the full IR from one or more root DOM elements.
 * All coordinates in the returned IR are relative to the coordinate root's
 * top-left corner (border box), not the page origin.
 *
 * When an array of elements is passed, each element is traversed and extracted
 * independently, then results are merged in array order. Use `options.coordinateRoot`
 * to specify which element's origin to use for coordinates (defaults to the
 * first element).
 *
 * This is the main pipeline entry point.
 */
export async function extractIR(root: Element | Element[], options: Options = {}): Promise<IRNode[]> {
  const roots = Array.isArray(root) ? root : [root];
  if (roots.length === 0) return [];

  // Clear image rasterization cache from previous runs
  clearImageCache();

  // Pre-fetch external images into internal caches (non-destructive to page DOM)
  if (options.includeImages) {
    for (const rootEl of roots) {
      await preloadImages(rootEl);
    }
  }

  const irNodes: IRNode[] = [];
  let globalIndex = 0;

  for (const rootEl of roots) {
    // 1. Traverse DOM and build stacking context tree
    const stackingTree = traverseDOM(
      rootEl,
      options.includeInvisible ?? false,
      options.walkIframes ?? false
    );

    // 2. Flatten to paint order
    const ordered = flattenStackingOrder(stackingTree);

    // 3. Extract geometry from each node (in absolute page coordinates)
    for (const node of ordered) {
      const el = node.element;

      // Propagate clip bounds from the stacking tree into the extracted style
      if (node.clipBounds) {
        node.extractedStyle.clipBounds = node.clipBounds;
      }
      if (node.clipQuads?.length) {
        node.extractedStyle.clipQuads = node.clipQuads;
      }

      // SVG root elements: extract HTML box first (background, borders),
      // then the SVG subtree on top. The HTML box must come first so
      // the SVG content paints over it (correct paint order).
      if (isSVGRoot(el)) {
        const htmlNodes = await extractHTMLGeometry(node, globalIndex, options);
        transformIRGeometry(htmlNodes, node.coordinateTransform);
        irNodes.push(...htmlNodes);
        globalIndex += htmlNodes.length || 1;

        const svgNodes = extractSVGSubtree(
          el as SVGSVGElement,
          globalIndex,
          options,
          // Pass accumulated HTML parent opacity (excluding SVG root's own)
          // so the SVG extractor can combine it with the SVG element tree opacity.
          (node.extractedStyle.opacity ?? 1) / (parseFloat(getComputedStyle(el).opacity || '1') || 1)
        );
        transformIRGeometry(svgNodes, node.coordinateTransform);
        irNodes.push(...svgNodes);
        globalIndex += svgNodes.length || 1;
        continue;
      }

      // Skip non-root SVG children (already handled by SVG subtree extraction)
      if (isSVGElement(el)) {
        continue;
      }

      // MathML root: extract decorations (fraction bars, radical overlines)
      if (isMathMLRoot(el)) {
        const mathNodes = extractMathMLFeatures(el, node.extractedStyle, globalIndex, options);
        transformIRGeometry(mathNodes, node.coordinateTransform);
        irNodes.push(...mathNodes);
        globalIndex += mathNodes.length;
      }

      // HTML element extraction
      const htmlNodes = await extractHTMLGeometry(node, globalIndex, options);
      transformIRGeometry(htmlNodes, node.coordinateTransform);
      irNodes.push(...htmlNodes);
      globalIndex += htmlNodes.length || 1;

      // Image element extraction (on top of HTML geometry)
      if (options.includeImages && isImageElement(el)) {
        const imageNodes = extractImageGeometry(el, node.extractedStyle, globalIndex, options);
        transformIRGeometry(imageNodes, node.coordinateTransform);
        irNodes.push(...imageNodes);
        globalIndex += imageNodes.length || 1;
      }

      // CSS background-image url() extraction
      if (options.includeImages && hasBackgroundImage(node.extractedStyle)) {
        const bgNodes = extractBackgroundImage(el, node.extractedStyle, globalIndex, options);
        transformIRGeometry(bgNodes, node.coordinateTransform);
        irNodes.push(...bgNodes);
        globalIndex += bgNodes.length || 1;
      }
    }
  }

  // 4. Offset coordinates so they are relative to the coordinate root's top-left
  //    and apply zoom in a single pass if both are needed
  const coordRoot = options.coordinateRoot ?? roots[0];
  const rootOrigin = getElementOrigin(coordRoot);
  const zoom = options.zoom ?? 1;

  if (zoom !== 1) {
    offsetAndScaleIRNodes(irNodes, rootOrigin.x, rootOrigin.y, zoom);
  } else {
    offsetIRNodes(irNodes, rootOrigin.x, rootOrigin.y);
  }

  return irNodes;
}

function transformIRGeometry(nodes: IRNode[], transform: StackingNode["coordinateTransform"]): void {
  if (
    transform.a === 1 &&
    transform.b === 0 &&
    transform.c === 0 &&
    transform.d === 1 &&
    transform.e === 0 &&
    transform.f === 0
  ) {
    return;
  }

  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        for (const point of node.points) {
          applyTransformToPoint(point, transform);
        }
        break;
      case "polyline":
        for (const point of node.points) {
          applyTransformToPoint(point, transform);
        }
        break;
      case "text":
        for (const point of node.quad) {
          applyTransformToPoint(point, transform);
        }
        break;
      case "image":
        for (const point of node.quad) {
          applyTransformToPoint(point, transform);
        }
        break;
    }
  }
}

function applyTransformToPoint(
  point: { x: number; y: number },
  transform: StackingNode["coordinateTransform"]
): void {
  const nextX = transform.a * point.x + transform.c * point.y + transform.e;
  const nextY = transform.b * point.x + transform.d * point.y + transform.f;
  point.x = nextX;
  point.y = nextY;
}

/**
 * Subtract (ox, oy) from every coordinate in the IR node list,
 * converting from absolute page coordinates to root-relative coordinates.
 */
function offsetIRNodes(nodes: IRNode[], ox: number, oy: number): void {
  if (ox === 0 && oy === 0) return;
  // Track already-offset clipBounds objects to avoid double-offsetting
  // (multiple IR nodes can share the same clipBounds reference).
  const offsetClips = new Set<NonNullable<IRNode["style"]["clipBounds"]>>();
  const offsetClipQuads = new Set<NonNullable<IRNode["style"]["clipQuads"]>>();
  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        for (const p of node.points) { p.x -= ox; p.y -= oy; }
        break;
      case "polyline":
        for (const p of node.points) { p.x -= ox; p.y -= oy; }
        break;
      case "text":
        for (const p of node.quad) { p.x -= ox; p.y -= oy; }
        break;
      case "image":
        for (const p of node.quad) { p.x -= ox; p.y -= oy; }
        break;
    }
    // Also offset clipBounds if present (only once per unique object)
    if (node.style.clipBounds && !offsetClips.has(node.style.clipBounds)) {
      node.style.clipBounds.x -= ox;
      node.style.clipBounds.y -= oy;
      offsetClips.add(node.style.clipBounds);
    }
    if (node.style.clipQuads && !offsetClipQuads.has(node.style.clipQuads)) {
      for (const clipQuad of node.style.clipQuads) {
        for (const point of clipQuad.points) {
          point.x -= ox;
          point.y -= oy;
        }
      }
      offsetClipQuads.add(node.style.clipQuads);
    }
  }
}

/**
 * Scale all coordinates in the IR node list by the given factor.
 * Also scales font sizes, stroke widths, border widths, and clip bounds.
 */
function scaleIRNodes(nodes: IRNode[], zoom: number): void {
  const scaledClips = new Set<NonNullable<IRNode["style"]["clipBounds"]>>();
  const scaledClipQuads = new Set<NonNullable<IRNode["style"]["clipQuads"]>>();
  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        for (const p of node.points) { p.x *= zoom; p.y *= zoom; }
        break;
      case "polyline":
        for (const p of node.points) { p.x *= zoom; p.y *= zoom; }
        break;
      case "text":
        for (const p of node.quad) { p.x *= zoom; p.y *= zoom; }
        break;
      case "image":
        for (const p of node.quad) { p.x *= zoom; p.y *= zoom; }
        node.width = Math.round(node.width * zoom);
        node.height = Math.round(node.height * zoom);
        break;
    }
    // Scale style properties that carry dimensional values
    const s = node.style;
    if (s.fontSize) { const v = parseFloat(s.fontSize); if (!isNaN(v)) s.fontSize = `${v * zoom}px`; }
    if (s.strokeWidth) { const v = parseFloat(s.strokeWidth); if (!isNaN(v)) s.strokeWidth = `${v * zoom}px`; }
    if (s.borderTopWidth) { const v = parseFloat(s.borderTopWidth); if (!isNaN(v)) s.borderTopWidth = `${v * zoom}px`; }
    if (s.borderRightWidth) { const v = parseFloat(s.borderRightWidth); if (!isNaN(v)) s.borderRightWidth = `${v * zoom}px`; }
    if (s.borderBottomWidth) { const v = parseFloat(s.borderBottomWidth); if (!isNaN(v)) s.borderBottomWidth = `${v * zoom}px`; }
    if (s.borderLeftWidth) { const v = parseFloat(s.borderLeftWidth); if (!isNaN(v)) s.borderLeftWidth = `${v * zoom}px`; }
    if (s.borderRadius) {
      s.borderRadius = s.borderRadius.split(/\s+/).map(v => {
        const n = parseFloat(v);
        return isNaN(n) ? v : `${n * zoom}px`;
      }).join(" ");
    }
    if (s.clipBounds && !scaledClips.has(s.clipBounds)) {
      s.clipBounds.x *= zoom;
      s.clipBounds.y *= zoom;
      s.clipBounds.w *= zoom;
      s.clipBounds.h *= zoom;
      s.clipBounds.radius *= zoom;
      scaledClips.add(s.clipBounds);
    }
    if (s.clipQuads && !scaledClipQuads.has(s.clipQuads)) {
      for (const clipQuad of s.clipQuads) {
        for (const point of clipQuad.points) {
          point.x *= zoom;
          point.y *= zoom;
        }
        clipQuad.radius *= zoom;
      }
      scaledClipQuads.add(s.clipQuads);
    }
  }
}

/**
 * Combined offset + scale in a single pass over all nodes.
 * Subtracts (ox, oy) then multiplies by zoom for every coordinate.
 */
function offsetAndScaleIRNodes(nodes: IRNode[], ox: number, oy: number, zoom: number): void {
  const processedClips = new Set<NonNullable<IRNode["style"]["clipBounds"]>>();
  const processedClipQuads = new Set<NonNullable<IRNode["style"]["clipQuads"]>>();
  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        for (const p of node.points) { p.x = (p.x - ox) * zoom; p.y = (p.y - oy) * zoom; }
        break;
      case "polyline":
        for (const p of node.points) { p.x = (p.x - ox) * zoom; p.y = (p.y - oy) * zoom; }
        break;
      case "text":
        for (const p of node.quad) { p.x = (p.x - ox) * zoom; p.y = (p.y - oy) * zoom; }
        break;
      case "image":
        for (const p of node.quad) { p.x = (p.x - ox) * zoom; p.y = (p.y - oy) * zoom; }
        node.width = Math.round(node.width * zoom);
        node.height = Math.round(node.height * zoom);
        break;
    }
    // Scale style properties
    const s = node.style;
    if (s.fontSize) { const v = parseFloat(s.fontSize); if (!isNaN(v)) s.fontSize = `${v * zoom}px`; }
    if (s.strokeWidth) { const v = parseFloat(s.strokeWidth); if (!isNaN(v)) s.strokeWidth = `${v * zoom}px`; }
    if (s.borderTopWidth) { const v = parseFloat(s.borderTopWidth); if (!isNaN(v)) s.borderTopWidth = `${v * zoom}px`; }
    if (s.borderRightWidth) { const v = parseFloat(s.borderRightWidth); if (!isNaN(v)) s.borderRightWidth = `${v * zoom}px`; }
    if (s.borderBottomWidth) { const v = parseFloat(s.borderBottomWidth); if (!isNaN(v)) s.borderBottomWidth = `${v * zoom}px`; }
    if (s.borderLeftWidth) { const v = parseFloat(s.borderLeftWidth); if (!isNaN(v)) s.borderLeftWidth = `${v * zoom}px`; }
    if (s.borderRadius) {
      s.borderRadius = s.borderRadius.split(/\s+/).map(v => {
        const n = parseFloat(v);
        return isNaN(n) ? v : `${n * zoom}px`;
      }).join(" ");
    }
    if (s.clipBounds && !processedClips.has(s.clipBounds)) {
      s.clipBounds.x = (s.clipBounds.x - ox) * zoom;
      s.clipBounds.y = (s.clipBounds.y - oy) * zoom;
      s.clipBounds.w *= zoom;
      s.clipBounds.h *= zoom;
      s.clipBounds.radius *= zoom;
      processedClips.add(s.clipBounds);
    }
    if (s.clipQuads && !processedClipQuads.has(s.clipQuads)) {
      for (const clipQuad of s.clipQuads) {
        for (const point of clipQuad.points) {
          point.x = (point.x - ox) * zoom;
          point.y = (point.y - oy) * zoom;
        }
        clipQuad.radius *= zoom;
      }
      processedClipQuads.add(s.clipQuads);
    }
  }
}

/** Check if a color string represents a visible (non-transparent) color. */
function isVisibleColor(color: string | undefined): boolean {
  if (!color || color === "transparent" || color === "none") return false;
  const m = color.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+))?\s*\)/);
  if (m && m[1] !== undefined && parseFloat(m[1]) <= 0) return false;
  if (color.startsWith("#") && color.length === 9) {
    if (parseInt(color.slice(7, 9), 16) === 0) return false;
  }
  return true;
}

function hasVisibleOutline(style: IRNode["style"]): boolean {
  if (!style.outlineWidth || parseFloat(style.outlineWidth) <= 0) return false;
  if (!style.outlineStyle || style.outlineStyle === "none") return false;
  return isVisibleColor(style.outlineColor ?? style.color ?? style.stroke ?? style.fill);
}

/**
 * Check whether an IR node contributes any visible output.
 * Filters out empty polygons/polylines with no fill, no stroke, no box-shadow, and no gradient.
 */
function isVisibleNode(node: IRNode): boolean {
  switch (node.type) {
    case "polygon": {
      const s = node.style;
      if (isVisibleColor(s.fill)) return true;
      if (isVisibleColor(s.stroke) && s.strokeWidth && parseFloat(s.strokeWidth) > 0) return true;
      if (hasVisibleOutline(s)) return true;
      if (s.boxShadow && s.boxShadow !== "none") return true;
      // Check for gradient or url() background
      if (s.backgroundImage && s.backgroundImage !== "none") return true;
      // Check individual border colors (mixed borders)
      if (isVisibleColor(s.borderTopColor) && s.borderTopWidth && parseFloat(s.borderTopWidth) > 0) return true;
      if (isVisibleColor(s.borderRightColor) && s.borderRightWidth && parseFloat(s.borderRightWidth) > 0) return true;
      if (isVisibleColor(s.borderBottomColor) && s.borderBottomWidth && parseFloat(s.borderBottomWidth) > 0) return true;
      if (isVisibleColor(s.borderLeftColor) && s.borderLeftWidth && parseFloat(s.borderLeftWidth) > 0) return true;
      return false;
    }
    case "polyline": {
      const s = node.style;
      if (node.closed && isVisibleColor(s.fill)) return true;
      if (isVisibleColor(s.stroke) && s.strokeWidth && parseFloat(s.strokeWidth) > 0) return true;
      return false;
    }
    case "text":
      return node.text.trim().length > 0;
    case "image":
      return true;
  }
}

/**
 * Render IR nodes through a writer.
 * Processes nodes in order (already sorted by the pipeline).
 * Invisible nodes (empty polygons with no fill/stroke/shadow) are automatically skipped.
 */
export async function renderIR<T>(nodes: IRNode[], writer: Writer<T>): Promise<T> {
  await writer.begin();

  for (const node of nodes) {
    if (!isVisibleNode(node)) continue;
    switch (node.type) {
      case "polygon":
        await writer.drawPolygon(node.points, node.style);
        break;
      case "text":
        await writer.drawText(node.quad, node.text, node.style);
        break;
      case "polyline":
        await writer.drawPolyline(node.points, node.closed, node.style);
        break;
      case "image":
        if (writer.drawImage) {
          await writer.drawImage(node.quad, node.dataUrl, node.width, node.height, node.style, node.rgbData);
        }
        break;
    }
  }

  return await writer.end();
}
