export type ParsedCssColor = { r: number; g: number; b: number; a: number };

const colorCache = new Map<string, ParsedCssColor | null>();

export function parseCssColor(color: string | undefined): ParsedCssColor | null {
  if (!color || color === "transparent" || color === "none") return null;

  const cached = colorCache.get(color);
  if (cached !== undefined) return cached;

  const result = parseCssColorUncached(color);
  if (colorCache.size > 2000) colorCache.clear();
  colorCache.set(color, result);
  return result;
}

export function parseVisibleCssColor(color: string | undefined): ParsedCssColor | null {
  const parsed = parseCssColor(color);
  return parsed && parsed.a > 0 ? parsed : null;
}

export function getVisibleCssColorString(color: string | undefined): string | null {
  return parseVisibleCssColor(color) ? color! : null;
}

export function cssColorToHex(color: string | undefined): string | undefined {
  const parsed = parseVisibleCssColor(color);
  if (!parsed) return undefined;
  return `#${toHexByte(parsed.r)}${toHexByte(parsed.g)}${toHexByte(parsed.b)}`;
}

export function cssColorToTrueColor(color: string | undefined): number | undefined {
  const parsed = parseVisibleCssColor(color);
  if (!parsed) return undefined;
  return (parsed.r << 16) | (parsed.g << 8) | parsed.b;
}

export function cssColorToColorRef(color: string | undefined): number | null {
  const parsed = parseVisibleCssColor(color);
  if (!parsed) return null;
  return parsed.r | (parsed.g << 8) | (parsed.b << 16);
}

function parseCssColorUncached(color: string): ParsedCssColor | null {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length !== 6 && hex.length !== 8) return null;

    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a,
    };
  }

  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!match) return null;

  return {
    r: parseInt(match[1]),
    g: parseInt(match[2]),
    b: parseInt(match[3]),
    a: match[4] !== undefined ? parseFloat(match[4]) : 1,
  };
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}