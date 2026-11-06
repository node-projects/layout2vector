# CAD text encoding

DXF output uses standard ASCII Unicode escapes so legacy code pages and binary-string saves preserve symbols and private-use characters. AcadDXFWriter returns bytes; do not convert those bytes through UTF-8 text serialization. DWG defaults to AC1021 for native Unicode text. Explicit legacy versions retain their own encoding limits.

Create and assign font-specific CAD text styles, using actual font filenames for Wingdings and Segoe UI. CAD previews map those filenames back to browser font-family names. Preserve the font requirement when moving drawings to another computer. Keep upstream text/font round-trip checks alongside the editor integration coverage.
