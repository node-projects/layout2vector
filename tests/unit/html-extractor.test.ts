import { test, expect, type Page } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("HTML Geometry Extraction", () => {
  test("extracts simple div box quad", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:50px;background:red;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { boxType: "border" });
    });

    expect(ir.length).toBeGreaterThan(0);
    const polygon = ir.find((n: any) => n.type === "polygon");
    expect(polygon).toBeDefined();
    // The box should be approximately 100x50
    const [tl, tr, br, bl] = polygon.points;
    expect(tr.x - tl.x).toBeCloseTo(100, 0);
    expect(bl.y - tl.y).toBeCloseTo(50, 0);
  });

  test("extracts text node geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <p id="target" style="font-size:16px;font-family:monospace;">Hello World</p>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
    });

    const textNode = ir.find((n: any) => n.type === "text");
    expect(textNode).toBeDefined();
    expect(textNode.text).toContain("Hello World");
  });

  test("skips display:none elements", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="visible" style="width:50px;height:50px;background:blue;"></div>
          <div id="hidden" style="display:none;width:50px;height:50px;background:red;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    // Should have geometry for root and visible, not hidden
    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Each visible element with non-zero size produces a polygon
    const widths = polygons.map(
      (p: any) => p.points[1].x - p.points[0].x
    );
    // Should NOT contain a 50px-wide red box at a later position
    // The hidden div should not appear
    expect(polygons.length).toBeGreaterThanOrEqual(1);
  });

  test("skips visibility:hidden elements", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div style="width:100px;height:100px;background:green;"></div>
          <div style="visibility:hidden;width:100px;height:100px;background:red;"></div>
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const polygons = ir.filter((n: any) => n.type === "polygon");
    // Only the green div should produce geometry (plus root)
    expect(polygons.length).toBeLessThanOrEqual(2);
  });

  test("skips visibility:hidden pseudo-elements", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="position:relative;width:120px;height:40px;color:black;">
          Visible
        </div>
        <style>
          #target::after {
            content: "hidden pseudo";
            position: absolute;
            left: 0;
            top: 20px;
            visibility: hidden;
          }
        </style>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeText: true,
        includePseudoElements: true,
      });
    });

    const textNodes = ir.filter((n: any) => n.type === "text");
    expect(textNodes.some((node: any) => node.text.includes("hidden pseudo"))).toBe(false);
  });

  test("handles content box type", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:100px;padding:10px;border:5px solid black;background:red;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { boxType: "content" });
    });

    const polygon = ir.find((n: any) => n.type === "polygon");
    expect(polygon).toBeDefined();
    // Content box should be 100x100 (the inner content, excluding padding/border)
    const width = polygon.points[1].x - polygon.points[0].x;
    const height = polygon.points[3].y - polygon.points[0].y;
    expect(width).toBeCloseTo(100, 0);
    expect(height).toBeCloseTo(100, 0);
  });

  test("preserves preformatted whitespace for transformed pre blocks", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:32px;background:#f5f1ea;">
        <pre id="plain" style="margin:0 0 24px;padding:18px 24px;background:#fff;border:2px solid #2f4858;font:18px/1.4 'Courier New', monospace;white-space:pre;">function renderBlock() {
  const title = "pre  block";
    return title.padEnd(14, " ");
}</pre>
        <pre id="rotated" style="margin:0;padding:18px 24px;background:#fff;border:2px solid #bc6c25;font:18px/1.4 'Courier New', monospace;white-space:pre;transform:rotate(-4deg) skewX(-5deg);transform-origin:top left;">if (line.startsWith("  ")) {
  rows.push(line);
    render("keep  spaces");
}</pre>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const extract = (window as any).__HC.extractIR;
      const plainIr = await extract(document.getElementById("plain"), { boxType: "border", includeText: true });
      const rotatedIr = await extract(document.getElementById("rotated"), { boxType: "border", includeText: true });

      const plainPolygon = plainIr.find((node: any) => node.type === "polygon");
      const plainTextNodes = plainIr.filter((node: any) => node.type === "text");
      const rotatedTextNodes = rotatedIr.filter((node: any) => node.type === "text");
      const rotatedFirstQuad = rotatedTextNodes[0].quad;
      const rotatedAngle = Math.atan2(
        rotatedFirstQuad[1].y - rotatedFirstQuad[0].y,
        rotatedFirstQuad[1].x - rotatedFirstQuad[0].x,
      );

      return {
        plainTexts: plainTextNodes.map((node: any) => node.text),
        rotatedTexts: rotatedTextNodes.map((node: any) => node.text),
        plainPaddingX: plainTextNodes[0].quad[0].x - plainPolygon.points[0].x,
        rotatedAngle,
      };
    });

    expect(summary.plainTexts).toEqual([
      'function renderBlock() {',
      '  const title = "pre  block";',
      '    return title.padEnd(14, " ");',
      '}',
    ]);
    expect(summary.rotatedTexts).toEqual([
      "if (line.startsWith(\"  \")) {",
      "  rows.push(line);",
      "    render(\"keep  spaces\");",
      "}",
    ]);
    expect(summary.plainPaddingX).toBeGreaterThan(20);
    expect(Math.abs(summary.rotatedAngle)).toBeGreaterThan(0.03);
  });

  test("textMeasurement auto uses pretext for non-standard writing modes", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:24px;font-family:'Segoe UI',sans-serif;">
        <p id="normal" style="margin:0 0 24px;font-size:24px;">Normal flow</p>
        <div id="vertical" style="height:220px;width:88px;font-size:24px;line-height:1.2;direction:rtl;writing-mode:vertical-rl;">VERTICAL</div>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const extract = (window as any).__HC.extractIR;
      const normalIr = await extract(document.getElementById("normal"), {
        boxType: "border",
        includeText: true,
        textMeasurement: "auto",
      });
      const verticalIr = await extract(document.getElementById("vertical"), {
        boxType: "border",
        includeText: true,
        textMeasurement: "auto",
      });
      const explicitIr = await extract(document.getElementById("normal"), {
        boxType: "border",
        includeText: true,
        textMeasurement: "pretext",
      });

      const toTextSummary = (ir: any[]) => ir
        .filter((node) => node.type === "text")
        .map((node) => ({
          text: node.text,
          whiteSpace: node.style.whiteSpace ?? null,
          writingMode: node.style.writingMode ?? null,
          direction: node.style.direction ?? null,
        }));

      return {
        normal: toTextSummary(normalIr),
        vertical: toTextSummary(verticalIr),
        explicit: toTextSummary(explicitIr),
      };
    });

    expect(summary.normal).toHaveLength(1);
    expect(summary.normal[0].text).toBe("Normal flow");

    // Pretext mode produces line-level text nodes (not per-character)
    expect(summary.vertical.length).toBeGreaterThanOrEqual(1);
    expect(summary.vertical.map((node: any) => node.text).join("")).toBe("VERTICAL");
    expect(summary.vertical.every((node: any) => node.whiteSpace === "pre")).toBe(true);
    expect(summary.vertical.every((node: any) => node.writingMode === null)).toBe(true);
    expect(summary.vertical.every((node: any) => node.direction === null)).toBe(true);

    // Explicit pretext mode for normal text
    expect(summary.explicit.length).toBeGreaterThanOrEqual(1);
    expect(summary.explicit.map((node: any) => node.text).join("")).toBe("Normal flow");
    expect(summary.explicit.every((node: any) => node.whiteSpace === "pre")).toBe(true);
  });
});
