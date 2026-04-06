# @node-projects/layout2vector

[![npm version](https://img.shields.io/npm/v/%40node-projects%2Flayout2vector)](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

A TypeScript (ESM) library that extracts rendered layout geometry from a live DOM — including HTML, SVG, CSS transforms, and Shadow DOM — and converts it to **DXF** or **PDF**.

## Overview

layout2vector works in three stages:

1. **DOM Extraction** — Traverses the live DOM (including open Shadow DOM trees), computes stacking context order, and uses `getBoxQuads()` / `getBoundingClientRect()` for HTML geometry and SVG-native APIs (`getCTM`, `getBBox`, `getTotalLength`, `getPointAtLength`) for SVG geometry.
2. **Intermediate Representation (IR)** — A flat, renderer-independent array of typed nodes (`polygon`, `polyline`, `text`) ordered by paint order, each carrying a style subset.
3. **Writers** — Pluggable output backends. Built-in writers for DXF (via `@tarikjabiri/dxf`) and PDF (via `jspdf`). Implement the `Writer<T>` interface to add your own.

## Installation

Package: [@node-projects/layout2vector](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

```bash
npm install @node-projects/layout2vector
```

## Quick Start

```ts
import { extractIR, renderIR, DXFWriter, PDFWriter } from "@node-projects/layout2vector";

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
const pdfDoc = renderIR(ir, pdfWriter); // returns a jsPDF instance
const pdfBuffer = pdfDoc.output("arraybuffer");
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
- Text → `TEXT` entities
- Rounded rectangles → `LWPOLYLINE` with arc-approximated corners
- Colors → `trueColor` from CSS `backgroundColor` / `color` / SVG fill/stroke
- Transparent elements (rgba alpha=0, `transparent`) are skipped

#### `PDFWriter`

```ts
new PDFWriter(pageWidth?: number, pageHeight?: number)
```

Produces a `jsPDF` document. Page dimensions default to A4 (210×297 mm). Coordinates are converted from px to pt (×0.75).

- Polygons → closed paths via `doc.lines()` or `doc.roundedRect()` (when `borderRadius` is set)
- Polylines → paths via `doc.lines()`
- Text → `doc.text()` with font family/size/weight mapping
- Fill/stroke mode automatically determined from style (fill only, stroke only, or both)
- Transparent elements are skipped
- Font fallback: tries the CSS font family, falls back to `helvetica`

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
| `backgroundImage` | `string?` | CSS background-image (gradients) |
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
  isImageElement,      // Check if <img> element
  extractImageGeometry, // Extract image data from <img>
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

Enable with `includeImages: true`. Supports `<img>` elements with any `src`:

- **SVG images** (`data:image/svg+xml`, `.svg` URLs): automatically converted to vector geometry (polygons, polylines, text) — no rasterization
- **Raster images** (PNG, JPEG, GIF, WebP, data URLs, remote URLs): extracted as `image` IR nodes with embedded data URL
- **Data URLs**: all `data:` schemes are supported (`base64`, URL-encoded, UTF-8)
- **Remote URLs**: images are rasterized via canvas; cross-origin images fall back to the original `src`
- **DXF output**: images are rendered as bounding-rectangle placeholders (DXF has limited raster support)
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

The `test:demos` suite loads HTML demo files from `tests/demos/`, extracts IR in a real Chromium browser, and writes both `.dxf` and `.pdf` files to `tests/output/`.

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
└──────────────┘     └──────────┘────>│  Custom    │──> ...
                                      └────────────┘
```

## License

MIT
