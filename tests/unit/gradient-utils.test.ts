import { expect, test } from "@playwright/test";

import {
  expandRepeatingGradientStops,
  normalizeGradientStopOffsets,
  parseAllGradientsAst,
  parseGradientAst,
} from "../../src/writers/shared/gradient-utils.js";

test.describe("Gradient Utils", () => {
  test("parses radial prefixes and preserves raw px stops in the shared AST", () => {
    const gradient = parseGradientAst("radial-gradient(circle at center, red 0px, blue 24px)");

    expect(gradient).not.toBeNull();
    expect(gradient?.type).toBe("radial");
    expect(gradient?.stops).toEqual([
      { color: "red", offset: 0, unit: "px" },
      { color: "blue", offset: 24, unit: "px" },
    ]);
  });

  test("normalizes implied stop offsets without changing explicit ones", () => {
    const resolved = normalizeGradientStopOffsets([
      { color: "red", offset: -1 },
      { color: "green", offset: 0.4 },
      { color: "blue", offset: -1 },
    ]);

    expect(resolved).toEqual([
      { color: "red", offset: 0 },
      { color: "green", offset: 0.4 },
      { color: "blue", offset: 1 },
    ]);
  });

  test("expands repeating stops and accepts a synthetic terminal stop callback", () => {
    const expanded = expandRepeatingGradientStops(
      [
        { color: "red", offset: 0 },
        { color: "blue", offset: 0.3 },
      ],
      () => ({ color: "green", offset: 1 }),
    );

    expect(expanded.at(-1)).toEqual({ color: "green", offset: 1 });
    expect(expanded.map((stop) => Number(stop.offset.toFixed(6)))).toEqual([0, 0.3, 0.3, 0.6, 0.6, 0.9, 0.9, 1]);
  });

  test("parses multiple gradients from a background image string", () => {
    const gradients = parseAllGradientsAst(
      "radial-gradient(circle, white 0%, transparent 42%), conic-gradient(from 210deg, red 0%, blue 100%)",
    );

    expect(gradients).toHaveLength(2);
    expect(gradients[0]?.type).toBe("radial");
    expect(gradients[1]).toMatchObject({ type: "conic", fromAngleDeg: 210 });
  });
});