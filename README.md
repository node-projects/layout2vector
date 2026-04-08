# @node-projects/layout2vector

[![npm version](https://img.shields.io/npm/v/%40node-projects%2Flayout2vector)](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

A TypeScript (ESM) library that extracts rendered layout geometry from a live DOM — including HTML, SVG, CSS transforms, and Shadow DOM — and converts it to **DXF**, **PDF**, **PNG**, **SVG**, or **HTML**.

## Overview

layout2vector works in three stages:

1. **DOM Extraction** — Traverses the live DOM (including open Shadow DOM trees), computes stacking context order, and uses `getBoxQuads()` / `getBoundingClientRect()` for HTML geometry and SVG-native APIs (`getCTM`, `getBBox`, `getTotalLength`, `getPointAtLength`) for SVG geometry.
2. **Intermediate Representation (IR)** — A flat, renderer-independent array of typed nodes (`polygon`, `polyline`, `text`, `image`) ordered by paint order, each carrying a style subset.
3. **Writers** — Pluggable output backends. Built-in writers for DXF (via `@tarikjabiri/dxf`), PDF (custom lightweight PDF generator), PNG (via Canvas 2D API), SVG, and HTML. Implement the `Writer<T>` interface to add your own.

## Installation

Package: [@node-projects/layout2vector](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

```bash
npm install @node-projects/layout2vector
```

## Quick Start

```ts
import { extractIR, renderIR, DXFWriter, PDFWriter, PNGWriter, SVGWriter, HTMLWriter } from "@node-projects/layout2vector";

// In a browser context (e.g. Playwright, Puppeteer, or a web page):
const root = document.getElementById("my-element")!;

// 1. Extract geometry from the live DOM
const ir = extractIR(root, {
  boxType: "border",      // "border" | "content"
  includeText: true,       // extract text node geometry
  includeInvisible: false, // skip display:none / visibility:hidden
});

// 2. Render to DXF
const dxfWriter = new DXFWriter(document.documentElement.scrollHeight);
const dxfString = renderIR(ir, dxfWriter);
// dxfString is a complete .dxf file as a string

// 3. Render to PDF
const pdfWriter = new PDFWriter(); // defaults to A4
const pdfDoc = renderIR(ir, pdfWriter); // returns a PdfDocument
await pdfDoc.finalize();
const pdfBytes = pdfDoc.toBytes(); // Uint8Array

// 4. Render to PNG (requires Canvas-capable environment)
const pngWriter = new PNGWriter(800, 600); // width, height in px
const pngResult = renderIR(ir, pngWriter);
await pngResult.finalize(); // loads and draws raster images
const pngDataUrl = pngResult.toDataURL(); // data:image/png;base64,...
const pngBytes = pngResult.toBytes(); // Uint8Array

// 5. Render to SVG
const svgWriter = new SVGWriter(800, 600); // width, height in px
const svgString = renderIR(ir, svgWriter);
// svgString is a complete standalone SVG document

// 6. Render to HTML
const htmlWriter = new HTMLWriter(800, 600); // width, height in px
const htmlString = renderIR(ir, htmlWriter);
// htmlString is a complete standalone HTML document
```

## API Reference

### Pipeline

#### `extractIR(root: Element, options?: Options): IRNode[]`

Main entry point. Traverses the DOM tree under `root`, builds a stacking context tree, flattens to paint order, and extracts geometry from each element.

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `boxType` | `"border" \| "content"` | `"border"` | Which CSS box to use for element quads |
| `includeText` | `boolean` | `true` | Whether to extract text node geometry |
| `includeImages` | `boolean` | `false` | Whether to extract `<img>` element content (see [Image Handling](#image-handling)) |
| `includeInvisible` | `boolean` | `false` | Include `display:none` / `visibility:hidden` elements |
| `flattenTransforms` | `boolean` | — | Reserved for future use |

#### `renderIR<T>(nodes: IRNode[], writer: Writer<T>): T`

Passes each IR node through the writer in paint order. Returns whatever the writer's `end()` method returns.

### Writers

#### `DXFWriter`

```ts
new DXFWriter(maxY?: number)
```

Produces a DXF string via `@tarikjabiri/dxf`. The `maxY` parameter (default 1000) is used to flip the Y axis (browser Y-down → DXF Y-up).

- Polygons → closed `LWPOLYLINE` entities
- Polylines → `LWPOLYLINE` entities (open or closed)
- Filled SVG shapes → `HATCH` entities with `SOLID` pattern (closed polylines with fill color)
- Text → `TEXT` entities
- Rounded rectangles → `LWPOLYLINE` with arc-approximated corners
- Colors → `trueColor` from CSS `backgroundColor` / `color` / SVG fill/stroke
- Transparent elements (rgba alpha=0, `transparent`) are skipped
- SVG images in `<img>` tags → converted to native DXF vector entities
- Raster images → `IMAGE` entities referencing external files. Access `dxfWriter.imageFiles` (a `Map<string, string>` of path → data URL) after `end()` to save the referenced image files alongside the DXF

#### `PNGWriter`

```ts
new PNGWriter(width: number, height: number, scale?: number)
```

Produces a `PNGResult` via the Canvas 2D API. Width and height are in CSS pixels. The optional `scale` parameter (default 1) acts as a device pixel ratio multiplier for higher resolution output (e.g. `scale: 2` produces a 2× image).

Requires a Canvas-capable environment (browser `document.createElement('canvas')`). When using Playwright or Puppeteer, run the writer inside `page.evaluate()`.

- Polygons → Canvas filled/stroked paths
- Polylines → Canvas path operations (open or closed)
- Rounded rectangles → Canvas `arcTo` paths
- Gradients → Canvas `createLinearGradient` / `createRadialGradient`
- Text → Canvas `fillText` with CSS font string
- Opacity → Canvas `globalAlpha`
- Transparent elements are skipped
- Raster images → drawn via async `finalize()` step using `Image` element loading

After `renderIR()`, call `await result.finalize()` to draw any queued raster images, then use `result.toDataURL()` for a data URL string or `result.toBytes()` for a `Uint8Array`.

#### `SVGWriter`

```ts
new SVGWriter(width: number, height: number)
```

Produces a standalone SVG document string. Width and height define the viewport in CSS pixels.

- Polygons → SVG `<rect>` (axis-aligned with border-radius) or `<path>` elements
- Polylines → SVG `<path>` elements (open or closed)
- Rounded rectangles → `<rect>` with `rx`/`ry` attributes
- Gradients → SVG `<linearGradient>` / `<radialGradient>` definitions with `userSpaceOnUse` units
- Text → SVG `<text>` elements with font properties, rotation, and decoration
- Text shadow → SVG `<filter>` with `<feDropShadow>`
- Box shadow → SVG `<filter>` with `<feDropShadow>` (outer) or clipped inset filter
- Opacity → SVG `opacity` attribute
- Stroke dash arrays → SVG `stroke-dasharray` attribute
- Images → SVG `<image>` elements with embedded data URLs
- Transparent elements are skipped

The output is a self-contained SVG with all gradients, filters, and images embedded inline.

#### `HTMLWriter`

```ts
new HTMLWriter(width: number, height: number)
```

Produces a standalone HTML document string. Width and height define the container dimensions in CSS pixels.

- Axis-aligned polygons → absolutely positioned `<div>` elements with CSS backgrounds, borders, and border-radius
- Non-axis-aligned polygons → inline SVG `<path>` elements
- Polylines → inline SVG `<path>` elements
- Text → `<span>` elements (axis-aligned) or SVG `<text>` elements (rotated)
- Gradients → CSS `background-image` on `<div>` elements
- Box shadow → CSS `box-shadow`
- Opacity → CSS `opacity`
- Images → `<img>` elements with data URL src
- Transparent elements are skipped

The output is a self-contained HTML document with all elements absolutely positioned to match the original layout.

#### `PDFWriter`

```ts
new PDFWriter(pageWidth?: number, pageHeight?: number, customFonts?: Map<string, Uint8Array>, defaultFont?: Uint8Array)
```

Produces a `PdfDocument`. Page dimensions default to A4 (210×297 mm). Coordinates are converted from px to pt (×0.75). Call `await doc.finalize()` then `doc.toBytes()` to get the final PDF as a `Uint8Array`.

The optional `defaultFont` parameter accepts a TTF file as `Uint8Array`. When provided, any text containing characters outside the standard WinAnsiEncoding range (e.g. emoji, CJK, math symbols like ⚖) will automatically use this font with full Unicode support via CID/Type0 embedding.

- Polygons → closed paths with fill/stroke operators (`f`, `S`, `B`)
- Polylines → paths with fill/stroke operators
- Rounded rectangles → Bézier-approximated rounded rect paths
- Gradients → PDF shading objects (axial for `linear-gradient`, radial for `radial-gradient`)
- Text → PDF text operators with standard font mapping (Helvetica, Times, Courier families)
- Fill/stroke mode automatically determined from style (fill only, stroke only, or both)
- Opacity → PDF ExtGState transparency
- Transparent elements are skipped
- SVG images in `<img>` tags → converted to native PDF vector paths
- Raster images → embedded as JPEG XObject images via DCTDecode
- Custom TrueType fonts → embedded as CIDFontType2 (Unicode) or simple TrueType (symbol fonts)

##### Embedding Custom Fonts

To use fonts beyond the standard PDF fonts (Helvetica, Times, Courier, Symbol, ZapfDingbats), pass a `Map<string, Uint8Array>` of font family name → TTF file data:

```ts
import { PDFWriter, parseTTF } from "@node-projects/layout2vector";
import * as fs from "node:fs";

// Load TTF files
const customFonts = new Map<string, Uint8Array>();
customFonts.set("Wingdings", new Uint8Array(fs.readFileSync("wingding.ttf")));
customFonts.set("MyFont", new Uint8Array(fs.readFileSync("myfont.ttf")));

// Create writer with custom fonts
const pdfWriter = new PDFWriter(210, 297, customFonts);
const pdfDoc = renderIR(ir, pdfWriter);
await pdfDoc.finalize();
const pdfBytes = pdfDoc.toBytes();
```

The font family name in the map must match the CSS `font-family` used in the HTML. The library includes a minimal TrueType parser (`parseTTF`) that extracts the metrics needed for PDF embedding (glyph widths, ascent/descent, cmap tables). Both Unicode fonts and symbol fonts (like Wingdings) are supported.

#### Custom Writers

Implement the `Writer<T>` interface:

```ts
import type { Writer, Quad, Point, Style } from "@node-projects/layout2vector";

class MyWriter implements Writer<string> {
  begin(): void { /* init */ }
  drawPolygon(points: Quad, style: Style): void { /* ... */ }
  drawPolyline(points: Point[], closed: boolean, style: Style): void { /* ... */ }
  drawText(quad: Quad, text: string, style: Style): void { /* ... */ }
  drawImage?(quad: Quad, dataUrl: string, width: number, height: number, style: Style): void { /* ... */ }
  end(): string { return "result"; }
}
```

### Types

#### `IRNode`

A discriminated union:

```ts
type IRNode =
  | { type: "polygon"; points: Quad; style: Style; zIndex: number }
  | { type: "text"; quad: Quad; text: string; style: Style; zIndex: number }
  | { type: "polyline"; points: Point[]; closed: boolean; style: Style; zIndex: number }
  | { type: "image"; quad: Quad; dataUrl: string; width: number; height: number; style: Style; zIndex: number };
```

#### `Quad`

A 4-point tuple: `[topLeft, topRight, bottomRight, bottomLeft]`, where each point is `{ x: number; y: number }`.

For untransformed elements quads are axis-aligned rectangles. For CSS-transformed or SVG-transformed elements, quads reflect the actual rendered corners.

#### `Style`

A subset of CSS computed styles relevant to rendering:

| Property | Type | Description |
|---|---|---|
| `fill` | `string?` | Background color / SVG fill |
| `stroke` | `string?` | Border color / SVG stroke |
| `strokeWidth` | `string?` | Border width / SVG stroke-width |
| `fontSize` | `string?` | Font size (e.g. `"16px"`) |
| `fontFamily` | `string?` | Font family |
| `fontWeight` | `string?` | Font weight (e.g. `"400"`, `"bold"`) |
| `fontStyle` | `string?` | `normal` / `italic` |
| `color` | `string?` | CSS text color |
| `opacity` | `number?` | Element opacity |
| `borderRadius` | `string?` | CSS border-radius |
| `borderTopColor`, etc. | `string?` | Individual border colors |
| `borderTopWidth`, etc. | `string?` | Individual border widths |
| `backgroundImage` | `string?` | CSS background-image (gradients and `url()`) |
| `boxShadow` | `string?` | CSS box-shadow |
| `transform` | `string?` | CSS transform |

### Advanced: Traversal Utilities

These are exported for advanced use cases (custom pipelines, analysis):

```ts
import {
  traverseDOM,        // Build stacking context tree
  flattenStackingOrder, // Flatten to paint order
  extractStyle,        // Extract Style from CSSStyleDeclaration
  isVisible,           // Check element visibility
  createsStackingContext, // Check if element creates stacking context
  isSVGElement,        // Check SVG namespace
  isSVGRoot,           // Check if <svg> root
  isImageElement,        // Check if <img> element
  extractImageGeometry,  // Extract image data from <img>
  hasBackgroundImage,    // Check if style has background-image url()
  extractBackgroundImage, // Extract background-image as IR nodes
} from "@node-projects/layout2vector";
```

## Features

### HTML Geometry
- Element box quads via `getBoxQuads()` (with `getBoundingClientRect` fallback)
- Text node geometry via `Range.getClientRects()`
- Border box and content box modes

### SVG Geometry
- All shape types: `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`, `text`
- Path sampling via `getTotalLength()` / `getPointAtLength()` (64 sample points)
- Circle/ellipse approximation (32 segments)
- Transform extraction via `getCTM()`

### CSS Support
- Stacking contexts: `z-index`, `opacity`, `transform`, `filter`, `perspective`, `mix-blend-mode`, `will-change`, `contain:paint`, `isolation:isolate`
- Border-radius (rendered as rounded rectangles in PDF, arc-approximated polylines in DXF)
- Background colors, border colors, font properties
- CSS transforms reflected in quad geometry (via `getBoxQuads`)

### Shadow DOM
- Traverses open/declarative shadow roots (`element.shadowRoot`)
- Declarative shadow DOM (`<template shadowrootmode="open">`) supported

### Image Handling

Enable with `includeImages: true`. Supports `<img>` elements and CSS `background-image: url()`:

- **SVG images** (`data:image/svg+xml`, `.svg` URLs): automatically converted to vector geometry (polygons, polylines, text) — no rasterization
- **Raster images** (PNG, JPEG, GIF, WebP, data URLs, remote URLs): extracted as `image` IR nodes with embedded data URL
- **CSS `background-image: url()`**: SVG URLs are vector-converted; raster URLs are extracted as image nodes
- **Data URLs**: all `data:` schemes are supported (`base64`, URL-encoded, UTF-8)
- **Remote URLs**: images are rasterized via canvas; cross-origin images fall back to the original `src`
- **DXF output**: raster images as `IMAGE` entities referencing external files; SVG shapes as native DXF entities with `HATCH` solid fills
- **PDF output**: JPEG images are embedded natively via DCTDecode; other formats are converted to JPEG automatically

### Color Handling
- Parses `rgb()`, `rgba()`, hex (`#rgb`, `#rrggbb`, `#rrggbbaa`)
- Alpha-aware: fully transparent colors (`rgba(0,0,0,0)`) are skipped, not rendered as black
- CSS `transparent` and `none` values handled correctly

## Browser Requirements

This library runs **in the browser** (it needs a live DOM). Use it via:

- **Playwright / Puppeteer** — inject the library into pages for headless conversion
- **Web page** — import and call directly in a web app
- **Electron** — use in renderer processes

The `getBoxQuads()` API is not supported in all browsers. For Chrome/Chromium, use the [get-box-quads-polyfill](https://github.com/nicolo-ribaudo/element-geometry-polyfill):

```ts
import { addPolyfill } from "get-box-quads-polyfill";
addPolyfill(window);
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run all tests (requires Playwright + Chromium)
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:ui
npm run test:demos
```

### Demo Conversion

The `test:demos` suite loads HTML demo files from `tests/demos/`, extracts IR in a real Chromium browser, and writes `.dxf`, `.pdf`, `.png`, `.svg`, and `.html` files to `tests/output/`.

For GitHub-friendly browsing of the generated HTML, PDF, and preview screenshots, see [tests/output/README.md](./tests/output/README.md).

Demo files cover: borders, gradients, transforms, SVG shapes, declarative shadow DOM, stacking contexts, typography, flexbox/grid layouts, and a comprehensive combined example.

## Architecture

```
┌──────────────┐     ┌──────────┐     ┌────────────┐
│  Live DOM    │────>│    IR    │────>│  DXFWriter │──> .dxf
│  (browser)   │     │ IRNode[] │     └────────────┘
│              │     │          │     ┌────────────┐
│  HTML + SVG  │     │ polygon  │────>│  PDFWriter │──> .pdf
│  + Shadow DOM│     │ polyline │     └────────────┘
│  + Transforms│     │ text     │     ┌────────────┐
└──────────────┘     │ image    │────>│  PNGWriter │──> .png
                     └──────────┘     └────────────┘
                                      ┌────────────┐
                                 ────>│  SVGWriter │──> .svg
                                      └────────────┘
                                      ┌────────────┐
                                 ────>│ HTMLWriter │──> .html
                                      └────────────┘
                                      ┌────────────┐
                                 ────>│  Custom    │──> ...
                                      └────────────┘
```

## License

MIT
