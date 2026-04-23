import { test, expect, type Page } from "@playwright/test";
import { setupPage } from "../helpers.js";

// A 1x1 red pixel JPEG as base64 data URL
const RED_PIXEL_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";

// A 2x2 red PNG as base64 data URL (canvas-generated for Firefox compatibility)
const RED_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC";

// A simple SVG as data URL
const SVG_CIRCLE_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>');

// SVG as UTF-8 data URL (URL-encoded)
const SVG_RECT_DATA_URL =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="blue"/></svg>');

async function setGeneratedRasterImage(page: Page, sourceWidth: number, sourceHeight: number): Promise<void> {
  await page.evaluate(({ sourceWidth, sourceHeight }) => {
    const img = document.getElementById("target") as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, sourceWidth, sourceHeight);
    img.src = canvas.toDataURL("image/png");
  }, { sourceWidth, sourceHeight });

  await page.waitForFunction(() => {
    const img = document.getElementById("target") as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  });
}

async function supportsGeneratedVideo(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (typeof MediaRecorder === "undefined") return false;
    if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
    return [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].some((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  });
}

async function setGeneratedVideo(page: Page, posterColor = "#00ff00"): Promise<void> {
  await page.evaluate(async ({ posterColor }) => {
    function makeColorDataUrl(color: string): string {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 18;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    }

    function getRecordingMimeType(): string {
      const candidates = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
      return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
    }

    async function recordSolidColorVideo(color: string): Promise<string> {
      const mimeType = getRecordingMimeType();
      if (!mimeType) throw new Error("No supported MediaRecorder video mime type");

      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 18;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const stream = canvas.captureStream(1);
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      const stopped = new Promise<Blob>((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: mimeType })), { once: true });
        recorder.addEventListener("error", () => reject(new Error("MediaRecorder failed")), { once: true });
      });

      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 250));
      recorder.stop();

      const blob = await stopped;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read generated video"));
        reader.readAsDataURL(blob);
      });
    }

    const video = document.getElementById("target") as HTMLVideoElement;
    video.poster = makeColorDataUrl(posterColor);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = await recordSolidColorVideo("#ff0000");

    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
        return;
      }

      const cleanup = () => {
        video.removeEventListener("loadeddata", onLoadedData);
        video.removeEventListener("error", onError);
      };
      const onLoadedData = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Video failed to load"));
      };

      video.addEventListener("loadeddata", onLoadedData);
      video.addEventListener("error", onError);
      video.load();
    });
  }, { posterColor });
}

test.describe("Image Extraction", () => {
  test("extracts raster image (JPEG data URL) as image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad).toBeDefined();
    expect(imageNode.width).toBeGreaterThan(0);
    expect(imageNode.height).toBeGreaterThan(0);

    // Quad should be approximately 100x100
    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(100, 0);
    expect(bl.y - tl.y).toBeCloseTo(100, 0);
  });

  test("extracts raster image (PNG data URL) as image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_PNG}" style="width:80px;height:60px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad[1].x - imageNode.quad[0].x).toBeCloseTo(80, 0);
    expect(imageNode.quad[3].y - imageNode.quad[0].y).toBeCloseTo(60, 0);
  });

  test("preserves transparency for small PNG images", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" style="width:4px;height:4px;display:block;" />
      </body></html>`
    );

    await page.evaluate(() => {
      const img = document.getElementById("target") as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 4, 4);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(1, 1, 2, 2);
      img.src = canvas.toDataURL("image/png");
    });

    await page.waitForFunction(() => {
      const img = document.getElementById("target") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      const imageNode = ir.find((n: any) => n.type === "image");
      if (!imageNode) return null;

      const decoded = await new Promise<{ corner: number[]; center: number[]; mimeType: string | null }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            corner: Array.from(ctx.getImageData(0, 0, 1, 1).data),
            center: Array.from(ctx.getImageData(1, 1, 1, 1).data),
            mimeType: imageNode.dataUrl.match(/^data:([^;,]+)/)?.[1] ?? null,
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted image"));
        img.src = imageNode.dataUrl;
      });

      return {
        ...decoded,
        hasRgbData: Array.isArray(imageNode.rgbData) && imageNode.rgbData.length > 0,
      };
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.mimeType).toBe("image/png");
    expect(extracted?.hasRgbData).toBe(true);
    expect(extracted?.corner[3]).toBe(0);
    expect(extracted?.center[0]).toBeGreaterThan(200);
    expect(extracted?.center[1]).toBeLessThan(50);
    expect(extracted?.center[2]).toBeLessThan(50);
    expect(extracted?.center[3]).toBe(255);
  });

  test("preserves transparency for large PNG images", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" style="width:512px;height:512px;display:block;" />
      </body></html>`
    );

    await page.evaluate(() => {
      const img = document.getElementById("target") as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 512, 512);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(128, 128, 256, 256);
      img.src = canvas.toDataURL("image/png");
    });

    await page.waitForFunction(() => {
      const img = document.getElementById("target") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      const imageNode = ir.find((n: any) => n.type === "image");
      if (!imageNode) return null;

      const decoded = await new Promise<{ corner: number[]; center: number[]; mimeType: string | null }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            corner: Array.from(ctx.getImageData(0, 0, 1, 1).data),
            center: Array.from(ctx.getImageData(256, 256, 1, 1).data),
            mimeType: imageNode.dataUrl.match(/^data:([^;,]+)/)?.[1] ?? null,
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted image"));
        img.src = imageNode.dataUrl;
      });

      return decoded;
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.mimeType).toBe("image/png");
    expect(extracted?.corner[3]).toBe(0);
    expect(extracted?.center[0]).toBeGreaterThan(200);
    expect(extracted?.center[1]).toBeLessThan(50);
    expect(extracted?.center[2]).toBeLessThan(50);
    expect(extracted?.center[3]).toBe(255);
  });

  test("converts SVG data URL (base64) to vector geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SVG_CIRCLE_DATA_URL}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG circle should be converted to polyline geometry, not an image node
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");

    // Should have vector geometry from the circle
    expect(polylineNodes.length).toBeGreaterThan(0);
    // Should NOT have a raster image node (SVG was converted)
    expect(imageNodes.length).toBe(0);
  });

  test("converts SVG data URL (UTF-8 encoded) to vector geometry", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SVG_RECT_DATA_URL}" style="width:200px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG rect should be converted to polygon geometry
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polygonNodes = ir.filter((n: any) => n.type === "polygon");

    expect(polygonNodes.length).toBeGreaterThan(0);
    expect(imageNodes.length).toBe(0);
  });

  test("remaps compound SVG path subpaths into the image quad", async ({ page }) => {
    const SVG_COMPOUND_DATA_URL = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><path fill="red" d="M5 5H25V15H5Z M40 5H60V15H40Z"/></svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;position:relative;">
        <img id="target" src="${SVG_COMPOUND_DATA_URL}" style="position:absolute;left:144px;top:15px;width:120px;height:24px;" />
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const ir = await (window as any).__HC.extractIR(document.body, {
        includeImages: true,
        includeText: false,
      });

      const compoundPath = ir.find((node: any) => node.type === "polyline" && node.style?.pathSubpaths?.length > 1);
      if (!compoundPath) return null;

      const flattenedMinX = Math.min(...compoundPath.points.map((point: any) => point.x));
      const subpathMinX = Math.min(
        ...compoundPath.style.pathSubpaths.flatMap((subpath: any) => subpath.points.map((point: any) => point.x))
      );

      return {
        flattenedMinX,
        subpathMinX,
        subpathCount: compoundPath.style.pathSubpaths.length,
      };
    });

    expect(summary).not.toBeNull();
    expect(summary?.subpathCount).toBe(2);
    expect(summary?.flattenedMinX).toBeGreaterThan(140);
    expect(summary?.subpathMinX).toBeGreaterThan(140);
    expect(Math.abs((summary?.flattenedMinX ?? 0) - (summary?.subpathMinX ?? 0))).toBeLessThan(1);
  });

  test("rasterizes SVG data URL when element effects require an image layer", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SVG_CIRCLE_DATA_URL}" style="width:100px;height:100px;display:block;filter:blur(4px);" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");

    expect(imageNodes.length).toBeGreaterThan(0);
    expect(imageNodes[0].dataUrl).toMatch(/^data:image\//);
    expect(polylineNodes.length).toBe(0);
  });

  test("keeps a safe data URL for remote SVG image nodes", async ({ page }) => {
    await page.route("https://assets.example.test/icon.svg", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8957e5" fill-rule="evenodd" d="M1 1h14v14H1z M5 5h6v6H5z"/></svg>',
      });
    });

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="https://assets.example.test/icon.svg" style="width:32px;height:32px;display:block;" />
      </body></html>`
    );

    await page.waitForFunction(() => {
      const img = document.getElementById("target") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });

    const imageNode = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      return ir.find((n: any) => n.type === "image") ?? null;
    });

    expect(imageNode).not.toBeNull();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.dataUrl).not.toBe("https://assets.example.test/icon.svg");
  });

  test("does NOT extract images when includeImages is false/unset", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: false,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("default (no includeImages option) does not extract images", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeText: false });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("extracts the first video frame as an image only when includeVideos is enabled", async ({ page }) => {
    if (!(await supportsGeneratedVideo(page))) {
      test.skip(true, "Generated video fixture requires MediaRecorder and captureStream support");
    }

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <video id="target" style="width:96px;height:54px;display:block;object-fit:cover;"></video>
      </body></html>`
    );
    await setGeneratedVideo(page, "#00ff00");

    const withoutVideos = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: false,
        includeText: false,
      });

      return ir.filter((n: any) => n.type === "image").length;
    });

    expect(withoutVideos).toBe(0);

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeVideos: true,
        includeImages: false,
        includeText: false,
      });

      const imageNodes = ir.filter((n: any) => n.type === "image");
      if (imageNodes.length === 0) return null;

      const imageNode = imageNodes[0];
      const center = await new Promise<number[]>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("canvas unavailable"));
            return;
          }
          ctx.drawImage(img, 0, 0);
          resolve(Array.from(ctx.getImageData(Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 1, 1).data));
        };
        img.onerror = () => reject(new Error("failed to decode extracted image"));
        img.src = imageNode.dataUrl;
      });

      return {
        count: imageNodes.length,
        dataUrl: imageNode.dataUrl,
        width: imageNode.width,
        height: imageNode.height,
        center,
      };
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.count).toBe(1);
    expect(extracted?.dataUrl).toMatch(/^data:image\//);
    expect(extracted?.width).toBeGreaterThan(0);
    expect(extracted?.height).toBeGreaterThan(0);
    expect(extracted?.center[0]).toBeGreaterThan(200);
    expect(extracted?.center[1]).toBeLessThan(80);
    expect(extracted?.center[2]).toBeLessThan(80);
  });

  test("extracts canvas content as an image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <canvas id="target" width="120" height="60" style="width:120px;height:60px;display:block;"></canvas>
      </body></html>`
    );

    await page.evaluate(() => {
      const canvas = document.getElementById("target") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#0044ff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(30, 30, 14, 0, Math.PI * 2);
      ctx.fill();
    });

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      const imageNode = ir.find((n: any) => n.type === "image");
      if (!imageNode) return null;

      const sampled = await new Promise<{ blue: number[]; white: number[] }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            blue: Array.from(ctx.getImageData(100, 30, 1, 1).data),
            white: Array.from(ctx.getImageData(30, 30, 1, 1).data),
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted canvas image"));
        img.src = imageNode.dataUrl;
      });

      return {
        width: imageNode.width,
        height: imageNode.height,
        dataUrl: imageNode.dataUrl,
        quadWidth: imageNode.quad[1].x - imageNode.quad[0].x,
        quadHeight: imageNode.quad[3].y - imageNode.quad[0].y,
        ...sampled,
      };
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.dataUrl).toMatch(/^data:image\//);
    expect(extracted?.width).toBe(120);
    expect(extracted?.height).toBe(60);
    expect(extracted?.quadWidth).toBeCloseTo(120, 0);
    expect(extracted?.quadHeight).toBeCloseTo(60, 0);
    expect(extracted?.blue[2]).toBeGreaterThan(200);
    expect(extracted?.blue[0]).toBeLessThan(50);
    expect(extracted?.white[0]).toBeGreaterThan(200);
    expect(extracted?.white[1]).toBeGreaterThan(200);
    expect(extracted?.white[2]).toBeGreaterThan(200);
  });

  test("skips broken/unloaded images gracefully", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="data:image/png;base64,INVALID" style="width:100px;height:100px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // Should not crash; broken images are skipped
    const imageNodes = ir.filter((n: any) => n.type === "image");
    // Broken image — naturalWidth is 0
    expect(imageNodes.length).toBe(0);
  });

  test("extracts multiple images in a container", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="root">
          <img src="${RED_PIXEL_JPEG}" style="width:50px;height:50px;" />
          <img src="${RED_PIXEL_PNG}" style="width:75px;height:75px;" />
        </div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("root")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(2);
  });

  test("fits object-fit: contain images inside the element box", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" style="width:100px;height:100px;object-fit:contain;display:block;" />
      </body></html>`
    );
    await setGeneratedRasterImage(page, 200, 100);

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();

    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(100, 0);
    expect(bl.y - tl.y).toBeCloseTo(50, 0);
    expect(tl.y).toBeCloseTo(25, 0);
  });

  test("keeps object-fit: scale-down images at intrinsic size instead of upscaling", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" style="width:100px;height:100px;object-fit:scale-down;display:block;" />
      </body></html>`
    );
    await setGeneratedRasterImage(page, 40, 20);

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();

    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(40, 0);
    expect(bl.y - tl.y).toBeCloseTo(20, 0);
    expect(tl.x).toBeCloseTo(30, 0);
    expect(tl.y).toBeCloseTo(40, 0);
  });

  test("image IR node has correct structure", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${RED_PIXEL_JPEG}" style="width:120px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();

    // Validate IR node structure
    expect(imageNode.type).toBe("image");
    expect(imageNode.quad).toHaveLength(4);
    expect(imageNode.quad[0]).toHaveProperty("x");
    expect(imageNode.quad[0]).toHaveProperty("y");
    expect(typeof imageNode.dataUrl).toBe("string");
    expect(typeof imageNode.width).toBe("number");
    expect(typeof imageNode.height).toBe("number");
    expect(typeof imageNode.zIndex).toBe("number");
    expect(imageNode.style).toBeDefined();
  });

  test("isImageElement utility works", async ({ page }) => {
    await setupPage(
      page,
      `<html><body>
        <img id="img" src="${RED_PIXEL_JPEG}" />
        <div id="div">not an image</div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const hc = (window as any).__HC;
      const img = document.getElementById("img")!;
      const div = document.getElementById("div")!;
      return {
        imgIsImage: hc.isImageElement(img),
        divIsImage: hc.isImageElement(div),
      };
    });

    expect(result.imgIsImage).toBe(true);
    expect(result.divIsImage).toBe(false);
  });

  test("extracts CSS background-image url() as image IR node", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:120px;height:80px;background-image:url('${RED_PIXEL_PNG}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNode = ir.find((n: any) => n.type === "image");
    expect(imageNode).toBeDefined();
    expect(imageNode.dataUrl).toMatch(/^data:image\//);
    expect(imageNode.quad).toBeDefined();

    const [tl, tr, _br, bl] = imageNode.quad;
    expect(tr.x - tl.x).toBeCloseTo(120, 0);
    expect(bl.y - tl.y).toBeCloseTo(80, 0);
  });

  test("extracts repeated CSS background-image tiles instead of stretching a single copy", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:16px;height:16px;"></div>
      </body></html>`
    );

    await page.evaluate(() => {
      const el = document.getElementById("target") as HTMLDivElement;
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 4, 4);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 4, 2);

      el.style.backgroundImage = `url('${canvas.toDataURL("image/png")}')`;
      el.style.backgroundRepeat = "repeat";
      el.style.backgroundPosition = "0px 0px";
      el.style.backgroundSize = "auto";
    });

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      const imageNode = ir.find((n: any) => n.type === "image");
      if (!imageNode) return null;

      const decoded = await new Promise<{ topBand: number[]; gapBand: number[]; repeatedBand: number[] }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            topBand: Array.from(ctx.getImageData(1, 1, 1, 1).data),
            gapBand: Array.from(ctx.getImageData(1, 6, 1, 1).data),
            repeatedBand: Array.from(ctx.getImageData(1, 9, 1, 1).data),
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted background image"));
        img.src = imageNode.dataUrl;
      });

      return decoded;
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.topBand[0]).toBeGreaterThan(200);
    expect(extracted?.topBand[3]).toBe(255);
    expect(extracted?.gapBand[3]).toBe(0);
    expect(extracted?.repeatedBand[0]).toBeGreaterThan(200);
    expect(extracted?.repeatedBand[3]).toBe(255);
  });

  test("extracts CSS background-image SVG data URL as vector geometry", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="blue"/></svg>');

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:100px;background-image:url('${SVG_BG}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // SVG background should produce polygon geometry (from rect), not an image node
    const polygonNodes = ir.filter((n: any) => n.type === "polygon");
    // Should have at least the element's own polygon + the SVG rect polygon
    expect(polygonNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("rasterizes CSS background-image SVG data URL when element effects require an image layer", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml," +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="black"/></svg>');

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;background:black;">
        <div id="target" style="width:100px;height:100px;background-image:url('${SVG_BG}');background-size:cover;filter:invert(1);"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polygonNodes = ir.filter((n: any) => n.type === "polygon" || n.type === "polyline");

    expect(imageNodes.length).toBeGreaterThan(0);
    expect(imageNodes[0].dataUrl).toMatch(/^data:image\//);
    expect(polygonNodes.length).toBe(1);
  });

  test("rasterized CSS background-image SVG preserves percentage-sized SVG viewport sizing", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 500 200" preserveAspectRatio="none"><rect x="400" y="0" width="100" height="200" fill="black"/></svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:200px;height:80px;background-image:url('${SVG_BG}');background-repeat:no-repeat;filter:invert(1);"></div>
      </body></html>`
    );

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
      const imageNode = ir.find((node: any) => node.type === "image");
      if (!imageNode) return null;

      return new Promise<{ rightAlpha: number; midAlpha: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            rightAlpha: ctx.getImageData(190, 40, 1, 1).data[3],
            midAlpha: ctx.getImageData(150, 40, 1, 1).data[3],
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted background image"));
        img.src = imageNode.dataUrl;
      });
    });

    expect(extracted).not.toBeNull();
    expect(extracted?.rightAlpha).toBeGreaterThan(200);
    expect(extracted?.midAlpha).toBe(0);
  });

  test("extracts quoted background-image SVG data URL with embedded quotes", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml,<svg focusable=\\\"false\\\" xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 100 100\\\"><rect width=\\\"100\\\" height=\\\"100\\\" fill=\\\"%2300f\\\"></rect></svg>";

    await setupPage(
      page,
      `<html><head><style>
        #target {
          width: 100px;
          height: 100px;
          background-image: url("${SVG_BG}");
          background-size: cover;
        }
      </style></head><body style="margin:0;padding:0;">
        <div id="target"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const polygonNodes = ir.filter((n: any) => n.type === "polygon");
    expect(polygonNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("extracts CSS-escaped background-image SVG data URL as vector geometry", async ({ page }) => {
    const SVG_BG = "data:image/svg+xml,\\00003csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'\\00003e\\00003crect width='100' height='100' fill='%2300f'/\\00003e\\00003c/svg\\00003e";

    await setupPage(
      page,
      `<html><head><style>
        #target {
          width: 100px;
          height: 100px;
          background-image: url("${SVG_BG}");
          background-size: cover;
        }
      </style></head><body style="margin:0;padding:0;">
        <div id="target"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    const polygonNodes = ir.filter((n: any) => n.type === "polygon");
    expect(polygonNodes.length).toBeGreaterThanOrEqual(2);
    expect(ir.some((n: any) => n.type === "image")).toBe(false);
  });

  test("does NOT extract background-image when includeImages is false", async ({ page }) => {
    const RED_PIXEL_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADklEQVQIW2P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==";

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div id="target" style="width:100px;height:100px;background-image:url('${RED_PIXEL_DATA_URL}');background-size:cover;"></div>
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: false,
        includeText: false,
      });
    });

    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(imageNodes.length).toBe(0);
  });

  test("extracts leaf masked elements as image IR nodes instead of solid boxes", async ({ page }) => {
    const MASK_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" fill="black"/></svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <span id="target" style="display:block;width:20px;height:20px;background-color:rgb(32, 33, 34);mask-image:url('${MASK_SVG}');-webkit-mask-image:url('${MASK_SVG}');mask-position:center;-webkit-mask-position:center;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat;mask-size:20px;-webkit-mask-size:20px;"></span>
      </body></html>`
    );

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      const imageNode = ir.find((node: any) => node.type === "image");
      const polygonCount = ir.filter((node: any) => node.type === "polygon").length;
      if (!imageNode) {
        return { imageCount: 0, polygonCount, samples: null };
      }

      const samples = await new Promise<{ center: number[]; corner: number[] }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            center: Array.from(ctx.getImageData(10, 10, 1, 1).data),
            corner: Array.from(ctx.getImageData(1, 1, 1, 1).data),
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted masked element"));
        img.src = imageNode.dataUrl;
      });

      return {
        imageCount: ir.filter((node: any) => node.type === "image").length,
        polygonCount,
        samples,
      };
    });

    expect(extracted.imageCount).toBe(1);
    expect(extracted.polygonCount).toBe(0);
    expect(extracted.samples).not.toBeNull();
    expect(extracted.samples?.center[3]).toBeGreaterThan(200);
    expect(extracted.samples?.center[0]).toBeLessThan(80);
    expect(extracted.samples?.center[1]).toBeLessThan(80);
    expect(extracted.samples?.center[2]).toBeLessThan(80);
    expect(extracted.samples?.corner[3]).toBe(0);
  });

  test("extracts masked elements when computed mask-image contains escaped SVG quotes", async ({ page }) => {
    const UTF8_MASK_SVG = 'data:image/svg+xml;utf8,<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 20 20\\"><circle cx=\\"10\\" cy=\\"10\\" r=\\"6\\" fill=\\"black\\"/></svg>';

    await setupPage(
      page,
      `<html><head><style>
        #target {
          display: block;
          width: 20px;
          height: 20px;
          background-color: rgb(32, 33, 34);
          mask-image: url("${UTF8_MASK_SVG}");
          -webkit-mask-image: url("${UTF8_MASK_SVG}");
          mask-position: center;
          -webkit-mask-position: center;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
          mask-size: 20px;
          -webkit-mask-size: 20px;
        }
      </style></head><body style="margin:0;padding:0;">
        <span id="target"></span>
      </body></html>`
    );

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target") as HTMLElement;

      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });

      return {
        imageCount: ir.filter((node: any) => node.type === "image").length,
        polygonCount: ir.filter((node: any) => node.type === "polygon").length,
      };
    });

    expect(extracted.imageCount).toBe(1);
    expect(extracted.polygonCount).toBe(0);
  });

  test("extracts pseudo-element background images through the image pipeline", async ({ page }) => {
    await setupPage(
      page,
      `<html><head><style>
        #target {
          width: 20px;
          height: 20px;
        }
        #target::before {
          content: "";
          display: block;
          width: 20px;
          height: 20px;
          background-image: url('${RED_PIXEL_PNG}');
          background-repeat: no-repeat;
          background-size: cover;
        }
      </style></head><body style="margin:0;padding:0;">
        <div id="target"></div>
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
    expect(summary.polygonCount).toBeLessThanOrEqual(1);
  });

  test("extracts masked pseudo-elements through the image pipeline", async ({ page }) => {
    const MASK_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M4 7l6 6 6-6" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );

    await setupPage(
      page,
      `<html><head><style>
        #target {
          position: relative;
          width: 24px;
          height: 24px;
        }
        #target::after {
          content: "";
          display: block;
          width: 20px;
          height: 20px;
          background-color: rgb(32, 33, 34);
          mask-image: url('${MASK_SVG}');
          -webkit-mask-image: url('${MASK_SVG}');
          mask-position: center;
          -webkit-mask-position: center;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
          mask-size: 20px;
          -webkit-mask-size: 20px;
        }
      </style></head><body style="margin:0;padding:0;">
        <div id="target"></div>
      </body></html>`
    );

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
        includePseudoElements: true,
      });

      const imageNode = ir.find((node: any) => node.type === "image");
      const fallbackPolygonCount = ir.filter((node: any) => {
        if (node.type !== "polygon") return false;
        const width = Math.round(Math.abs(node.points[1].x - node.points[0].x));
        const height = Math.round(Math.abs(node.points[3].y - node.points[0].y));
        return node.style?.fill === "rgb(32, 33, 34)" && width === 20 && height === 20;
      }).length;

      if (!imageNode) {
        return { imageCount: 0, fallbackPolygonCount, samples: null };
      }

      const samples = await new Promise<{ center: number[]; corner: number[] }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          resolve({
            center: Array.from(ctx.getImageData(10, 10, 1, 1).data),
            corner: Array.from(ctx.getImageData(1, 1, 1, 1).data),
          });
        };
        img.onerror = () => reject(new Error("failed to decode extracted masked pseudo element"));
        img.src = imageNode.dataUrl;
      });

      return {
        imageCount: ir.filter((node: any) => node.type === "image").length,
        fallbackPolygonCount,
        samples,
      };
    });

    expect(extracted.imageCount).toBe(1);
    expect(extracted.fallbackPolygonCount).toBe(0);
    expect(extracted.samples).not.toBeNull();
    expect(extracted.samples?.center[3]).toBeGreaterThan(0);
    expect(extracted.samples?.corner[3]).toBe(0);
  });

  test("skips masked pseudo-elements when the mask asset cannot be loaded", async ({ page }) => {
    await setupPage(
      page,
      `<html><head><style>
        #target {
          position: relative;
          width: 16px;
          height: 16px;
        }
        #target::after {
          content: "";
          display: block;
          width: 12px;
          height: 12px;
          background-color: rgb(51, 102, 204);
          mask-image: url('file:///__html-converter-tests__/missing-arrow.svg');
          -webkit-mask-image: url('file:///__html-converter-tests__/missing-arrow.svg');
          mask-position: center;
          -webkit-mask-position: center;
          mask-repeat: no-repeat;
          -webkit-mask-repeat: no-repeat;
          mask-size: 12px;
          -webkit-mask-size: 12px;
        }
      </style></head><body style="margin:0;padding:0;">
        <div id="target"></div>
      </body></html>`
    );

    const extracted = await page.evaluate(async () => {
      const el = document.getElementById("target")!;
      const ir = await (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
        includePseudoElements: true,
      });

      const fallbackPolygonCount = ir.filter((node: any) => {
        if (node.type !== "polygon") return false;
        const width = Math.round(Math.abs(node.points[1].x - node.points[0].x));
        const height = Math.round(Math.abs(node.points[3].y - node.points[0].y));
        return node.style?.fill === "rgb(51, 102, 204)" && width === 12 && height === 12;
      }).length;

      return {
        imageCount: ir.filter((node: any) => node.type === "image").length,
        fallbackPolygonCount,
      };
    });

    expect(extracted.imageCount).toBe(0);
    expect(extracted.fallbackPolygonCount).toBe(0);
  });

  test("hasBackgroundImage utility works", async ({ page }) => {
    await setupPage(
      page,
      `<html><body>
        <div id="bg" style="background-image:url('data:image/png;base64,AAAA');width:10px;height:10px;"></div>
        <div id="grad" style="background-image:linear-gradient(red,blue);width:10px;height:10px;"></div>
        <div id="none" style="width:10px;height:10px;"></div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const hc = (window as any).__HC;
      return {
        bgHasImage: hc.hasBackgroundImage({ backgroundImage: "url('data:image/png;base64,AAAA')" }),
        gradHasImage: hc.hasBackgroundImage({ backgroundImage: "linear-gradient(red, blue)" }),
        noneHasImage: hc.hasBackgroundImage({ backgroundImage: "none" }),
        emptyHasImage: hc.hasBackgroundImage({}),
      };
    });

    expect(result.bgHasImage).toBe(true);
    expect(result.gradHasImage).toBe(false);
    expect(result.noneHasImage).toBe(false);
    expect(result.emptyHasImage).toBe(false);
  });

  test("SVG with root evenodd + multi-subpath paths is rasterized (MultipleSignalLamp)", async ({ page }) => {
    // MultipleSignalLamp SVG: root has fill-rule:evenodd, paths have multiple subpaths (M commands)
    // => evenodd matters for rendering, so it must be rasterized, not vectorized
    const MULTI_SUBPATH_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" style="fill-rule:evenodd;clip-rule:evenodd;">' +
      '<path d="M303,100C398,100 475,183 475,286C475,388 398,471 303,471C208,471 131,388 131,286C131,183 208,100 303,100Z' +
      'M181,178C158,207 145,245 145,286C145,327 158,364 181,394L289,286L181,178Z" style="fill:rgb(6,0,0);"/>' +
      '</svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${MULTI_SUBPATH_SVG}" style="width:120px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeImages: true, includeText: false });
    });

    // Should be rasterized as image (not vector), because evenodd + multi-subpath
    const imageNodes = ir.filter((n: any) => n.type === "image");
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");
    expect(imageNodes.length).toBeGreaterThan(0);
    expect(polylineNodes.length).toBe(0);
  });

  test("SVG with root evenodd + simple shapes is vectorized (PhotoelectricProximitySensor)", async ({ page }) => {
    // SVG with fill-rule:evenodd on root but only simple shapes (single-subpath paths, rect, ellipse)
    // => evenodd doesn't matter, safe to vectorize
    const SIMPLE_SVG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 200" style="fill-rule:evenodd;clip-rule:evenodd;">' +
      '<ellipse cx="400" cy="110" rx="85" ry="78" style="fill:none;stroke:black;stroke-width:7px;"/>' +
      '<path d="M141,101L141,104L5,101L141,98L141,101L305,101L305,101L141,101Z"/>' +
      '<rect x="4" y="5" width="4" height="190"/>' +
      '</svg>'
    );

    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <img id="target" src="${SIMPLE_SVG}" style="width:200px;height:80px;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, { includeImages: true, includeText: false });
    });

    // Should be vectorized (polygon/polyline), NOT rasterized
    const vectorNodes = ir.filter((n: any) => n.type === "polygon" || n.type === "polyline");
    const imageNodes = ir.filter((n: any) => n.type === "image");
    expect(vectorNodes.length).toBeGreaterThan(0);
    expect(imageNodes.length).toBe(0);
  });

  test("SVG in img tag produces geometry at correct position", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:0;">
        <div style="height:50px;"></div>
        <img id="target" src="${SVG_CIRCLE_DATA_URL}" style="width:100px;height:100px;display:block;" />
      </body></html>`
    );

    const ir = await page.evaluate(() => {
      const el = document.getElementById("target")!;
      return (window as any).__HC.extractIR(el, {
        includeImages: true,
        includeText: false,
      });
    });

    // The SVG geometry should be positioned below the 50px spacer
    const polylineNodes = ir.filter((n: any) => n.type === "polyline");
    if (polylineNodes.length > 0) {
      // At least some points should be below y=50
      const hasPointsBelowSpacer = polylineNodes.some((n: any) =>
        n.points.some((p: any) => p.y >= 50)
      );
      expect(hasPointsBelowSpacer).toBe(true);
    }
  });
});
