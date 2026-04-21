# Paint EMF Probes

Open each .emf file in Paint and note whether it opens at all.

Reply with lines like:
- 01-basic-polygon: works
- 02-basic-text: fails

Files:
- 01-basic-polygon.emf: Filled polygon only; isolates basic brush, pen, and POLYGON16 output. Key records: POLYGON16.
- 02-basic-text.emf: Text only; isolates EXTCREATEFONTINDIRECTW and EXTTEXTOUTW handling. Key records: EXTCREATEFONTINDIRECTW, EXTTEXTOUTW.
- 03-polygon-and-text.emf: Simple shape and text together; checks whether Paint fails only once text is combined with normal drawing. Key records: POLYGON16, EXTCREATEFONTINDIRECTW, EXTTEXTOUTW.
- 04-roundrect.emf: Rounded rectangle only; isolates ROUNDRECT records. Key records: ROUNDRECT.
- 05-clipped-polygon.emf: Polygon clipped with CSS clip-path; isolates path clipping records. Key records: SETPOLYFILLMODE, BEGINPATH, POLYGON16, ENDPATH, SELECTCLIPPATH.
- 06-bitmap.emf: Bitmap only; isolates STRETCHDIBITS without transforms. Key records: STRETCHDIBITS.
- 07-rotated-bitmap.emf: Bitmap with rotation; isolates SETWORLDTRANSFORM plus STRETCHDIBITS. Key records: SETWORLDTRANSFORM, STRETCHDIBITS.
- 08-dashed-polyline.emf: Stroke-only dashed line; isolates dashed CREATEPEN style and POLYLINE16 output. Key records: POLYLINE16.
- 09-tall-polygon.emf: Very tall page with shape only; isolates Paint behavior on capped tall-page headers without text. Key records: POLYGON16.
- 10-tall-text.emf: Very tall page with text only; isolates tall-page header plus EMF text records. Key records: EXTCREATEFONTINDIRECTW, EXTTEXTOUTW.
- 11-evenodd-compound-path.emf: Compound evenodd fill; checks whether Paint fails on multi-subpath fill content without text or images. Key records: SETPOLYFILLMODE, BEGINPATH, POLYLINE16, CLOSEFIGURE, ENDPATH, FILLPATH.
- 12-single-path-winding-fill.emf: Single closed path filled via FILLPATH with winding fill; isolates whether Paint accepts path painting at all. Key records: SETPOLYFILLMODE, BEGINPATH, POLYLINE16, CLOSEFIGURE, ENDPATH, FILLPATH.
- 13-single-path-evenodd-fill.emf: Single closed path filled via FILLPATH with evenodd fill; isolates whether Paint rejects ALTERNATE fill mode even without compound geometry. Key records: SETPOLYFILLMODE, BEGINPATH, POLYLINE16, CLOSEFIGURE, ENDPATH, FILLPATH.
- 14-compound-path-winding-fill.emf: Compound path filled with winding fill; isolates whether the failure needs multiple subpaths or specifically evenodd compound filling. Key records: SETPOLYFILLMODE, BEGINPATH, POLYLINE16, CLOSEFIGURE, ENDPATH, FILLPATH.
