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
