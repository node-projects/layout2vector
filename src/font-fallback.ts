import type { FontAssetCollection } from "./font-assets.js";
import type { IRNode, Style } from "./types.js";
import { loadFontAssetsIntoDocument } from "./font-assets.js";
import { ImageWriter } from "./writers/image-writer.js";

export type RasterizeFontTextOptions = {
  /** Device pixel ratio used for rasterized fallback text images. */
  scale?: number;
  /** Restrict rasterization to a subset of normalized font-family names. */
  onlyFamilies?: string[];
};

function normalizeFontFamilyName(family: string): string {
  return family.replace(/["']/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseFontFamilies(family: string | undefined): string[] {
  if (!family) return [];

  const seen = new Set<string>();
  const families: string[] = [];
  for (const token of family.split(",")) {
    const normalized = normalizeFontFamilyName(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    families.push(normalized);
  }

  return families;
}

function shouldRasterizeTextNode(node: Extract<IRNode, { type: "text" }>, families: Set<string>): boolean {
  return parseFontFamilies(node.style.fontFamily).some((family) => families.has(family));
}

function createLocalTextStyle(style: Style): Style {
  return {
    ...style,
    clipBounds: undefined,
    clipQuads: undefined,
    clipPath: undefined,
    mixBlendMode: undefined,
  };
}

function createRasterizedImageStyle(style: Style): Style {
  return {
    clipBounds: style.clipBounds,
    clipQuads: style.clipQuads,
    clipPath: style.clipPath,
    imageRendering: style.imageRendering,
  };
}

function extractRgbData(canvas: HTMLCanvasElement): number[] {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgbData: number[] = [];
  for (let i = 0; i < imageData.length; i += 4) {
    const alpha = imageData[i + 3] / 255;
    rgbData.push(Math.round(imageData[i] * alpha + 255 * (1 - alpha)));
    rgbData.push(Math.round(imageData[i + 1] * alpha + 255 * (1 - alpha)));
    rgbData.push(Math.round(imageData[i + 2] * alpha + 255 * (1 - alpha)));
  }
  return rgbData;
}

async function rasterizeTextNode(
  node: Extract<IRNode, { type: "text" }>,
  scale: number,
): Promise<Extract<IRNode, { type: "image" }> | null> {
  const dx = node.quad[1].x - node.quad[0].x;
  const dy = node.quad[1].y - node.quad[0].y;
  const ldx = node.quad[3].x - node.quad[0].x;
  const ldy = node.quad[3].y - node.quad[0].y;
  const width = Math.max(1, Math.hypot(dx, dy));
  const height = Math.max(1, Math.hypot(ldx, ldy));

  const writer = new ImageWriter({
    width,
    height,
    scale,
    backgroundColor: null,
  });
  await writer.begin();
  await writer.drawText(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    node.text,
    createLocalTextStyle(node.style),
  );
  const result = await writer.end();
  await result.finalize();

  const canvas = result.getCanvas();
  if (canvas.width <= 0 || canvas.height <= 0) return null;

  return {
    type: "image",
    quad: node.quad,
    dataUrl: result.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
    rgbData: extractRgbData(canvas),
    style: createRasterizedImageStyle(node.style),
    zIndex: node.zIndex,
    source: node.source,
  };
}

export async function rasterizeFontTextNodes(
  nodes: IRNode[],
  fonts: FontAssetCollection | undefined,
  options: RasterizeFontTextOptions = {},
): Promise<IRNode[]> {
  if (!fonts || fonts.faces.length === 0) return [...nodes];

  await loadFontAssetsIntoDocument(fonts);

  const families = options.onlyFamilies?.length
    ? new Set(options.onlyFamilies.map(normalizeFontFamilyName))
    : new Set(fonts.faces.map((face) => normalizeFontFamilyName(face.family)));
  if (families.size === 0) return [...nodes];

  const scale = options.scale ?? 1;
  const result: IRNode[] = [];
  for (const node of nodes) {
    if (node.type !== "text" || !shouldRasterizeTextNode(node, families)) {
      result.push(node);
      continue;
    }

    const rasterized = await rasterizeTextNode(node, scale);
    result.push(rasterized ?? node);
  }

  return result;
}