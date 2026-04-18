export function parseGradientAngle(dirStr: string): number {
  dirStr = dirStr.trim();
  const degMatch = dirStr.match(/^([\d.]+)deg$/);
  if (degMatch) return parseFloat(degMatch[1]);
  const radMatch = dirStr.match(/^([\d.]+)rad$/);
  if (radMatch) return parseFloat(radMatch[1]) * (180 / Math.PI);
  const turnMatch = dirStr.match(/^([\d.]+)turn$/);
  if (turnMatch) return parseFloat(turnMatch[1]) * 360;
  const dirMap: Record<string, number> = {
    "to top": 0,
    "to right": 90,
    "to bottom": 180,
    "to left": 270,
    "to top right": 45,
    "to right top": 45,
    "to bottom right": 135,
    "to right bottom": 135,
    "to bottom left": 225,
    "to left bottom": 225,
    "to top left": 315,
    "to left top": 315,
  };
  return dirMap[dirStr] ?? 180;
}

export function splitTopLevelCommaSeparated(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function findFirstTopLevelComma(value: string): number {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) return i;
  }
  return -1;
}

export function extractFirstGradient(bgImage: string): string | null {
  const match = bgImage.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/);
  if (!match || match.index === undefined) return null;

  let depth = 0;
  const start = match.index;
  for (let i = start; i < bgImage.length; i++) {
    if (bgImage[i] === "(") depth++;
    else if (bgImage[i] === ")") {
      depth--;
      if (depth === 0) return bgImage.slice(start, i + 1);
    }
  }

  return null;
}

export function extractAllGradients(bgImage: string): string[] {
  const gradients: string[] = [];
  const re = /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bgImage)) !== null) {
    let depth = 0;
    const start = match.index;
    for (let i = start; i < bgImage.length; i++) {
      if (bgImage[i] === "(") depth++;
      else if (bgImage[i] === ")") {
        depth--;
        if (depth === 0) {
          gradients.push(bgImage.slice(start, i + 1));
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return gradients;
}

export type GradientStopUnit = "auto" | "fraction" | "px";

export type GradientStopAst<TColor = string> = {
  offset: number;
  unit: GradientStopUnit;
  color: TColor;
};

export type LinearGradientAst<TColor = string> = {
  type: "linear";
  angleDeg: number;
  stops: GradientStopAst<TColor>[];
  repeating: boolean;
};

export type RadialGradientAst<TColor = string> = {
  type: "radial";
  stops: GradientStopAst<TColor>[];
  repeating: boolean;
};

export type ConicGradientAst<TColor = string> = {
  type: "conic";
  fromAngleDeg: number;
  stops: GradientStopAst<TColor>[];
  repeating: boolean;
};

export type ParsedGradientAst<TColor = string> =
  | LinearGradientAst<TColor>
  | RadialGradientAst<TColor>
  | ConicGradientAst<TColor>;

export type ParseGradientAstOptions<TColor = string> = {
  parseColor?: (value: string) => TColor | null;
};

function parseGradientColor<TColor>(value: string, options: ParseGradientAstOptions<TColor>): TColor | null {
  if (options.parseColor) return options.parseColor(value);
  return value as TColor;
}

function parseAngleValue(value: string, unit: string | undefined): number {
  const numeric = parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  if (unit === "rad") return numeric * (180 / Math.PI);
  if (unit === "turn") return numeric * 360;
  return numeric;
}

export function parseGradientColorStops<TColor = string>(
  argsStr: string,
  options: ParseGradientAstOptions<TColor> = {},
): GradientStopAst<TColor>[] {
  const stops: GradientStopAst<TColor>[] = [];
  const parts = splitTopLevelCommaSeparated(argsStr);

  for (const part of parts) {
    const percentMatch = part.match(/([\d.]+)%\s*$/);
    const pxMatch = !percentMatch ? part.match(/([\d.]+)px\s*$/) : null;
    const colorStr = (percentMatch || pxMatch)
      ? part.slice(0, (percentMatch || pxMatch)!.index).trim()
      : part.trim();
    if (!colorStr) continue;

    const color = parseGradientColor(colorStr, options);
    if (color == null) continue;

    let offset = -1;
    let unit: GradientStopUnit = "auto";
    if (percentMatch) {
      offset = parseFloat(percentMatch[1]) / 100;
      unit = "fraction";
    } else if (pxMatch) {
      offset = parseFloat(pxMatch[1]);
      unit = "px";
    }

    stops.push({ offset, unit, color });
  }

  return stops;
}

export function normalizeGradientStopOffsets<TStop extends { offset: number }>(stops: readonly TStop[]): TStop[] {
  const resolved = stops.map((stop) => ({ ...stop })) as TStop[];
  if (resolved.length === 0) return resolved;

  if (resolved[0].offset < 0) resolved[0].offset = 0;
  if (resolved[resolved.length - 1].offset < 0) resolved[resolved.length - 1].offset = 1;

  let lastKnown = 0;
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].offset >= 0) {
      const gap = index - lastKnown;
      if (gap > 1) {
        const start = resolved[lastKnown].offset;
        const end = resolved[index].offset;
        for (let fill = lastKnown + 1; fill < index; fill += 1) {
          resolved[fill].offset = start + (end - start) * ((fill - lastKnown) / gap);
        }
      }
      lastKnown = index;
    }
  }

  return resolved;
}

export function expandRepeatingGradientStops<TStop extends { offset: number }>(
  stops: readonly TStop[],
  createEdgeStop?: (sortedStops: readonly TStop[]) => TStop,
): TStop[] {
  if (stops.length < 2) return [...stops];

  const sortedStops = [...stops].sort((left, right) => left.offset - right.offset);
  const period = sortedStops[sortedStops.length - 1].offset;
  if (!(period > 0 && period < 0.999999)) return sortedStops;

  const repeated: TStop[] = [];
  const repetitions = Math.ceil(1 / period) + 1;
  for (let rep = 0; rep < repetitions; rep += 1) {
    const base = rep * period;
    for (const stop of sortedStops) {
      const offset = base + stop.offset;
      if (offset > 1.000001) break;
      repeated.push({ ...stop, offset: Math.min(offset, 1) } as TStop);
    }
  }

  if (!repeated.some((stop) => Math.abs(stop.offset - 1) < 0.000001) && createEdgeStop) {
    repeated.push(createEdgeStop(sortedStops));
  }

  return repeated;
}

export function parseGradientAst<TColor = string>(
  bgImage: string | undefined,
  options: ParseGradientAstOptions<TColor> = {},
): ParsedGradientAst<TColor> | null {
  if (!bgImage || bgImage === "none") return null;

  const gradientStr = extractFirstGradient(bgImage);
  if (!gradientStr) return null;

  const linearMatch = gradientStr.match(/^(repeating-)?linear-gradient\((.+)\)$/);
  if (linearMatch) {
    const repeating = !!linearMatch[1];
    const inner = linearMatch[2];
    const splitIdx = findFirstTopLevelComma(inner);
    let angleDeg = 180;
    let stopsStr = inner;
    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim();
      if (/^(to\s|[-\d.]+deg|[-\d.]+rad|[-\d.]+turn)/i.test(firstPart)) {
        angleDeg = parseGradientAngle(firstPart);
        stopsStr = inner.slice(splitIdx + 1);
      }
    }

    const stops = parseGradientColorStops(stopsStr, options);
    return stops.length >= 2 ? { type: "linear", angleDeg, stops, repeating } : null;
  }

  const radialMatch = gradientStr.match(/^(repeating-)?radial-gradient\((.+)\)$/);
  if (radialMatch) {
    const repeating = !!radialMatch[1];
    let inner = radialMatch[2];
    const splitIdx = findFirstTopLevelComma(inner);
    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim().toLowerCase();
      if (/^(circle|ellipse|closest|farthest|at\s)/.test(firstPart)) {
        inner = inner.slice(splitIdx + 1);
      }
    }

    const stops = parseGradientColorStops(inner, options);
    return stops.length >= 2 ? { type: "radial", stops, repeating } : null;
  }

  const conicMatch = gradientStr.match(/^(repeating-)?conic-gradient\((.+)\)$/);
  if (conicMatch) {
    const repeating = !!conicMatch[1];
    const inner = conicMatch[2];
    const splitIdx = findFirstTopLevelComma(inner);
    let fromAngleDeg = 0;
    let stopsStr = inner;
    if (splitIdx >= 0) {
      const firstPart = inner.slice(0, splitIdx).trim();
      const fromMatch = firstPart.match(/^from\s+(-?[\d.]+)(deg|rad|turn)?/i);
      if (fromMatch) {
        fromAngleDeg = parseAngleValue(fromMatch[1], fromMatch[2]?.toLowerCase());
        stopsStr = inner.slice(splitIdx + 1);
      }
    }

    const stops = parseGradientColorStops(stopsStr, options);
    return stops.length >= 2 ? { type: "conic", fromAngleDeg, stops, repeating } : null;
  }

  return null;
}

export function parseAllGradientsAst<TColor = string>(
  bgImage: string | undefined,
  options: ParseGradientAstOptions<TColor> = {},
): ParsedGradientAst<TColor>[] {
  if (!bgImage || bgImage === "none") return [];

  const gradients: ParsedGradientAst<TColor>[] = [];
  for (const gradientStr of extractAllGradients(bgImage)) {
    const gradient = parseGradientAst(gradientStr, options);
    if (gradient) gradients.push(gradient);
  }

  return gradients;
}