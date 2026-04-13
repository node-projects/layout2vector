# Feature Comparison

This document compares `@node-projects/layout2vector` with `html2canvas` and the `yorickshan/html2canvas-pro` fork.

`html2canvas` and `html2canvas-pro` are DOM-to-canvas screenshot libraries.
`layout2vector` solves a broader export problem: it extracts a structured intermediate representation (IR) from the live DOM and then writes that IR to multiple output formats.

Note: `html2canvas-pro` here refers to the open-source fork at `yorickshan/html2canvas-pro`, not an official commercial edition from the original `html2canvas` project.

Status meanings:

- `Yes`: explicitly documented or covered by repo tests
- `Partial`: supported with important limits or only for some outputs
- `Not documented`: I did not find an explicit upstream claim in the pages reviewed on 2026-04-13
- `No`: explicitly unsupported or outside the tool's model

## Output Formats

This matrix lists the concrete output formats discussed in this comparison.

| Output format | layout2vector | html2canvas | html2canvas-pro | Notes |
| --- | --- | --- | --- | --- |
| DXF | Yes | No | No | Native writer in `layout2vector`. |
| DWG | No | No | No | Included here for completeness. None of the compared tools ships native DWG output. |
| EMF | Yes | No | No | Native writer in `layout2vector`. |
| PDF | Yes | No | No | Native writer in `layout2vector`. html2canvas tools do not emit PDF directly. |
| PNG | Yes | Yes | Yes | html2canvas and html2canvas-pro can export PNG through the returned canvas, not through a dedicated PNG writer abstraction. |
| JPEG | Yes | Yes | Yes | html2canvas and html2canvas-pro can export JPEG through canvas APIs. |
| WEBP | Yes | Yes | Yes | html2canvas and html2canvas-pro can export WEBP where the browser canvas implementation supports it. |
| SVG | Yes | No | No | Native writer in `layout2vector`. |
| HTML | Yes | No | No | Native writer in `layout2vector`. |
| Canvas object | Yes | Yes | Yes | `layout2vector` now exposes a native `CanvasWriter` that returns an `HTMLCanvasElement`. |

| Capability | layout2vector | html2canvas | html2canvas-pro | Notes |
| --- | --- | --- | --- | --- |
| Core rendering model | Structured DOM -> IR -> writer pipeline | DOM -> canvas reconstruction | DOM -> canvas reconstruction | `layout2vector` exposes typed IR nodes and writer backends. Both html2canvas projects document canvas screenshot generation rather than structured export. |
| Requires a temporary cloned document/container | No | Yes | Yes | html2canvas exposes clone-oriented options such as `onclone` and `removeContainer`. html2canvas-pro stays clone-based and adds `iframeContainer` plus document-cloner fixes for edge cases. |
| Built-in output formats | DXF, EMF, PDF, PNG, JPEG, WEBP, SVG, HTML, Canvas | `HTMLCanvasElement` output | `HTMLCanvasElement` output | See the output-format matrix above for the per-format breakdown, including DWG as an explicit unsupported row. |
| Structured IR / custom backends | Yes | No | No | `layout2vector` exposes `polygon`, `polyline`, `text`, and `image` IR nodes plus a `Writer<T>` interface. |
| Keeps text as text/vector objects | Yes | No | No | html2canvas tools rasterize text into a canvas. `layout2vector` preserves text nodes for text-capable writers. |
| Open Shadow DOM | Yes | Not documented | Yes | `layout2vector` traverses open Shadow DOM. html2canvas-pro documents automatic Shadow DOM handling and `iframeContainer`. |
| Flexbox layouts | Yes | Yes | Yes | html2canvas and html2canvas-pro list `flex` support. `layout2vector` has a UI test for flexbox layout extraction. |
| Grid layouts | Yes | Not documented | Not documented | `layout2vector` has a UI test for CSS grid. I did not find an explicit grid claim in upstream feature pages. |
| CSS transforms | Yes | Partial | Partial | html2canvas and html2canvas-pro both describe transform support as limited. `layout2vector` extracts transformed geometry from live layout APIs. |
| Stacking order / z-index paint order | Yes | Yes | Yes | `layout2vector` builds and flattens a stacking-context tree. html2canvas feature pages list `z-index` support. |
| `<img>` and CSS `background-image` | Yes | Yes | Yes | html2canvas tools support `url()`, with same-origin or CORS/proxy constraints. `layout2vector` extracts `<img>` and CSS background images and preloads them into caches. |
| Gradient backgrounds | Yes | Yes | Yes | html2canvas and html2canvas-pro document `linear-gradient()` and `radial-gradient()` support. `layout2vector` supports gradients across multiple writers. |
| Box shadow | Yes | No | No | Both upstream feature pages explicitly list `box-shadow` as unsupported. `layout2vector` implements box-shadow handling in multiple writers. |
| Text shadow | Yes | Yes | Yes | html2canvas and html2canvas-pro list `text-shadow` support. `layout2vector` carries `textShadow` through supported writers. |
| `image-rendering` / pixelated image export | Yes | Not documented | Yes | html2canvas-pro explicitly supports CSS `image-rendering` and global image smoothing controls. `layout2vector` preserves `imageRendering` and disables smoothing when requested. |
| Modern CSS color functions (`color()`, `lab()`, `lch()`, `oklab()`, `oklch()`) | Partial | No | Yes | `layout2vector` now has tested parsing for `color(srgb ...)`, `lab()`, `lch()`, `oklab()`, and `oklch()`. Broader `color()` profiles such as `display-p3` are still not covered. |
| `object-fit` on `<img>` | Partial | No | Yes | `layout2vector` has direct test coverage for `contain`, `cover`, and `scale-down` on extracted `<img>` content. Custom `object-position` handling is still not explicitly covered. |
| CSS `clip-path` shapes | Partial | Not documented | Yes | `layout2vector` now has tested support for `inset()`, `circle()`, `ellipse()`, and `polygon()` across the Image/Canvas, HTML, SVG, PDF, and EMF writers. `path()` and more complex nested clip composition are still missing. |
| Form controls as value-aware export | Yes | No | No | `layout2vector` can synthesize native controls into IR that preserves visible values and states across writers. html2canvas tools may paint controls into pixels, but they do not expose a structured form-control export model. |
| MathML-specific handling | Yes | Not documented | Not documented | `layout2vector` has a MathML extractor for browser-rendered MathML features. |
| SVG markers (`marker-start`, `marker-mid`, `marker-end`) | Yes | Not documented | Not documented | `layout2vector` has explicit SVG marker extraction and tests. |
| Cross-origin image control knobs | Partial | Yes | Yes+ | html2canvas documents `allowTaint`, `useCORS`, and `proxy`. html2canvas-pro keeps those and adds `customIsSameOrigin`. `layout2vector` preloads images, but browser security still applies. |
| CAD / print / vector-document workflows | Yes | No | No | This is the clearest product split: `layout2vector` targets DXF, EMF, PDF, SVG, and HTML export, not just screenshots. |

## Takeaways

- If you need a browser-side screenshot as a canvas or PNG, html2canvas and html2canvas-pro are the closest direct fit.
- If you need structured export, editable output, or vector/document formats such as DXF, EMF, PDF, SVG, or standalone HTML, `layout2vector` has a much broader feature surface.
- html2canvas-pro extends html2canvas mainly through newer CSS support and better image handling, but it still keeps the same canvas-first output model.

## Clone-Based Downside In html2canvas

html2canvas and html2canvas-pro do not render directly from the live subtree in place. They build a temporary cloned document/container and render from that copy.

That design is flexible, but it creates a real failure mode: the cloned tree has to reproduce enough of the original environment for layout and painting to still match. In practice, that can break down when the capture depends on runtime state or context that does not copy perfectly, such as Shadow DOM boundaries, slot distribution, scroll-dependent layout, JS-mutated values, media or canvas state, adopted nodes, or surrounding viewport and iframe context.

The public APIs and changelogs reflect that complexity. html2canvas documents `onclone`, clone cleanup, and temporary render-container options. html2canvas-pro adds `iframeContainer` specifically for Shadow DOM scenarios, documents Shadow DOM handling, and has recent fixes for slot rendering and document-cloner ordering. That is a good practical indicator that clone correctness is part of the problem space, not just CSS support.

By contrast, `layout2vector` walks the live rendered DOM, reads computed geometry directly, and then exports from the extracted IR. That does not remove every browser limitation, but it avoids a whole class of clone-synchronization bugs.

## Sources

Internal project sources used for this comparison:

- [README.md](./README.md)
- [src/index.ts](./src/index.ts)
- [src/pipeline.ts](./src/pipeline.ts)
- [src/traversal.ts](./src/traversal.ts)
- [src/extractors/form-controls.ts](./src/extractors/form-controls.ts)
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

When a cell says `Not documented`, it means I did not find an explicit claim in the upstream public docs above. It does not necessarily mean the feature fails in practice.