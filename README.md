# @node-projects/layout2vector

[![npm version](https://img.shields.io/npm/v/%40node-projects%2Flayout2vector)](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

A TypeScript (ESM) library that extracts rendered layout geometry from a live DOM — including HTML, SVG, CSS transforms, Shadow DOM, and opt-in same-origin iframe traversal — and converts it to **DXF**, **DWG**, **EMF**, **EMF+**, **PDF**, **Canvas**, **PNG**, **SVG**, or **HTML**.

## Overview

layout2vector works in three stages:

1. **DOM Extraction** — Traverses the live DOM (including open Shadow DOM trees and, optionally, same-origin iframe documents), computes stacking context order, and uses `getBoxQuads()` / `getBoundingClientRect()` for HTML geometry and SVG-native APIs (`getCTM`, `getBBox`, `getTotalLength`, `getPointAtLength`) for SVG geometry.
2. **Intermediate Representation (IR)** — A flat, renderer-independent array of typed nodes (`polygon`, `polyline`, `text`, `image`) ordered by paint order, each carrying a style subset.
3. **Writers** — Pluggable output backends. Built-in writers for DXF (via `@tarikjabiri/dxf`), DXF/DWG (via `@node-projects/acad-ts`), EMF and EMF+ (Windows Enhanced Metafile variants), PDF (custom lightweight PDF generator), Canvas, PNG/JPEG/WEBP (via Canvas 2D API), SVG, and HTML. Implement the `Writer<T>` interface to add your own.

For a feature-by-feature comparison with html2canvas, html2canvas-pro, and SnapDOM, including output-model tradeoffs, see [FEATURES.md](./FEATURES.md).

## Installation

Package: [@node-projects/layout2vector](https://www.npmjs.com/package/%40node-projects%2Flayout2vector)

```bash
npm install @node-projects/layout2vector
```

## Quick Start

```ts
import { extractIR, renderIR, DXFWriter, DWGWriter, AcadDXFWriter, EMFWriter, EMFPlusWriter, PDFWriter, CanvasWriter, ImageWriter, SVGWriter, HTMLWriter } from "@node-projects/layout2vector";

// In a browser context (e.g. Playwright, Puppeteer, or a web page):
const root = document.getElementById("my-element")!;

// 1. Extract geometry from the live DOM (now async!)
const ir = await extractIR(root, {
  boxType: "border",      // "border" | "content"
  includeText: true,       // extract text node geometry
  includeInvisible: false, // skip display:none / visibility:hidden
  includeImages: true,     // enable image extraction (recommended)
  convertFormControls: true, // synthesize native form controls into value/state-aware IR
  walkIframes: true,       // walk same-origin iframe documents too
  rootScrollBehavior: "expand", // optional: export the full content of a scrollable root
});

// 2. Render to DXF
const dxfWriter = new DXFWriter({ maxY: document.documentElement.scrollHeight });
const dxfString = await renderIR(ir, dxfWriter);
// dxfString is a complete .dxf file as a string

// 3. Render to PDF
const pdfWriter = new PDFWriter(); // defaults to A4
const pdfDoc = await renderIR(ir, pdfWriter); // returns a PdfDocument
await pdfDoc.finalize();
const pdfBytes = pdfDoc.toBytes(); // Uint8Array

// 4. Render to Canvas (requires Canvas-capable environment)
const canvasWriter = new CanvasWriter({ width: 800, height: 600, scale: 2 });
const canvas = await renderIR(ir, canvasWriter);
document.body.append(canvas);

// 5. Render to PNG/JPEG/WEBP (requires Canvas-capable environment)
const imageWriter = new ImageWriter({ width: 800, height: 600 });
const imageResult = await renderIR(ir, imageWriter);
await imageResult.finalize(); // loads and draws raster images
const pngDataUrl = imageResult.toDataURL(); // data:image/png;base64,...
const pngBytes = imageResult.toBytes(); // Uint8Array
const jpegDataUrl = imageResult.toDataURL("image/jpeg", 0.92); // JPEG output

// 6. Render to SVG
const svgWriter = new SVGWriter({ width: 800, height: 600 });
const svgString = await renderIR(ir, svgWriter);
// svgString is a complete standalone SVG document

// 7. Render to HTML
const htmlWriter = new HTMLWriter({ width: 800, height: 600, customCss: ".my-class { color: red; }" });
const htmlString = await renderIR(ir, htmlWriter);
// htmlString is a complete standalone HTML document

// 8. Render to EMF (Windows Enhanced Metafile)
const emfWriter = new EMFWriter({ width: 800, height: 600 });
const emfBytes = await renderIR(ir, emfWriter); // Uint8Array → save as .emf file

// 9. Render to EMF+ (EMF container with EMF+ records)
const emfPlusWriter = new EMFPlusWriter({ width: 800, height: 600 });
const emfPlusBytes = await renderIR(ir, emfPlusWriter); // Uint8Array → save as .emf file

// 10. Render to DWG (AutoCAD binary format via @node-projects/acad-ts)
const dwgWriter = new DWGWriter({ maxY: document.documentElement.scrollHeight });
const dwgBytes = await renderIR(ir, dwgWriter); // Uint8Array → save as .dwg file

// 11. Render to DXF via acad-ts (alternative DXF writer)
const acadDxfWriter = new AcadDXFWriter({ maxY: document.documentElement.scrollHeight });
const acadDxfBytes = await renderIR(ir, acadDxfWriter);
// acadDxfBytes is a complete .dxf file as a Uint8Array

```

## Preserving Webfonts

Use `extractIRWithAssets()` when the source DOM relies on downloadable `@font-face` fonts such as icon fonts or brand fonts. It returns the normal IR plus a `fontAssets` bundle that compatible writers can reuse.

```ts
import {
  extractIRWithAssets,
  renderIR,
  HTMLWriter,
  SVGWriter,
  PDFWriter,
  ImageWriter,
  DWGWriter,
  EMFWriter,
  rasterizeFontTextNodes,
} from "@node-projects/layout2vector";

const root = document.getElementById("icons")!;
const bounds = root.getBoundingClientRect();

const { ir, fontAssets } = await extractIRWithAssets(root, {
  includeImages: true,
  includeFonts: true,
});

// HTML and SVG can emit @font-face rules from the collected assets.
const htmlWriter = new HTMLWriter({
  width: bounds.width,
  height: bounds.height,
  fontAssets,
  fontMode: { type: "inline" },
});
const html = await renderIR(ir, htmlWriter);

const svgWriter = new SVGWriter({
  width: bounds.width,
  height: bounds.height,
  fontAssets,
  fontMode: { type: "external", basePath: "fonts" },
});
const svg = await renderIR(ir, svgWriter);
// Save svgWriter.fontFiles alongside the SVG when using external mode.

// PDF automatically registers the collected font files.
const pdfWriter = new PDFWriter({
  pageWidth: 210,
  pageHeight: 297,
  fontAssets,
  useFontEditorCore: true,
});
const pdfDoc = await renderIR(ir, pdfWriter);
await pdfDoc.finalize();

// Raster outputs load collected fonts before drawing text.
const imageWriter = new ImageWriter({
  width: bounds.width,
  height: bounds.height,
  fontAssets,
});
const image = await renderIR(ir, imageWriter);
await image.finalize();

// CAD and EMF-family writers cannot embed browser webfonts directly in Node.
// Convert the affected text nodes to raster image nodes first.
const fallbackIr = await rasterizeFontTextNodes(ir, fontAssets);

const dwgBytes = await renderIR(fallbackIr, new DWGWriter({ maxY: bounds.height }));
const emfBytes = await renderIR(fallbackIr, new EMFWriter({ width: bounds.width, height: bounds.height }));
```

- `HTMLWriter` and `SVGWriter` only emit downloadable fonts when you pass both `fontAssets` and `fontMode`. The default `fontMode` is `{ type: "none" }`.
- `PDFWriter` embeds collected TTF font assets directly. Set `useFontEditorCore: true` to also convert WOFF, WOFF2, and OTF sources via the optional `fonteditor-core` dependency.
- `ImageWriter` and `CanvasWriter` can load collected fonts before drawing text in browser or Playwright contexts.
- `rasterizeFontTextNodes()` is the fallback path for DXF, DWG, Acad DXF, EMF, and EMF+ when exact browser webfont rendering matters.

## API Reference

### Pipeline


#### `async extractIR(root: Element, options?: Options): Promise<IRNode[]>`

Main entry point. Traverses the DOM tree under `root`, builds a stacking context tree, flattens to paint order, and extracts geometry from each element.

**Note:** `extractIR` is now async and must be awaited. It automatically preloads all images (including `<img>` and CSS `background-image`, even in Shadow DOM) without mutating the DOM.

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `boxType` | `"border" \| "content"` | `"border"` | Which CSS box to use for element quads |
| `includeText` | `boolean` | `true` | Whether to extract text node geometry |
| `includeImages` | `boolean` | `false` | Whether to extract `<img>` element content (see [Image Handling](#image-handling)) |
| `includeFonts` | `boolean` | `false` | When used with `extractIRWithAssets()`, downloads the `@font-face` files actually used by extracted text so compatible writers can preserve webfonts |
| `includeVideos` | `boolean` | `false` | Whether to extract `<video>` elements as image IR nodes using the first decoded video frame |
| `includeSourceMetadata` | `boolean` | `false` | Whether to attach source metadata to each IR node for debugging and traceability. HTML and SVG writers surface this as `data-source-*` attributes. |
| `includeInvisible` | `boolean` | `false` | Include `display:none` / `visibility:hidden` elements |
| `textMeasurement` | `"line" \| "pretext" \| "auto"` | `"line"` | Text extraction granularity. `pretext` uses `@chenglou/pretext` for accurate text measurement and layout, supporting all writing modes (vertical-rl, vertical-lr, sideways-rl, sideways-lr). `auto` keeps the fast line mode for normal text and switches to pretext only when non-default `writing-mode` or `direction` is present. Requires `@chenglou/pretext` to be installed when using `pretext` or `auto` with non-standard writing modes. |
| `walkIframes` | `boolean` | `false` | Traverse same-origin iframe documents and merge their content into the same IR paint order |
| `rootScrollBehavior` | `"clip" \| "expand"` | `"clip"` | Controls scrollable overflow on the extraction root only. Use `"expand"` to export the full content of a root with `overflow: scroll|auto|overlay` while keeping nested scroll containers clipped normally. Root `overflow: hidden|clip` still clips normally. |
| `zoom` | `number` | `1` | Scale factor applied to all extracted coordinates. Useful when the source DOM is rendered at a different zoom level |
| `imageScale` | `number` | `1` | Scale factor for rasterizing embedded images. Higher values (e.g. `2`) produce sharper images when zooming in on the exported file. Max pixel dimension is capped at 4096 |
| `svgToVector` | `boolean` | `false` | When true, embedded SVG images (in `<img>` tags and CSS `background-image`) are always converted to vector IR nodes (polygon, polyline, text) instead of being rasterized to bitmap image nodes. This produces resolution-independent output but may not accurately render SVGs that use fill-rule:evenodd with complex multi-subpath paths. |
| `convertFormControls` | `boolean` | `false` | When true, native form controls are converted into synthetic IR nodes that preserve visible values and states across writers. Supported controls include checkbox, radio, range, file, text-like inputs (including date/time variants), textarea, select, progress, and meter. |
| `includePseudoElements` | `boolean` | `true` | When true, `::before` and `::after` pseudo-elements with generated content are extracted into the IR as polygon and text nodes. Be careful, this option modifies original DOM cause it need to create real elements for them in DOM. CSS `counter()`, `counters()`, `attr()`, `open-quote`/`close-quote`, and string literals are resolved. Best results with Firefox (native `getBoxQuads` on pseudo replacement elements). |


**Note:**
If `svgToVector` is `true`, all embedded SVG images are vectorized, even if they use `fill-rule:evenodd`. This produces resolution-independent output, but may not exactly match browser rendering for complex SVGs with multiple subpaths and evenodd fill rules. By default (`svgToVector: false`), such SVGs are rasterized to ensure visual fidelity.

If `convertFormControls` is `true`, the extractor approximates native control chrome with ordinary IR primitives (`polygon`, `polyline`, and `text`) so every writer can render control values and states without special-case renderer code.

If `walkIframes` is `true`, `extractIR()` descends into same-origin iframe documents and maps their geometry back into the parent page coordinate space. Cross-origin iframes and not-yet-loaded frames are skipped.

#### `async extractIRWithAssets(root: Element \| Element[], options?: Options): Promise<ExtractIRWithAssetsResult>`

Calls `extractIR()` and, when `options.includeFonts === true`, also collects the downloadable `@font-face` assets used by the extracted text.

- `ir`: the same IR array returned by `extractIR()`
- `fontAssets`: an optional `FontAssetCollection` for `HTMLWriter`, `SVGWriter`, `CanvasWriter`, `ImageWriter`, and `PDFWriter`

When `includeFonts` is false, the result is simply `{ ir }`.

#### `async renderIR<T>(nodes: IRNode[], writer: Writer<T>): Promise<T>`

Passes each IR node through the writer in paint order. Returns a Promise for the writer's `end()` result. You must `await` the result.

#### `async rasterizeFontTextNodes(nodes: IRNode[], fonts: FontAssetCollection | undefined, options?: RasterizeFontTextOptions): Promise<IRNode[]>`

Replaces matching text nodes with PNG-backed `image` nodes after loading the collected webfonts into the current document. Use this as a fallback before DXF, DWG, Acad DXF, EMF, or EMF+ export when those targets cannot reproduce the browser font directly.

- `scale`: device-pixel-ratio multiplier for the rasterized fallback images
- `onlyFamilies`: optional list of normalized font-family names to rasterize; omitted means all collected downloadable font families

### Writers


#### `DXFWriter`

```ts
type DXFWriterOptions = {
  maxY?: number;  // Y-axis flip height (default: 1000)
  zoom?: number;
};
new DXFWriter(options?: DXFWriterOptions)
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


#### `DWGWriter`

```ts
type DWGWriterOptions = {
  maxY?: number;  // Y-axis flip height (default: 1000)
  zoom?: number;
  acadVersion?: ACadVersion
};
new DWGWriter(options?: DWGWriterOptions)
```

Produces a `Uint8Array` containing an AutoCAD DWG binary file via `@node-projects/acad-ts`. The `maxY` parameter (default 1000) is used to flip the Y axis (browser Y-down → DWG Y-up).

- Polygons → closed `LWPOLYLINE` entities with optional solid `HATCH` fill
- Polylines → `LWPOLYLINE` entities (open or closed)
- Filled shapes → `HATCH` entities with `SOLID` pattern
- Text → `TEXT` entities with rotation and color
- Rounded rectangles → `LWPOLYLINE` with arc-approximated corners
- Colors → true color from CSS `backgroundColor` / `color` / SVG fill/stroke
- Transparent elements (rgba alpha=0, `transparent`) are skipped
- Output is an AC1032-format (AutoCAD 2018+) DWG file


#### `AcadDXFWriter`

```ts
type AcadDXFWriterOptions = {
  maxY?: number;  // Y-axis flip height (default: 1000)
  zoom?: number;
  acadVersion?: ACadVersion
};
new AcadDXFWriter(options?: AcadDXFWriterOptions)
```

An alternative DXF writer that uses `@node-projects/acad-ts` instead of `@tarikjabiri/dxf`. Produces a `Uint8Array` containing ASCII DXF bytes with the same entity types as `DWGWriter`:

- Polygons → closed `LWPOLYLINE` entities with optional solid `HATCH` fill
- Polylines → `LWPOLYLINE` entities (open or closed)
- Filled shapes → `HATCH` entities with `SOLID` pattern
- Text → `TEXT` entities with rotation and color
- Rounded rectangles → `LWPOLYLINE` with arc-approximated corners
- Colors → true color from CSS `backgroundColor` / `color` / SVG fill/stroke
- Transparent elements are skipped


#### `EMFWriter`

```ts
type EMFWriterOptions = {
  width: number;
  height: number;
  zoom?: number;
};
new EMFWriter(options: EMFWriterOptions)
```

Produces a `Uint8Array` containing a binary **Enhanced Metafile (EMF)** file (Windows GDI format). Width and height define the viewport in CSS pixels.

- Polygons → `EMR_POLYGON16` entities with GDI brush/pen
- Polylines → `EMR_POLYLINE16` entities (open or closed)
- Rounded rectangles → `EMR_ROUNDRECT` entities
- Text → `EMR_EXTTEXTOUTW` entities with `EMR_EXTCREATEFONTINDIRECTW` font selection
- Images → `EMR_STRETCHDIBITS` entities with 24-bit DIB pixel data
- Colors → GDI COLORREF (`0x00BBGGRR` values)
- Transparent elements are skipped
- Output is a valid AC1015-format EMF file readable by GDI-enabled applications (Word, Visio, AutoCAD, etc.)


#### `EMFPlusWriter`

```ts
type EMFPlusWriterOptions = {
  width: number;
  height: number;
  zoom?: number;
};
new EMFPlusWriter(options: EMFPlusWriterOptions)
```

Produces a `Uint8Array` containing an **EMF+** drawing stream wrapped in an EMF container. Width and height define the viewport in CSS pixels.

- Polygons and rounded shapes → EMF+ path objects with fill/stroke records
- Polylines → EMF+ path objects with stroke records
- Text → EMF+ font/string-format objects plus `DrawString`
- Images → EMF+ bitmap/image objects plus `DrawImagePoints`
- Clipping → EMF+ clip rect/path state records
- Transparent elements are skipped
- Output is still saved as `.emf`, but the payload uses EMF+ records inside `EMR_COMMENT` wrappers



#### `CanvasWriter`

```ts
type CanvasWriterOptions = {
  width: number;
  height: number;
  fontAssets?: FontAssetCollection;
  scale?: number;
  zoom?: number;
};
new CanvasWriter(options: CanvasWriterOptions)
```

Produces an `HTMLCanvasElement` directly via the Canvas 2D API. `CanvasWriter` uses the same drawing backend as `ImageWriter`, but it automatically finalizes queued raster images before returning the canvas.

When `fontAssets` is provided, `CanvasWriter` loads the collected downloadable fonts into the document before drawing text.

- Polygons, polylines, text, gradients, opacity, and embedded images render through the Canvas 2D API
- Returns a ready-to-use `HTMLCanvasElement` from `await renderIR(ir, new CanvasWriter(...))`
- Best fit when you want to continue drawing, display the export immediately, or call `canvas.toDataURL()` / `canvas.toBlob()` yourself


#### `ImageWriter` (formerly `PNGWriter`)

```ts
type ImageWriterOptions = {
  width: number;
  height: number;
  fontAssets?: FontAssetCollection;
  scale?: number;
  zoom?: number;
};
new ImageWriter(options: ImageWriterOptions)
```

Produces an `ImageResult` via the Canvas 2D API. Width and height are in CSS pixels. The optional `scale` parameter (default 1) acts as a device pixel ratio multiplier for higher resolution output (e.g. `scale: 2` produces a 2× image).

When `fontAssets` is provided, `ImageWriter` loads the collected downloadable fonts into the document before drawing text.

Output format is configurable: call `result.toDataURL(mimeType, quality)` or `result.toBytes(mimeType, quality)` with `"image/png"` (default), `"image/jpeg"`, or `"image/webp"`.

Requires a Canvas-capable environment (browser `document.createElement('canvas')`). When using Playwright or Puppeteer, run the writer inside `page.evaluate()`.

> **Note:** `PNGWriter`, `PNGResult`, and `PNGWriterOptions` are still exported as aliases for backward compatibility.

- Polygons → Canvas filled/stroked paths
- Polylines → Canvas path operations (open or closed)
- Rounded rectangles → Canvas `arcTo` paths
- Gradients → Canvas `createLinearGradient` / `createRadialGradient` / `createConicGradient`, including repeating linear/radial/conic gradients
- Text → Canvas `fillText` with CSS font string, preserving extracted font-family stacks when the Canvas environment can resolve them
- Opacity → Canvas `globalAlpha`
- Transparent elements are skipped
- Raster images → drawn via async `finalize()` step using `Image` element loading

After `await renderIR()`, call `await result.finalize()` to draw any queued raster images, then use `result.toDataURL(mimeType?, quality?)` for a data URL string or `result.toBytes(mimeType?, quality?)` for a `Uint8Array`. Supported MIME types: `"image/png"` (default), `"image/jpeg"`, `"image/webp"`.


#### `SVGWriter`

```ts
type SVGWriterOptions = {
  width: number;
  height: number;
  fontAssets?: FontAssetCollection;
  fontMode?: FontAssetMode;
  zoom?: number;
};
new SVGWriter(options: SVGWriterOptions)
```

Produces a standalone SVG document string. Width and height define the viewport in CSS pixels.

To preserve downloadable webfonts, pass the `fontAssets` returned by `extractIRWithAssets()` and set `fontMode` to `{ type: "inline" }` or `{ type: "external", basePath }`. The default is `{ type: "none" }`. When using external mode, save `svgWriter.fontFiles` after `end()`.

- Polygons → SVG `<rect>` (axis-aligned with border-radius) or `<path>` elements
- Polylines → SVG `<path>` elements (open or closed)
- Rounded rectangles → `<rect>` with `rx`/`ry` attributes
- Gradients → SVG `<linearGradient>` / `<radialGradient>` definitions with `userSpaceOnUse` units, plus conic-gradient fallback patterns built from sector paths, including repeating variants
- Text → SVG `<text>` elements with the extracted font-family stack, font properties, rotation, and decoration
- Text shadow → SVG `<filter>` with `<feDropShadow>`
- Box shadow → SVG `<filter>` with `<feDropShadow>` (outer) or clipped inset filter
- Opacity → SVG `opacity` attribute
- Stroke dash arrays → SVG `stroke-dasharray` attribute
- Images → SVG `<image>` elements with embedded data URLs
- Transparent elements are skipped

The output is a self-contained SVG with all gradients, filters, and images embedded inline.

Duplicate `<clipPath>` definitions are deduplicated (shared by reference). Duplicate raster images are embedded once as a `<symbol>` and referenced via `<use>` elements to reduce output size.



#### `HTMLWriter`

```ts
type HTMLImageMode =
  | { type: "inline" }
  | { type: "external"; basePath: string }
  | { type: "css" };

type HTMLWriterOptions = {
  width: number;
  height: number;
  fontAssets?: FontAssetCollection;
  fontMode?: FontAssetMode;
  imageMode?: HTMLImageMode;
  zoom?: number;
  customCss?: string;
};

new HTMLWriter(options: HTMLWriterOptions)
```

Produces a standalone HTML document string. Width and height define the container dimensions in CSS pixels. The `imageMode` parameter controls how images are rendered:

To preserve downloadable webfonts, pass the `fontAssets` returned by `extractIRWithAssets()` and set `fontMode` to `{ type: "inline" }` or `{ type: "external", basePath }`. The default is `{ type: "none" }`. When using external mode, save `htmlWriter.fontFiles` after `end()`.

- `{ type: "inline" }` (default): Images are rendered as `<img src="data:...">` elements (each image in-place)
- `{ type: "external", basePath }`: Images are rendered as `<img src="[basePath]/imageN.png">` with external file references (see `htmlWriter.imageFiles` after `end()`)
- `{ type: "css" }`: Images are rendered as CSS `background-image` on `<div>` elements, deduplicated into shared CSS classes

The optional `zoom` parameter (default 1) multiplies all coordinates and dimensions (useful for high-DPI output or scaling).

- Axis-aligned polygons → absolutely positioned `<div>` elements with CSS backgrounds, borders, and border-radius
- Non-axis-aligned polygons → inline SVG `<path>` elements
- Polylines → inline SVG `<path>` elements
- Text → `<span>` elements (axis-aligned) or SVG `<text>` elements (rotated), preserving extracted font-family stacks plus carried spacing and decoration styles where HTML/CSS supports them
- Gradients → CSS `background-image` on `<div>` elements
- Box shadow → CSS `box-shadow`
- Opacity → CSS `opacity`
- Images → as above, depending on `imageMode`
- Transparent elements are skipped

The output is a self-contained HTML document with all elements absolutely positioned to match the original layout. When `imageMode.type === "css"`, duplicate images are deduplicated into shared CSS classes. When `imageMode.type === "external"`, call `htmlWriter.imageFiles` after `end()` to get a `Map<string, string>` of image file names to data URLs for saving alongside the HTML.


#### `PDFWriter`

```ts
type PDFWriterOptions = {
  pageWidth?: number;
  pageHeight?: number;
  fontAssets?: FontAssetCollection;
  useFontEditorCore?: boolean;
  customFonts?: Map<string, Uint8Array>;
  defaultFont?: Uint8Array;
  zoom?: number;
};
new PDFWriter(options?: PDFWriterOptions)
```

Produces a `PdfDocument`. Page dimensions default to A4 (210×297 mm). Coordinates are converted from px to pt (×0.75). Call `await doc.finalize()` then `doc.toBytes()` to get the final PDF as a `Uint8Array`.

The optional `defaultFont` parameter accepts a TTF file as `Uint8Array`. When provided, any text containing characters outside the standard WinAnsiEncoding range (e.g. emoji, CJK, math symbols like ⚖) will automatically use this font with full Unicode support via CID/Type0 embedding.

When `fontAssets` is provided, `PDFWriter` automatically registers collected TTF `@font-face` sources from `extractIRWithAssets()`. To convert WOFF, WOFF2, or OTF sources to embeddable TrueType data first, set `useFontEditorCore: true` and install the optional `fonteditor-core` dependency.

- Polygons → closed paths with fill/stroke operators (`f`, `S`, `B`)
- Polylines → paths with fill/stroke operators
- Rounded rectangles → Bézier-approximated rounded rect paths
- Gradients → PDF shading objects (axial for `linear-gradient`, radial for `radial-gradient`) plus repeating stop expansion for linear/radial gradients, and sector-based fallback rendering for conic gradients (including repeating conic)
- Text → PDF text operators with standard font mapping (Helvetica, Times, Courier families)
- Fill/stroke mode automatically determined from style (fill only, stroke only, or both)
- Opacity → PDF ExtGState transparency
- Transparent elements are skipped
- SVG images in `<img>` tags → converted to native PDF vector paths
- Raster images → embedded as JPEG XObject images via DCTDecode
- Custom TrueType fonts → embedded as CIDFontType2 (Unicode) or simple TrueType (symbol fonts)

##### Embedding Custom Fonts

To use fonts beyond the standard PDF fonts (Helvetica, Times, Courier, Symbol, ZapfDingbats), pass a `Map<string, Uint8Array>` of font family name → TTF file data. Use this path when you already have local TTF files; use `fontAssets` when you want to embed the webfonts captured from the source page:

```ts
import { PDFWriter, parseTTF } from "@node-projects/layout2vector";
import * as fs from "node:fs";

// Load TTF files
const customFonts = new Map<string, Uint8Array>();
customFonts.set("Wingdings", new Uint8Array(fs.readFileSync("wingding.ttf")));
customFonts.set("MyFont", new Uint8Array(fs.readFileSync("myfont.ttf")));

// Create writer with custom fonts
const pdfWriter = new PDFWriter(210, 297, customFonts);
const pdfDoc = await renderIR(ir, pdfWriter);
await pdfDoc.finalize();
const pdfBytes = pdfDoc.toBytes();
```

The font family name in the map must match the CSS `font-family` used in the HTML. The library includes a minimal TrueType parser (`parseTTF`) that extracts the metrics needed for PDF embedding (glyph widths, ascent/descent, cmap tables). Both Unicode fonts and symbol fonts (like Wingdings) are supported.


#### IR Node Filtering

Invisible polygons and polylines (no fill, no stroke, no border, no boxShadow, no gradient) are automatically filtered out before rendering. This reduces output size and eliminates empty elements in HTML, SVG, PNG, PDF, and DXF outputs.

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

`extractHTMLGeometry()`, `extractPseudoElements()`, `extractImageGeometry()`, and `extractBackgroundImage()` are async. If you build a custom extraction pipeline instead of calling `extractIR()`, await those helpers directly. `preloadImages()` is still available, but it is now an optional optimization rather than a correctness requirement.

## Features

### HTML Geometry
- Element box quads via `getBoxQuads()` (with `getBoundingClientRect` fallback)
- Text node geometry via `Range.getClientRects()`
- Border box and content box modes

### SVG Geometry
- All shape types: `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path`, `text`
- `<use>` elements: shadow DOM content is traversed for full vector extraction
- Path sampling via `getTotalLength()` / `getPointAtLength()` (64 sample points)
- Circle/ellipse approximation (32 segments)
- Transform extraction via `getCTM()`
- `display:none` and `visibility:hidden` SVG elements are correctly skipped

### CSS Support
- Stacking contexts: `z-index`, `opacity`, `transform`, `filter`, `perspective`, `mix-blend-mode`, `will-change`, `contain:paint`, `isolation:isolate`
- Border-radius (rendered as rounded rectangles in PDF, arc-approximated polylines in DXF)
- `corner-shape` / `superellipse()` — all keyword values (`round`, `scoop`, `bevel`, `notch`, `square`, `squircle`) and arbitrary `superellipse(K)` values are extracted per-corner and rendered as superellipse curves in all vector/raster writers (Chrome 139+)
- Background colors, border colors, font properties
- CSS transforms reflected in quad geometry (via `getBoxQuads`)
- `::before` / `::after` pseudo-elements with generated content (string literals, `counter()`, `counters()`, `attr()`, `open-quote`/`close-quote`)

### Shadow DOM
- Traverses open/declarative shadow roots (`element.shadowRoot`)
- Declarative shadow DOM (`<template shadowrootmode="open">`) supported


### Image Handling

Enable with `includeImages: true`. All image preloading and embedding is now **automatic** and handled internally by `extractIR` (no need to call any preload function). For custom pipelines, the async image helpers can also fetch/decode what they need on demand; `preloadImages()` is only an optimization. The DOM is **not mutated** during preloading.

- **All images** (including `<img>` and CSS `background-image: url()`, even in Shadow DOM) are embedded as data URLs in all output formats (DXF, PDF, PNG, SVG, HTML).
- **SVG images** (`data:image/svg+xml`, `.svg` URLs): automatically converted to vector geometry (polygons, polylines, text) — no rasterization.
- **Raster images** (PNG, JPEG, GIF, WebP, data URLs, remote URLs): extracted as `image` IR nodes with embedded data URL.
- **Video elements**: enable with `includeVideos: true` to rasterize each `<video>` into an `image` IR node using its first decoded frame. `imageScale` also applies to video frame rasterization.
- **CSS `background-image: url()`**: SVG URLs are vector-converted; raster URLs are extracted as image nodes.
- **Data URLs**: all `data:` schemes are supported (`base64`, URL-encoded, UTF-8).
- **Remote URLs**: images are rasterized via canvas; cross-origin images fall back to the original `src`.
- **DXF output**: raster images as `IMAGE` entities referencing external files; SVG shapes as native DXF entities with `HATCH` solid fills.
- **PDF output**: JPEG images are embedded natively via DCTDecode; other formats are converted to JPEG automatically.
- **Caching**: identical images (same source URL and dimensions) are rasterized only once per extraction run, improving performance when the same image appears on multiple elements.
- **Shadow DOM**: background images and images in shadow roots are now fully supported and embedded.

### Color Handling
- Parses `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, hex (`#rgb`, `#rrggbb`, `#rrggbbaa`)
- `color()` function with all CSS Color Level 4 predefined profiles: `srgb`, `srgb-linear`, `display-p3`, `a98-rgb`, `prophoto-rgb`, `rec2020`, `xyz`, `xyz-d50`, `xyz-d65`
- `lab()`, `lch()`, `oklab()`, `oklch()` perceptual color functions
- Alpha-aware: fully transparent colors (`rgba(0,0,0,0)`) are skipped, not rendered as black
- CSS `transparent` and `none` values handled correctly
- All color spaces are converted to sRGB for output

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

The `test:demos` suite loads HTML demo files from `tests/demos/`, extracts IR in a real Chromium browser, and writes `.dxf`, `.pdf`, `.png`, `.svg`, `.html`, and `.emf` files to `tests/output/`.

For GitHub-friendly browsing of the generated HTML, PDF, and preview screenshots, see [tests/output/README.md](./tests/output/README.md).

Demo files cover: borders, gradients, transforms, SVG shapes, declarative shadow DOM, stacking contexts, typography, flexbox/grid layouts, and a comprehensive combined example.

## Architecture

```
┌──────────────┐     ┌──────────┐     ┌────────────┐
│  Live DOM    │────>│    IR    │────>│  DXFWriter │──> .dxf
│  (browser)   │     │ IRNode[] │     └────────────┘
│              │     │          │     ┌────────────┐
│  HTML + SVG  │     │ polygon  │────>│  EMFWriter │──> .emf
│  + Shadow DOM│     │ polyline │     └────────────┘
│  + Transforms│     │ text     │     ┌────────────┐
└──────────────┘     │ image    │────>│  PDFWriter │──> .pdf
                                      └────────────┘
                                      ┌────────────┐
                                 ────>│  PNGWriter │──> .png
                                      └────────────┘
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
