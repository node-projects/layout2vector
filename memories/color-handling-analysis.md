# htmlConverter Color Handling - Complete Analysis

## Key Files

### Core Color Module
- [src/writers/shared/css-color.ts](src/writers/shared/css-color.ts) - **Central color parsing module**
- [src/writers/shared/gradient-utils.ts](src/writers/shared/gradient-utils.ts) - Gradient parsing helpers
- [src/writers/shared/writer-utils.ts](src/writers/shared/writer-utils.ts) - General writer utilities

### Extraction
- [src/traversal.ts](src/traversal.ts) - DOM traversal & `extractStyle()` (where colors are read from computed styles)
- [src/extractors/html-extractor.ts](src/extractors/html-extractor.ts) - HTML geometry extraction
- [src/pipeline.ts](src/pipeline.ts) - IR generation pipeline & visibility checks

### Writers (Color Consumers)
- [src/writers/canvas-writer.ts](src/writers/canvas-writer.ts) - Canvas 2D drawing (delegates to image-writer)
- [src/writers/image-writer.ts](src/writers/image-writer.ts) - Canvas-based raster (PNG, JPEG, WebP)
- [src/writers/svg-writer.ts](src/writers/svg-writer.ts) - SVG output
- [src/writers/acad-writer.ts](src/writers/acad-writer.ts) - DXF/DWG via acad-ts
- [src/writers/pdf-writer.ts](src/writers/pdf-writer.ts) - PDF output
- [src/writers/html-writer.ts](src/writers/html-writer.ts) - HTML output
- [src/writers/dxf-writer.ts](src/writers/dxf-writer.ts) - DXF via @tarikjabiri/dxf
- [src/writers/emf-writer.ts](src/writers/emf-writer.ts) - EMF (enhanced metafile)
- [src/writers/png-writer.ts](src/writers/png-writer.ts) - PNG-specific (canvas-backed)

### Tests
- [tests/unit/css-color.test.ts](tests/unit/css-color.test.ts) - Color parsing tests

---

## Color Pipeline

```
DOM Element
    ↓
[traversal.ts] extractStyle() reads computed styles
    ↓ (collects: fill, stroke, color, borderTopColor, etc.)
    ↓
[Style object in IR Node]
    ↓
[pipeline.ts] renderIR() dispatches to Writer
    ↓
[Writer] (svg-writer, image-writer, pdf-writer, acad-writer, etc.)
    ↓
[Writers call parseCssColor()] to convert CSS strings → { r, g, b, a }
    ↓
[Format conversion] (toHex, toTrueColor, toColorRef, linear/Lab/Oklab, etc.)
    ↓
Final output (SVG, Canvas, PDF, DXF, etc.)
```

---

## CSS Color Parsing (`parseCssColor()`)

### Supported Formats

1. **Hex Colors**
   - `#RGB` → expands to `#RRGGBB`
   - `#RRGGBB` (opaque)
   - `#RRGGBBAA` (with alpha)

2. **RGB/RGBA (Modern & Legacy)**
   - Legacy comma syntax: `rgba(194, 31, 31, 0.52)` ✓
   - Legacy comma syntax: `rgba(194, 31, 31)` ✓
   - Modern slash syntax: `rgb(100 150 200 / 0.5)` ✓
   - Spaces or commas: both supported
   - Percentage values: `rgb(50% 75% 100%)`
   - Percentages + commas: `rgba(100%, 50%, 75%, 0.8)`

3. **Modern CSS Color Functions** (Partial Support)
   - ✓ `color(srgb r g b / alpha)` - **sRGB only**
   - ✓ `color(srgb-linear r g b / alpha)` - Linear sRGB (converted to sRGB)
   - ✗ `color(display-p3 ...)` - NOT supported (returns null)
   - ✗ Other profiles - NOT supported

4. **Lab & LCH** ✓
   - `lab(L a b / alpha)` → Lab colorspace
   - `lch(L C H / alpha)` → LCH cylindrical (converted to Lab internally)
   - Lightness: % or numeric (0-100 in CIE Lab)
   - Hue: deg, rad, turn, or unitless degrees

5. **Oklab & OKLch** ✓
   - `oklab(L a b / alpha)` → Oklab (perceptually uniform)
   - `oklch(L C H / alpha)` → OKLch cylindrical
   - Lightness: % or numeric (0-1)
   - Hue: deg, rad, turn, or unitless degrees

6. **Special Keywords**
   - `transparent` → null (alpha = 0)
   - `none` → null
   - **No named colors** (e.g., `"red"`, `"blue"`) - these return null

### Return Type
```typescript
type ParsedCssColor = { r: number; g: number; b: number; a: number }
// r, g, b: 0-255
// a: 0-1 (alpha)
```

### Key Functions

```typescript
parseCssColor(color: string | undefined): ParsedCssColor | null
// Main entry point, includes color caching (2000-entry LRU)

parseVisibleCssColor(color: string | undefined): ParsedCssColor | null
// Returns null if alpha = 0 (transparent)

cssColorToHex(color: string | undefined): string | undefined
// → "#RRGGBB" (ignores alpha)

cssColorToTrueColor(color: string | undefined): number | undefined
// → (r << 16) | (g << 8) | b (for DXF/DWG)

cssColorToColorRef(color: string | undefined): number | null
// → r | (g << 8) | (b << 16) (GDI COLORREF for EMF/Windows)
```

---

## Color Space Conversions

### Lab ColorSpace (CIE LAB)
- Uses D50 reference white
- Converts Lab → XYZ(D50) → Linear sRGB → sRGB
- Functions: `fromLab(l, a, b, alpha)`, `labInv()`

### Oklab ColorSpace (Perceptually Uniform)
- More modern perceptual model
- Converts Oklab → Linear sRGB → sRGB
- Functions: `fromOklab(l, a, b, alpha)`

### Linear sRGB
- Applies inverse gamma correction: `linearToSrgb(value)`
- For values ≤ 0.0031308: `12.92 * value`
- For values > 0.0031308: `1.055 * value^(1/2.4) - 0.055`

---

## Style Extraction (`traversal.ts: extractStyle()`)

What CSS properties are extracted from computed styles:

### Colors Extracted
- `fill` - Computed from `backgroundColor` → falls back to gradient first color-stop
- `stroke` - From `borderColor` or SVG `stroke`
- `color` - Text color
- `borderTopColor`, `borderRightColor`, `borderBottomColor`, `borderLeftColor` - Individual borders
- `outlineColor` - Outline color (used when outline is visible)
- `textShadow` - Text shadow color component
- `boxShadow` - Box shadow color component (parsed by writers)

### Gradients
- `backgroundImage` - Includes `linear-gradient()`, `radial-gradient()`, `conic-gradient()` and repeating variants
- `mask` and `-webkit-mask` - Mask image (can contain gradients)

### Filter
- `filter` - Can include shadows, blurs (not fully parsed, passed as string)

---

## Visibility Checks

### `pipeline.ts: isVisibleColor()`
```typescript
function isVisibleColor(color: string | undefined): boolean
```
A color is **visible** if:
- Not `undefined`, `"transparent"`, or `"none"`
- Not `rgba(...)` with alpha ≤ 0
- Not `#XXXXXX00` (hex with alpha = 0)

### `pipeline.ts: isVisibleNode()`
Skips rendering of polygons/polylines with:
- No `fill` (and fill is visible) ✓ Renders
- No `stroke` AND stroke width > 0 ✓ Renders
- No outline/borders/shadows/gradients ✓ Skips

---

## Color Handling by Writer

### Canvas/Image Writers
- `formatCssColor(parsed)` → converts `{ r, g, b, a }` back to `"rgb(r, g, b)"` or `"rgba(r, g, b, a)"`
- Used for gradient interpolation (colors sampled at gradient stops)
- Box shadow parsing extracts colors via regex (rgb/rgba/hex)

### SVG Writer
- Uses parsed colors directly in `fill=` and `stroke=` attributes
- Converts to `rgb()` or `rgba()` strings
- Gradient-aware: interpolates colors across stops
- Also handles `filter: drop-shadow()` color extraction

### PDF Writer
- `parseVisibleColor()` returns `{ r, g, b, a }`
- Uses `(r/255, g/255, b/255, a)` in PDF color space operators
- Box shadow parsing extracts colors for shadow drawing
- Text color via `[r/255 g/255 b/255] rg`

### Acad (DXF/DWG) Writer
- `cssToAcadColor()` calls `parseCssColor()`, extracts `r, g, b`
- Creates `acad.Color(r, g, b)` (true color)
- Converts to nearest index color if needed via `toNearestAcadIndexColor()`
- Applies fill colors with `HATCH` entities
- Text color from `style.color` or fallback to `style.fill`

### EMF Writer
- Uses `cssColorToColorRef()` → `r | (g << 8) | (b << 16)`
- GDI COLORREF format (little-endian BGR)

### DXF Writer (@tarikjabiri/dxf)
- Uses true color values from CSS
- LWPOLYLINE with `trueColor` from parsed fill/stroke
- IMAGE entities reference external files

### HTML Writer
- Passes color strings directly or wraps in style attributes
- Can include modern CSS color functions (handled by browser when rendering)

---

## Cache & Performance

### Color Caching
- `colorCache` (Map) stores parsed colors
- Max 2000 entries (clears when exceeded)
- Parsing is fast but called per color occurrence
- Key: CSS string (e.g., `"rgba(194, 31, 31, 0.52)"`)

### Image Caching
- Raster images cached separately (image-extractor.ts)
- Cache cleared at start of each `extractIR()` call

---

## Edge Cases & Known Limitations

### ✓ Handled Well
- Legacy `rgba(r, g, b, a)` with commas (browsers sometimes emit this)
- Mixed comma & slash syntax support
- Transparent colors properly skipped
- Lab/Oklab conversion with correct matrices
- Linear sRGB gamma correction accurate
- Gradients with modern color functions in stops

### ✗ Known Gaps (from FEATURES.md)
- **No named colors** (`"red"`, `"blue"`, etc.) - return `null`
- **`color(display-p3 ...)` and other color profiles** - NOT parsed (only sRGB)
- **No hwb()** - Not in the codebase
- **No `hsl()` / `hsla()`** - Not supported
- **Font embedding/face colors** - Limited control

### ⚠ Potential Issues
1. **Computed styles vary by browser** - Some browsers normalize `rgba()` to spaced syntax
2. **Semi-transparent fills can disappear** - Alpha values properly checked but depends on writer implementation
3. **Gradients in CSS properties** - Only first color extracted for solid fallback (not full gradient parsing in style extraction)
4. **SVG stroke/fill attributes** - Handled by SVG extractor separately (different pipeline)

---

## Color Workflow Examples

### Example 1: Simple Div
```html
<div style="background: rgb(100, 150, 200); color: #FF0000;">Text</div>
```
→ `fill: "rgb(100, 150, 200)"`, `color: "#FF0000"` in Style
→ Writer calls `parseCssColor()` on each
→ `{ r: 100, g: 150, b: 200, a: 1 }` and `{ r: 255, g: 0, b: 0, a: 1 }`

### Example 2: Gradient
```html
<div style="background: linear-gradient(90deg, red, blue);"></div>
```
→ `backgroundImage: "linear-gradient(...)"` in Style
→ Writer extracts gradient function, parses color stops
→ For each stop, calls `parseCssColor()` on the color string
→ Interpolates between parsed colors across gradient

### Example 3: Modern Color Function
```html
<div style="background: lab(54.2917% 80.8125 69.8851);"></div>
```
→ `fill: "lab(...)"` in Style
→ `parseCssColor()` detects `lab()`, calls `parseLabFunction()`
→ Converts Lab → XYZ → Linear sRGB → sRGB
→ Returns `{ r: 255, g: 0, b: 0, a: 1 }`

### Example 4: Border with Opacity
```html
<div style="border: 2px solid rgba(100, 50, 200, 0.5);"></div>
```
→ `borderTopColor: "rgba(100, 50, 200, 0.5)"` in Style
→ `parseCssColor()` with comma syntax → `{ r: 100, g: 50, b: 200, a: 0.5 }`
→ Writer respects alpha (certain writers may preserve/blend, others convert to opaque)

---

## Future Enhancement Opportunities

1. **hwb() support** - Add `parseHwbFunction()` for HWB colorspace
2. **hsl()/hsla() support** - Add HSL conversion (common in modern CSS)
3. **Named colors** - Cache hash of standard CSS colors
4. **display-p3 and other color()** profiles - Add matrix conversions for Adobe RGB, Rec2020
5. **Implicit gradients** - Better parsing of gradient color-stops with auto-positioning
6. **CSS Custom Properties** - Follow `var()` to resolve actual colors (currently not resolved)
