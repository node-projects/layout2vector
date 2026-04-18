import { test, expect } from "@playwright/test";
import { setupPage } from "../helpers.js";

test.describe("Form control conversion", () => {
  test("is opt-in and preserves control values and states", async ({ page }) => {
    await setupPage(
      page,
      `<html><body style="margin:0;padding:24px;font-family:Arial,sans-serif;">
        <input id="text-input" type="text" value="Alice Johnson">
        <input id="search-input" type="search" placeholder="Search projects">
        <textarea id="textarea" rows="3" cols="18">First line\nSecond line</textarea>
        <textarea id="textarea-placeholder" rows="3" cols="18" placeholder="Add release notes"></textarea>
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
        searchInput: await summarize("search-input"),
        textarea: await summarize("textarea"),
        textareaPlaceholder: await summarize("textarea-placeholder"),
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
    expect(summary.searchInput.texts).toContain("Search projects");
    expect(summary.textarea.texts.join(" ")).toContain("First line");
    expect(summary.textarea.texts.join(" ")).toContain("Second line");
    expect(summary.textareaPlaceholder.texts).toContain("Add release notes");

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

  test("uses placeholder pseudo styles and avoids inventing boxes for transparent proxy textareas", async ({ page }) => {
    await setupPage(
      page,
      `<html><head><style>
        #proxy {
          width: 240px;
          height: 56px;
          padding: 8px 12px;
          background: transparent;
          border: 0;
          border-radius: 6px 6px 0 0;
          color: transparent;
          resize: none;
          box-sizing: border-box;
        }
        #proxy::placeholder {
          color: rgb(145, 152, 161);
          opacity: 1;
          font-style: italic;
        }
      </style></head><body style="margin:0;padding:24px;background:rgb(13, 17, 23);font-family:Arial,sans-serif;">
        <textarea id="proxy" placeholder="Ask anything or type @ to add context"></textarea>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const HC = (window as any).__HC;
      const el = document.getElementById("proxy")!;
      const ir = await HC.extractIR(el, {
        includeText: true,
        convertFormControls: true,
      });

      return {
        polygons: ir.filter((node: any) => node.type === "polygon"),
        texts: ir.filter((node: any) => node.type === "text"),
      };
    });

    expect(summary.polygons).toHaveLength(0);
    expect(summary.texts.length).toBeGreaterThan(0);
    expect(summary.texts.map((node: any) => node.text).join(" ")).toContain("Ask anything or type @ to add context");
    expect(summary.texts[0].style.color).toBe("rgb(145, 152, 161)");
    expect(summary.texts[0].style.fontStyle).toBe("italic");
  });

  test("does not invent a fallback box when a transparent textarea only contributes visible text", async ({ page }) => {
    await setupPage(
      page,
      `<html><head><style>
        #search-proxy {
          width: 240px;
          height: 56px;
          padding: 8px 12px;
          background: transparent;
          border: 0;
          box-sizing: border-box;
          color: rgb(232, 234, 237);
          resize: none;
        }
      </style></head><body style="margin:0;padding:24px;background:rgb(31, 31, 31);font-family:Arial,sans-serif;">
        <textarea id="search-proxy">google</textarea>
      </body></html>`
    );

    const summary = await page.evaluate(async () => {
      const HC = (window as any).__HC;
      const el = document.getElementById("search-proxy")!;
      const ir = await HC.extractIR(el, {
        includeText: true,
        convertFormControls: true,
      });

      return {
        polygons: ir.filter((node: any) => node.type === "polygon"),
        texts: ir.filter((node: any) => node.type === "text"),
      };
    });

    expect(summary.polygons).toHaveLength(0);
    expect(summary.texts).toHaveLength(1);
    expect(summary.texts[0].text).toBe("google");
    expect(summary.texts[0].style.color).toBe("rgb(232, 234, 237)");
  });
});