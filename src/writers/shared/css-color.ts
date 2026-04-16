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

  const oklch = parseOklchFunction(value);
  if (oklch) return oklch;

  const hsl = parseHslFunction(value);
  if (hsl) return hsl;

  return parseHwbFunction(value);
}

function parseRgbColor(color: string): ParsedCssColor | null {
  const match = color.match(/^(rgb|rgba)\((.+)\)$/);
  if (!match) return null;

  const fnName = match[1];
  const { channels, alpha: slashAlpha } = splitChannels(match[2]);
  let alpha = slashAlpha;

  if (channels.length === 4 && fnName === "rgba" && !match[2].includes("/")) {
    alpha = parseAlpha(channels[3]);
    channels.pop();
  }

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
  const c1 = parseColorChannel(channels[1]);
  const c2 = parseColorChannel(channels[2]);
  const c3 = parseColorChannel(channels[3]);
  if (c1 === null || c2 === null || c3 === null) return null;

  switch (profile) {
    case "srgb":
      return {
        r: clampByte(c1 * 255),
        g: clampByte(c2 * 255),
        b: clampByte(c3 * 255),
        a: alpha,
      };

    case "srgb-linear":
      return fromLinearSrgb(c1, c2, c3, alpha);

    case "display-p3": {
      const lr = srgbToLinear(c1);
      const lg = srgbToLinear(c2);
      const lb = srgbToLinear(c3);
      const x = 0.4865709486482162 * lr + 0.26566769316909306 * lg + 0.1982172852343625 * lb;
      const y = 0.22897456406974884 * lr + 0.6917385218365064 * lg + 0.079286914093745 * lb;
      const z = 0.04511338185890264 * lg + 1.043944368900976 * lb;
      return fromXyzD65(x, y, z, alpha);
    }

    case "a98-rgb": {
      const lr = Math.sign(c1) * Math.pow(Math.abs(c1), 563 / 256);
      const lg = Math.sign(c2) * Math.pow(Math.abs(c2), 563 / 256);
      const lb = Math.sign(c3) * Math.pow(Math.abs(c3), 563 / 256);
      const x = 0.5766690429101305 * lr + 0.1855582379065463 * lg + 0.1882286462349947 * lb;
      const y = 0.29734497525053605 * lr + 0.6273635662554661 * lg + 0.07529145849399788 * lb;
      const z = 0.02703136138641234 * lr + 0.07068885253582723 * lg + 0.9913375368376388 * lb;
      return fromXyzD65(x, y, z, alpha);
    }

    case "prophoto-rgb": {
      const decode = (v: number) =>
        Math.abs(v) <= 1 / 512 ? v / 16 : Math.sign(v) * Math.pow(Math.abs(v), 1.8);
      const lr = decode(c1);
      const lg = decode(c2);
      const lb = decode(c3);
      const xD50 = 0.7977604896723027 * lr + 0.13518583717574031 * lg + 0.0313493495815248 * lb;
      const yD50 = 0.2880711282292934 * lr + 0.7118432178101014 * lg + 0.00008565396060525902 * lb;
      const zD50 = 0.8251046025104602 * lb;
      return fromXyzD50(xD50, yD50, zD50, alpha);
    }

    case "rec2020": {
      const a2020 = 1.09929682680944;
      const b2020 = 0.018053968510807;
      const decode = (v: number) => {
        const abs = Math.abs(v);
        if (abs < b2020 * 4.5) return v / 4.5;
        return Math.sign(v) * Math.pow((abs + a2020 - 1) / a2020, 1 / 0.45);
      };
      const lr = decode(c1);
      const lg = decode(c2);
      const lb = decode(c3);
      const x = 0.6369580483012914 * lr + 0.14461690358620832 * lg + 0.1688809751641721 * lb;
      const y = 0.2627002120112671 * lr + 0.6779980715188708 * lg + 0.05930171646986196 * lb;
      const z = 0.028072693049087428 * lg + 1.0609850577107909 * lb;
      return fromXyzD65(x, y, z, alpha);
    }

    case "xyz":
    case "xyz-d65":
      return fromXyzD65(c1, c2, c3, alpha);

    case "xyz-d50":
      return fromXyzD50(c1, c2, c3, alpha);

    default:
      return null;
  }
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

  return fromXyzD50(xD50, yD50, zD50, alpha);
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

function fromXyzD65(x: number, y: number, z: number, alpha: number): ParsedCssColor {
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return fromLinearSrgb(r, g, b, alpha);
}

function fromXyzD50(xD50: number, yD50: number, zD50: number, alpha: number): ParsedCssColor {
  const x = 0.9555766 * xD50 - 0.0230393 * yD50 + 0.0631636 * zD50;
  const y = -0.0282895 * xD50 + 1.0099416 * yD50 + 0.0210077 * zD50;
  const z = 0.0122982 * xD50 - 0.020483 * yD50 + 1.3299098 * zD50;
  return fromXyzD65(x, y, z, alpha);
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

function srgbToLinear(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  return Math.pow((value + 0.055) / 1.055, 2.4);
}

function parseColorChannel(token: string): number | null {
  if (token === "none") return 0;
  if (token.endsWith("%")) {
    const value = parseFloat(token);
    return Number.isNaN(value) ? null : value / 100;
  }
  const value = parseFloat(token);
  return Number.isNaN(value) ? null : value;
}

function parseHslFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^(hsl|hsla)\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha: slashAlpha } = splitChannels(match[2]);
  let alpha = slashAlpha;

  if (channels.length === 4 && match[1] === "hsla" && !match[2].includes("/")) {
    alpha = parseAlpha(channels[3]);
    channels.pop();
  }

  if (channels.length !== 3) return null;

  const h = parseAngle(channels[0]);
  const s = parsePercentOrNumber(channels[1]);
  const l = parsePercentOrNumber(channels[2]);
  if (h === null || s === null || l === null) return null;

  return fromHsl(h, s, l, alpha);
}

function parseHwbFunction(color: string): ParsedCssColor | null {
  const match = color.match(/^hwb\((.+)\)$/);
  if (!match) return null;

  const { channels, alpha } = splitChannels(match[1]);
  if (channels.length !== 3) return null;

  const h = parseAngle(channels[0]);
  const w = parsePercentOrNumber(channels[1]);
  const b = parsePercentOrNumber(channels[2]);
  if (h === null || w === null || b === null) return null;

  return fromHwb(h, w, b, alpha);
}

function parsePercentOrNumber(token: string): number | null {
  const trimmed = token.trim();
  if (trimmed.endsWith("%")) {
    const value = parseFloat(trimmed);
    return Number.isNaN(value) ? null : value;
  }
  const value = parseFloat(trimmed);
  return Number.isNaN(value) ? null : value;
}

function fromHsl(h: number, s: number, l: number, alpha: number): ParsedCssColor {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s / 100);
  const lit = clamp01(l / 100);
  const a = sat * Math.min(lit, 1 - lit);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return lit - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return {
    r: clampByte(f(0) * 255),
    g: clampByte(f(8) * 255),
    b: clampByte(f(4) * 255),
    a: clamp01(alpha),
  };
}

function fromHwb(h: number, w: number, b: number, alpha: number): ParsedCssColor {
  const white = w / 100;
  const black = b / 100;
  if (white + black >= 1) {
    const gray = clampByte((white / (white + black)) * 255);
    return { r: gray, g: gray, b: gray, a: clamp01(alpha) };
  }
  const rgb = fromHsl(h, 100, 50, 1);
  const factor = 1 - white - black;
  return {
    r: clampByte((rgb.r / 255 * factor + white) * 255),
    g: clampByte((rgb.g / 255 * factor + white) * 255),
    b: clampByte((rgb.b / 255 * factor + white) * 255),
    a: clamp01(alpha),
  };
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