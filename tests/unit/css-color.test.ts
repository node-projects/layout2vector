import { test, expect } from "@playwright/test";
import { parseCssColor } from "../../src/writers/shared/css-color.js";

function expectOpaqueRed(parsed: { r: number; g: number; b: number; a: number } | null): void {
  expect(parsed).not.toBeNull();
  expect(parsed!.r).toBeGreaterThan(250);
  expect(parsed!.g).toBeLessThan(6);
  expect(parsed!.b).toBeLessThan(6);
  expect(parsed!.a).toBeCloseTo(1, 3);
}

test.describe("CSS color parsing", () => {
  test("parses legacy rgba() comma syntax", () => {
    const parsed = parseCssColor("rgba(194, 31, 31, 0.52)");
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ r: 194, g: 31, b: 31, a: 0.52 });
  });

  test("parses color(srgb ...) modern syntax", () => {
    const parsed = parseCssColor("color(srgb 1 0 0 / 0.5)");
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  test("parses lab() and lch() color functions", () => {
    expectOpaqueRed(parseCssColor("lab(54.2917% 80.8125 69.8851)"));
    expectOpaqueRed(parseCssColor("lch(54.2917% 106.839 40.853)"));
  });

  test("parses oklab() and oklch() color functions", () => {
    expectOpaqueRed(parseCssColor("oklab(0.62796 0.22486 0.12585)"));
    expectOpaqueRed(parseCssColor("oklch(0.62796 0.25768 29.234)"));
  });
});