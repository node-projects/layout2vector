import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

const TEST9_HTML = `<div id="root" style="width: 100%; height: 100%; border: none; overflow: auto; position: absolute;">
  <style>
    div {
      border: 1px solid black;
    }
  </style>
  <div id="a" style="position:absolute;left:44px;top:99px;width:101px;height:53px;">abcdef</div>
  <div id="b" style="position:absolute;left:185px;top:82px;width:101px;height:53px;writing-mode:vertical-rl;">abcdef</div>
  <div id="c" style="position:absolute;left:398px;top:170px;width:101px;height:204px;writing-mode:vertical-rl;direction:rtl;">abcdef</div>
  <div id="d" style="position:absolute;left:403px;top:87px;width:101px;height:53px;direction:rtl;">abcdef</div>
  <div id="e" style="position:absolute;left:228px;top:233px;width:101px;height:53px;writing-mode:sideways-rl;">abcdef</div>
  <div id="f" style="position:absolute;left:201px;top:329px;width:101px;height:125px;writing-mode:sideways-lr;">abcdef</div>
  <div id="g" style="position:absolute;left:342px;top:394px;width:101px;height:125px;writing-mode:sideways-lr;direction:rtl;">abcdef</div>
  <div id="h" style="position:absolute;left:98px;top:228px;width:101px;height:101px;writing-mode:vertical-lr;">abcdef</div>
  <div id="i" style="position:absolute;left:40px;top:381px;width:101px;height:101px;writing-mode:vertical-lr;direction:rtl;">abcdef</div>
</div>`;

type Vector = {
  dx: number;
  dy: number;
  absDx: number;
  absDy: number;
};

function dominantAxis(vector: Vector): "x" | "y" {
  return vector.absDy > vector.absDx ? "y" : "x";
}

function directionSign(vector: Vector): number {
  return dominantAxis(vector) === "y"
    ? Math.sign(vector.dy || 0)
    : Math.sign(vector.dx || 0);
}

function expectVectorMatches(source: Vector, actual: Vector): void {
  expect(dominantAxis(actual)).toBe(dominantAxis(source));
  expect(directionSign(actual)).toBe(directionSign(source));
}

test.describe("test9 writing-mode orientation", () => {
  test("source progression matches extracted IR and HTML output for all writing-mode cases", async ({ page }) => {
    await setupPage(page, `<html><body style="margin:0;padding:0;">${TEST9_HTML}</body></html>`);

    const summary = await page.evaluate(async () => {
      const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
      const root = document.getElementById("root") ?? document.body;
      const HC = (window as any).__HC;

      function progressionFromTextNode(textNode: Text | null): { dx: number; dy: number; absDx: number; absDy: number } | null {
        if (!textNode) return null;
        const text = textNode.textContent ?? "";
        if (!text) return null;

        const range = document.createRange();
        const centers: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < text.length; index++) {
          try {
            range.setStart(textNode, index);
            range.setEnd(textNode, index + 1);
          } catch {
            continue;
          }

          const rects = range.getClientRects();
          for (let rectIndex = 0; rectIndex < rects.length; rectIndex++) {
            const rect = rects[rectIndex];
            if (rect.width * rect.height <= 0.01) continue;
            centers.push({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            });
            break;
          }
        }

        if (centers.length < 2) return null;
        const first = centers[0];
        const last = centers[centers.length - 1];
        const dx = last.x - first.x;
        const dy = last.y - first.y;
        return { dx, dy, absDx: Math.abs(dx), absDy: Math.abs(dy) };
      }

      function progressionFromElement(el: Element | null): { dx: number; dy: number; absDx: number; absDy: number } | null {
        if (!el) return null;
        return progressionFromTextNode(el.firstChild as Text | null);
      }

      function progressionFromIrNode(node: any): { dx: number; dy: number; absDx: number; absDy: number } | null {
        if (!node || node.type !== "text") return null;
        const dx = node.quad[1].x - node.quad[0].x;
        const dy = node.quad[1].y - node.quad[0].y;
        return { dx, dy, absDx: Math.abs(dx), absDy: Math.abs(dy) };
      }

      const source: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      for (const id of ids) {
        source[id] = progressionFromElement(document.getElementById(id));
      }

      const lineIr = await HC.extractIR(root, {
        includeText: true,
        includeImages: false,
        includeSourceMetadata: true,
        textMeasurement: "line",
      });
      const autoIr = await HC.extractIR(root, {
        includeText: true,
        includeImages: false,
        includeSourceMetadata: true,
        textMeasurement: "auto",
      });

      const line: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      const auto: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      for (const id of ids) {
        line[id] = progressionFromIrNode(lineIr.find((node: any) => node.type === "text" && node.source?.id === id && node.text.includes("abcdef")));
        auto[id] = progressionFromIrNode(autoIr.find((node: any) => node.type === "text" && node.source?.id === id && node.text.includes("abcdef")));
      }

      const autoHtml = await HC.renderIR(autoIr, new HC.HTMLWriter({ width: 1280, height: 720 }));
      return { source, line, auto, autoHtml };
    });

    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const) {
      expect(summary.source[id]).not.toBeNull();
      expect(summary.line[id]).not.toBeNull();
      expect(summary.auto[id]).not.toBeNull();
      expectVectorMatches(summary.source[id]!, summary.line[id]!);
      expectVectorMatches(summary.source[id]!, summary.auto[id]!);
    }

    expect(summary.source.f!.dy).toBeLessThan(0);
    expect(summary.source.g!.dy).toBeLessThan(0);

    await page.setContent(summary.autoHtml, { waitUntil: "load" });

    const output = await page.evaluate(() => {
      const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

      function progressionFromTextNode(textNode: Text | null): { dx: number; dy: number; absDx: number; absDy: number } | null {
        if (!textNode) return null;
        const text = textNode.textContent ?? "";
        if (!text) return null;

        const range = document.createRange();
        const centers: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < text.length; index++) {
          try {
            range.setStart(textNode, index);
            range.setEnd(textNode, index + 1);
          } catch {
            continue;
          }

          const rects = range.getClientRects();
          for (let rectIndex = 0; rectIndex < rects.length; rectIndex++) {
            const rect = rects[rectIndex];
            if (rect.width * rect.height <= 0.01) continue;
            centers.push({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            });
            break;
          }
        }

        if (centers.length < 2) return null;
        const first = centers[0];
        const last = centers[centers.length - 1];
        const dx = last.x - first.x;
        const dy = last.y - first.y;
        return { dx, dy, absDx: Math.abs(dx), absDy: Math.abs(dy) };
      }

      const result: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      for (const id of ids) {
        const el = Array.from(document.querySelectorAll(`[data-source-id="${id}"]`))
          .find((node) => (node.textContent ?? "").includes("abcdef"));
        result[id] = progressionFromTextNode((el?.firstChild as Text | null) ?? null);
      }
      return result;
    });

    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const) {
      expect(output[id]).not.toBeNull();
      expectVectorMatches(summary.source[id]!, output[id]!);
    }
  });
});
