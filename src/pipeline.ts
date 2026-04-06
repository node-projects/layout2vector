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
import { isImageElement, extractImageGeometry } from "./image-extractor.js";

/**
 * Extract the full IR from a root DOM element.
 * This is the main pipeline entry point.
 */
export function extractIR(root: Element, options: Options = {}): IRNode[] {
  // 1. Traverse DOM and build stacking context tree
  const stackingTree = traverseDOM(root, options.includeInvisible ?? false);

  // 2. Flatten to paint order
  const ordered = flattenStackingOrder(stackingTree);

  // 3. Extract geometry from each node
  const irNodes: IRNode[] = [];
  let globalIndex = 0;

  for (const node of ordered) {
    const el = node.element;

    // SVG root elements get their entire subtree extracted separately
    if (isSVGRoot(el)) {
      const svgNodes = extractSVGSubtree(
        el as SVGSVGElement,
        globalIndex,
        options
      );
      irNodes.push(...svgNodes);
      globalIndex += svgNodes.length || 1;
      continue;
    }

    // Skip non-root SVG children (already handled by SVG subtree extraction)
    if (isSVGElement(el)) {
      continue;
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
  }

  return irNodes;
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
          writer.drawImage(node.quad, node.dataUrl, node.width, node.height, node.style);
        }
        break;
    }
  }

  return writer.end();
}
