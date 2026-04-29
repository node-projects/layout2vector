- With linked acad-ts containing commit b7ed429 and a fresh acad-ts build, htmlConverter no longer needs the local DWG Windows-1252 monkey patch in src/writers/acad-writer.ts.
- After npm link, rebuild acad-ts before Playwright demos; stale dist output can surface browser-side import errors until rebuilt.

- Before acad-ts commit b7ed429, AC18 DWG variable text was effectively written with the wrong encoding relative to header codePage; the old htmlConverter monkey patch can stay removed once the fixed acad-ts build is present.
- Verified after patch removal: linked acad-ts round-trips DWG variable text "säöü" correctly, and htmlConverter Playwright demo `convert demo: test9` passes.
- acad-ts DXF umlaut failures in htmlConverter were caused by using `DxfWriter` through a string sink and then writing the result as UTF-8; acad-ts itself documents/tests ANSI_1252 DXF correctly when given a `Uint8Array` output target. The current htmlConverter wrapper in `src/writers/acad-writer.ts` returns `string` for `AcadDXFWriter`, which is the wrong abstraction for exact legacy-codepage DXF bytes.
