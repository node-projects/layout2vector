import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

const RED_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC";

test.describe("PNG Writer Output", () => {
  test("produces a valid PNG data URL for a simple element", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:50px;background:red;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(100, 50);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
    // Verify it's a non-trivial PNG (more than just the header)
    const base64 = result.split(",")[1];
    expect(base64.length).toBeGreaterThan(100);
  });

  test("renders text into PNG", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:blue;">
          <p style="color:white;font-size:14px;margin:10px;">Hello PNG</p>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
      const writer = new (window as any).__HC.PNGWriter(200, 100);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return {
        dataUrl: pngResult.toDataURL(),
        irCount: ir.length,
        hasText: ir.some((n: any) => n.type === "text"),
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.irCount).toBeGreaterThan(0);
    expect(result.hasText).toBe(true);
  });

  test("renders polylines and filled shapes", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target">
          <svg width="200" height="200" viewBox="0 0 200 200">
            <rect x="10" y="10" width="80" height="80" fill="green" stroke="black" stroke-width="2"/>
            <circle cx="150" cy="50" r="40" fill="orange"/>
            <polyline points="10,180 50,120 90,180" fill="none" stroke="blue" stroke-width="3"/>
          </svg>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(200, 200);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return {
        dataUrl: pngResult.toDataURL(),
        irCount: ir.length,
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.irCount).toBeGreaterThan(0);
  });

  test("preserves holes in compound SVG paths", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target">
          <svg width="100" height="100" viewBox="0 0 100 100">
            <path d="M10 10 H90 V90 H10 Z M35 35 H65 V65 H35 Z" fill="rgb(145, 152, 161)" fill-rule="evenodd" />
          </svg>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(100, 100);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const ctx = pngResult.getCanvas().getContext("2d")!;
      return {
        outer: Array.from(ctx.getImageData(20, 20, 1, 1).data),
        hole: Array.from(ctx.getImageData(50, 50, 1, 1).data),
      };
    });

    expect(result.outer[0]).toBeGreaterThan(120);
    expect(result.outer[0]).toBeLessThan(180);
    expect(result.outer[1]).toBeGreaterThan(120);
    expect(result.outer[2]).toBeGreaterThan(120);
    expect(result.hole[0]).toBeGreaterThan(240);
    expect(result.hole[1]).toBeGreaterThan(240);
    expect(result.hole[2]).toBeGreaterThan(240);
  });

  test("clips circular images in PNG output", async ({ page }) => {
    await setupPage(page, "<html><body style=\"margin:0;\"></body></html>");

    const result = await page.evaluate(async (dataUrl) => {
      const writer = new (window as any).__HC.PNGWriter(80, 80);
      const pngResult = await (window as any).__HC.renderIR([{
        type: "image",
        quad: [
          { x: 20, y: 20 },
          { x: 52, y: 20 },
          { x: 52, y: 52 },
          { x: 20, y: 52 },
        ],
        dataUrl,
        width: 2,
        height: 2,
        style: {
          borderRadius: "50%",
        },
        zIndex: 0,
      }], writer);

      await pngResult.finalize();
      const ctx = pngResult.getCanvas().getContext("2d")!;
      const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        center: sample(36, 36),
        corner: sample(22, 22),
      };
    }, RED_PIXEL_PNG);

    expect(result.center[0]).toBeGreaterThan(200);
    expect(result.center[1]).toBeLessThan(80);
    expect(result.center[2]).toBeLessThan(80);
    expect(result.center[3]).toBe(255);
    expect(result.corner[0]).toBeGreaterThan(240);
    expect(result.corner[1]).toBeGreaterThan(240);
    expect(result.corner[2]).toBeGreaterThan(240);
    expect(result.corner[3]).toBe(255);
  });

  test("applies blur filters to filled shapes in PNG output", async ({ page }) => {
    await setupPage(page, "<html><body style=\"margin:0;\"></body></html>");

    const result = await page.evaluate(async () => {
      const writer = new (window as any).__HC.PNGWriter(120, 120);
      const pngResult = await (window as any).__HC.renderIR([
        {
          type: "polygon",
          points: [
            { x: 8, y: 40 },
            { x: 28, y: 40 },
            { x: 28, y: 80 },
            { x: 8, y: 80 },
          ],
          style: {
            fill: "rgb(255, 0, 0)",
          },
          zIndex: 0,
        },
        {
          type: "polygon",
          points: [
            { x: 72, y: 40 },
            { x: 92, y: 40 },
            { x: 92, y: 80 },
            { x: 72, y: 80 },
          ],
          style: {
            fill: "rgb(255, 0, 0)",
            filter: "blur(10px)",
          },
          zIndex: 1,
        },
      ], writer);

      await pngResult.finalize();
      const ctx = pngResult.getCanvas().getContext("2d")!;
      const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        controlOutside: sample(34, 60),
        blurredCenter: sample(82, 60),
        blurredOutside: sample(98, 60),
      };
    });

    expect(result.blurredCenter[0]).toBeGreaterThan(180);
    expect(result.blurredCenter[0]).toBeGreaterThan(result.blurredCenter[1] + 80);
    expect(result.blurredCenter[0]).toBeGreaterThan(result.blurredCenter[2] + 80);
    expect(result.controlOutside[0]).toBeGreaterThan(240);
    expect(result.controlOutside[1]).toBeGreaterThan(240);
    expect(result.controlOutside[2]).toBeGreaterThan(240);
    expect(result.blurredOutside[1]).toBeLessThan(result.controlOutside[1]);
    expect(result.blurredOutside[2]).toBeLessThan(result.controlOutside[2]);
  });

  test("handles rounded rectangles", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:150px;height:80px;background:#4CAF50;border-radius:15px;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(150, 80);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  test("handles gradients", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:200px;height:100px;background:linear-gradient(to right, red, blue);"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(200, 100);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      return pngResult.toDataURL();
    });

    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  test("supports scale parameter for high-DPI output", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:50px;background:purple;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });

      // 1x
      const writer1x = new (window as any).__HC.PNGWriter(100, 50, 1);
      const result1x = await (window as any).__HC.renderIR(ir, writer1x);
      await result1x.finalize();
      const dataUrl1x = result1x.toDataURL();

      // 2x
      const writer2x = new (window as any).__HC.PNGWriter(100, 50, 2);
      const result2x = await (window as any).__HC.renderIR(ir, writer2x);
      await result2x.finalize();
      const dataUrl2x = result2x.toDataURL();

      return {
        size1x: dataUrl1x.length,
        size2x: dataUrl2x.length,
      };
    });

    // 2x should produce a larger PNG (more pixels)
    expect(result.size2x).toBeGreaterThan(result.size1x);
  });

  test("toBytes returns valid PNG bytes", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:50px;height:50px;background:green;"></div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(50, 50);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const bytes = pngResult.toBytes();
      // Check PNG magic number: 137 80 78 71 13 10 26 10
      return {
        length: bytes.length,
        magic: [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]],
      };
    });

    expect(result.length).toBeGreaterThan(0);
    // PNG magic number
    expect(result.magic).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("handles transparent elements correctly", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="width:100px;height:100px;">
          <div style="width:80px;height:80px;background:rgba(255,0,0,0.5);"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, { boxType: "border" });
      const writer = new (window as any).__HC.PNGWriter(100, 100);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const canvas = pngResult.getCanvas();
      const ctx = canvas.getContext("2d")!;
      const pixel = Array.from(ctx.getImageData(40, 40, 1, 1).data);
      return {
        dataUrl: pngResult.toDataURL(),
        pixel,
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.pixel[0]).toBeGreaterThan(240);
    expect(result.pixel[1]).toBeLessThan(200);
    expect(result.pixel[2]).toBeLessThan(200);
    expect(result.pixel[3]).toBe(255);
  });

  test("renders translucent pre backgrounds", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="target" style="position:relative;width:400px;height:320px;">
          <pre
            style="position:absolute;left:40px;top:30px;width:240px;height:160px;border:1px solid black;background:rgba(194, 31, 31, 0.52);margin:0;"
          >line one
line two
line three</pre>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
      });
      const prePolygon = ir.find((node: any) =>
        node.type === "polygon" &&
        Math.min(...node.points.map((point: any) => point.x)) >= 40 &&
        Math.min(...node.points.map((point: any) => point.y)) >= 30
      );

      const writer = new (window as any).__HC.PNGWriter(400, 320);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const canvas = pngResult.getCanvas();
      const ctx = canvas.getContext("2d")!;

      return {
        fill: prePolygon?.style?.fill,
        pixel: Array.from(ctx.getImageData(120, 100, 1, 1).data),
      };
    });

    expect(result.fill).toBe("rgba(194, 31, 31, 0.52)");
    expect(result.pixel[0]).toBeGreaterThan(210);
    expect(result.pixel[1]).toBeLessThan(170);
    expect(result.pixel[2]).toBeLessThan(170);
    expect(result.pixel[3]).toBe(255);
  });

  test("renders translucent pre backgrounds in the test8 layout", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="width: 100%; height: 100%; border: none; overflow: auto; position: absolute;">
          <button style="width:200px;height:53px;position:absolute;left:62px;top:59px;rotate:0deg;">Button</button>
          <select style="position:absolute;left:62px;top:112px;width:200px;height:88px;"></select>
          <textarea style="position:absolute;left:62px;top:200px;width:194px;height:175px;"></textarea>
          <input type="checkbox" style="position:absolute;left:106px;top:422px;width:75px;height:59px;">
          <input type="datetime-local" style="position:absolute;left:62px;top:381px;">
          <input value="mnnmnmnm" style="position:absolute;left:407px;top:114px;">
          <pre
            style="position:absolute;left:407px;top:122px;width:327px;height:227px;border:1px solid black;background:rgba(194, 31, 31, 0.52);margin:0;"
          >    dsfd.  fsdfd
    dsfdfs.  dfddsf
    sdf x
    dsfdfsdfddsfdfssddfs </pre>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("root")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
        includeImages: true,
      });
      const prePolygon = ir.find((node: any) =>
        node.type === "polygon" && node.style?.fill === "rgba(194, 31, 31, 0.52)"
      );

      const writer = new (window as any).__HC.PNGWriter(740, 500);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();
      const canvas = pngResult.getCanvas();
      const ctx = canvas.getContext("2d")!;

      return {
        fill: prePolygon?.style?.fill,
        pixel: Array.from(ctx.getImageData(520, 260, 1, 1).data),
      };
    });

    expect(result.fill).toBe("rgba(194, 31, 31, 0.52)");
    expect(result.pixel[0]).toBeGreaterThan(210);
    expect(result.pixel[1]).toBeLessThan(170);
    expect(result.pixel[2]).toBeLessThan(170);
    expect(result.pixel[3]).toBe(255);
  });

  test("renders object-fit: cover by cropping source image edges", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" style="width:100px;height:100px;object-fit:cover;display:block;" />
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const img = document.getElementById("target") as HTMLImageElement;
      const source = document.createElement("canvas");
      source.width = 200;
      source.height = 100;
      const sourceCtx = source.getContext("2d")!;
      sourceCtx.fillStyle = "#ff0000";
      sourceCtx.fillRect(0, 0, 200, 100);
      sourceCtx.fillStyle = "#00ff00";
      sourceCtx.fillRect(0, 0, 25, 100);
      sourceCtx.fillStyle = "#0000ff";
      sourceCtx.fillRect(175, 0, 25, 100);
      img.src = source.toDataURL("image/png");

      await new Promise<void>((resolve) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve();
          return;
        }
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });

      const ir = await (window as any).__HC.extractIR(img, {
        includeImages: true,
        includeText: false,
      });
      const writer = new (window as any).__HC.PNGWriter(100, 100);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();

      const outImg = new Image();
      outImg.src = pngResult.toDataURL();
      await new Promise<void>((resolve) => {
        if (outImg.complete && outImg.naturalWidth > 0) {
          resolve();
          return;
        }
        outImg.onload = () => resolve();
        outImg.onerror = () => resolve();
      });

      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(outImg, 0, 0);

      const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        left: sample(5, 50),
        center: sample(50, 50),
        right: sample(95, 50),
      };
    });

    for (const pixel of [result.left, result.center, result.right]) {
      expect(pixel[0]).toBeGreaterThan(160);
      expect(pixel[1]).toBeLessThan(110);
      expect(pixel[2]).toBeLessThan(110);
      expect(pixel[3]).toBeGreaterThan(200);
    }
  });

  test("renders vertical text when pretext measurement is enabled", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:12px;background:white;">
        <div id="target" style="height:220px;width:96px;color:rgb(23, 63, 95);font:700 24px/1.2 'Segoe UI', sans-serif;direction:rtl;writing-mode:vertical-rl;">VERTICAL</div>
      </body></html>`
    );

    const result = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        boxType: "border",
        includeText: true,
        textMeasurement: "auto",
      });
      const writer = new (window as any).__HC.PNGWriter(120, 240);
      const pngResult = await (window as any).__HC.renderIR(ir, writer);
      await pngResult.finalize();

      return {
        dataUrl: pngResult.toDataURL(),
        textNodes: ir.filter((node: any) => node.type === "text").map((node: any) => node.text),
      };
    });

    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.textNodes.join("")).toBe("VERTICAL");
    expect(result.textNodes.length).toBeGreaterThanOrEqual(1);
  });
});
