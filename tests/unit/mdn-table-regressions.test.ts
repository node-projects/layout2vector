import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("MDN table regressions", () => {
  test("closed details content is not exported while open details content is exported", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:12px;">
        <details id="closed">
          <summary>Closed summary</summary>
          <div>Closed details body should stay hidden.</div>
        </details>
        <details id="open" open>
          <summary>Open summary</summary>
          <div>Open details body should be exported.</div>
        </details>
      </body></html>`
    );

    const texts = await page.evaluate(async () => {
      const root = document.body;
      const ir = await (window as any).__HC.extractIR(root, {
        includeText: true,
        includeImages: false,
      });

      return ir
        .filter((node: any) => node.type === "text")
        .map((node: any) => node.text);
    });

    expect(texts.join(" ")).toContain("Closed summary");
    expect(texts.join(" ")).toContain("Open details body should be exported.");
    expect(texts.join(" ")).not.toContain("Closed details body should stay hidden.");
  });

  test("masked icon extraction works when mask shorthand is none but -webkit-mask-image is present", async ({ page }) => {
    const MASK_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="black" d="M2 7h12v2H2z"/></svg>'
    );

    await setupPage(
      page,
      `<html><head><style>
        #target {
          display: inline-block;
          width: 16px;
          height: 16px;
          background: rgb(95, 99, 104);
          mask: none;
          -webkit-mask-image: url("${MASK_SVG}");
          -webkit-mask-position: center;
          -webkit-mask-repeat: no-repeat;
          -webkit-mask-size: 16px;
        }
      </style></head><body style="margin:0;padding:0;">
        <abbr id="target" title="partial"></abbr>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      return {
        imageCount: ir.filter((node: any) => node.type === "image").length,
        polygonCount: ir.filter((node: any) => node.type === "polygon").length,
      };
    });

    expect(summary.imageCount).toBe(1);
    expect(summary.polygonCount).toBe(0);
  });

  test("rotated MDN-style header labels preserve source progression in IR and HTML output", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:24px;background:#f6f7f9;">
        <table style="border-collapse:collapse;table-layout:fixed;background:#fff;">
          <thead>
            <tr>
              <th style="height:120px;width:120px;padding:0;border:1px solid #d5d7dc;"><div id="chrome-header" style="display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);font:700 20px/1 'Segoe UI',sans-serif;">Chrome</div></th>
              <th style="height:120px;width:120px;padding:0;border:1px solid #d5d7dc;"><div id="firefox-header" style="display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);font:700 20px/1 'Segoe UI',sans-serif;">Firefox</div></th>
              <th style="height:120px;width:120px;padding:0;border:1px solid #d5d7dc;"><div id="safari-header" style="display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);font:700 20px/1 'Segoe UI',sans-serif;">Safari</div></th>
            </tr>
          </thead>
        </table>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const ids = ["chrome-header", "firefox-header", "safari-header"];
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

      function progressionFromIrNode(node: any): { dx: number; dy: number; absDx: number; absDy: number } | null {
        if (!node || node.type !== "text") return null;
        const dx = node.quad[1].x - node.quad[0].x;
        const dy = node.quad[1].y - node.quad[0].y;
        return { dx, dy, absDx: Math.abs(dx), absDy: Math.abs(dy) };
      }

      const source: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      for (const id of ids) {
        source[id] = progressionFromTextNode(document.getElementById(id)?.firstChild as Text | null);
      }

      const ir = await HC.extractIR(document.body, {
        includeText: true,
        includeImages: false,
        includeSourceMetadata: true,
        textMeasurement: "auto",
      });

      const extracted: Record<string, { dx: number; dy: number; absDx: number; absDy: number } | null> = {};
      for (const id of ids) {
        extracted[id] = progressionFromIrNode(ir.find((node: any) => node.type === "text" && node.source?.id === id));
      }

      const html = await HC.renderIR(ir, new HC.HTMLWriter({ width: 900, height: 220 }));
      return { source, extracted, html };
    });

    const dominantAxis = (vector: { absDx: number; absDy: number }) => vector.absDy > vector.absDx ? "y" : "x";
    const directionSign = (vector: { dx: number; dy: number; absDx: number; absDy: number }) => dominantAxis(vector) === "y"
      ? Math.sign(vector.dy || 0)
      : Math.sign(vector.dx || 0);

    for (const id of ["chrome-header", "firefox-header", "safari-header"] as const) {
      expect(summary.source[id]).not.toBeNull();
      expect(summary.extracted[id]).not.toBeNull();
      expect(dominantAxis(summary.extracted[id]!)).toBe(dominantAxis(summary.source[id]!));
      expect(directionSign(summary.extracted[id]!)).toBe(directionSign(summary.source[id]!));
      expect(summary.source[id]!.dy).toBeLessThan(0);
    }

    await page.setContent(summary.html, { waitUntil: "load" });

    const output = await page.evaluate(() => {
      const ids = ["chrome-header", "firefox-header", "safari-header"];

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
          .find((node) => (node.textContent ?? "").trim().length > 0);
        result[id] = progressionFromTextNode((el?.firstChild as Text | null) ?? null);
      }
      return result;
    });

    for (const id of ["chrome-header", "firefox-header", "safari-header"] as const) {
      expect(output[id]).not.toBeNull();
      expect(dominantAxis(output[id]!)).toBe(dominantAxis(summary.source[id]!));
      expect(directionSign(output[id]!)).toBe(directionSign(summary.source[id]!));
    }
  });
});
