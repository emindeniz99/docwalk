import { EditorView } from "@codemirror/view";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "./styles.css";
import { App } from "./App";
import { releaseDraft } from "./share/draft";
import { DRAFT_STORAGE_KEY } from "./share/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A short pasted draft keeps the deck small; nothing personal (AGENTS.md rule 10).
const DOC = "# Shell checks\n\n## First point\n\nAlpha.\n\n## Second point\n\nBeta.\n";

let root: Root | null = null;

beforeEach(async () => {
  // These checks are about the desktop edit view, where source and deck sit
  // side by side; a phone shows one of them at a time.
  await page.viewport(1280, 800);
  localStorage.setItem(
    DRAFT_STORAGE_KEY,
    JSON.stringify({ markdown: DOC, source: { kind: "paste" } }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  releaseDraft();
});

async function mountApp() {
  const container = document.createElement("div");
  container.style.height = "800px";
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(App)));
  await expect
    .poll(() => container.querySelector(".docwalk-statusbar")?.textContent, { timeout: 30_000 })
    .toMatch(/\d+ slides/);
  return container;
}

const byLabel = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes(text))!;

const option = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLElement>('.docwalk-outline [role="option"]')].find((o) =>
    o.textContent?.includes(text),
  )!;
const address = (el: HTMLElement) => el.querySelector(".docwalk-preview-address")?.textContent;
const markers = (el: HTMLElement) =>
  [...el.querySelectorAll(".dw-note-marker")].map((m) => m.getAttribute("title") ?? "");

describe("leaving present mode", () => {
  // Escape keeps focus on the deck; the Exit button must too, or a keyboard
  // user lands on <body>: the next Tab starts from the top and arrows stop
  // moving slides.
  test("the Exit button leaves keyboard focus on the deck, as Escape does", async () => {
    const el = await mountApp();
    await userEvent.click(button(el, "Present"));
    await expect
      .poll(() => el.querySelector(".docwalk-app")?.getAttribute("data-view"))
      .toBe("present");
    // present() focuses the deck once the fullscreen request settles; wait for it, or
    // that late focus call would hide the defect.
    await expect.poll(() => document.activeElement?.classList.contains("reveal")).toBe(true);
    const exit = el.querySelector<HTMLElement>(".docwalk-exit")!;
    act(() => exit.focus());
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => el.querySelector(".docwalk-app")?.getAttribute("data-view"))
      .toBe("edit");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".docwalk-deck-pane")).not.toBeNull();
  });

  // A phone shows source or preview, not both. Coming back to the source pane
  // would hide the deck that holds focus, and the talk the presenter just gave.
  test("on a phone, leaving present mode shows the preview pane, where focus stays", async () => {
    await page.viewport(390, 844);
    const el = await mountApp();
    const app = el.querySelector(".docwalk-app")!;
    expect(app.getAttribute("data-pane")).toBe("source");
    await userEvent.click(button(el, "Present"));
    await expect.poll(() => app.getAttribute("data-view")).toBe("present");
    await expect.poll(() => document.activeElement?.classList.contains("reveal")).toBe(true);
    await userEvent.click(el.querySelector<HTMLElement>(".docwalk-exit")!);
    await expect.poll(() => app.getAttribute("data-view")).toBe("edit");
    expect(app.getAttribute("data-pane")).toBe("preview");
    expect(document.activeElement?.closest(".docwalk-deck-pane")).not.toBeNull();
    expect(el.querySelector<HTMLElement>(".docwalk-deck-pane")!.offsetHeight).toBeGreaterThan(0);
  });

  // Present unmounts the outline and the pane switch, and Chromium resets the
  // page's scroll; the preview pane was selected but the slide sat below the
  // outline, off screen, until the presenter scrolled.
  test("on a phone, the slide is on screen after leaving present mode, not below the outline", async () => {
    await page.viewport(390, 844);
    const el = await mountApp();
    const app = el.querySelector(".docwalk-app")!;
    await userEvent.click(button(el, "Preview"));
    await expect.poll(() => app.getAttribute("data-pane")).toBe("preview");
    await userEvent.click(button(el, "Present"));
    await expect.poll(() => app.getAttribute("data-view")).toBe("present");
    await expect.poll(() => document.activeElement?.classList.contains("reveal")).toBe(true);
    await userEvent.click(el.querySelector<HTMLElement>(".docwalk-exit")!);
    await expect.poll(() => app.getAttribute("data-view")).toBe("edit");
    const slide = () =>
      el.querySelector<HTMLElement>(".docwalk-deck-pane .reveal")!.getBoundingClientRect();
    await expect.poll(() => slide().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(slide().top).toBeGreaterThanOrEqual(0);
  });
});

describe("pen marks across a deck rebuild", () => {
  const DRAW = '.docwalk-annotate-draw[data-active="true"]';
  const activeMarks = (el: HTMLElement) =>
    el.querySelector<SVGSVGElement>(`.docwalk-deck-pane ${DRAW}`)?.children.length ?? -1;

  function stroke(el: HTMLElement) {
    const svg = el.querySelector<SVGSVGElement>(`.docwalk-deck-pane ${DRAW}`)!;
    const r = svg.getBoundingClientRect();
    const at = (type: string, f: number) =>
      svg.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0.5,
          clientX: r.left + r.width * (0.2 + 0.4 * f),
          clientY: r.top + r.height * 0.5,
        }),
      );
    at("pointerdown", 0);
    for (let i = 1; i <= 8; i++) at("pointermove", i / 8);
    at("pointerup", 1);
  }

  /**
   * Waits for the deck that shows `text` and for the pen layer to sit on it.
   * A rebuild puts up the new deck first and moves the layer onto it once
   * the deck is ready, and typing that pauses past the rebuild delay
   * rebuilds more than once: a check made when the address changed could
   * still meet an earlier deck, or the new one without its layer.
   */
  async function penLayerOn(el: HTMLElement, text: string) {
    await expect
      .poll(() => el.querySelector(".docwalk-deck-pane .reveal")?.textContent ?? "", {
        timeout: 20_000,
      })
      .toContain(text);
    await expect.poll(() => activeMarks(el), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
  }

  // An edit (or an agent write, or a disk reload) rebuilds the deck while the
  // presenter is mid-talk. Marks on the slides the edit did not touch must
  // stay; marks over text that changed would point at the wrong thing.
  test("an edit keeps the marks on unchanged slides and drops them on the edited one", async () => {
    const el = await mountApp();
    await penLayerOn(el, "Beta.");
    await userEvent.click(byLabel(el, "Pen"));
    await userEvent.click(option(el, "First point"));
    await expect.poll(() => address(el)).toBe("first-point/1");
    stroke(el);
    expect(activeMarks(el)).toBe(1);
    await userEvent.click(option(el, "Second point"));
    await expect.poll(() => address(el)).toBe("second-point/1");
    stroke(el);
    expect(activeMarks(el)).toBe(1);

    await expect.poll(() => el.querySelector(".cm-content"), { timeout: 20_000 }).not.toBeNull();
    await userEvent.click(el.querySelector<HTMLElement>(".cm-content")!);
    await userEvent.keyboard("{Control>}{End}{/Control} Gamma.");
    await penLayerOn(el, "Gamma.");

    await userEvent.click(option(el, "Second point"));
    await expect.poll(() => address(el)).toBe("second-point/1");
    expect(activeMarks(el)).toBe(0);
    await userEvent.click(option(el, "First point"));
    await expect.poll(() => address(el)).toBe("first-point/1");
    expect(activeMarks(el)).toBe(1);
  });
});

describe("slide notes in the editor gutter", () => {
  // The code block is taller than a slide, so the Config page (line 7) keeps a note.
  const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
  const NOTED = `# Notes doc\n\n## Short\n\nFine.\n\n## Config\n\nBefore.\n\n\`\`\`\n${code}\n\`\`\`\n`;

  // Until the deck rebuilds, the notes come from slides of the text before the
  // edit. A slide whose section the edit renamed has no line in the new text:
  // its note once went to line 1, on a heading it says nothing about.
  test("a note whose section an edit removed waits for the rebuild instead of moving to line 1", async () => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ markdown: NOTED, source: { kind: "paste" } }),
    );
    const el = await mountApp();
    await expect
      .poll(() => markers(el), { timeout: 20_000 })
      .toEqual([expect.stringContaining("(config/")]);
    const view = EditorView.findFromDOM(el.querySelector<HTMLElement>(".cm-editor")!)!;
    const heading = view.state.doc.line(7);
    act(() =>
      view.dispatch({ changes: { from: heading.from, to: heading.to, insert: "## Settings" } }),
    );
    // Checked at once, inside the rebuild delay: the deck on screen is still the old one.
    expect(el.querySelector(".cm-line.dw-note-line")?.textContent ?? null).toBeNull();
    expect(markers(el)).toEqual([]);
    await expect
      .poll(() => markers(el), { timeout: 20_000 })
      .toEqual([expect.stringContaining("(settings/")]);
    expect(el.querySelector(".cm-line.dw-note-line")?.textContent).toContain("## Settings");
  });
});

describe("annotation shortcuts in the edit view", () => {
  // The toolbar is on screen in the edit view and its buttons advertise P/L/A/E
  // and Escape through aria-keyshortcuts, so those keys must work there too.
  test("Escape turns off the pen the user just picked, so the next click does not draw", async () => {
    const el = await mountApp();
    const pen = byLabel(el, "Pen");
    await userEvent.click(pen);
    expect(pen.getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(pen.getAttribute("aria-checked")).toBe("false");
  });

  test("P and L pick tools while focus is on the deck or its toolbar", async () => {
    const el = await mountApp();
    act(() => el.querySelector<HTMLElement>(".reveal")!.focus());
    await userEvent.keyboard("p");
    expect(byLabel(el, "Pen").getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("l");
    expect(byLabel(el, "Laser pointer").getAttribute("aria-checked")).toBe("true");
  });

  // Outside the deck pane the keys keep their own meaning: P in the outline is
  // type-ahead, not "start drawing".
  test("keys pressed in the outline are not taken as tool shortcuts", async () => {
    const el = await mountApp();
    act(() => el.querySelector<HTMLElement>('.docwalk-outline [role="option"]')!.focus());
    await userEvent.keyboard("p");
    expect(byLabel(el, "Pen").getAttribute("aria-checked")).toBe("false");
  });
});
