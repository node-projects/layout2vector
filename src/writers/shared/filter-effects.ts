export function getCssCanvasFilter(filter: string | undefined): string | undefined {
  const value = filter?.trim();
  if (!value || value === "none") return undefined;
  return value;
}

export function extractBlurRadiusPx(filter: string | undefined): number | undefined {
  const value = filter?.trim();
  if (!value || value === "none") return undefined;

  const matches = [...value.matchAll(/blur\(\s*(-?[\d.]+)px\s*\)/gi)];
  if (matches.length === 0) return undefined;

  const radius = matches.reduce((sum, match) => {
    const parsed = parseFloat(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? sum + parsed : sum;
  }, 0);

  return radius > 0 ? radius : undefined;
}

export function mapMixBlendModeToCanvasComposite(mixBlendMode: string | undefined): GlobalCompositeOperation | undefined {
  switch (mixBlendMode?.trim()) {
    case undefined:
    case "":
    case "normal":
      return undefined;
    case "plus-lighter":
      return "lighter";
    case "multiply":
    case "screen":
    case "overlay":
    case "darken":
    case "lighten":
    case "color-dodge":
    case "color-burn":
    case "hard-light":
    case "soft-light":
    case "difference":
    case "exclusion":
    case "hue":
    case "saturation":
    case "color":
    case "luminosity":
      return mixBlendMode as GlobalCompositeOperation;
    default:
      return undefined;
  }
}

export function getSvgBlendModeStyle(mixBlendMode: string | undefined): string | undefined {
  const value = mixBlendMode?.trim();
  if (!value || value === "normal") return undefined;
  return value;
}