import type { Point, Quad } from '../../types.js';

type PixelRect = { x: number; y: number; width: number; height: number; color: string };

/** Coalesce bitmap pixels into filled CAD rectangles, retaining transparent holes. */
export async function cadImageRectangles(dataUrl: string, width: number, height: number, rgbData?: number[]): Promise<PixelRect[]> {
  let pixels: Uint8ClampedArray;
  if (typeof document !== 'undefined') {
    const image = new Image(); image.src = dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, width, height);
    pixels = context.getImageData(0, 0, width, height).data;
  } else if (rgbData?.length === width * height * 3) {
    pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels.set(rgbData.slice(i * 3, i * 3 + 3), i * 4); pixels[i * 4 + 3] = 255;
    }
  } else {
    throw new Error('CAD image conversion requires browser image decoding or RGB pixels.');
  }
  const rectangles: PixelRect[] = [];
  let previous = new Map<string, PixelRect>();
  for (let y = 0; y < height; y++) {
    const row = new Map<string, PixelRect>();
    for (let x = 0; x < width;) {
      const start = x, offset = (y * width + x) * 4;
      const rgba = pixels.slice(offset, offset + 4);
      x++;
      while (x < width && rgba.every((v, c) => pixels[(y * width + x) * 4 + c] === v)) x++;
      if (!rgba[3]) continue;
      const alpha = rgba[3] / 255;
      const color = `rgb(${[0, 1, 2].map(c => Math.round(rgba[c] * alpha + 255 * (1 - alpha))).join(',')})`;
      const key = `${start}:${x}:${color}`;
      let rect = previous.get(key);
      if (rect) rect.height++;
      else { rect = { x: start, y, width: x - start, height: 1, color }; rectangles.push(rect); }
      row.set(key, rect);
    }
    previous = row;
  }
  return rectangles;
}

export function cadImageQuad(rect: PixelRect, quad: Quad, width: number, height: number): Point[] {
  const point = (x: number, y: number): Point => ({
    x: quad[0].x + (quad[1].x - quad[0].x) * x / width + (quad[3].x - quad[0].x) * y / height,
    y: quad[0].y + (quad[1].y - quad[0].y) * x / width + (quad[3].y - quad[0].y) * y / height,
  });
  return [point(rect.x, rect.y), point(rect.x + rect.width, rect.y), point(rect.x + rect.width, rect.y + rect.height), point(rect.x, rect.y + rect.height)];
}

/** DXF's ASCII Unicode escapes survive legacy code pages and binary-string saving. */
export function cadUnicodeText(value: string): string {
  return value.replace(/[^\x00-\x7f]/g, c => `\\U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

export function cadFontFilename(family: string): string {
  const files: Record<string, string> = { Wingdings: 'wingding', 'Segoe UI': 'segoeui', 'Segoe UI Symbol': 'seguisym', ArialMT: 'arial' };
  return (files[family] ?? family) + '.ttf';
}
