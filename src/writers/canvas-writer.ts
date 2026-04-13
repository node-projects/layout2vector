import type { Point, Quad, Style, Writer } from "../types.js";
import { ImageWriter, type ImageWriterOptions } from "./image-writer.js";

export type CanvasWriterOptions = ImageWriterOptions;

export class CanvasWriter implements Writer<HTMLCanvasElement> {
  private writer: ImageWriter;

  constructor(optionsOrWidth: CanvasWriterOptions | number, height?: number, scale?: number, zoom?: number) {
    this.writer = new ImageWriter(optionsOrWidth as ImageWriterOptions | number, height, scale, zoom);
  }

  async begin(): Promise<void> {
    await this.writer.begin();
  }

  async drawPolygon(points: Quad, style: Style): Promise<void> {
    await this.writer.drawPolygon(points, style);
  }

  async drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void> {
    await this.writer.drawPolyline(points, closed, style);
  }

  async drawText(quad: Quad, text: string, style: Style): Promise<void> {
    await this.writer.drawText(quad, text, style);
  }

  async drawImage(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void> {
    await this.writer.drawImage(quad, dataUrl, width, height, style, rgbData);
  }

  async end(): Promise<HTMLCanvasElement> {
    const result = await this.writer.end();
    await result.finalize();
    return result.getCanvas();
  }
}