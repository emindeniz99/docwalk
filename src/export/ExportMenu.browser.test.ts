import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { ExportMenu, STATUS_FADE_MS, type ExportMenuProps } from "./ExportMenu";
import type { ExportOptions } from "./types";

// The exporters have their own tests (export.browser.test.ts); here only the
// menu's status matters, so the HTML build and the download are stubbed.
vi.mock("./html", () => ({
  exportHtml: vi.fn<() => Promise<Blob>>(async () => new Blob(["<!doctype html>"])),
}));
vi.mock("./download", () => ({ downloadBlob: vi.fn<() => void>() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  await page.viewport(1280, 800);
});

const options = (): ExportOptions => ({
  // A long title, so the "Downloaded <file>" message is wider than the space left of the button.
  title: "Ledgerline quarterly review and planning notes",
  slides: [{ address: "a/1", title: "A", element: document.createElement("section") }],
  size: { width: 1280, height: 720 },
});

/** The header the way App lays it out on a phone, with the Source/Preview switch under it. */
function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      h(
        "div",
        null,
        h(
          "header",
          { className: "docwalk-toolbar" },
          h(
            "div",
            { className: "docwalk-toolbar-actions" },
            h("button", { className: "docwalk-button" }, "Open"),
            h(ExportMenu, { getOptions: options }),
            h("button", { className: "docwalk-button" }, "More"),
          ),
        ),
        h(
          "button",
          { "data-testid": "source", style: { width: "100%", height: "44px" } },
          "Source",
        ),
      ),
    ),
  );
  return container;
}

async function exportHtml(el: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(el.querySelector<HTMLElement>(".docwalk-export-trigger")!);
  await userEvent.click(page.getByRole("menuitem", { name: "Download HTML" }));
  const status = el.querySelector<HTMLElement>('[role="status"]')!;
  await expect.poll(() => status.textContent).toMatch(/^Downloaded /);
  return status;
}

describe("export status on a phone", () => {
  // The pill floats over the controls under the header. It once stayed there
  // for good, with its start cut off by the screen edge, and ate taps meant
  // for the Source/Preview switch.
  test("the whole message is on screen", async () => {
    const status = await exportHtml(mount());
    const box = status.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
  });

  test("a tap on the pill reaches the control under it", async () => {
    const el = mount();
    const status = await exportHtml(el);
    const box = status.getBoundingClientRect();
    const source = el.querySelector<HTMLElement>('[data-testid="source"]')!;
    const under = source.getBoundingClientRect();
    expect(box.bottom).toBeGreaterThan(under.top);
    const x = box.left + box.width / 2;
    const y = (Math.max(box.top, under.top) + box.bottom) / 2;
    expect(document.elementFromPoint(x, y)).toBe(source);
  });

  test("a finished download's message clears itself; the live region stays for the next one", async () => {
    const el = mount();
    const status = await exportHtml(el);
    await expect
      .poll(() => status.textContent, { timeout: STATUS_FADE_MS + 2000, interval: 250 })
      .toBe("");
    expect(el.querySelector('[role="status"]')).toBe(status);
  });
});

const trigger = (el: HTMLElement) => el.querySelector<HTMLElement>(".docwalk-export-trigger")!;
const names = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.textContent);

function mountWith(getOptions: ExportMenuProps["getOptions"], hasNotes = false): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(ExportMenu, { getOptions, hasNotes })));
  return container;
}

describe("Print with speaker notes (decision 114)", () => {
  test("the item shows only while the document has notes", async () => {
    const without = mountWith(() => null);
    await userEvent.click(trigger(without));
    expect(names()).toEqual(["Print or save as PDF", "Download HTML", "Download PNG images"]);
    await userEvent.keyboard("{Escape}");
    act(() => root?.unmount());
    document.body.replaceChildren();

    const withNotes = mountWith(() => null, true);
    await userEvent.click(trigger(withNotes));
    expect(names()).toEqual([
      "Print or save as PDF",
      "Print with speaker notes",
      "Download HTML",
      "Download PNG images",
    ]);
    for (const item of document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      expect(item.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  test("only that item asks for notes; Print, HTML and PNG never do, and nothing remembers it", async () => {
    const asked = vi.fn<ExportMenuProps["getOptions"]>(() => null);
    const el = mountWith(asked, true);
    const pick = async (name: string) => {
      await userEvent.click(trigger(el));
      await userEvent.click(page.getByRole("menuitem", { name }));
    };
    await pick("Print with speaker notes");
    expect(asked).toHaveBeenLastCalledWith(false, true);
    // A job, not a setting: the next jobs carry no notes.
    for (const name of ["Print or save as PDF", "Download HTML", "Download PNG images"]) {
      await pick(name);
      expect(asked).toHaveBeenLastCalledWith(false, false);
    }
    await pick("Print with speaker notes");
    expect(asked).toHaveBeenLastCalledWith(false, true);
    expect(asked).toHaveBeenCalledTimes(5);
  });
});
