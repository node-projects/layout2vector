import type { Quad, Style } from "../../types.js";

export function getVisibleStroke<T>(
  style: Pick<Style, "stroke" | "strokeWidth">,
  parseColor: (color: string | undefined) => T | null | undefined,
): { color: T; width: number } | null {
  const color = parseColor(style.stroke);
  if (color == null) return null;

  const width = style.strokeWidth ? parseFloat(style.strokeWidth) : 0;
  if (width <= 0) return null;

  return { color, width };
}

export function isAxisAlignedRect(points: Quad): boolean {
  const eps = 0.5;
  return (
    Math.abs(points[0].y - points[1].y) < eps &&
    Math.abs(points[2].y - points[3].y) < eps &&
    Math.abs(points[0].x - points[3].x) < eps &&
    Math.abs(points[1].x - points[2].x) < eps
  );
}

export function parseMinDimensionBorderRadius(borderRadius: string | undefined, w?: number, h?: number): number {
  if (!borderRadius || borderRadius === "0px" || borderRadius === "0%") return 0;
  const raw = borderRadius.split(/\s+/)[0];
  if (!raw) return 0;
  if (raw.endsWith("%")) {
    const pct = parseFloat(raw);
    if (isNaN(pct) || pct <= 0) return 0;
    const ref = (w !== undefined && h !== undefined) ? Math.min(w, h) : 0;
    return (pct / 100) * ref;
  }
  const val = parseFloat(raw);
  return !isNaN(val) && val > 0 ? val : 0;
}

export function parseAverageBorderRadius(borderRadius: string | undefined, elWidth?: number, elHeight?: number): number {
  if (!borderRadius || borderRadius === "0px") return 0;
  const val = parseFloat(borderRadius);
  if (isNaN(val) || val <= 0) return 0;
  if (borderRadius.includes("%")) {
    const avgDim = ((elWidth ?? 0) + (elHeight ?? 0)) / 2;
    return avgDim > 0 ? avgDim * val / 100 : val;
  }
  return val;
}

export function formatWriterNumber(v: number): string {
  return +v.toFixed(2) + "";
}