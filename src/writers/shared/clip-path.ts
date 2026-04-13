import type { Point, Quad } from "../../types.js";

export type ClipPathBounds = { x: number; y: number; w: number; h: number };
export type ClipPathFillRule = "nonzero" | "evenodd";

export type ClipPathShape =
  | {
      kind: "inset";
      x: number;
      y: number;
      w: number;
      h: number;
      rx: number;
      ry: number;
      fillRule: "nonzero";
    }
  | {
      kind: "ellipse";
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      fillRule: "nonzero";
    }
  | {
      kind: "polygon";
      points: Point[];
      fillRule: ClipPathFillRule;
    };

export function getQuadBounds(quad: Quad): ClipPathBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of quad) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function getPointBounds(points: Point[]): ClipPathBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function parseClipLength(token: string, reference: number): number {
  const value = token.trim().toLowerCase();
  if (!value) return 0;
  if (value.endsWith("%")) {
    return (parseFloat(value) / 100) * reference;
  }
  const numeric = parseFloat(value);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function expandInsetValues(values: string[]): [string, string, string, string] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return [values[0], values[1], values[2], values[3]];
}

function parseInsetRadii(rawRound: string | undefined, bounds: ClipPathBounds): { rx: number; ry: number } {
  if (!rawRound) return { rx: 0, ry: 0 };

  const tokens = rawRound
    .trim()
    .replace(/\//g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return { rx: 0, ry: 0 };

  const rx = parseClipLength(tokens[0], bounds.w);
  const ry = tokens[1] ? parseClipLength(tokens[1], bounds.h) : rx;
  return { rx, ry };
}

export function parseClipPathShape(clipPath: string | undefined, bounds: ClipPathBounds): ClipPathShape | null {
  const raw = clipPath?.trim();
  if (!raw || raw === "none") return null;

  const inset = raw.match(/^inset\((.+)\)$/i);
  if (inset) {
    const [rawInsets, rawRound] = inset[1].split(/\s+round\s+/i, 2);
    const values = rawInsets.trim().split(/\s+/).filter(Boolean);
    if (values.length === 0 || values.length > 4) return null;

    const [topToken, rightToken, bottomToken, leftToken] = expandInsetValues(values);
    const top = parseClipLength(topToken, bounds.h);
    const right = parseClipLength(rightToken, bounds.w);
    const bottom = parseClipLength(bottomToken, bounds.h);
    const left = parseClipLength(leftToken, bounds.w);
    const radii = parseInsetRadii(rawRound, bounds);

    return {
      kind: "inset",
      x: bounds.x + left,
      y: bounds.y + top,
      w: Math.max(0, bounds.w - left - right),
      h: Math.max(0, bounds.h - top - bottom),
      rx: radii.rx,
      ry: radii.ry,
      fillRule: "nonzero",
    };
  }

  const circle = raw.match(/^circle\((.+)\)$/i);
  if (circle) {
    const [radiusToken, centerToken] = circle[1].split(/\s+at\s+/i, 2);
    const center = centerToken ? centerToken.trim().split(/\s+/).filter(Boolean) : ["50%", "50%"];
    if (center.length !== 2) return null;

    const radius = parseClipLength(radiusToken.trim(), Math.min(bounds.w, bounds.h));
    return {
      kind: "ellipse",
      cx: bounds.x + parseClipLength(center[0], bounds.w),
      cy: bounds.y + parseClipLength(center[1], bounds.h),
      rx: radius,
      ry: radius,
      fillRule: "nonzero",
    };
  }

  const ellipse = raw.match(/^ellipse\((.+)\)$/i);
  if (ellipse) {
    const [radiiToken, centerToken] = ellipse[1].split(/\s+at\s+/i, 2);
    const radii = radiiToken.trim().split(/\s+/).filter(Boolean);
    const center = centerToken ? centerToken.trim().split(/\s+/).filter(Boolean) : ["50%", "50%"];
    if (radii.length !== 2 || center.length !== 2) return null;

    return {
      kind: "ellipse",
      cx: bounds.x + parseClipLength(center[0], bounds.w),
      cy: bounds.y + parseClipLength(center[1], bounds.h),
      rx: parseClipLength(radii[0], bounds.w),
      ry: parseClipLength(radii[1], bounds.h),
      fillRule: "nonzero",
    };
  }

  const polygon = raw.match(/^polygon\((.+)\)$/i);
  if (polygon) {
    const parts = polygon[1].split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) return null;

    let fillRule: ClipPathFillRule = "nonzero";
    const firstPart = parts[0].toLowerCase();
    if (firstPart === "evenodd" || firstPart === "nonzero") {
      fillRule = firstPart as ClipPathFillRule;
      parts.shift();
    }
    if (parts.length < 3) return null;

    const points = parts
      .map((part) => part.split(/\s+/).filter(Boolean))
      .filter((coords) => coords.length >= 2)
      .map((coords) => ({
        x: bounds.x + parseClipLength(coords[0], bounds.w),
        y: bounds.y + parseClipLength(coords[1], bounds.h),
      }));

    if (points.length < 3) return null;

    return {
      kind: "polygon",
      points,
      fillRule,
    };
  }

  return null;
}