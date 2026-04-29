# Feature Comparison

This document compares `@node-projects/layout2vector` with `html2canvas`, the `yorickshan/html2canvas-pro` fork, and `@zumer/snapdom` (`zumerlab/snapdom`).

All three alternatives are screenshot-oriented DOM capture tools, but they do not optimize for exactly the same output model:

- `html2canvas` and `html2canvas-pro` reconstruct the DOM into a canvas-oriented screenshot.
- `SnapDOM` clones a DOM subtree, inlines styles and resources, serializes the capture through SVG `foreignObject`, and exports screenshot-oriented web formats. It also exposes a beta plugin system.
- `layout2vector` solves a broader export problem: it walks the live rendered DOM, extracts a structured intermediate representation (IR), and writes that IR to multiple output formats.

Note: `html2canvas-pro` here refers to the open-source fork at `yorickshan/html2canvas-pro`, not an official commercial edition from the original `html2canvas` project.

Status meanings:

- `Yes`: explicitly documented or covered by repo tests
- `Partial`: supported with important limits, only through options/plugins, or only for some outputs
- `Not documented`: I did not find an explicit upstream claim in the pages reviewed on 2026-04-13 and 2026-04-15
- `No`: explicitly unsupported or outside the tool's model

## Output Formats

This matrix lists the concrete output formats discussed in this comparison.

| Output format | layout2vector | html2canvas | html2canvas-pro | SnapDOM | Notes |
| --- | --- | --- | --- | --- | --- |
| DXF | Yes | No | No | No | Native writer in `layout2vector`. |
| DXF (acad-ts) | Yes | No | No | No | Alternative DXF writer in `layout2vector` using `@node-projects/acad-ts`. |
| DWG | Yes | No | No | No | Native writer in `layout2vector` using `@node-projects/acad-ts`. |
| EMF | Yes | No | No | No | Native GDI EMF writer in `layout2vector`. |
| EMF+ | Yes | No | No | No | Native EMF+ writer in `layout2vector` using an EMF container with EMF+ comment records. |
| PDF | Yes | No | No | Partial | `layout2vector` has a native PDF writer. SnapDOM documents PDF export through the official `pdf-image` plugin, which embeds a raster capture into a downloadable PDF. |
| PNG | Yes | Yes | Yes | Yes | html2canvas and html2canvas-pro export PNG through the returned canvas. SnapDOM exposes `toPng()`. |
| JPEG | Yes | Yes | Yes | Yes | html2canvas and html2canvas-pro export JPEG through canvas APIs. SnapDOM exposes `toJpg()`. |
| WEBP | Yes | Yes | Yes | Yes | html2canvas and html2canvas-pro export WEBP where the browser canvas implementation supports it. SnapDOM exposes `toWebp()`. |
| SVG | Yes | No | No | Yes | `layout2vector` writes a standalone SVG document from IR. SnapDOM exports a self-contained SVG snapshot built around cloned DOM plus `foreignObject`. |
| HTML | Yes | No | No | No | Native writer in `layout2vector`. |
| Canvas object | Yes | Yes | Yes | Yes | `layout2vector` has `CanvasWriter`; SnapDOM exposes `toCanvas()`. |

## Capabilities

| Capability | layout2vector | html2canvas | html2canvas-pro | SnapDOM | Notes |
| --- | --- | --- | --- | --- | --- |
| Core rendering model | Structured DOM -> IR -> writer pipeline | DOM -> canvas reconstruction | DOM -> canvas reconstruction | Clone -> style/resource inlining -> SVG `foreignObject` -> export | `layout2vector` exposes typed IR nodes and writer backends; the others are screenshot-first. |
| Requires a temporary cloned document/container | No | Yes | Yes | Yes | html2canvas exposes clone-oriented options such as `onclone` and `removeContainer`. html2canvas-pro stays clone-based and adds `iframeContainer` plus document-cloner fixes. SnapDOM explicitly documents a clone-based capture flow. |
| Built-in output formats | DXF, DWG, EMF, EMF+, PDF, PNG, JPEG, WEBP, SVG, HTML, Canvas | `HTMLCanvasElement` output | `HTMLCanvasElement` output | SVG, PNG, JPG, WEBP, Canvas, Blob | SnapDOM's PDF story is plugin-based, not a built-in core writer. |
| Structured IR / custom backends | Yes | No | No | Partial | `layout2vector` exposes `polygon`, `polyline`, `text`, and `image` IR nodes plus a `Writer<T>` interface. SnapDOM can add custom exports through beta plugins, but it does not expose a typed scene graph. |
| Plugin / hook system around capture | No | No | No | Yes | SnapDOM documents `beforeSnap`, `beforeClone`, `afterClone`, `beforeRender`, `afterRender`, `beforeExport`, `afterExport`, and `defineExports`. |
| Keeps text as text/vector objects | Yes | No | No | No | html2canvas, html2canvas-pro, and SnapDOM are screenshot-oriented. `layout2vector` preserves text nodes for text-capable writers, including extracted font-family stacks in the HTML, SVG, and Canvas/Image outputs. |
| Open Shadow DOM | Yes | Not documented | Yes | Yes | `layout2vector` traverses open Shadow DOM. html2canvas-pro documents automatic Shadow DOM handling and `iframeContainer`. SnapDOM documents Shadow DOM support in its clone flow. |
| Same-origin iframe traversal | Yes | Not documented | Not documented | Yes | `layout2vector` can opt into live same-origin iframe walking with `walkIframes`. SnapDOM explicitly documents same-origin iframe support. Cross-origin or unavailable iframe documents are still skipped by browser constraints. |
| Generated content (`::before` / `::after`, `counter()`, `counters()`) | Yes | Not documented | Not documented | Yes | `layout2vector` extracts `::before`/`::after` pseudo-elements with `counter()`, `counters()`, `attr()`, and `open-quote`/`close-quote` resolution. SnapDOM explicitly documents pseudo-element inlining and counter resolution. |
| CSS `corner-shape` / `superellipse()` | Yes | No | No | No | `layout2vector` extracts per-corner `corner-shape` values (`round`, `scoop`, `bevel`, `notch`, `square`, `squircle`, `superellipse(K)`) and renders superellipse curves in all output formats. Requires Chrome 139+. |
| CSS `line-clamp` | Yes | Not documented | Not documented | Yes | `layout2vector` has browser-side coverage for legacy `-webkit-line-clamp`, modern `line-clamp`, implicit ellipsis, and `no-ellipsis` truncation when the browser exposes those values. |
| Flexbox layouts | Yes | Yes | Yes | Not documented | html2canvas and html2canvas-pro list `flex` support. `layout2vector` has a UI test for flexbox layout extraction. |
| Grid layouts | Yes | Not documented | Not documented | Not documented | `layout2vector` has a UI test for CSS grid. I did not find explicit upstream claims for the other tools in the reviewed material. |
| CSS transforms | Yes | Partial | Partial | Yes | html2canvas and html2canvas-pro both describe transform support as limited. SnapDOM documents `outerTransforms` controls and otherwise relies on cloned DOM styling. `layout2vector` extracts transformed geometry from live layout APIs. |
| Stacking order / z-index paint order | Yes | Yes | Yes | Not documented | `layout2vector` builds and flattens a stacking-context tree. html2canvas feature pages list `z-index` support. |
| `<img>` and CSS `background-image` | Yes | Yes | Yes | Yes | html2canvas tools support `url()` with same-origin or CORS/proxy constraints. `layout2vector` extracts `<img>` and CSS background images and preloads them into caches. SnapDOM documents inlining external images and backgrounds. |
| Gradient backgrounds | Yes | Yes | Yes | Not documented | html2canvas and html2canvas-pro document `linear-gradient()` and `radial-gradient()` support. `layout2vector` supports `linear-gradient()`, `radial-gradient()`, `conic-gradient()`, and repeating linear/radial/conic variants across HTML, Canvas/Image, PDF, and SVG, with solid-fill fallback in writers that do not implement gradients. |
| Box shadow | Yes | No | No | Partial | Both html2canvas feature pages explicitly list `box-shadow` as unsupported. SnapDOM's `outerShadows` option shows shadow handling on the cloned root is configurable and can be stripped by default. |
| Text shadow | Yes | Yes | Yes | Partial | html2canvas and html2canvas-pro list `text-shadow` support. SnapDOM's `outerShadows` option can strip root text-shadow. `layout2vector` carries `textShadow` through supported writers. |
| `image-rendering` / pixelated image export | Yes | Not documented | Yes | Not documented | html2canvas-pro explicitly supports CSS `image-rendering` and global image smoothing controls. `layout2vector` preserves `imageRendering` and disables smoothing when requested. |
| Modern CSS color functions (`color()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `hsl()`, `hwb()`) | Yes | No | Yes | Not documented | `layout2vector` supports all CSS Color Level 4 predefined `color()` profiles (`srgb`, `srgb-linear`, `display-p3`, `a98-rgb`, `prophoto-rgb`, `rec2020`, `xyz`, `xyz-d50`, `xyz-d65`) plus `lab()`, `lch()`, `oklab()`, `oklch()`, `hsl()`/`hsla()`, and `hwb()`. |
| `object-fit` on `<img>` | Partial | No | Yes | Not documented | `layout2vector` now covers `fill`, `none`, `contain`, `cover`, and `scale-down`, including keyword/percentage/four-value `object-position` alignment. `object-view-box` cropping is also supported when the browser exposes that property (currently Chromium-class engines). |
| CSS `clip-path` shapes | Partial | Not documented | Yes | Not documented | `layout2vector` has tested support for `inset()`, `circle()`, `ellipse()`, `polygon()`, and `path()` across the Image/Canvas, HTML, SVG, PDF, and EMF writers. More complex nested clip composition is still limited. |
| Form controls as value-aware export | Yes | No | No | Partial | `layout2vector` can synthesize native controls into IR that preserves visible values and states across writers. SnapDOM can capture rendered controls in screenshots, but it does not expose a structured form-control export model. |
| MathML-specific handling | Yes | Not documented | Not documented | Not documented | `layout2vector` has a MathML extractor for browser-rendered MathML features. |
| SVG markers (`marker-start`, `marker-mid`, `marker-end`) | Yes | Not documented | Not documented | Not documented | `layout2vector` has explicit SVG marker extraction and tests. |
| Font embedding / icon-font controls | No | No | No | Yes | I did not find a public font-embedding control surface in `layout2vector`, html2canvas, or html2canvas-pro. SnapDOM documents `embedFonts`, `localFonts`, `iconFonts`, and `excludeFonts`. |
| Cache control / pre-cache API | No | No | No | Yes | `layout2vector` has internal caches but no public cache mode API. SnapDOM documents `cache` modes and `preCache()`. |
| Cross-origin image control knobs | Partial | Yes | Yes+ | Yes | html2canvas documents `allowTaint`, `useCORS`, and `proxy`. html2canvas-pro keeps those and adds `customIsSameOrigin`. SnapDOM documents `useProxy` plus fallback image handling. `layout2vector` preloads images, but browser security still applies. |
| CAD / print / vector-document workflows | Yes | No | No | No | This is the clearest product split: `layout2vector` targets DXF, DWG, EMF, EMF+, PDF, SVG, and HTML export, not just screenshots. |

## Takeaways

- If you need a browser-side screenshot as a canvas or PNG/JPEG/WEBP export, html2canvas, html2canvas-pro, and SnapDOM are the closest direct fits.
- html2canvas-pro extends html2canvas mainly through newer CSS support and better image handling, but it still keeps the same canvas-first output model.
- SnapDOM is also screenshot-first, but it adds more export ergonomics than html2canvas: SVG and Blob export, reusable capture objects, font/proxy controls, `preCache()`, and a beta plugin/hook surface.
- If you need structured export, editable output, preserved text/vector semantics, or vector/document formats such as DXF, DWG, EMF, PDF, SVG, or standalone HTML, `layout2vector` has the broadest feature surface in this set.

## Clone-Based Screenshot Trade-Offs

html2canvas, html2canvas-pro, and SnapDOM all rely on some form of cloned capture pipeline rather than exporting directly from the live subtree in place.

That design is useful because it enables screenshot-focused features such as DOM filtering, style inlining, pseudo-element handling, font embedding, export helpers, and plugin-time capture transforms. In SnapDOM specifically, the clone-plus-`foreignObject` pipeline is what makes its pseudo-element, counter, font, and custom-export story possible.

The cost is that fidelity depends on the cloned tree reproducing enough runtime context for layout and painting to still match the live page. In practice, clone-based capture can still run into edge cases around Shadow DOM boundaries, slot distribution, scroll-dependent layout, JS-mutated state, iframe context, media state, and browser-specific `foreignObject` behavior.

`layout2vector` makes the opposite trade. It walks the live rendered DOM, reads computed geometry directly, and exports from the extracted IR. That avoids a whole class of clone-synchronization bugs and makes CAD/vector/document outputs possible, but it does not currently expose the same screenshot-pipeline hook surface that SnapDOM advertises.

## Sources

Internal project sources used for this comparison:

- [README.md](./README.md)
- [src/index.ts](./src/index.ts)
- [src/pipeline.ts](./src/pipeline.ts)
- [src/traversal.ts](./src/traversal.ts)
- [src/extractors/html-extractor.ts](./src/extractors/html-extractor.ts)
- [src/extractors/form-controls.ts](./src/extractors/form-controls.ts)
- [src/extractors/image-extractor.ts](./src/extractors/image-extractor.ts)
- [src/extractors/mathml-extractor.ts](./src/extractors/mathml-extractor.ts)
- [src/extractors/svg-extractor.ts](./src/extractors/svg-extractor.ts)
- [src/writers/html-writer.ts](./src/writers/html-writer.ts)
- [src/writers/image-writer.ts](./src/writers/image-writer.ts)
- [src/writers/emf-writer.ts](./src/writers/emf-writer.ts)
- [src/writers/pdf-writer.ts](./src/writers/pdf-writer.ts)
- [src/writers/svg-writer.ts](./src/writers/svg-writer.ts)
- [src/writers/shared/clip-path.ts](./src/writers/shared/clip-path.ts)
- [src/writers/shared/css-color.ts](./src/writers/shared/css-color.ts)
- [tests/ui/rendering.test.ts](./tests/ui/rendering.test.ts)
- [src/writers/canvas-writer.ts](./src/writers/canvas-writer.ts)
- [tests/unit/canvas-writer.test.ts](./tests/unit/canvas-writer.test.ts)
- [tests/unit/clip-path-writers.test.ts](./tests/unit/clip-path-writers.test.ts)
- [tests/unit/css-color.test.ts](./tests/unit/css-color.test.ts)
- [tests/unit/form-controls.test.ts](./tests/unit/form-controls.test.ts)
- [tests/unit/image-extractor.test.ts](./tests/unit/image-extractor.test.ts)
- [tests/unit/png-writer.test.ts](./tests/unit/png-writer.test.ts)
- [tests/unit/svg-markers.test.ts](./tests/unit/svg-markers.test.ts)

External sources reviewed on 2026-04-13:

- [html2canvas documentation](https://html2canvas.hertzen.com/documentation.html)
- [html2canvas features](https://html2canvas.hertzen.com/features/)
- [html2canvas configuration](https://html2canvas.hertzen.com/configuration/)
- [html2canvas-pro homepage](https://yorickshan.github.io/html2canvas-pro/)
- [html2canvas-pro why page](https://yorickshan.github.io/html2canvas-pro/why.html)
- [html2canvas-pro features](https://yorickshan.github.io/html2canvas-pro/features.html)
- [html2canvas-pro configuration](https://yorickshan.github.io/html2canvas-pro/configuration.html)
- [html2canvas-pro GitHub repository](https://github.com/yorickshan/html2canvas-pro)

External sources reviewed on 2026-04-15:

- [SnapDOM GitHub repository / README](https://github.com/zumerlab/snapdom)

When a cell says `Not documented`, it means I did not find an explicit claim in the upstream public docs above. It does not necessarily mean the feature fails in practice.