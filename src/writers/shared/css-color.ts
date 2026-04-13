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
  const value = color.trim().toLowerCase();

  if (value.startsWith("#")) {
    let hex = value.slice(1);
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

  const rgb = parseRgbColor(value);
  if (rgb) return rgb;

  const colorFunction = parseColorFunction(value);
  if (colorFunction) return colorFunction;

  const lab = parseLabFunction(value);
  if (lab) return lab;

  const lch = parseLchFunction(value);
  if (lch) return lch;

  const oklab = parseOklabFunction(value);
  if (oklab) return oklab;

  return parseOklchFunction(value);
}

function parseRgbColor(color: string): ParsedCssColor | null {
  const match = color.match(/^rgba?\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const r = parseRgbChannel(channels[0]);
  const g = parseRgbChannel(channels[1]);
  const b = parseRgbChannel(channels[2]);
  if (r === null || g === null || b === null) return null;

  return { r, g, b, a: alpha };
}

function parseColorFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^color\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 4) return null;

  const profile = channels[0];
  const r = parseUnitInterval(channels[1]);
  const g = parseUnitInterval(channels[2]);
  const b = parseUnitInterval(channels[3]);
  if (r === null || g === null || b === null) return null;

  if (profile === "srgb") {
    return {
      r: clampByte(r * 255),
      g: clampByte(g * 255),
      b: clampByte(b * 255),
      a: alpha,
    };
  }

  if (profile === "srgb-linear") {
    return fromLinearSrgb(r, g, b, alpha);
  }

  return null;
}

function parseLabFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^lab\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const l = parseLightness(channels[0], 100);
  const a = parseFloat(channels[1]);
  const b = parseFloat(channels[2]);
  if (l === null || Number.isNaN(a) || Number.isNaN(b)) return null;

  return fromLab(l, a, b, alpha);
}

function parseLchFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^lch\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const l = parseLightness(channels[0], 100);
  const c = parseFloat(channels[1]);
  const h = parseAngle(channels[2]);
  if (l === null || Number.isNaN(c) || h === null) return null;

  const angleRad = (h * Math.PI) / 180;
  return fromLab(l, c * Math.cos(angleRad), c * Math.sin(angleRad), alpha);
}

function parseOklabFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^oklab\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const l = parseLightness(channels[0], 1);
  const a = parseFloat(channels[1]);
  const b = parseFloat(channels[2]);
  if (l === null || Number.isNaN(a) || Number.isNaN(b)) return null;

  return fromOklab(l, a, b, alpha);
}

function parseOklchFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^oklch\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const l = parseLightness(channels[0], 1);
  const c = parseFloat(channels[1]);
  const h = parseAngle(channels[2]);
  if (l === null || Number.isNaN(c) || h === null) return null;

  const angleRad = (h * Math.PI) / 180;
  return fromOklab(l, c * Math.cos(angleRad), c * Math.sin(angleRad), alpha);
}

function splitChannels(input: string): { channels: string[]; alpha: number } {
  const slashIndex = input.indexOf("/");
  const channelPart = slashIndex >= 0 ? input.slice(0, slashIndex) : input;
  const alphaPart = slashIndex >= 0 ? input.slice(slashIndex + 1) : undefined;
  const channels = channelPart.includes(",")
    ? channelPart.split(",").map((part) => part.trim()).filter(Boolean)
    : channelPart.trim().split(/\s+/).filter(Boolean);

  return {
    channels,
    alpha: parseAlpha(alphaPart),
  };
}

function parseRgbChannel(token: string): number | null {
  if (token.endsWith("%")) {
    const value = parseFloat(token);
    if (Number.isNaN(value)) return null;
    return clampByte((value / 100) * 255);
  }
  const value = parseFloat(token);
  if (Number.isNaN(value)) return null;
  return clampByte(value);
}

function parseUnitInterval(token: string): number | null {
  if (token.endsWith("%")) {
    const value = parseFloat(token);
    if (Number.isNaN(value)) return null;
    return clamp01(value / 100);
  }
  const value = parseFloat(token);
  if (Number.isNaN(value)) return null;
  return clamp01(value);
}

function parseLightness(token: string, percentScale: number): number | null {
  if (token.endsWith("%")) {
    const value = parseFloat(token);
    if (Number.isNaN(value)) return null;
    return (value / 100) * percentScale;
  }
  const value = parseFloat(token);
  return Number.isNaN(value) ? null : value;
}

function parseAlpha(token: string | undefined): number {
  if (!token) return 1;
  const trimmed = token.trim();
  if (trimmed.endsWith("%")) {
    const value = parseFloat(trimmed);
    return Number.isNaN(value) ? 1 : clamp01(value / 100);
  }
  const value = parseFloat(trimmed);
  return Number.isNaN(value) ? 1 : clamp01(value);
}

function parseAngle(token: string): number | null {
  const trimmed = token.trim();
  const value = parseFloat(trimmed);
  if (Number.isNaN(value)) return null;
  if (trimmed.endsWith("rad")) return value * (180 / Math.PI);
  if (trimmed.endsWith("turn")) return value * 360;
  if (trimmed.endsWith("grad")) return value * 0.9;
  return value;
}

function fromLab(l: number, a: number, b: number, alpha: number): ParsedCssColor {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const xD50 = 0.96422 * labInv(fx);
  const yD50 = labInv(fy);
  const zD50 = 0.82521 * labInv(fz);

  const x = 0.9555766 * xD50 - 0.0230393 * yD50 + 0.0631636 * zD50;
  const y = -0.0282895 * xD50 + 1.0099416 * yD50 + 0.0210077 * zD50;
  const z = 0.0122982 * xD50 - 0.020483 * yD50 + 1.3299098 * zD50;

  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bLinear = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  return fromLinearSrgb(r, g, bLinear, alpha);
}

function fromOklab(l: number, a: number, b: number, alpha: number): ParsedCssColor {
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = lPrime * lPrime * lPrime;
  const m3 = mPrime * mPrime * mPrime;
  const s3 = sPrime * sPrime * sPrime;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLinear = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return fromLinearSrgb(r, g, bLinear, alpha);
}

function fromLinearSrgb(r: number, g: number, b: number, alpha: number): ParsedCssColor {
  return {
    r: clampByte(linearToSrgb(r) * 255),
    g: clampByte(linearToSrgb(g) * 255),
    b: clampByte(linearToSrgb(b) * 255),
    a: clamp01(alpha),
  };
}

function labInv(value: number): number {
  const cube = value * value * value;
  return cube > 216 / 24389 ? cube : (116 * value - 16) / (24389 / 27);
}

function linearToSrgb(value: number): number {
  if (value <= 0.0031308) return 12.92 * value;
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}