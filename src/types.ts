/**
 * Core types for the DOM → Geometry → DXF/PDF library.
 */

/** A 2D point. */
export type Point = { x: number; y: number };

/** A quad defined by 4 points (top-left, top-right, bottom-right, bottom-left). */
export type Quad = [Point, Point, Point, Point];

/** An absolute clip quad, optionally with rounded corners. */
export type ClipQuad = {
  points: Quad;
  radius: number;
};

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
  letterSpacing?: string;
  wordSpacing?: string;
  textIndent?: string;
  whiteSpace?: string;
  wordBreak?: string;
  overflowWrap?: string;

  direction?: string;
  writingMode?: string;

  outlineColor?: string;
  outlineWidth?: string;
  outlineStyle?: string;
  outlineOffset?: string;
  filter?: string;
  mixBlendMode?: string;
  mask?: string;

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
  /** Per-corner superellipse K values [TL, TR, BR, BL] from CSS corner-shape. */
  cornerShapes?: [number, number, number, number];
  backgroundImage?: string;
  boxShadow?: string;
  transform?: string;
  overflow?: string;
  textOverflow?: string;
  imageRendering?: string;
  clipPath?: string;
  /** One or more absolute clip quads inherited from iframe viewports. */
  clipQuads?: ClipQuad[];
  /** Clip boundary from an ancestor with overflow:hidden + border-radius (absolute page coords). */
  clipBounds?: { x: number; y: number; w: number; h: number; radius: number };
};

/** Controls how text is split into IR text nodes during extraction. */
export type TextMeasurementMode = "line" | "pretext" | "auto";

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
   * Controls text extraction granularity.
   * - `line`: one IR text node per visual line (default), uses browser getBoxQuads
   * - `pretext`: uses @chenglou/pretext for accurate text measurement and layout,
   *   supports all writing modes (horizontal-tb, vertical-rl, vertical-lr, sideways-rl, sideways-lr)
   * - `auto`: uses `line` for horizontal-tb with ltr direction, `pretext` for all other writing modes
   */
  textMeasurement?: TextMeasurementMode;
  /**
   * When true, same-origin iframe documents are traversed and extracted as part
   * of the parent tree. Cross-origin or not-yet-loaded iframes are skipped.
   * Defaults to false.
   */
  walkIframes?: boolean;
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
  /**
   * Scale factor for rasterizing embedded images.
   * Higher values produce sharper images when zooming in on the exported file.
   * For example, `imageScale: 2` renders embedded PNGs at 2× their display size.
   * Defaults to 1 (images rendered at display resolution).
   */
  imageScale?: number;
  /**
   * When true, embedded SVG images (in `<img>` tags and CSS `background-image`)
   * are converted directly to vector IR nodes (polygon, polyline, text) instead
   * of being rasterized to bitmap image nodes. This produces resolution-independent
   * output but may not accurately render SVGs that use fill-rule:evenodd with
   * complex multi-subpath paths.
   * Defaults to false (SVGs with evenodd multi-subpath paths are rasterized).
   */
  svgToVector?: boolean;
  /**
   * When true, native form controls are converted to synthetic IR nodes that
   * preserve their visible state or value (for example checkbox/radio state,
   * input values, select labels, and progress values) instead of relying on the
   * browser exposing those visuals as regular DOM text and boxes.
   * Defaults to false.
   */
  convertFormControls?: boolean;
  /**
   * When true, ::before and ::after pseudo-elements with generated content
   * (including counter(), counters(), attr(), and string literals) are
   * extracted into the IR as polygon and text nodes.
   * Requires a browser that resolves counter values in getComputedStyle
   * (Firefox).  Defaults to true.
   */
  includePseudoElements?: boolean;
};

/** Writer interface for output generation. */
export interface Writer<TOutput> {
  begin(): Promise<void>;
  drawPolygon(points: Quad, style: Style): Promise<void>;
  drawPolyline(points: Point[], closed: boolean, style: Style): Promise<void>;
  drawText(quad: Quad, text: string, style: Style): Promise<void>;
  drawImage?(quad: Quad, dataUrl: string, width: number, height: number, style: Style, rgbData?: number[]): Promise<void>;
  end(): Promise<TOutput>;
}
