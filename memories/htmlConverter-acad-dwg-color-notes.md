# CAD colors and symbol geometry

Preserve explicit true colors for CAD entities and hatches, including separate black and white. Do not map near-neutral fills to adaptive index 7. acad-ts AC18+ serializers write true-color RGB integers as BGR bytes; retain asymmetric-color round-trip coverage.

The SVG preview uses direct fills for solid hatches. Bitmap icons are coalesced into filled paths inside reusable CAD blocks, and repeated explicit-color hatch blocks share SVG definitions. Preserve insert scale, rotation, base point and bounds when rendering. Browser-based alpha holes are retained; partial alpha in the bitmap fallback is blended over white.
