import type { PathSubpath, Point, Quad } from "../../types.js";
import { svgPathProperties } from "svg-path-properties";

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
    }
  | {
      kind: "path";
      subpaths: PathSubpath[];
      fillRule: ClipPathFillRule;
    };

const PATH_SAMPLE_COUNT = 24;

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

  const path = raw.match(/^path\((.+)\)$/i);
  if (path) {
    return parsePathClipPath(path[1], bounds);
  }

  return null;
}

function parsePathClipPath(rawArgs: string, bounds: ClipPathBounds): ClipPathShape | null {
  const parsed = parsePathFunctionArguments(rawArgs);
  if (!parsed) return null;

  const subpathData = splitPathSubpathsFromString(parsed.pathData);
  if (subpathData.length === 0) return null;

  const subpaths = subpathData
    .map((pathData) => samplePathSubpath(pathData, bounds))
    .filter((subpath): subpath is PathSubpath => !!subpath);

  if (subpaths.length === 0) return null;

  return {
    kind: "path",
    subpaths,
    fillRule: parsed.fillRule,
  };
}

function parsePathFunctionArguments(rawArgs: string): { fillRule: ClipPathFillRule; pathData: string } | null {
  const match = rawArgs.trim().match(/^(?:(evenodd|nonzero)\s*,\s*)?(["'])([\s\S]*)\2$/i);
  if (!match) return null;

  return {
    fillRule: (match[1]?.toLowerCase() as ClipPathFillRule | undefined) ?? "nonzero",
    pathData: decodeCssStringLiteral(match[3]),
  };
}

function decodeCssStringLiteral(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1");
}

function samplePathSubpath(pathData: string, bounds: ClipPathBounds): PathSubpath | null {
  try {
    const properties = new svgPathProperties(pathData);
    const totalLength = properties.getTotalLength();
    if (!Number.isFinite(totalLength) || totalLength <= 0) return null;

    const sampleCount = Math.max(PATH_SAMPLE_COUNT, Math.ceil(totalLength / 6));
    const points: Point[] = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      const point = properties.getPointAtLength((totalLength * index) / sampleCount);
      points.push({ x: bounds.x + point.x, y: bounds.y + point.y });
    }

    return {
      points,
      closed: /[Zz]\s*$/.test(pathData.trim()) || /[Zz]/.test(pathData),
    };
  } catch {
    return null;
  }
}

type PathDataSegmentLike = {
  type: string;
  values: number[];
};

const PATH_COMMAND_ARITY: Record<string, number> = {
  A: 7,
  C: 6,
  H: 1,
  L: 2,
  M: 2,
  Q: 4,
  S: 4,
  T: 2,
  V: 1,
  Z: 0,
};

function isPathCommandToken(token: string): boolean {
  return /^[AaCcHhLlMmQqSsTtVvZz]$/.test(token);
}

function parsePathDataCommands(pathData: string): PathDataSegmentLike[] | null {
  const commands: PathDataSegmentLike[] = [];
  let index = 0;
  let currentCommand = "";

  function skipSeparators(): void {
    while (index < pathData.length && /[\s,]/.test(pathData[index])) {
      index += 1;
    }
  }

  function readNumberValue(): number | null {
    skipSeparators();
    const match = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(pathData.slice(index));
    if (!match) return null;

    const value = Number(match[0]);
    if (!Number.isFinite(value)) return null;
    index += match[0].length;
    return value;
  }

  function readArcFlagValue(): number | null {
    skipSeparators();
    const flag = pathData[index];
    if (flag !== "0" && flag !== "1") return null;
    index += 1;
    return Number(flag);
  }

  function readSegmentValues(command: string): number[] | null {
    const upperCommand = command.toUpperCase();
    const arity = PATH_COMMAND_ARITY[upperCommand];
    if (arity === undefined || arity === 0) return [];

    const values: number[] = [];
    for (let valueIndex = 0; valueIndex < arity; valueIndex += 1) {
      const value = upperCommand === "A" && (valueIndex === 3 || valueIndex === 4)
        ? readArcFlagValue()
        : readNumberValue();
      if (value === null) return null;
      values.push(value);
    }
    return values;
  }

  while (true) {
    skipSeparators();
    if (index >= pathData.length) break;

    if (isPathCommandToken(pathData[index])) {
      currentCommand = pathData[index];
      index += 1;
    } else if (!currentCommand) {
      return null;
    }

    const upperCommand = currentCommand.toUpperCase();
    const arity = PATH_COMMAND_ARITY[upperCommand];
    if (arity === undefined) return null;

    if (arity === 0) {
      commands.push({ type: currentCommand, values: [] });
      currentCommand = "";
      continue;
    }

    if (upperCommand === "M") {
      const moveValues = readSegmentValues(currentCommand);
      if (!moveValues) return null;

      commands.push({ type: currentCommand, values: moveValues });
      const lineCommand = currentCommand === "m" ? "l" : "L";

      skipSeparators();
      while (index < pathData.length && !isPathCommandToken(pathData[index])) {
        const lineValues = readSegmentValues(lineCommand);
        if (!lineValues) return null;
        commands.push({
          type: lineCommand,
          values: lineValues,
        });
        skipSeparators();
      }
      continue;
    }

    while (true) {
      const values = readSegmentValues(currentCommand);
      if (!values) return null;

      commands.push({
        type: currentCommand,
        values,
      });

      skipSeparators();
      if (index >= pathData.length || isPathCommandToken(pathData[index])) break;
    }
  }

  return commands;
}

function advancePathCurrentPoint(
  segment: PathDataSegmentLike,
  currentPoint: Point,
  subpathStart: Point,
): Point {
  const type = segment.type;
  const values = segment.values;
  const relative = type === type.toLowerCase();

  switch (type.toUpperCase()) {
    case "Z":
      return { ...subpathStart };
    case "H": {
      const x = values[values.length - 1];
      return {
        x: relative ? currentPoint.x + x : x,
        y: currentPoint.y,
      };
    }
    case "V": {
      const y = values[values.length - 1];
      return {
        x: currentPoint.x,
        y: relative ? currentPoint.y + y : y,
      };
    }
    case "A":
    case "C":
    case "L":
    case "M":
    case "Q":
    case "S":
    case "T": {
      const x = values[values.length - 2];
      const y = values[values.length - 1];
      return {
        x: relative ? currentPoint.x + x : x,
        y: relative ? currentPoint.y + y : y,
      };
    }
    default:
      return currentPoint;
  }
}

function splitParsedPathDataCommands(segments: PathDataSegmentLike[]): string[] {
  const subpaths: PathDataSegmentLike[][] = [];
  let currentSubpath: PathDataSegmentLike[] = [];
  let currentPoint: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };

  for (const segment of segments) {
    if (segment.type.toUpperCase() === "M") {
      if (currentSubpath.length > 0) {
        subpaths.push(currentSubpath);
      }

      currentPoint = advancePathCurrentPoint(segment, currentPoint, subpathStart);
      subpathStart = { ...currentPoint };
      currentSubpath = [{ type: "M", values: [currentPoint.x, currentPoint.y] }];
      continue;
    }

    if (currentSubpath.length === 0) {
      return [];
    }

    currentSubpath.push({
      type: segment.type.toUpperCase() === "Z" ? "Z" : segment.type,
      values: [...segment.values],
    });
    currentPoint = advancePathCurrentPoint(segment, currentPoint, subpathStart);
  }

  if (currentSubpath.length > 0) {
    subpaths.push(currentSubpath);
  }

  return subpaths.map(serializePathDataSegments);
}

function serializePathDataSegments(segments: PathDataSegmentLike[]): string {
  return segments.map((segment) => {
    if (segment.values.length === 0) return segment.type;
    return `${segment.type}${segment.values.map((value) => {
      const rounded = Math.round(value * 1000) / 1000;
      return Number.isInteger(rounded) ? rounded.toString() : rounded.toString();
    }).join(" ")}`;
  }).join(" ");
}

function splitPathSubpathsFromString(pathData: string): string[] {
  const trimmed = pathData.trim();
  if (!trimmed) return [];

  const parsed = parsePathDataCommands(trimmed);
  if (!parsed) return [trimmed];

  const moveCommands = parsed.filter((segment) => segment.type.toUpperCase() === "M");
  if (moveCommands.length <= 1) return [trimmed];

  const subpaths = splitParsedPathDataCommands(parsed);
  return subpaths.length > 1 ? subpaths : [trimmed];
}