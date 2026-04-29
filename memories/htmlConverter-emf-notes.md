- EMF clip-path portability is better when clip shapes are polygonized before SELECTCLIPPATH; ROUNDRECT/ELLIPSE path records caused the clip-path demo to drop later clipped content.
- For EMF clip regressions, rerun the focused demo and rasterize the generated .emf to confirm the rendered clip result, not just record generation.

- Strict EMF consumers can reject files if EMR_EXTCREATEFONTINDIRECTW omits the full 320-byte EXTLOGFONTW payload; writing only the 92-byte LOGFONTW prefix produced 104-byte font records instead of the 332-byte spec-sized records.
- EMR_STRETCHDIBITS has 72 fixed bytes after the 8-byte EMR header. Using 80 fixed bytes shifted offBmiSrc/offBitsSrc from 80/120 to 88/128 and made image records non-compliant even though GDI+ still rendered them.

- Some non-Windows EMF consumers appear to reject tall files once EMR_HEADER.rclFrame exceeds 65535 in 0.01mm units. Keeping rclFrame within that range, scaling width/height proportionally, and matching szlDevice/szlMillimeters to the page header improves compatibility for tall outputs like github.emf and google.emf.

- Paint rejects EMR_FILLPATH-based path painting even for simple single-subpath fills. For EMF `style.pathSubpaths`, switching filled output to EMR_POLYPOLYGON16 and stroke-only multi-subpaths to EMR_POLYPOLYLINE16 keeps clip-path path records intact while making the manual Paint probes open.
