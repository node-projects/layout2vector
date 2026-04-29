import type { IRNode } from "./types.js";

/** Supported downloaded font source formats. */
export type FontAssetSourceFormat = "ttf" | "otf" | "woff" | "woff2";

/** One downloadable font source for an extracted @font-face rule. */
export type FontAssetSource = {
  format: FontAssetSourceFormat;
  mimeType: string;
  data: Uint8Array;
  originalUrl?: string;
};

/** One extracted @font-face entry used by the rendered document. */
export type FontAsset = {
  family: string;
  weight?: string;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
  display?: string;
  sources: FontAssetSource[];
};

/** Document-level downloadable font assets used by extracted text. */
export type FontAssetCollection = {
  faces: FontAsset[];
};

/** Controls how downloadable fonts are emitted by text-based writers. */
export type FontAssetMode =
  | { type: "none" }
  | { type: "inline" }
  | { type: "external"; basePath?: string };

export type CollectFontAssetsOptions = {
  ir?: IRNode[];
  onlyUsed?: boolean;
  timeoutMs?: number;
};

type FontAssetSourceCandidate = {
  format: FontAssetSourceFormat;
  mimeType: string;
  url: string;
};

type FontAssetCandidate = {
  family: string;
  weight?: string;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
  display?: string;
  sources: FontAssetSourceCandidate[];
};

const FONT_FETCH_TIMEOUT_MS = 12000;
const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "emoji",
  "math",
  "fangsong",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "inherit",
  "initial",
  "unset",
  "default",
]);

const loadedFontFaces = new Map<string, Promise<void>>();

function normalizeFontFamilyName(family: string): string {
  return family.replace(/["']/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseFontFamilies(family: string | undefined): string[] {
  if (!family) return [];

  const seen = new Set<string>();
  const families: string[] = [];
  for (const token of splitCssCommaList(family)) {
    const normalized = normalizeFontFamilyName(token);
    if (!normalized || GENERIC_FONT_FAMILIES.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    families.push(normalized);
  }
  return families;
}

function stripCssQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitCssCommaList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let parenDepth = 0;

  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }

    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += ch;
      continue;
    }

    if (ch === "," && parenDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function guessFontFormat(url: string, explicitFormat?: string): FontAssetSourceFormat | null {
  const normalizedFormat = stripCssQuotes(explicitFormat ?? "").toLowerCase();
  if (normalizedFormat === "woff2") return "woff2";
  if (normalizedFormat === "woff") return "woff";
  if (normalizedFormat === "truetype" || normalizedFormat === "ttf") return "ttf";
  if (normalizedFormat === "opentype" || normalizedFormat === "otf") return "otf";

  if (url.startsWith("data:")) {
    const mimeType = url.slice(5, url.indexOf(";") > 0 ? url.indexOf(";") : url.indexOf(",")).toLowerCase();
    if (mimeType.includes("woff2")) return "woff2";
    if (mimeType.includes("woff")) return "woff";
    if (mimeType.includes("ttf") || mimeType.includes("truetype")) return "ttf";
    if (mimeType.includes("otf") || mimeType.includes("opentype")) return "otf";
    return null;
  }

  try {
    const parsed = new URL(url, document.baseURI);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith(".woff2")) return "woff2";
    if (pathname.endsWith(".woff")) return "woff";
    if (pathname.endsWith(".ttf")) return "ttf";
    if (pathname.endsWith(".otf")) return "otf";
  } catch {
    // Ignore malformed URLs.
  }

  return null;
}

function mimeTypeForFontFormat(format: FontAssetSourceFormat): string {
  switch (format) {
    case "woff2": return "font/woff2";
    case "woff": return "font/woff";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
  }
}

function resolveCssUrl(url: string, baseUrl: string): string | null {
  if (!url) return null;
  if (url.startsWith("data:")) return url;

  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

function parseFontFaceSources(srcValue: string, baseUrl: string): FontAssetSourceCandidate[] {
  const seen = new Set<string>();
  const sources: FontAssetSourceCandidate[] = [];

  for (const entry of splitCssCommaList(srcValue)) {
    const urlMatch = entry.match(/url\((.+?)\)/i);
    if (!urlMatch) continue;

    const rawUrl = stripCssQuotes(urlMatch[1]);
    const resolvedUrl = resolveCssUrl(rawUrl, baseUrl);
    if (!resolvedUrl) continue;

    const formatMatch = entry.match(/format\((.+?)\)/i);
    const format = guessFontFormat(resolvedUrl, formatMatch?.[1]);
    if (!format) continue;

    const key = `${format}:${resolvedUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      format,
      mimeType: mimeTypeForFontFormat(format),
      url: resolvedUrl,
    });
  }

  return sources;
}

function collectUsedFontFamilies(ir: IRNode[] | undefined): Set<string> {
  const families = new Set<string>();

  for (const node of ir ?? []) {
    if (node.type !== "text") continue;
    for (const family of parseFontFamilies(node.style.fontFamily)) {
      families.add(family);
    }
  }

  return families;
}

function addSheetList(target: Set<CSSStyleSheet>, list: StyleSheetList | CSSStyleSheet[] | undefined): void {
  if (!list) return;
  for (const sheet of Array.from(list)) {
    if (sheet instanceof CSSStyleSheet) {
      target.add(sheet);
    }
  }
}

function collectStyleSheets(roots: Element[]): CSSStyleSheet[] {
  const sheets = new Set<CSSStyleSheet>();

  function walk(node: Element | ShadowRoot): void {
    for (const el of Array.from(node.querySelectorAll("*"))) {
      if (el.shadowRoot) {
        addSheetList(sheets, el.shadowRoot.styleSheets);
        walk(el.shadowRoot);
      }
    }
  }

  for (const root of roots) {
    addSheetList(sheets, root.ownerDocument.styleSheets);
    const rootNode = root.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      addSheetList(sheets, rootNode.styleSheets);
    }
    walk(root.shadowRoot ?? root);
  }

  return [...sheets];
}

function mergeFontAssetCandidate(target: Map<string, FontAssetCandidate>, candidate: FontAssetCandidate): void {
  const key = [
    normalizeFontFamilyName(candidate.family),
    candidate.weight ?? "",
    candidate.style ?? "",
    candidate.stretch ?? "",
    candidate.unicodeRange ?? "",
    candidate.display ?? "",
  ].join("|");

  const existing = target.get(key);
  if (!existing) {
    target.set(key, candidate);
    return;
  }

  const existingSources = new Set(existing.sources.map((source) => `${source.format}:${source.url}`));
  for (const source of candidate.sources) {
    const sourceKey = `${source.format}:${source.url}`;
    if (existingSources.has(sourceKey)) continue;
    existing.sources.push(source);
    existingSources.add(sourceKey);
  }
}

function extractCssDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const regex = /([\w-]+)\s*:\s*([^;]+);?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(block))) {
    declarations.set(match[1].toLowerCase(), match[2].trim());
  }
  return declarations;
}

function collectFontFaceCandidatesFromCssText(
  cssText: string,
  baseUrl: string,
  target: Map<string, FontAssetCandidate>,
): string[] {
  const importUrls: string[] = [];
  const importRegex = /@import\s+(?:url\()?\s*["']?([^"')\s]+)["']?\s*\)?/gi;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRegex.exec(cssText))) {
    const resolvedUrl = resolveCssUrl(importMatch[1], baseUrl);
    if (resolvedUrl) importUrls.push(resolvedUrl);
  }

  const fontFaceRegex = /@font-face\s*\{([\s\S]*?)\}/gi;
  let match: RegExpExecArray | null;
  while ((match = fontFaceRegex.exec(cssText))) {
    const declarations = extractCssDeclarations(match[1]);
    const family = stripCssQuotes(declarations.get("font-family") ?? "");
    if (!family) continue;

    const sources = parseFontFaceSources(declarations.get("src") ?? "", baseUrl);
    if (sources.length === 0) continue;

    mergeFontAssetCandidate(target, {
      family,
      weight: declarations.get("font-weight") || undefined,
      style: declarations.get("font-style") || undefined,
      stretch: declarations.get("font-stretch") || undefined,
      unicodeRange: declarations.get("unicode-range") || undefined,
      display: declarations.get("font-display") || undefined,
      sources,
    });
  }

  return importUrls;
}

async function fetchStyleSheetText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function collectFontFaceCandidatesFromSheet(
  sheet: CSSStyleSheet,
  baseUrl: string,
  target: Map<string, FontAssetCandidate>,
  visited: Set<CSSStyleSheet>,
  visitedUrls: Set<string>,
): Promise<void> {
  if (visited.has(sheet)) return;
  visited.add(sheet);

  let rules: CSSRuleList | null = null;
  try {
    rules = sheet.cssRules;
  } catch {
    rules = null;
  }

  if (!rules) {
    const sheetUrl = sheet.href || baseUrl;
    if (!sheetUrl || visitedUrls.has(sheetUrl)) return;
    visitedUrls.add(sheetUrl);

    const cssText = await fetchStyleSheetText(sheetUrl, FONT_FETCH_TIMEOUT_MS);
    if (!cssText) return;

    const importUrls = collectFontFaceCandidatesFromCssText(cssText, sheetUrl, target);
    for (const importUrl of importUrls) {
      if (visitedUrls.has(importUrl)) continue;
      visitedUrls.add(importUrl);
      const importedText = await fetchStyleSheetText(importUrl, FONT_FETCH_TIMEOUT_MS);
      if (!importedText) continue;
      collectFontFaceCandidatesFromCssText(importedText, importUrl, target);
    }
    return;
  }

  for (const rule of Array.from(rules)) {
    if (rule.type === CSSRule.IMPORT_RULE) {
      const importRule = rule as CSSImportRule;
      if (importRule.styleSheet) {
        await collectFontFaceCandidatesFromSheet(
          importRule.styleSheet,
          importRule.href || baseUrl,
          target,
          visited,
          visitedUrls,
        );
      }
      continue;
    }

    if (rule.type !== CSSRule.FONT_FACE_RULE) continue;

    const fontFaceRule = rule as CSSFontFaceRule;
    const family = stripCssQuotes(fontFaceRule.style.getPropertyValue("font-family"));
    if (!family) continue;

    const sources = parseFontFaceSources(fontFaceRule.style.getPropertyValue("src"), sheet.href || baseUrl);
    if (sources.length === 0) continue;

    const candidate: FontAssetCandidate = {
      family,
      weight: fontFaceRule.style.getPropertyValue("font-weight") || undefined,
      style: fontFaceRule.style.getPropertyValue("font-style") || undefined,
      stretch: fontFaceRule.style.getPropertyValue("font-stretch") || undefined,
      unicodeRange: fontFaceRule.style.getPropertyValue("unicode-range") || undefined,
      display: fontFaceRule.style.getPropertyValue("font-display") || undefined,
      sources,
    };

    mergeFontAssetCandidate(target, candidate);
  }
}

function choosePreferredSource(
  sources: FontAssetSourceCandidate[],
  preferredFormats: FontAssetSourceFormat[],
): FontAssetSourceCandidate | null {
  for (const format of preferredFormats) {
    const match = sources.find((source) => source.format === format);
    if (match) return match;
  }
  return null;
}

function selectFontSources(candidate: FontAssetCandidate): FontAssetSourceCandidate[] {
  const selected: FontAssetSourceCandidate[] = [];
  const seen = new Set<string>();

  for (const source of [
    choosePreferredSource(candidate.sources, ["woff2", "woff", "ttf", "otf"]),
    choosePreferredSource(candidate.sources, ["ttf", "otf", "woff", "woff2"]),
  ]) {
    if (!source) continue;
    const key = `${source.format}:${source.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(source);
  }

  return selected;
}

function decodeBase64String(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  throw new Error("No base64 decoder available");
}

function decodeDataUrl(dataUrl: string): { mimeType: string; data: Uint8Array } | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/i);
  if (!match) return null;

  const mimeType = (match[1] || "application/octet-stream").toLowerCase();
  const isBase64 = !!match[2];
  const payload = match[3] ?? "";

  try {
    if (isBase64) {
      return { mimeType, data: decodeBase64String(payload) };
    }
    return {
      mimeType,
      data: new TextEncoder().encode(decodeURIComponent(payload)),
    };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function downloadFontSource(
  source: FontAssetSourceCandidate,
  timeoutMs: number,
): Promise<FontAssetSource | null> {
  if (source.url.startsWith("data:")) {
    const decoded = decodeDataUrl(source.url);
    if (!decoded) return null;
    return {
      format: source.format,
      mimeType: source.mimeType || decoded.mimeType,
      data: decoded.data,
    };
  }

  try {
    const response = await fetchWithTimeout(source.url, timeoutMs);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      format: source.format,
      mimeType: contentType || source.mimeType,
      data,
      originalUrl: source.url,
    };
  } catch {
    return null;
  }
}

function compareFontAssets(left: FontAssetCandidate, right: FontAssetCandidate): number {
  return (
    left.family.localeCompare(right.family)
    || (left.weight ?? "").localeCompare(right.weight ?? "")
    || (left.style ?? "").localeCompare(right.style ?? "")
    || (left.stretch ?? "").localeCompare(right.stretch ?? "")
  );
}

export async function collectFontAssets(
  root: Element | Element[],
  options: CollectFontAssetsOptions = {},
): Promise<FontAssetCollection> {
  const roots = Array.isArray(root) ? root : [root];
  if (roots.length === 0) return { faces: [] };

  const usedFamilies = options.onlyUsed === false ? null : collectUsedFontFamilies(options.ir);
  if (usedFamilies && usedFamilies.size === 0) {
    return { faces: [] };
  }

  const candidates = new Map<string, FontAssetCandidate>();
  const visitedSheets = new Set<CSSStyleSheet>();
  const visitedUrls = new Set<string>();
  for (const sheet of collectStyleSheets(roots)) {
    await collectFontFaceCandidatesFromSheet(
      sheet,
      roots[0].ownerDocument.baseURI,
      candidates,
      visitedSheets,
      visitedUrls,
    );
  }

  const timeoutMs = options.timeoutMs ?? FONT_FETCH_TIMEOUT_MS;
  const faces: FontAsset[] = [];
  for (const candidate of [...candidates.values()].sort(compareFontAssets)) {
    if (usedFamilies && !usedFamilies.has(normalizeFontFamilyName(candidate.family))) continue;

    const selectedSources = selectFontSources(candidate);
    const downloadedSources = (await Promise.all(
      selectedSources.map((source) => downloadFontSource(source, timeoutMs)),
    )).filter((source): source is FontAssetSource => !!source);
    if (downloadedSources.length === 0) continue;

    faces.push({
      family: candidate.family,
      weight: candidate.weight,
      style: candidate.style,
      stretch: candidate.stretch,
      unicodeRange: candidate.unicodeRange,
      display: candidate.display,
      sources: downloadedSources,
    });
  }

  return { faces };
}

function cloneFontBytes(bytes: Uint8Array): ArrayBuffer {
  const clone = new Uint8Array(bytes.length);
  clone.set(bytes);
  return clone.buffer;
}

function chooseLoadableFontSource(face: FontAsset): FontAssetSource | null {
  return face.sources.find((source) => source.format === "woff2")
    ?? face.sources.find((source) => source.format === "woff")
    ?? face.sources.find((source) => source.format === "ttf")
    ?? face.sources.find((source) => source.format === "otf")
    ?? null;
}

export async function loadFontAssetsIntoDocument(fonts: FontAssetCollection | undefined): Promise<void> {
  if (!fonts || fonts.faces.length === 0) return;
  if (typeof document === "undefined" || !("fonts" in document)) return;

  const fontSet = document.fonts;
  const loads: Promise<void>[] = [];

  for (const face of fonts.faces) {
    const source = chooseLoadableFontSource(face);
    if (!source) continue;

    const key = [
      normalizeFontFamilyName(face.family),
      face.weight ?? "",
      face.style ?? "",
      face.stretch ?? "",
      face.unicodeRange ?? "",
      source.format,
      source.originalUrl ?? `bytes:${source.data.length}`,
    ].join("|");

    const existing = loadedFontFaces.get(key);
    if (existing) {
      loads.push(existing);
      continue;
    }

    const descriptors: FontFaceDescriptors = {};
    if (face.weight) descriptors.weight = face.weight;
    if (face.style) descriptors.style = face.style;
    if (face.stretch) descriptors.stretch = face.stretch;
    if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange;
    if (face.display) descriptors.display = face.display as FontDisplay;

    const fontFace = new FontFace(face.family, cloneFontBytes(source.data), descriptors);
    const loadPromise = fontFace.load()
      .then(() => {
        fontSet.add(fontFace);
      })
      .catch(() => {
        // Keep best-effort behavior: one broken font should not block export.
      });

    loadedFontFaces.set(key, loadPromise);
    loads.push(loadPromise);
  }

  await Promise.all(loads);
  await document.fonts.ready;
}