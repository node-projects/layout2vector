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
import { extractHTMLGeometry } from "./html-extractor.js";
import { extractSVGSubtree } from "./svg-extractor.js";
import { isImageElement, extractImageGeometry, hasBackgroundImage, extractBackgroundImage } from "./image-extractor.js";
import { isMathMLRoot, extractMathMLFeatures } from "./mathml-extractor.js";
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
export function extractIR(root: Element | Element[], options: Options = {}): IRNode[] {
  const roots = Array.isArray(root) ? root : [root];
  if (roots.length === 0) return [];

  const irNodes: IRNode[] = [];
  let globalIndex = 0;

  for (const rootEl of roots) {
    // 1. Traverse DOM and build stacking context tree
    const stackingTree = traverseDOM(rootEl, options.includeInvisible ?? false);

    // 2. Flatten to paint order
    const ordered = flattenStackingOrder(stackingTree);

    // 3. Extract geometry from each node (in absolute page coordinates)
    for (const node of ordered) {
      const el = node.element;

      // Propagate clip bounds from the stacking tree into the extracted style
      if (node.clipBounds) {
        node.extractedStyle.clipBounds = node.clipBounds;
      }

      // SVG root elements: extract HTML box first (background, borders),
      // then the SVG subtree on top. The HTML box must come first so
      // the SVG content paints over it (correct paint order).
      if (isSVGRoot(el)) {
        const htmlNodes = extractHTMLGeometry(node, globalIndex, options);
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
        irNodes.push(...mathNodes);
        globalIndex += mathNodes.length;
      }

      // HTML element extraction
      const htmlNodes = extractHTMLGeometry(node, globalIndex, options);
      irNodes.push(...htmlNodes);
      globalIndex += htmlNodes.length || 1;

      // Image element extraction (on top of HTML geometry)
      if (options.includeImages && isImageElement(el)) {
        const imageNodes = extractImageGeometry(el, node.extractedStyle, globalIndex, options);
        irNodes.push(...imageNodes);
        globalIndex += imageNodes.length || 1;
      }

      // CSS background-image url() extraction
      if (options.includeImages && hasBackgroundImage(node.extractedStyle)) {
        const bgNodes = extractBackgroundImage(el, node.extractedStyle, globalIndex, options);
        irNodes.push(...bgNodes);
        globalIndex += bgNodes.length || 1;
      }
    }
  }

  // 4. Offset coordinates so they are relative to the coordinate root's top-left
  const coordRoot = options.coordinateRoot ?? roots[0];
  const rootOrigin = getElementOrigin(coordRoot);
  offsetIRNodes(irNodes, rootOrigin.x, rootOrigin.y);

  return irNodes;
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
  }
}

/**
 * Render IR nodes through a writer.
 * Processes nodes in order (already sorted by the pipeline).
 */
export function renderIR<T>(nodes: IRNode[], writer: Writer<T>): T {
  writer.begin();

  for (const node of nodes) {
    switch (node.type) {
      case "polygon":
        writer.drawPolygon(node.points, node.style);
        break;
      case "text":
        writer.drawText(node.quad, node.text, node.style);
        break;
      case "polyline":
        writer.drawPolyline(node.points, node.closed, node.style);
        break;
      case "image":
        if (writer.drawImage) {
          writer.drawImage(node.quad, node.dataUrl, node.width, node.height, node.style, node.rgbData);
        }
        break;
    }
  }

  return writer.end();
}
