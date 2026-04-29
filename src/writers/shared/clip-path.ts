import type { PathSubpath, Point, Quad } from "../../types.js";

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
  const commands = parsePathDataCommands(pathData);
  if (!commands) return null;

  const sampled = flattenPathCommands(commands);
  if (!sampled || sampled.points.length < 2) {
    return null;
  }

  return {
    points: sampled.points.map((point) => ({ x: bounds.x + point.x, y: bounds.y + point.y })),
    closed: sampled.closed,
  };
}

type PathDataSegmentLike = {
  type: string;
  values: number[];
};

type FlattenedPathSegment =
  | {
      kind: "line";
      start: Point;
      end: Point;
    }
  | {
      kind: "quadratic";
      start: Point;
      control: Point;
      end: Point;
    }
  | {
      kind: "cubic";
      start: Point;
      control1: Point;
      control2: Point;
      end: Point;
    }
  | {
      kind: "arc";
      start: Point;
      end: Point;
      center: Point;
      rx: number;
      ry: number;
      rotation: number;
      startAngle: number;
      deltaAngle: number;
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

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function pointsEqual(a: Point, b: Point, epsilon = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function resolvePoint(currentPoint: Point, relative: boolean, x: number, y: number): Point {
  return relative
    ? { x: currentPoint.x + x, y: currentPoint.y + y }
    : { x, y };
}

function reflectPoint(control: Point | null, around: Point): Point {
  if (!control) return clonePoint(around);
  return {
    x: around.x * 2 - control.x,
    y: around.y * 2 - control.y,
  };
}

function evaluateLine(start: Point, end: Point, t: number): Point {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
  };
}

function evaluateQuadratic(start: Point, control: Point, end: Point, t: number): Point {
  const oneMinusT = 1 - t;
  return {
    x: oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x,
    y: oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y,
  };
}

function evaluateCubic(start: Point, control1: Point, control2: Point, end: Point, t: number): Point {
  const oneMinusT = 1 - t;
  return {
    x: oneMinusT * oneMinusT * oneMinusT * start.x
      + 3 * oneMinusT * oneMinusT * t * control1.x
      + 3 * oneMinusT * t * t * control2.x
      + t * t * t * end.x,
    y: oneMinusT * oneMinusT * oneMinusT * start.y
      + 3 * oneMinusT * oneMinusT * t * control1.y
      + 3 * oneMinusT * t * t * control2.y
      + t * t * t * end.y,
  };
}

function clampUnit(value: number): number {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function vectorAngle(u: Point, v: Point): number {
  const magnitude = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
  if (magnitude === 0) return 0;

  const cross = u.x * v.y - u.y * v.x;
  const dot = u.x * v.x + u.y * v.y;
  return Math.atan2(cross, dot);
}

function buildArcSegment(
  start: Point,
  end: Point,
  rx: number,
  ry: number,
  xAxisRotation: number,
  largeArcFlag: number,
  sweepFlag: number,
): FlattenedPathSegment {
  let adjustedRx = Math.abs(rx);
  let adjustedRy = Math.abs(ry);
  if (adjustedRx === 0 || adjustedRy === 0 || pointsEqual(start, end)) {
    return {
      kind: "line",
      start,
      end,
    };
  }

  const rotation = (xAxisRotation * Math.PI) / 180;
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const x1Prime = cosRotation * dx + sinRotation * dy;
  const y1Prime = -sinRotation * dx + cosRotation * dy;

  const rxSquared = adjustedRx * adjustedRx;
  const rySquared = adjustedRy * adjustedRy;
  const x1PrimeSquared = x1Prime * x1Prime;
  const y1PrimeSquared = y1Prime * y1Prime;

  const radiiScale = x1PrimeSquared / rxSquared + y1PrimeSquared / rySquared;
  if (radiiScale > 1) {
    const scale = Math.sqrt(radiiScale);
    adjustedRx *= scale;
    adjustedRy *= scale;
  }

  const adjustedRxSquared = adjustedRx * adjustedRx;
  const adjustedRySquared = adjustedRy * adjustedRy;
  const denominator = adjustedRxSquared * y1PrimeSquared + adjustedRySquared * x1PrimeSquared;
  if (denominator === 0) {
    return {
      kind: "line",
      start,
      end,
    };
  }

  const numerator = Math.max(
    0,
    adjustedRxSquared * adjustedRySquared
      - adjustedRxSquared * y1PrimeSquared
      - adjustedRySquared * x1PrimeSquared,
  );
  const centerFactorSign = largeArcFlag === sweepFlag ? -1 : 1;
  const centerFactor = centerFactorSign * Math.sqrt(numerator / denominator);
  const cxPrime = centerFactor * ((adjustedRx * y1Prime) / adjustedRy);
  const cyPrime = centerFactor * (-(adjustedRy * x1Prime) / adjustedRx);

  const center = {
    x: cosRotation * cxPrime - sinRotation * cyPrime + (start.x + end.x) / 2,
    y: sinRotation * cxPrime + cosRotation * cyPrime + (start.y + end.y) / 2,
  };

  const startVector = {
    x: (x1Prime - cxPrime) / adjustedRx,
    y: (y1Prime - cyPrime) / adjustedRy,
  };
  const endVector = {
    x: (-x1Prime - cxPrime) / adjustedRx,
    y: (-y1Prime - cyPrime) / adjustedRy,
  };

  let deltaAngle = vectorAngle(startVector, endVector);
  if (!sweepFlag && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweepFlag && deltaAngle < 0) deltaAngle += Math.PI * 2;

  return {
    kind: "arc",
    start,
    end,
    center,
    rx: adjustedRx,
    ry: adjustedRy,
    rotation,
    startAngle: Math.atan2(startVector.y, startVector.x),
    deltaAngle,
  };
}

function evaluateArc(segment: Extract<FlattenedPathSegment, { kind: "arc" }>, t: number): Point {
  const angle = segment.startAngle + segment.deltaAngle * t;
  const cosRotation = Math.cos(segment.rotation);
  const sinRotation = Math.sin(segment.rotation);
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);

  return {
    x: segment.center.x + cosRotation * segment.rx * cosAngle - sinRotation * segment.ry * sinAngle,
    y: segment.center.y + sinRotation * segment.rx * cosAngle + cosRotation * segment.ry * sinAngle,
  };
}

function estimateSegmentLength(segment: FlattenedPathSegment): number {
  switch (segment.kind) {
    case "line":
      return distanceBetween(segment.start, segment.end);
    case "quadratic": {
      let length = 0;
      let previous = segment.start;
      for (let index = 1; index <= 10; index += 1) {
        const point = evaluateQuadratic(segment.start, segment.control, segment.end, index / 10);
        length += distanceBetween(previous, point);
        previous = point;
      }
      return length;
    }
    case "cubic": {
      let length = 0;
      let previous = segment.start;
      for (let index = 1; index <= 12; index += 1) {
        const point = evaluateCubic(segment.start, segment.control1, segment.control2, segment.end, index / 12);
        length += distanceBetween(previous, point);
        previous = point;
      }
      return length;
    }
    case "arc": {
      let length = 0;
      let previous = segment.start;
      const samples = Math.max(12, Math.ceil(Math.abs(segment.deltaAngle) / (Math.PI / 8)));
      for (let index = 1; index <= samples; index += 1) {
        const point = evaluateArc(segment, index / samples);
        length += distanceBetween(previous, point);
        previous = point;
      }
      return length;
    }
  }
}

function evaluateSegment(segment: FlattenedPathSegment, t: number): Point {
  switch (segment.kind) {
    case "line":
      return evaluateLine(segment.start, segment.end, t);
    case "quadratic":
      return evaluateQuadratic(segment.start, segment.control, segment.end, t);
    case "cubic":
      return evaluateCubic(segment.start, segment.control1, segment.control2, segment.end, t);
    case "arc":
      return evaluateArc(segment, t);
  }
}

function appendSampledSegmentPoints(
  points: Point[],
  segment: FlattenedPathSegment,
  sampleCount: number,
): void {
  const segmentSamples = Math.max(1, sampleCount);
  for (let index = 1; index <= segmentSamples; index += 1) {
    const point = evaluateSegment(segment, index / segmentSamples);
    const previous = points[points.length - 1];
    if (!previous || !pointsEqual(previous, point)) {
      points.push(point);
    }
  }
}

function flattenPathCommands(commands: PathDataSegmentLike[]): PathSubpath | null {
  const segments: FlattenedPathSegment[] = [];
  let currentPoint: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let previousCubicControl: Point | null = null;
  let previousQuadraticControl: Point | null = null;
  let previousCommand = "";
  let closed = false;

  for (const command of commands) {
    const type = command.type.toUpperCase();
    const relative = command.type === command.type.toLowerCase();
    const values = command.values;

    switch (type) {
      case "M": {
        const nextPoint = resolvePoint(currentPoint, relative, values[0], values[1]);
        currentPoint = nextPoint;
        subpathStart = nextPoint;
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      case "L": {
        const end = resolvePoint(currentPoint, relative, values[0], values[1]);
        segments.push({ kind: "line", start: currentPoint, end });
        currentPoint = end;
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      case "H": {
        const end = relative
          ? { x: currentPoint.x + values[0], y: currentPoint.y }
          : { x: values[0], y: currentPoint.y };
        segments.push({ kind: "line", start: currentPoint, end });
        currentPoint = end;
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      case "V": {
        const end = relative
          ? { x: currentPoint.x, y: currentPoint.y + values[0] }
          : { x: currentPoint.x, y: values[0] };
        segments.push({ kind: "line", start: currentPoint, end });
        currentPoint = end;
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      case "C": {
        const control1 = resolvePoint(currentPoint, relative, values[0], values[1]);
        const control2 = resolvePoint(currentPoint, relative, values[2], values[3]);
        const end = resolvePoint(currentPoint, relative, values[4], values[5]);
        segments.push({ kind: "cubic", start: currentPoint, control1, control2, end });
        currentPoint = end;
        previousCubicControl = control2;
        previousQuadraticControl = null;
        break;
      }
      case "S": {
        const control1 = previousCommand === "C" || previousCommand === "S"
          ? reflectPoint(previousCubicControl, currentPoint)
          : clonePoint(currentPoint);
        const control2 = resolvePoint(currentPoint, relative, values[0], values[1]);
        const end = resolvePoint(currentPoint, relative, values[2], values[3]);
        segments.push({ kind: "cubic", start: currentPoint, control1, control2, end });
        currentPoint = end;
        previousCubicControl = control2;
        previousQuadraticControl = null;
        break;
      }
      case "Q": {
        const control = resolvePoint(currentPoint, relative, values[0], values[1]);
        const end = resolvePoint(currentPoint, relative, values[2], values[3]);
        segments.push({ kind: "quadratic", start: currentPoint, control, end });
        currentPoint = end;
        previousQuadraticControl = control;
        previousCubicControl = null;
        break;
      }
      case "T": {
        const control: Point = previousCommand === "Q" || previousCommand === "T"
          ? reflectPoint(previousQuadraticControl, currentPoint)
          : clonePoint(currentPoint);
        const end = resolvePoint(currentPoint, relative, values[0], values[1]);
        segments.push({ kind: "quadratic", start: currentPoint, control, end });
        currentPoint = end;
        previousQuadraticControl = control;
        previousCubicControl = null;
        break;
      }
      case "A": {
        const end = resolvePoint(currentPoint, relative, values[5], values[6]);
        const segment = buildArcSegment(
          currentPoint,
          end,
          values[0],
          values[1],
          values[2],
          values[3],
          values[4],
        );
        segments.push(segment);
        currentPoint = end;
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      case "Z": {
        closed = true;
        if (!pointsEqual(currentPoint, subpathStart)) {
          segments.push({ kind: "line", start: currentPoint, end: subpathStart });
        }
        currentPoint = clonePoint(subpathStart);
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      }
      default:
        return null;
    }

    previousCommand = type;
  }

  if (segments.length === 0) return null;

  const segmentLengths = segments.map(estimateSegmentLength);
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(totalLength) || totalLength <= 0) return null;

  const totalSampleCount = Math.max(PATH_SAMPLE_COUNT, Math.ceil(totalLength / 6));
  const points: Point[] = [clonePoint(segments[0].start)];
  for (let index = 0; index < segments.length; index += 1) {
    const segmentLength = segmentLengths[index];
    const segmentSampleCount = Math.max(1, Math.ceil((segmentLength / totalLength) * totalSampleCount));
    appendSampledSegmentPoints(points, segments[index], segmentSampleCount);
  }

  return {
    points,
    closed,
  };
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