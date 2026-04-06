/**
 * @node-projects/html-converter
 *
 * DOM → Geometry → DXF/PDF library.
 * Extracts rendered layout geometry from a live DOM and converts it to DXF or PDF.
 */

// Core types
export type { Point, Quad, Style, IRNode, Options, Writer } from "./types.js";

// Pipeline
export { extractIR, renderIR } from "./pipeline.js";

// Traversal (advanced usage)
export {
  traverseDOM,
  flattenStackingOrder,
  extractStyle,
  isVisible,
  createsStackingContext,
  isSVGElement,
  isSVGRoot,
  type StackingNode,
} from "./traversal.js";

// Extractors (advanced usage)
export { extractHTMLGeometry } from "./html-extractor.js";
export { extractSVGSubtree } from "./svg-extractor.js";

// Writers
export { DXFWriter } from "./dxf-writer.js";
export { PDFWriter } from "./pdflite-writer.js";
