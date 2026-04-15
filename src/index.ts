/**
 * @node-projects/html-converter
 *
 * DOM → Geometry → DXF/PDF library.
 * Extracts rendered layout geometry from a live DOM and converts it to DXF or PDF.
 */

// Core types
export type { Point, Quad, Style, IRNode, Options, Writer, TextMeasurementMode } from "./types.js";

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

// Geometry utilities
export { getElementQuad, getElementQuads, getElementOrigin, quadSize, getSvgScreenCtm, roundedQuadPath, type PathSegment } from "./geometry.js";

// Extractors (advanced usage)
export { extractHTMLGeometry } from "./extractors/html-extractor.js";
export { extractSVGSubtree } from "./extractors/svg-extractor.js";
export { extractImageGeometry, isImageElement, hasBackgroundImage, extractBackgroundImage, preloadImages } from "./extractors/image-extractor.js";
export { isMathMLRoot, isMathMLElement, extractMathMLFeatures } from "./extractors/mathml-extractor.js";
export { extractPseudoElements, parseCSSContentValue } from "./extractors/pseudo-extractor.js";

// Writers
export { DXFWriter, type DXFWriterOptions } from "./writers/dxf-writer.js";
export { EMFWriter, type EMFWriterOptions } from "./writers/emf-writer.js";
export { PDFWriter, type PDFWriterOptions } from "./writers/pdf-writer.js";
export { CanvasWriter, type CanvasWriterOptions } from "./writers/canvas-writer.js";
export { ImageWriter, ImageResult, type ImageWriterOptions } from "./writers/image-writer.js";
/** @deprecated Use ImageWriter/ImageResult/ImageWriterOptions instead. */
export { PNGWriter, PNGResult, type PNGWriterOptions } from "./writers/png-writer.js";
export { SVGWriter, type SVGWriterOptions } from "./writers/svg-writer.js";
export { HTMLWriter, type HTMLImageMode, type HTMLWriterOptions } from "./writers/html-writer.js";
export { DWGWriter, type DWGWriterOptions, AcadDXFWriter, type AcadDXFWriterOptions } from "./writers/acad-writer.js";

// Font utilities
export { parseTTF, type ParsedTTF } from "./ttf-parser.js";
