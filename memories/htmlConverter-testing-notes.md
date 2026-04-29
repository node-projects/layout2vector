- Browser-side Playwright tests use a hand-assembled injected bundle in tests/helpers.ts; when adding a new dist extraction module, add it to injectLibrary() or page tests will miss the new code.
- Demo conversion tests can selectively enable extractor options per demo file by checking window.location.pathname inside the page-side extractIR call.
- Cross-writer clip-path regressions are easiest to test node-side in tests/unit/clip-path-writers.test.ts by rendering manual IR through HTML/SVG/PDF/EMF writers; that avoids the browser injection path when validating writer-only behavior.
- Same-origin iframe traversal is opt-in via `walkIframes`; browser-side iframe changes should be validated with `npm run build` first because Playwright injects `dist/`, then with the focused integration iframe tests and the `convert demo: iframes` demo path.
- Chromium headless can render `file://` iframe content while still exposing `iframe.contentDocument === null`; `tests/demos/demo-conversion.ts` works around that by rewriting local HTML iframe `src` values to `srcdoc` with a `<base>` tag before running `walkIframes` extraction.

- Transformed iframe clipping is carried through the IR via `style.clipQuads`; if iframe content leaks only in some formats, check whether the affected writer applies both `clipBounds` and `clipQuads` before looking at traversal math.

- Collapsed whitespace around inline siblings must not be blindly trimmed during HTML extraction: a text node like `" world "` between `<b>`/`<a>` needs its boundary spaces preserved and emitted with `style.whiteSpace = "pre"`, or all writers collapse `Hello world again` into `Helloworldagain`-style runs in demos like `wikipedia`.

- Boundary spaces around inline siblings should only survive when the browser actually rendered a whitespace character box; if the collapsed space wrapped away at a line edge, preserve DOM order but drop that space or outputs like wikipedia regain bogus leading/trailing spaces in HTML/SVG/PDF.

- Firefox native `getBoxQuads` exposes wrapped text more accurately than the Chromium polyfill; wrapped HTML text runs still normalize `whiteSpace` to `pre` and should keep `textIndent` cleared on split line nodes, but non-last justified lines need `style.textAlign = "justify"` preserved so HTML/SVG writers can recreate the expanded word spacing from the measured quad width.
- Writing-mode support now has `textMeasurement: "line" | "character" | "auto"`; `auto` only expands text to grapheme-level IR when `writingMode` is non-default or `direction` is not `ltr`, which is the intended path to support vertical/RTL text in non-HTML writers.
- PDF rounded-rect output must apply the CSS common scaling factor for oversized uniform radii like `border-radius:999px`; clamping horizontal and vertical radii independently turns hero pills into ellipses even though SVG/HTML/CAD writers still look correct.
- Pretext-based vertical-writing extraction needs the parent element's border-box quad mapped back onto the local content box; otherwise text in rotated vertical tags keeps the 90° writing-mode turn but drops the element's own transform, as seen in the Firefox font-stacks `RTL Signal` badge.
- When Firefox exposes a single native text-node quad for vertical or sideways text, prefer that box over pretext placement for exact positioning, but reorder the DOMQuad points into inline-flow order before handing them to the writers; the raw DOMQuad order keeps the correct position but makes the text look like a 6° horizontal quad instead of a 96° vertical run.



- Firefox demo screenshot generation can exceed the default 30s Playwright timeout; `tests/demos/screenshot.test.ts` needs an explicit longer timeout for the full Firefox demo matrix.
- The Firefox `convert demo: github` path is remote-heavy enough to exceed the generic 120s demo timeout during full-suite runs; keep extra timeout headroom there even when the focused test passes.

- The GitHub demo only shows placeholder text end-to-end when `tests/demos/demos.test.ts` opts into `convertFormControls`; once enabled, shared form-control extraction now falls back to `placeholder` for empty text inputs and textareas.
- Small transparent raster images now stay PNG in extracted IR when `rgbData` is available, while PDF/EMF still use white-blended `rgbData`; this fixes GitHub repo avatars that were previously flattened to white JPEGs.
- Some modern UIs use a transparent native textarea/input purely as an interaction target and paint the visible field elsewhere; for those, form-control conversion should emit placeholder/value text but only synthesize a box when the control has real visible chrome (fill, non-zero border/stroke, shadow, or background image). Visible text color alone is not enough, or GitHub/Google-style search inputs turn white in generated output.
- PDF image embedding should prefer decoding `data:image/png` and emitting an `/SMask` when alpha is present, even if `rgbData` exists; otherwise transparent PNGs get flattened to white in PDF output.

- PDF outer `box-shadow` rendering must respect `borderRadius` even when `blur=0`; otherwise circular GitHub-style badge icons render as square dark boxes in PDF output.

- HTML writer images need `style.borderRadius` copied onto the emitted `<img>`/CSS image node; otherwise avatars like GitHub's `prc-Avatar-Avatar-*` render square in `github-ir.html` even when extraction preserved the radius.
- Firefox exposes `-webkit-line-clamp` titles as multiple text-node quads even when `overflow:hidden` + `textOverflow:ellipsis` is set; `src/extractors/html-extractor.ts` must not route those through the single-line ellipsis path, and should keep only the clamped number of lines while ellipsizing the last visible fragment.
- Remote SVG <img> sources can still poison Firefox PNG export even when extraction already produced a safe raster/data payload if `extractImageGeometry()` restores the original non-data `src`; only keep the original SVG source when it is already a `data:image/svg+xml` URL.
- `clipTextToWidth()` has two distinct ellipsis cases: single-line `text-overflow: ellipsis` should only append `…` when the measured text exceeds the available width, while the last visible line of a multi-line clamp must still force `…` when hidden lines remain.

- GitHub octicons can encode multiple filled subpaths in one `<path>` using a `Z m...` sequence; on Firefox, `SVGPathElement.getPathData({ normalize: true })` is the cleanest way to split those into separate sampled polylines before writing HTML/SVG/PNG/PDF output.

- Firefox vertical-writing coverage with `textMeasurement: "auto"` goes through the pretext path, which clears `style.writingMode`/`direction` on the emitted IR text nodes and preserves the layout as rotated quads instead. End-to-end tests for those cases should assert on the rotated text geometry or writer transforms, not on exported `writing-mode` attributes.







- Multi-writer page export now lives in `tests/demos/demo-conversion.ts`; `tests/demos/url.test.ts` reuses it for live pages and reads the target from `HTML_CONVERTER_TEST_URL` or npm config (`npm run test:url --url=https://example.com`).

- Async demo fixtures can gate shared conversion through `document.documentElement.dataset.demoReady`; `tests/demos/demo-conversion.ts` now waits until that flag leaves `pending` before injecting the library and exporting.
- `tests/demos/demo-conversion.ts` PNG export should use the shared `viewport` width/height, not raw IR max bounds; otherwise live pages like GitHub grow much wider than the SVG/PDF output when off-viewport nodes exist.
- Live canvases can be readable even when canvas-to-canvas redraw fails; for page extraction, serializing `HTMLCanvasElement` with `toDataURL()` first is more reliable than sampling a secondary canvas, as seen on GitHub's 1000x950 top canvas.
- `tests/demos/url.test.ts` now accepts `HTML_CONVERTER_TEST_COLOR_SCHEME` / npm `--color-scheme=dark|light|no-preference`; `tests/demos/demo-conversion.ts` also inlines any remaining non-data IR image URLs node-side before writer rendering so live-page PNG export does not fail on cross-origin images that the browser can display but not re-read.


