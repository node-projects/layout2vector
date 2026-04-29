import type { FontAsset, FontAssetSource, FontAssetSourceFormat } from "../../font-assets.js";

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  if (typeof btoa === "function") {
    return btoa(binary);
  }

  throw new Error("No base64 encoder available");
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function normalizeFontBasePath(basePath: string | undefined): string {
  return (basePath ?? "fonts").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function choosePreferredWebFontSource(face: FontAsset): FontAssetSource | null {
  return face.sources.find((source) => source.format === "woff2")
    ?? face.sources.find((source) => source.format === "woff")
    ?? face.sources.find((source) => source.format === "ttf")
    ?? face.sources.find((source) => source.format === "otf")
    ?? null;
}

export function fontFormatToCssFormat(format: FontAssetSourceFormat): string {
  switch (format) {
    case "ttf": return "truetype";
    case "otf": return "opentype";
    default: return format;
  }
}

export function buildEmbeddedFontDataUrl(source: FontAssetSource): string {
  return `data:${source.mimeType};base64,${encodeBase64(source.data)}`;
}

export function buildFontFaceCss(face: FontAsset, sourceUrl: string, format: FontAssetSourceFormat): string {
  const declarations = [
    `font-family:"${escapeCssString(face.family)}"`,
    `src:url("${escapeCssString(sourceUrl)}") format("${fontFormatToCssFormat(format)}")`,
  ];

  if (face.style) declarations.push(`font-style:${face.style}`);
  if (face.weight) declarations.push(`font-weight:${face.weight}`);
  if (face.stretch) declarations.push(`font-stretch:${face.stretch}`);
  if (face.display) declarations.push(`font-display:${face.display}`);
  if (face.unicodeRange) declarations.push(`unicode-range:${face.unicodeRange}`);

  return `@font-face{${declarations.join(";")};}`;
}