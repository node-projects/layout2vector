import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("Stacking Context", () => {
  test("detects stacking context from z-index + position", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="ctx" style="position:relative;z-index:1;width:100px;height:100px;background:red;"></div>
          <div id="normal" style="width:100px;height:100px;background:blue;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);

      // Find the ctx child
      const ctxChild = tree.children.find(
        (c: any) => c.element.id === "ctx"
      );
      return {
        ctxCreatesContext: ctxChild?.createsStackingContext,
        ctxZIndex: ctxChild?.zIndex,
      };
    });

    expect(result.ctxCreatesContext).toBe(true);
    expect(result.ctxZIndex).toBe(1);
  });

  test("detects stacking context from opacity < 1", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="opaque" style="opacity:0.5;width:50px;height:50px;background:green;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);
      const child = tree.children.find(
        (c: any) => c.element.id === "opaque"
      );
      return child?.createsStackingContext;
    });

    expect(result).toBe(true);
  });

  test("detects stacking context from transform", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="transformed" style="transform:rotate(5deg);width:50px;height:50px;background:purple;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);
      const child = tree.children.find(
        (c: any) => c.element.id === "transformed"
      );
      return child?.createsStackingContext;
    });

    expect(result).toBe(true);
  });

  test("detects stacking context from isolation:isolate", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root">
          <div id="isolated" style="isolation:isolate;width:50px;height:50px;background:cyan;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);
      const child = tree.children.find(
        (c: any) => c.element.id === "isolated"
      );
      return child?.createsStackingContext;
    });

    expect(result).toBe(true);
  });

  test("respects stacking order: negative < zero < positive z-index", async ({
    page,
  }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;">
          <div id="pos" style="position:absolute;z-index:2;width:50px;height:50px;background:red;"></div>
          <div id="zero" style="position:absolute;z-index:0;width:50px;height:50px;background:green;"></div>
          <div id="neg" style="position:absolute;z-index:-1;width:50px;height:50px;background:blue;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);
      const ordered = HC.flattenStackingOrder(tree);
      return ordered.map((n: any) => n.element.id).filter((id: string) => id);
    });

    // neg should come before root, zero, then pos
    const negIdx = result.indexOf("neg");
    const zeroIdx = result.indexOf("zero");
    const posIdx = result.indexOf("pos");

    expect(negIdx).toBeLessThan(zeroIdx);
    expect(zeroIdx).toBeLessThan(posIdx);
  });

  test("z-index only applies within same stacking context", async ({
    page,
  }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;">
        <div id="root" style="position:relative;">
          <div id="ctx1" style="position:relative;z-index:1;">
            <div id="inner-high" style="position:relative;z-index:999;width:50px;height:50px;background:red;"></div>
          </div>
          <div id="ctx2" style="position:relative;z-index:2;width:50px;height:50px;background:blue;"></div>
        </div>
      </body></html>`
    );

    const result = await page.evaluate(() => {
      const HC = (window as any).__HC;
      const root = document.getElementById("root")!;
      const tree = HC.traverseDOM(root, false);
      const ordered = HC.flattenStackingOrder(tree);
      return ordered.map((n: any) => n.element.id).filter((id: string) => id);
    });

    // ctx2 (z:2) should come after ctx1 (z:1), even though inner-high has z:999
    const ctx1Idx = result.indexOf("ctx1");
    const ctx2Idx = result.indexOf("ctx2");
    expect(ctx1Idx).toBeLessThan(ctx2Idx);
  });
});
