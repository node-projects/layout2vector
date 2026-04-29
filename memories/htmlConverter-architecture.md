# @node-projects/layout2vector Codebase Architecture

## Project Overview
A TypeScript/ESM library that extracts rendered layout geometry from a live DOM (HTML, SVG, CSS transforms, Shadow DOM) and converts to DXF or PDF output. **Zero external dependencies for core** except `@tarikjabiri/dxf` for DXF serialization.

**Package:** `@node-projects/layout2vector`

## Core Three-Stage Pipeline

### Stage 1: DOM Extraction (traversal.ts + extractors)
- **traverseDOM()**: Builds stacking context tree from DOM
  - Handles Shadow DOM (open roots)
  - Computes stacking contexts (z-index, opacity, transform rules)
  - Collects text nodes separately
  - Checks visibility (display:none, visibility:hidden, opacity:0)
  - Overflow clipping for static export is decided in traversal.ts: hidden, clip, scroll, auto, and overlay all create inherited clipBounds so non-scrollable outputs render the visible scrollport rather than full overflow content.
- **flattenStackingOrder()**: Flattens tree to paint order:
  - Negative z-index children → self → zero z-index → positive z-index
  - Maintains stable sort within same z-index

### Stage 2: Intermediate Representation (IR) Generation (pipeline.ts)
**IRNode** = discriminated union of:
- `polygon`: Quad (4 points) + style (for rectangles, SVG shapes)
- `polyline`: Point[] + closed:bool + style
- `text`: Quad + text string + style (HTML text nodes)
- `image`: Quad + dataUrl + width/height + optional rgbData + style

Each node has: type, style (subset of CSS), zIndex (paint order)

### Stage 3: Writer Output (writers)
Pluggable interface `Writer<T>`:
- `begin()` → `drawPolygon|drawPolyline|drawText|drawImage` → `end(): T`
- **DXFWriter** → DXF string (@tarikjabiri/dxf backend)
- **PDFWriter** → PdfDocument (custom pdf-lite implementation)

## Key Components

### src/index.ts (Public API)
```
export type { Point, Quad, Style, IRNode, Options, Writer }
export { extractIR, renderIR }
export { DXFWriter, PDFWriter }
export { traverseDOM, flattenStackingOrder, ... }  // advanced utilities
```

### src/types.ts (Core Data Model)
- **Point**: `{ x: number; y: number }`
- **Quad**: `[Point, Point, Point, Point]` = 4-corner polygon (top-left, top-right, bottom-right, bottom-left)
- **Style**: Subset of CSS (fill, stroke, fontSize, fontFamily, fontWeight, borderRadius, transform, etc.)
- **IRNode**: Union type above
- **Options**: boxType ("border"|"content"), includeText, includeImages, includeInvisible

### src/traversal.ts (DOM → Stacking Tree)
- **StackingNode**: { element, style, extractedStyle, createsStackingContext, children[], textNodes[], zIndex }
- **extractStyle()**: Extracts computed styles relevant to rendering
- **createsStackingContext()**: Detects z-index layers (position+z-index, opacity<1, transform, filter, etc.)
- **isVisible()**: Checks display:none, visibility:hidden, opacity:0
- **isSVGElement()** / **isSVGRoot()**: Distinguish SVG namespace elements

### src/html-extractor.ts (HTML Geometry)
- **extractHTMLGeometry()**: Uses `getBoxQuads()` with `getBoundingClientRect()` fallback
- **extractTextNode()**: Uses `Range.getClientRects()` for per-line text splitting
- Per-visual-line text splitting handles text wrapping correctly
- Applies textTransform (uppercase, lowercase, capitalize)

### src/svg-extractor.ts (SVG Geometry)
- **extractSVGSubtree()**: Walks SVG tree in DOM order (no z-index in SVG)
- Shape handlers:
  - `rect`: Axis-aligned quad
  - `circle`/`ellipse`: 32-segment polyline approximation
  - `line`/`polyline`/`polygon`: Direct point extraction
  - `path`: Via `getTotalLength()` + `getPointAtLength()` (64 sample points)
  - `text`: Text extraction with styling
  - `marker`: Arrow/marker extraction with transformation
- **getCtm()**: Gets screen transformation matrix
- Handles `url(#gradient)` references and extracts first stop color

### src/image-extractor.ts (Images & Background Images)
- **<img> elements**:
  - SVG images → vector geometry extraction (recursive extractSVGSubtree)
  - Raster images → embedded as data URL
- **CSS background-image**:
  - `url()` patterns: vector SVG or rasterized to PNG
  - Gradients: passed through to writers
  - Rasterization via canvas (cross-origin workaround via XHR + blob)
- **preloadImages()**: Pre-converts file:// URLs to data URLs (avoids canvas tainting in Chromium)

### src/dxf-writer.ts (DXF Output)
- Uses `@tarikjabiri/dxf` library (LWPOLYLINE, HATCH, TEXT, IMAGE entities)
- Color conversion: CSS colors → 24-bit trueColor integers
- Rounded rectangles: Arc approximation (8 segments per corner)
- Stroke handling: Border vs. fill style separation
- Images: Referenced as external files via `imageFiles: Map<string, string>` (path → dataUrl)
- Y-axis flipping: DXF Y-up vs. browser Y-down
- Transparency skipping: alpha=0 or "transparent" → ignored

### src/pdflite-writer.ts (PDF Output)
- Custom **zero-dependency PDF implementation** (`pdf-objects.ts`)
- Features:
  - Type1 standard fonts (Helvetica, Times, Courier + bold variants)
  - Linear & radial gradients (via PDF shading functions)
  - ExtGState transparency (opacity)
  - Raster image embedding (JPEG via DCTDecode or raw RGB)
  - Text with rotation support
- Color functions: Type 2 (2-color) and Type 3 (multi-stop stitching)
- Page dimensions: Configurable (default A4 210×297mm)
- Coordinate conversion: px → pt (×0.75)

### src/pdf-objects.ts (PDF Serialization)
Minimal PDF 1.4 object model:
- **PdfName, PdfNumber, PdfBoolean, PdfArray, PdfDictionary, PdfStream**
- **PdfReference**: Object numbering
- **PdfIndirectObject**: Wrapper for indirect refs
- **PdfFont, PdfPage, PdfPages**
- **PdfDocument**: Single-page document with:
  - Cross-reference (xref) table
  - Trailer dictionary
  - Binary stream support (for image DCTDecode)

## Data Flow

```
HTML/DOM (browser context)
  ↓
traverseDOM(root)         → StackingNode tree
  ↓
flattenStackingOrder()    → StackingNode[] (paint order)
  ↓
extractHTMLGeometry()     → IRNode[] (HTML elements)
extractSVGSubtree()       → IRNode[] (SVG shapes)
extractImageGeometry()    → IRNode[] (images)
  ↓ (concatenate + offset to root-relative coords)
ir: IRNode[]
  ↓
renderIR(ir, writer)      → writer.begin()
                           → for each node: drawPolygon/drawPolyline/drawText/drawImage
                           → writer.end()
  ↓
DXF string / PDF document
```

## Important Design Decisions

1. **Stacking Context Tree Flattening**: Maintains CSS paint order (not DOM order)
2. **Text Splitting**: Per-visual-line via Range.getClientRects() (vs. single quad)
3. **SVG in <img> Tags**: Converted to vector geometry when possible (recursive extraction)
4. **Canvas Tainting Workaround**: file:// and cross-origin URLs converted to data URLs before extraction
5. **PDF Zero-Dependency**: Custom minimal PDF object model (1.4 spec) avoids external deps
6. **Opacity Handling**: IR includes style.opacity for per-element transparency in writers
7. **Border Radius**: DXF/PDF arc approximation for rounded corners
8. **Gradient Strategy**: Canvas/Image use native canvas gradients (`linear`, `radial`, `conic`), PDF uses native shading for linear/radial plus sector slices for conic, SVG uses native defs for linear/radial plus a pattern of sector paths for conic because SVG has no native conic gradient primitive, and CAD/EMF writers fall back to solid fill when gradients are unsupported.
- SVG conic fallback detail: the `<pattern>` tile must keep `patternUnits="userSpaceOnUse"` for placement, but the sector paths need to be emitted in local tile coordinates with a `viewBox`; Firefox can serialize the pattern yet paint only the base fill if the sector geometry is authored in page-space coordinates.

9. **Coordinate Systems**: All IR in absolute page coords → then offset to root-relative

## Testing Strategy

1. **Unit tests** (`tests/unit/`): Writers (DXF/PDF IR structure), specific extractors
2. **Integration tests** (`tests/integration/`): Full pipeline, stacking contexts, determinism
3. **UI tests** (`tests/ui/`): Flexbox, grid, CSS transforms, nested layouts, Shadow DOM
4. **Demo tests** (`tests/demos/`): Large HTML files → file outputs (DXF + PDF)
5. **Screenshot tests**: Visual verification of rendered outputs via Playwright

## Dependencies

**Runtime:**
- `@tarikjabiri/dxf`: ^2.8.9 (DXF serialization only; optional for DXFWriter)

**Dev:**
- TypeScript 6.0.2
- Playwright 1.59.1
- get-box-quads-polyfill (for dev/testing)
- Node.js types

## File Organization

```
src/
  types.ts              → Core types (IRNode, Style, etc.)
  traversal.ts          → DOM tree + stacking context
  html-extractor.ts     → HTML geometry via getBoxQuads + Range API
  svg-extractor.ts      → SVG shapes via SVG native APIs
  image-extractor.ts    → <img> and background-image extraction
  pipeline.ts           → extractIR + renderIR orchestration
  dxf-writer.ts         → DXF output (@tarikjabiri/dxf)
  pdflite-writer.ts     → PDF output (custom)
- Source layout is now split by ownership: `src/extractors/` for extraction modules, `src/writers/` for output backends, `src/writers/shared/` for writer-only helpers, and `src/shared/` for cross-cutting helpers used outside writers.
- `src/extractors/pseudo-extractor.ts` handles ::before/::after pseudo-element extraction with CSS counter()/counters()/attr()/open-quote/close-quote resolution via DOM tree walking. The geometry is measured by temporarily suppressing the real pseudo-element and inserting a replacement `<hc-pseudo>` element measured via getBoxQuads. Option `includePseudoElements` (default true) controls this in pipeline.ts.
- CSS `corner-shape` / `superellipse()` support: `Style.cornerShapes?: [number, number, number, number]` (TL, TR, BR, BL K values). Extracted in `extractStyle()` via `getPropertyValue("corner-*-shape")`. `roundedQuadPath()` in `geometry.ts` accepts `cornerShapes` and generates superellipse curves. Writers skip native rounded-rect primitives when cornerShapes is set, falling through to `roundedQuadPath()`. Chrome 139+ only (Firefox doesn't support corner-shape). The math: for K>0 convex shapes use `R*(1 - sin(θ)^(1/K))` parametric form; K=0 is bevel (straight line); K<0 concave shapes use reflection `R*cos(θ)^(1/|K|)`. Special cases: K≥10 → square (corner vertex), K≤-10 → notch (mirror point).

  pdf-objects.ts        → PDF 1.4 serialization
  index.ts              → Public API exports
tests/
  helpers.ts            → Playwright utilities + library injection
- Playwright browser tests inject the built `dist/` bundle from `tests/helpers.ts`; after changing `src/`, run `npm run build` before trusting browser-side test results.

  demos/                → Large demo HTML files → DXF/PDF output
  unit/                 → Core functionality tests
  integration/          → End-to-end pipeline tests
  ui/                   → Layout/rendering tests
```
