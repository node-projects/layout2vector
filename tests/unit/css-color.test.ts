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

  test("parses color(display-p3 ...)", () => {
    const parsed = parseCssColor("color(display-p3 1 0 0)");
    expect(parsed).not.toBeNull();
    // display-p3 red is more saturated than sRGB red
    expect(parsed!.r).toBeGreaterThan(250);
    expect(parsed!.g).toBeLessThan(20);
    expect(parsed!.b).toBeLessThan(20);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses color(display-p3 ...) with alpha", () => {
    const parsed = parseCssColor("color(display-p3 0 0.8 0.4 / 0.7)");
    expect(parsed).not.toBeNull();
    expect(parsed!.a).toBeCloseTo(0.7, 3);
    expect(parsed!.g).toBeGreaterThan(150);
  });

  test("parses color(a98-rgb ...)", () => {
    const parsed = parseCssColor("color(a98-rgb 1 0 0)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBeGreaterThan(250);
    expect(parsed!.g).toBeLessThan(20);
    expect(parsed!.b).toBeLessThan(20);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses color(prophoto-rgb ...)", () => {
    const parsed = parseCssColor("color(prophoto-rgb 0.7 0.2 0.1)");
    expect(parsed).not.toBeNull();
    // ProPhoto red maps well outside sRGB green, so g clamps to 0
    expect(parsed!.r).toBeGreaterThan(200);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses color(rec2020 ...)", () => {
    const parsed = parseCssColor("color(rec2020 1 0 0)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBeGreaterThan(250);
    expect(parsed!.g).toBeLessThan(30);
    expect(parsed!.b).toBeLessThan(20);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses color(xyz-d65 ...) and color(xyz ...)", () => {
    const d65 = parseCssColor("color(xyz-d65 0.41 0.21 0.02)");
    const xyz = parseCssColor("color(xyz 0.41 0.21 0.02)");
    expect(d65).not.toBeNull();
    expect(xyz).not.toBeNull();
    // xyz is an alias for xyz-d65
    expect(d65).toEqual(xyz);
    expect(d65!.r).toBeGreaterThan(200);
    expect(d65!.a).toBeCloseTo(1, 3);
  });

  test("parses color(xyz-d50 ...)", () => {
    const parsed = parseCssColor("color(xyz-d50 0.44 0.22 0.01)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBeGreaterThan(200);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("color() profiles with percentages", () => {
    const parsed = parseCssColor("color(display-p3 90% 30% 20%)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBeGreaterThan(200);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses hsl() modern syntax", () => {
    const parsed = parseCssColor("hsl(0 100% 50%)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBe(255);
    expect(parsed!.g).toBe(0);
    expect(parsed!.b).toBe(0);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses hsl() green and blue", () => {
    const green = parseCssColor("hsl(120 100% 50%)");
    expect(green).not.toBeNull();
    expect(green!.r).toBe(0);
    expect(green!.g).toBe(255);
    expect(green!.b).toBe(0);

    const blue = parseCssColor("hsl(240 100% 50%)");
    expect(blue).not.toBeNull();
    expect(blue!.r).toBe(0);
    expect(blue!.g).toBe(0);
    expect(blue!.b).toBe(255);
  });

  test("parses hsla() legacy comma syntax", () => {
    const parsed = parseCssColor("hsla(300, 70%, 55%, 0.7)");
    expect(parsed).not.toBeNull();
    expect(parsed!.a).toBeCloseTo(0.7, 3);
    expect(parsed!.r).toBeGreaterThan(180);
    expect(parsed!.b).toBeGreaterThan(100);
  });

  test("parses hsl() with slash alpha", () => {
    const parsed = parseCssColor("hsl(200 60% 50% / 0.5)");
    expect(parsed).not.toBeNull();
    expect(parsed!.a).toBeCloseTo(0.5, 3);
  });

  test("parses hwb()", () => {
    // Pure red: hue=0, white=0%, black=0%
    const red = parseCssColor("hwb(0 0% 0%)");
    expect(red).not.toBeNull();
    expect(red!.r).toBe(255);
    expect(red!.g).toBe(0);
    expect(red!.b).toBe(0);
  });

  test("parses hwb() with white and black", () => {
    const parsed = parseCssColor("hwb(120 10% 10%)");
    expect(parsed).not.toBeNull();
    expect(parsed!.g).toBeGreaterThan(200);
    expect(parsed!.a).toBeCloseTo(1, 3);
  });

  test("parses hwb() achromatic when white+black >= 100%", () => {
    const gray = parseCssColor("hwb(0 60% 60%)");
    expect(gray).not.toBeNull();
    expect(gray!.r).toBe(gray!.g);
    expect(gray!.g).toBe(gray!.b);
    // 60/(60+60) = 0.5 → 128
    expect(gray!.r).toBe(128);
  });

  test("parses hwb() with alpha", () => {
    const parsed = parseCssColor("hwb(180 0% 30% / 0.8)");
    expect(parsed).not.toBeNull();
    expect(parsed!.a).toBeCloseTo(0.8, 3);
  });

  test("color(srgb ...) still works after refactor", () => {
    const parsed = parseCssColor("color(srgb 0.5 0.5 0.5)");
    expect(parsed).not.toBeNull();
    expect(parsed!.r).toBe(128);
    expect(parsed!.g).toBe(128);
    expect(parsed!.b).toBe(128);
  });

  test("returns null for unknown color() profile", () => {
    expect(parseCssColor("color(unknown 0.5 0.5 0.5)")).toBeNull();
  });
});