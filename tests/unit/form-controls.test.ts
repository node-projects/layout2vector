import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("Form control conversion", () => {
  test("is opt-in and preserves control values and states", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:24px;font-family:Arial,sans-serif;">
        <input id="text-input" type="text" value="Alice Johnson">
        <textarea id="textarea" rows="3" cols="18">First line\nSecond line</textarea>
        <input id="checkbox" type="checkbox" checked>
        <input id="checkbox-mixed" type="checkbox">
        <input id="radio" type="radio" checked>
        <select id="select">
          <option>Option A</option>
          <option selected>Option B</option>
        </select>
        <progress id="progress" value="65" max="100"></progress>
        <input id="date" type="date" value="2026-04-13">
        <input id="time" type="time" value="14:35">
        <input id="datetime" type="datetime-local" value="2026-04-13T14:35">
        <input id="month" type="month" value="2026-04">
        <input id="week" type="week" value="2026-W16">
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const HC = (window as any).__HC;
      (document.getElementById("checkbox-mixed") as HTMLInputElement).indeterminate = true;

      async function summarize(id: string, convertFormControls = true) {
        const el = document.getElementById(id)!;
        const ir = await HC.extractIR(el, {
          includeText: true,
          convertFormControls,
        });

        return {
          texts: ir.filter((node: any) => node.type === "text").map((node: any) => node.text),
          polygonCount: ir.filter((node: any) => node.type === "polygon").length,
          closedPolylines: ir.filter((node: any) => node.type === "polyline" && node.closed).length,
          openPolylinePointCounts: ir
            .filter((node: any) => node.type === "polyline" && !node.closed)
            .map((node: any) => node.points.length),
        };
      }

      return {
        gated: await summarize("text-input", false),
        textInput: await summarize("text-input"),
        textarea: await summarize("textarea"),
        checkbox: await summarize("checkbox"),
        checkboxMixed: await summarize("checkbox-mixed"),
        radio: await summarize("radio"),
        select: await summarize("select"),
        progress: await summarize("progress"),
        date: await summarize("date"),
        time: await summarize("time"),
        datetime: await summarize("datetime"),
        month: await summarize("month"),
        week: await summarize("week"),
      };
    });

    expect(summary.gated.texts).not.toContain("Alice Johnson");

    expect(summary.textInput.texts).toContain("Alice Johnson");
    expect(summary.textarea.texts.join(" ")).toContain("First line");
    expect(summary.textarea.texts.join(" ")).toContain("Second line");

    expect(summary.checkbox.openPolylinePointCounts).toContain(3);
    expect(summary.checkboxMixed.polygonCount).toBeGreaterThanOrEqual(2);
    expect(summary.radio.closedPolylines).toBeGreaterThanOrEqual(2);

    expect(summary.select.texts).toContain("Option B");
    expect(summary.select.openPolylinePointCounts).toContain(3);

    expect(summary.progress.polygonCount).toBeGreaterThanOrEqual(2);
    expect(summary.progress.texts).toContain("65%");

    expect(summary.date.texts).toContain("2026-04-13");
    expect(summary.time.texts).toContain("14:35");
    expect(summary.datetime.texts).toContain("2026-04-13 14:35");
    expect(summary.month.texts).toContain("2026-04");
    expect(summary.week.texts).toContain("2026-W16");
  });
});