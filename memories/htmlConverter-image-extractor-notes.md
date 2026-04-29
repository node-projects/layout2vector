- CSS `background-image: url(...)` values from `getComputedStyle()` may contain embedded escaped quotes inside SVG data URLs, so regexes like `url("([^"]+)")` truncate the payload.
- CSS background SVG data URLs can also arrive with CSS hex escapes like `\00003csvg`; decode CSS escapes before `decodeURIComponent` when extracting SVG markup.
- Regressions are covered in `tests/unit/image-extractor.test.ts` for embedded-quote and CSS-escaped SVG background images.

- Cross-origin `<video>` elements can still taint canvas reads even when the live element is already decoded at `currentTime === 0`; prefer an `anonymous` clone for remote sources without `crossOrigin` before calling `getImageData()` or video export silently drops the frame.

- Transparent raster transport must be decided from image alpha alone, not from whether `rgbData` was generated. Large PNGs may intentionally skip `rgbData`, but their exported `dataUrl` still needs to stay PNG or HTML/SVG output loses transparency.

- Raster CSS `background-image` extraction must compose the rendered layer from computed `background-repeat`, `background-size`, `background-position`, and attachment instead of stretching a single tile to the element bounds. Also preloaded PNG background data URLs should stay PNG/decoded images, not be converted to JPEG.

- Rasterized SVG `background-image` assets with `width="100%" height="100%"` should size from the background positioning area, not the browser's fallback `naturalWidth`/`naturalHeight` (often `300x150`); otherwise `auto`/`contain` backgrounds in `svg-files.html` render cropped or undersized across all writers.

- Low-level image helpers (`extractImageGeometry`, `extractBackgroundImage`, and the masked-image path) are now async and must not depend on `preloadImages()` for correctness; direct custom-pipeline calls should work on remote SVG/CSS image URLs without an explicit preload step.
- Page-side remote image preloads should not use `credentials: "include"`; cross-origin SVG/image fetches in the browser context need default/same-origin credentials or ACAO `*` routes start failing and remote SVG fallback tests regress.
- Asset waits must be bounded: image decode/fetch and video readiness can otherwise stall extraction indefinitely on ad-heavy pages. Prefer timeouts that skip the bad asset over waiting forever.


- Pixelated or tiny raster CSS background images need two protections in `renderBackgroundImage()`: disable canvas smoothing for the draw, and keep the output as PNG instead of JPEG. Nearest-neighbor drawing alone is not enough because JPEG re-encoding reintroduces blur at hard pixel edges.

- Large repeated raster CSS background patterns should stay PNG when the repeated tile is small (for example `<=64x64`). Re-encoding those full repeated surfaces as JPEG can force EMF+ into its compressed-image path; `background-repeat-emfplus.emf` only became Paint-compatible again once the repeated tile stayed PNG and the writer emitted raw 32bpp pixels instead of a compressed bitmap object.
