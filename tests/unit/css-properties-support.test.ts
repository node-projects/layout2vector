import { expect, test } from "@playwright/test";
import { setupPage } from "../helpers.js";
import { renderIR } from "../../src/pipeline.js";
import { HTMLWriter } from "../../src/writers/html-writer.js";
import { SVGWriter } from "../../src/writers/svg-writer.js";
import type { IRNode, Quad } from "../../src/types.js";

test.describe("CSS property support", () => {
  test("extractIR carries requested visual and text styles", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:24px;background:#f7f1e8;">
        <div id="visual" style="width:180px;height:120px;background:linear-gradient(135deg, rgb(255, 202, 58), rgb(251, 133, 0));outline:4px dashed rgb(2, 48, 71);outline-offset:8px;filter:drop-shadow(0 12px 20px rgba(2, 48, 71, 0.35));mix-blend-mode:multiply;mask:radial-gradient(circle at 35% 35%, rgb(0, 0, 0) 0 38%, rgba(0, 0, 0, 0) 60%) center / 100% 100% no-repeat;-webkit-mask:radial-gradient(circle at 35% 35%, rgb(0, 0, 0) 0 38%, rgba(0, 0, 0, 0) 60%) center / 100% 100% no-repeat;transform:rotate(-6deg) skewX(-8deg);transform-origin:top left;"></div>
        <p id="text" style="margin:48px 0 0;width:240px;color:rgb(108, 24, 48);font-family:Georgia, 'Times New Roman', serif;font-size:29px;font-weight:700;font-style:italic;line-height:44px;letter-spacing:2px;word-spacing:6px;text-align:justify;text-decoration:underline;text-transform:uppercase;text-indent:48px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">styled
text withlongtoken</p>
        <p id="textSingle" style="margin:24px 0 0;width:240px;color:rgb(108, 24, 48);font-family:Georgia, 'Times New Roman', serif;font-size:29px;font-weight:700;font-style:italic;line-height:44px;letter-spacing:2px;word-spacing:6px;text-align:justify;text-decoration:underline;text-transform:uppercase;text-indent:48px;white-space:nowrap;word-break:break-word;overflow-wrap:anywhere;">single line sample</p>
        <p id="ellipsis" style="margin:24px 0 0;width:150px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">This is intentionally much longer than the card width.</p>
        <div id="vertical" style="margin-top:24px;height:180px;width:88px;color:rgb(38, 70, 83);font:600 24px/1.2 'Segoe UI', sans-serif;direction:rtl;writing-mode:vertical-rl;transform:rotate(4deg);transform-origin:top left;">RTL FLOW</div>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const extract = (window as any).__HC.extractIR;
      const visualIr = await extract(document.getElementById("visual"), { boxType: "border", includeText: false });
      const textIr = await extract(document.getElementById("text"), { boxType: "border", includeText: true });
      const textSingleIr = await extract(document.getElementById("textSingle"), { boxType: "border", includeText: true });
      const ellipsisIr = await extract(document.getElementById("ellipsis"), { boxType: "border", includeText: true });
      const verticalIr = await extract(document.getElementById("vertical"), { boxType: "border", includeText: true });

      const visualNode = visualIr.find((node: any) => node.type === "polygon");
      const textNode = textIr.find((node: any) => node.type === "text");
      const textSingleNode = textSingleIr.find((node: any) => node.type === "text");
      const ellipsisNode = ellipsisIr.find((node: any) => node.type === "text");
      const verticalNode = verticalIr.find((node: any) => node.type === "text");

      return {
        visualStyle: visualNode?.style,
        textStyle: textNode?.style,
        textSingleStyle: textSingleNode?.style,
        ellipsisStyle: ellipsisNode?.style,
        verticalStyle: verticalNode?.style,
      };
    });

    expect(summary.visualStyle.outlineWidth).toBe("4px");
    expect(summary.visualStyle.outlineOffset).toBe("8px");
    expect(summary.visualStyle.filter).toContain("drop-shadow");
    expect(summary.visualStyle.mixBlendMode).toBe("multiply");
    expect(summary.visualStyle.mask).toBeTruthy();

    expect(summary.textStyle.color).toBe("rgb(108, 24, 48)");
    expect(summary.textStyle.fontSize).toBe("29px");
    expect(summary.textStyle.fontWeight).toBe("700");
    expect(summary.textStyle.fontStyle).toBe("italic");
    expect(summary.textStyle.lineHeight).toBe("44px");
    expect(summary.textStyle.letterSpacing).toBe("2px");
    expect(summary.textStyle.wordSpacing).toBe("6px");
    expect(summary.textStyle.textDecoration).toContain("underline");
    expect(summary.textStyle.textTransform).toBe("uppercase");
    expect(["pre-wrap", "pre"]).toContain(summary.textStyle.whiteSpace);
    expect(summary.textStyle.wordBreak).toBe("break-word");
    expect(summary.textStyle.overflowWrap).toBe("anywhere");

    expect(summary.textSingleStyle.textAlign).toBe("justify");
    expect(summary.textSingleStyle.textIndent).toBe("48px");

    expect(summary.ellipsisStyle.textOverflow).toBe("ellipsis");
    expect(summary.ellipsisStyle.whiteSpace).toBe("nowrap");
    expect(summary.verticalStyle.direction).toBe("rtl");
    expect(summary.verticalStyle.writingMode).toBe("vertical-rl");
  });

  test("HTML writer emits carried CSS properties for transformed boxes and text", async () => {
    const polygonPoints: Quad = [
      { x: 24, y: 18 },
      { x: 176, y: 34 },
      { x: 156, y: 146 },
      { x: 4, y: 130 },
    ];
    const textQuad: Quad = [
      { x: 28, y: 170 },
      { x: 188, y: 170 },
      { x: 188, y: 214 },
      { x: 28, y: 214 },
    ];

    const nodes: IRNode[] = [
      {
        type: "polygon",
        points: polygonPoints,
        style: {
          fill: "rgb(255, 244, 214)",
          borderRadius: "18px",
          outlineColor: "rgb(10, 20, 30)",
          outlineWidth: "4px",
          outlineStyle: "dashed",
          outlineOffset: "6px",
          filter: "blur(1px)",
          mixBlendMode: "multiply",
          mask: "radial-gradient(circle, rgb(0, 0, 0) 55%, rgba(0, 0, 0, 0) 72%)",
        },
        zIndex: 0,
      },
      {
        type: "text",
        quad: textQuad,
        text: "Styled preview",
        style: {
          color: "rgb(12, 34, 56)",
          fontFamily: "Georgia, serif",
          fontSize: "28px",
          fontWeight: "700",
          fontStyle: "italic",
          lineHeight: "36px",
          letterSpacing: "2px",
          wordSpacing: "4px",
          textDecoration: "underline",
          whiteSpace: "pre",
          direction: "rtl",
          writingMode: "vertical-rl",
          filter: "grayscale(1)",
          mixBlendMode: "screen",
          mask: "linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0.25))",
        },
        zIndex: 1,
      },
    ];

    const writer = new HTMLWriter({ width: 240, height: 240 });
    const html = await renderIR(nodes, writer);

    expect(html).toContain("transform:matrix(");
    expect(html).toContain("outline:4px dashed rgb(10, 20, 30)");
    expect(html).toContain("outline-offset:6px");
    expect(html).toContain("filter:blur(1px)");
    expect(html).toContain("mix-blend-mode:multiply");
    expect(html).toContain("mask:radial-gradient");
    expect(html).toContain("-webkit-mask:radial-gradient");

    expect(html).toContain("letter-spacing:2px");
    expect(html).toContain("word-spacing:4px");
    expect(html).toContain("writing-mode:vertical-rl");
    expect(html).toContain("direction:rtl");
    expect(html).toContain("filter:grayscale(1)");
    expect(html).toContain("mix-blend-mode:screen");
    expect(html).toContain("-webkit-mask:linear-gradient");
  });

  test("SVG writer emits native writing-mode and direction attributes for text", async () => {
    const textQuad: Quad = [
      { x: 20, y: 24 },
      { x: 52, y: 24 },
      { x: 52, y: 204 },
      { x: 20, y: 204 },
    ];

    const nodes: IRNode[] = [{
      type: "text",
      quad: textQuad,
      text: "VERTICAL",
      style: {
        color: "rgb(12, 34, 56)",
        fontFamily: "Georgia, serif",
        fontSize: "28px",
        fontWeight: "700",
        direction: "rtl",
        writingMode: "vertical-rl",
      },
      zIndex: 0,
    }];

    const writer = new SVGWriter({ width: 120, height: 240 });
    const svg = await renderIR(nodes, writer);

    expect(svg).toContain('writing-mode="vertical-rl"');
    expect(svg).toContain('direction="rtl"');
    expect(svg).toContain('unicode-bidi="embed"');
  });

  test("SVG writer emits a conic-gradient pattern fallback", async () => {
    const nodes: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 20, y: 20 },
        { x: 180, y: 20 },
        { x: 180, y: 140 },
        { x: 20, y: 140 },
      ],
      style: {
        fill: "rgb(255, 0, 0)",
        backgroundImage: "conic-gradient(from 45deg, rgb(255, 0, 0) 0%, rgb(255, 255, 0) 30%, rgb(0, 128, 255) 70%, rgb(255, 0, 0) 100%)",
        borderRadius: "24px",
      },
      zIndex: 0,
    }];

    const writer = new SVGWriter({ width: 220, height: 180 });
    const svg = await renderIR(nodes, writer);

    expect(svg).toContain("<pattern id=\"cg");
    expect(svg).toContain("fill=\"url(#cg");
    expect(svg).toContain("A");
  });

  test("SVG writer emits a repeating-conic pattern fallback", async () => {
    const nodes: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 30, y: 20 },
        { x: 170, y: 20 },
        { x: 170, y: 160 },
        { x: 30, y: 160 },
      ],
      style: {
        fill: "rgb(11, 57, 84)",
        backgroundImage: "repeating-conic-gradient(from 30deg, rgb(11, 57, 84) 0%, rgb(11, 57, 84) 10%, rgb(191, 215, 234) 10%, rgb(191, 215, 234) 20%, rgb(255, 102, 99) 20%, rgb(255, 102, 99) 30%)",
        borderRadius: "70px",
      },
      zIndex: 0,
    }];

    const writer = new SVGWriter({ width: 220, height: 180 });
    const svg = await renderIR(nodes, writer);

    expect(svg).toContain('<pattern id="cg');
    expect(svg).toContain('patternContentUnits="userSpaceOnUse"');
    expect(svg).toContain("fill=\"url(#cg");
  });

  test("SVG writer stacks multiple background gradients bottom-to-top", async () => {
    const nodes: IRNode[] = [{
      type: "polygon",
      points: [
        { x: 20, y: 20 },
        { x: 180, y: 20 },
        { x: 180, y: 180 },
        { x: 20, y: 180 },
      ],
      style: {
        fill: "rgb(232, 232, 232)",
        backgroundImage: "radial-gradient(circle, rgb(255, 255, 255) 0%, rgb(255, 255, 255) 42%, rgba(0, 0, 0, 0) 43%), conic-gradient(from 210deg, rgba(15, 76, 117, 0.15) 0%, rgb(15, 76, 117) 18%, rgb(50, 130, 184) 44%, rgb(187, 225, 250) 72%, rgba(15, 76, 117, 0.15) 100%)",
        borderRadius: "80px",
      },
      zIndex: 0,
    }];

    const writer = new SVGWriter({ width: 220, height: 220 });
    const svg = await renderIR(nodes, writer);

    expect(svg).toContain('<radialGradient id="rg');
    expect(svg).toContain('<pattern id="cg');
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});