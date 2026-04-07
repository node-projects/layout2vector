/**
 * Core types for the DOM → Geometry → DXF/PDF library.
 */

/** A 2D point. */
export type Point = { x: number; y: number };

/** A quad defined by 4 points (top-left, top-right, bottom-right, bottom-left). */
export type Quad = [Point, Point, Point, Point];

/** Extracted computed style subset. */
export type Style = {
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  strokeDasharray?: string;

  fontSize?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  textDecoration?: string;
  textAlign?: string;
  textTransform?: string;
  textShadow?: string;
  lineHeight?: string;

  opacity?: number;
  zIndex?: number;

  borderTopColor?: string;
  borderRightColor?: string;
  borderBottomColor?: string;
  borderLeftColor?: string;
  borderTopWidth?: string;
  borderRightWidth?: string;
  borderBottomWidth?: string;
  borderLeftWidth?: string;
  borderTopStyle?: string;
  borderRightStyle?: string;
  borderBottomStyle?: string;
  borderLeftStyle?: string;

  borderRadius?: string;
  backgroundImage?: string;
  boxShadow?: string;
  transform?: string;
  overflow?: string;
  textOverflow?: string;
};

/** Intermediate representation node. */
export type IRNode =
  | {
      type: "polygon";
      points: Quad;
      style: Style;
      zIndex: number;
    }
  | {
      type: "text";
      quad: Quad;
      text: string;
      style: Style;
      zIndex: number;
    }
  | {
      type: "polyline";
      points: Point[];
      closed: boolean;
      style: Style;
      zIndex: number;
    }
  | {
      type: "image";
      quad: Quad;
      dataUrl: string;
      width: number;
      height: number;
      /** Raw RGB pixel data (3 bytes per pixel, row-major) for lossless PDF embedding. */
      rgbData?: number[];
      style: Style;
      zIndex: number;
    };

/** Extraction options. */
export type Options = {
  boxType?: "border" | "content";
  includeText?: boolean;
  includeImages?: boolean;
  includeInvisible?: boolean;
  flattenTransforms?: boolean;
};

/** Writer interface for output generation. */
export interface Writer<TOutput> {
  begin(): void;
  drawPolygon(points: Quad, style: Style): void;
  drawPolyline(points: Point[], closed: boolean, style: Style): void;
  drawText(quad: Quad, text: string, style: Style): void;
  drawImage?(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): void;
  end(): TOutput;
}
