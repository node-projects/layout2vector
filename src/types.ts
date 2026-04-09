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
  imageRendering?: string;
  /** Clip boundary from an ancestor with overflow:hidden + border-radius (absolute page coords). */
  clipBounds?: { x: number; y: number; w: number; h: number; radius: number };
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
  /**
   * When extracting from multiple elements (passing an array to extractIR),
   * specifies which element's top-left corner to use as the coordinate origin.
   * Defaults to the first element in the array.
   */
  coordinateRoot?: Element;
  /**
   * Scale factor applied to all extracted coordinates during IR generation.
   * Useful when the source DOM is rendered at a different zoom level.
   * For example, `zoom: 2` doubles all coordinates and sizes.
   * Defaults to 1 (no scaling).
   */
  zoom?: number;
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
