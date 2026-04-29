- Gradient parsing and repeating-stop expansion are shared in src/writers/shared/gradient-utils.ts; image-writer.ts, pdf-writer.ts, and svg-writer.ts only adapt stop units and color types locally.
- When refactoring gradients, preserve writer-specific stop color typing and conic fallback behavior; the low-risk first step is a shared parser that returns a normalized gradient AST plus writer-local color conversion.
- EMF+ now uses native brush objects for linear and radial gradients, keeps conic gradients vector by approximating them with many clipped solid sectors, and preserves transparent stops so multi-layer backgrounds still compose correctly.


