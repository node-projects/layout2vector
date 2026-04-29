- CSS background SVGs should only stay vector when the element has no compositing/effect requirements; if `style.filter`, blend mode, mask, or clip effects are present, rasterize the SVG background the same way `<img>` SVG extraction already does.
- SVG/PDF inset `box-shadow` output is most reliable as a clipped even-odd frame inside the element bounds. Feeding an inset-shadow filter from a `fill="none"` source produces no visible pixels.
- Writer-only regressions for cross-format shadow output are easiest to cover with manual IR tests in `tests/unit/writers.test.ts` and `tests/unit/pdf-writer.test.ts`, then confirm the affected demos with `npx playwright test tests/demos/demos.test.ts --project=demos --grep "convert demo: (box-shadow|svg-files)"`.
- PDF inset shadows must paint after the element fill pass; drawing them before the fill leaves the right color ops in the stream but the gray fill covers the shadow, which looks like a missing regression in `box-shadow.html`.

