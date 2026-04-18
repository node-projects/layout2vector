import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

function expectMostlyRed(pixel: number[]): void {
  expect(pixel[0]).toBeGreaterThan(180);
  expect(pixel[1]).toBeLessThan(80);
  expect(pixel[2]).toBeLessThan(80);
  expect(pixel[3]).toBeGreaterThan(200);
}

function expectMostlyWhite(pixel: number[]): void {
  expect(pixel[0]).toBeGreaterThan(220);
  expect(pixel[1]).toBeGreaterThan(220);
  expect(pixel[2]).toBeGreaterThan(220);
  expect(pixel[3]).toBeGreaterThan(200);
}

test.describe("CanvasWriter", () => {
  test("renders IR directly to an HTML canvas", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:40px;height:20px;background:#ff0000;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.CanvasWriter({ width: 40, height: 20 });
      const canvas = await (window as any).__HC.renderIR(ir, writer);
      const pixel = Array.from(canvas.getContext("2d")!.getImageData(20, 10, 1, 1).data);
      return { width: canvas.width, height: canvas.height, pixel };
    });

    expect(result.width).toBe(40);
    expect(result.height).toBe(20);
    expectMostlyRed(result.pixel);
  });

  test("preserves the full CSS font-family stack when rendering text", async ({ page }) => {
    await setupPage(page, `<html><body style="margin:0;padding:0;"></body></html>`);

    const result = await page.evaluate(async () => {
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      let capturedFont = "";

      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        capturedFont = this.font;
        return originalFillText.apply(this, args as [string, number, number, number?]);
      };

      try {
        const writer = new (window as any).__HC.CanvasWriter({ width: 220, height: 80 });
        await writer.begin();
        await writer.drawText(
          [
            { x: 20, y: 20 },
            { x: 200, y: 20 },
            { x: 200, y: 52 },
            { x: 20, y: 52 },
          ],
          "Stack",
          {
            color: "rgb(0, 0, 0)",
            fontFamily: '"Mona Sans", "Segoe UI", sans-serif',
            fontSize: "24px",
            fontWeight: "700",
            fontStyle: "italic",
          },
        );
        const canvas = await writer.end();
        return {
          capturedFont,
          width: canvas.width,
        };
      } finally {
        CanvasRenderingContext2D.prototype.fillText = originalFillText;
      }
    });

    expect(result.width).toBe(220);
    expect(result.capturedFont).toContain('italic');
    expect(result.capturedFont).toMatch(/\b(?:700|bold)\b/);
    expect(result.capturedFont).toContain('"Mona Sans", "Segoe UI", sans-serif');
  });

  const clipCases = [
    {
      name: "inset()",
      clipPath: "inset(20px 10px 30px 40px round 8px)",
      inside: [50, 30],
      outside: [5, 5],
    },
    {
      name: "circle()",
      clipPath: "circle(30px at 50px 50px)",
      inside: [50, 50],
      outside: [10, 10],
    },
    {
      name: "ellipse()",
      clipPath: "ellipse(20px 30px at 50px 50px)",
      inside: [50, 50],
      outside: [10, 10],
    },
    {
      name: "polygon()",
      clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
      inside: [50, 80],
      outside: [10, 10],
    },
  ] as const;

  for (const clipCase of clipCases) {
    test(`applies ${clipCase.name} clip-path when rendering to canvas`, async ({ page }) => {
      await setupPage(
        page,
        `<html><body style="margin:0;padding:0;">
          <div id="target" style="width:100px;height:100px;background:#ff0000;clip-path:${clipCase.clipPath};"></div>
        </body></html>`
      );

      const result = await page.evaluate(async ({ inside, outside }) => {
        const el = document.getElementById("target")!;
        const ir = await (window as any).__HC.extractIR(el, {
          boxType: "border",
          includeText: false,
        });
        const writer = new (window as any).__HC.CanvasWriter({ width: 100, height: 100 });
        const canvas = await (window as any).__HC.renderIR(ir, writer);
        const ctx = canvas.getContext("2d")!;
        return {
          inside: Array.from(ctx.getImageData(inside[0], inside[1], 1, 1).data),
          outside: Array.from(ctx.getImageData(outside[0], outside[1], 1, 1).data),
        };
      }, { inside: clipCase.inside, outside: clipCase.outside });

      expectMostlyRed(result.inside);
      expectMostlyWhite(result.outside);
    });
  }
});
