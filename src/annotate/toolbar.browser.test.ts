import { act, createElement as h, createRef, Fragment, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { AnnotationToolbar, PEN_COLORS, resolvePenColor, type PenColor } from "./AnnotationToolbar";
import { annotationShortcut, useAnnotationShortcuts } from "./useAnnotationShortcuts";
import type { AnnotationMode } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function key(init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const undo = vi.fn<() => void>();
const redo = vi.fn<() => void>();
const clear = vi.fn<() => void>();

// Browser tests are *.browser.test.ts (no JSX), so the harness uses createElement.
function Harness() {
  const [mode, setMode] = useState<AnnotationMode>("off");
  const [color, setColor] = useState<PenColor>("--dw-color-primary");
  const [board, setBoard] = useState(false);
  const toggle = () => setBoard((open) => !open);
  useAnnotationShortcuts({ mode, setMode, undo, redo, board: { open: board, toggle } });
  return h(
    Fragment,
    null,
    h("output", { "data-testid": "mode" }, mode),
    h("output", { "data-testid": "color" }, color),
    h("output", { "data-testid": "board" }, String(board)),
    h("input", { "aria-label": "Search" }),
    h(AnnotationToolbar, {
      mode,
      onModeChange: setMode,
      color,
      onColorChange: setColor,
      board,
      onBoardToggle: toggle,
      onUndo: undo,
      onClear: clear,
    }),
  );
}

const harness = () => h(Harness);

/** The accessible name of the focused control. */
const label = () => document.activeElement?.getAttribute("aria-label");

const text = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-testid="${id}"]`)?.textContent;

describe("annotation toolbar", () => {
  test("every control has an accessible name and a 44px target, for screen readers and touch", () => {
    const el = render(harness());
    const controls = [
      ...el.querySelectorAll<HTMLElement>(
        ".docwalk-annotate-toolbar button, .docwalk-annotate-swatch",
      ),
    ].filter((c) => c.checkVisibility());
    // With room for all twelve, the More tools menu stays out of the way (decision 110).
    expect(controls).toHaveLength(6 + 3 + 3);
    for (const c of controls) {
      const name =
        c.getAttribute("aria-label") ?? c.querySelector("input")?.getAttribute("aria-label");
      expect(name).toBeTruthy();
      const r = c.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("Rectangle and Ellipse sit between Arrow and Eraser, named, with their shortcut keys (decision 110)", () => {
    const el = render(harness());
    const names = [...el.querySelectorAll(".docwalk-annotate-group:first-child button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Pen", "Laser pointer", "Arrow", "Rectangle", "Ellipse", "Eraser"]);
    // React Aria's ToggleButton drops aria-keyshortcuts, so the toolbar sets it on the element.
    for (const [name, shortcut] of [
      ["Pen", "P"],
      ["Laser pointer", "L"],
      ["Arrow", "A"],
      ["Rectangle", "R"],
      ["Ellipse", "C"],
      ["Eraser", "E"],
    ] as const) {
      const button = el.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
      expect(button.getAttribute("aria-keyshortcuts")).toBe(shortcut);
      const box = button.getBoundingClientRect();
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });

  test.each([
    ["Rectangle", "rect"],
    ["Ellipse", "ellipse"],
  ])("pressing %s selects it and pressing it again turns annotation off", (name, mode) => {
    const el = render(harness());
    const button = el.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
    act(() => button.click());
    expect(text(el, "mode")).toBe(mode);
    expect(button.getAttribute("aria-checked") ?? button.getAttribute("aria-pressed")).toBe("true");
    act(() => button.click());
    expect(text(el, "mode")).toBe("off");
  });

  test("the Whiteboard toggle sits with Undo and Clear, named, pressed when open, a 44px target (decision 110)", () => {
    const el = render(harness());
    const toggle = el.querySelector<HTMLElement>('[aria-label="Whiteboard"]')!;
    expect(toggle.closest(".docwalk-annotate-group")).toBe(
      el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!.closest(".docwalk-annotate-group"),
    );
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("W");
    expect(toggle.querySelector("svg")).not.toBeNull();
    const box = toggle.getBoundingClientRect();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    act(() => toggle.click());
    expect(text(el, "board")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle.click());
    expect(text(el, "board")).toBe("false");
  });

  test("pressing a tool selects it and pressing it again turns annotation off", () => {
    const el = render(harness());
    const pen = el.querySelector<HTMLElement>('[aria-label="Pen"]')!;
    act(() => pen.click());
    expect(text(el, "mode")).toBe("pen");
    // A single-select group exposes the active tool as a checked radio to screen readers.
    expect(pen.getAttribute("aria-checked") ?? pen.getAttribute("aria-pressed")).toBe("true");
    act(() => pen.click());
    expect(text(el, "mode")).toBe("off");
  });

  test("swatches are one radio group; choosing one reports its token variable", () => {
    const el = render(harness());
    expect(el.querySelectorAll('[role="radiogroup"] input[type="radio"]')).toHaveLength(3);
    act(() => el.querySelector<HTMLInputElement>('input[aria-label="Blue"]')!.click());
    expect(text(el, "color")).toBe("--dw-color-focus");
  });

  test("swatch variables resolve to real colours, since drauu writes them into SVG attributes", () => {
    for (const { variable } of PEN_COLORS) expect(resolvePenColor(variable)).not.toBe("");
  });

  test("undo and clear buttons call through", () => {
    const el = render(harness());
    act(() => el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!.click());
    act(() => el.querySelector<HTMLElement>('[aria-label="Clear marks"]')!.click());
    expect(undo).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });
});

describe("annotation shortcuts", () => {
  test("P, L, A and E pick a tool; Escape turns annotation off", () => {
    const el = render(harness());
    key({ key: "p" });
    expect(text(el, "mode")).toBe("pen");
    key({ key: "l" });
    expect(text(el, "mode")).toBe("laser");
    key({ key: "a" });
    expect(text(el, "mode")).toBe("arrow");
    key({ key: "e" });
    expect(text(el, "mode")).toBe("eraser");
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(text(el, "mode")).toBe("off");
  });

  test("R picks the rectangle and C the ellipse, in either case", () => {
    const el = render(harness());
    key({ key: "r" });
    expect(text(el, "mode")).toBe("rect");
    key({ key: "C" });
    expect(text(el, "mode")).toBe("ellipse");
    key({ key: "r" });
    expect(text(el, "mode")).toBe("rect");
  });

  test("R and C leave text entry and a focus view alone", () => {
    const el = render(harness());
    // The keys work on the page, so the refusals below are not just missing keys.
    key({ key: "r" });
    expect(text(el, "mode")).toBe("rect");
    key({ key: "Escape" });
    const input = el.querySelector("input[aria-label=Search]")!;
    for (const k of ["r", "c"]) key({ key: k }, input);
    const focusView = document.createElement("div");
    focusView.className = "docwalk-focus";
    const inside = document.createElement("button");
    focusView.append(inside);
    el.append(focusView);
    for (const k of ["r", "c"]) expect(key({ key: k }, inside).defaultPrevented).toBe(false);
    expect(text(el, "mode")).toBe("off");
  });

  test("W opens and closes the whiteboard, in either case, and the toggle follows", () => {
    const el = render(harness());
    expect(key({ key: "w" }).defaultPrevented).toBe(true);
    expect(text(el, "board")).toBe("true");
    expect(el.querySelector('[aria-label="Whiteboard"]')!.getAttribute("aria-pressed")).toBe(
      "true",
    );
    key({ key: "W" });
    expect(text(el, "board")).toBe("false");
    expect(text(el, "mode")).toBe("off");
  });

  test("W leaves text entry, a focus view and Ctrl+W (close tab) alone", () => {
    const el = render(harness());
    key({ key: "w" });
    expect(text(el, "board")).toBe("true");
    key({ key: "w" });
    const input = el.querySelector("input[aria-label=Search]")!;
    key({ key: "w" }, input);
    const focusView = document.createElement("div");
    focusView.className = "docwalk-focus";
    const inside = document.createElement("button");
    focusView.append(inside);
    el.append(focusView);
    expect(key({ key: "w" }, inside).defaultPrevented).toBe(false);
    expect(key({ key: "w", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "w", metaKey: true }).defaultPrevented).toBe(false);
    expect(text(el, "board")).toBe("false");
  });

  test("Escape turns the tool off first, then closes the whiteboard, then is left alone", () => {
    const el = render(harness());
    key({ key: "w" });
    key({ key: "p" });
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(text(el, "mode")).toBe("off");
    expect(text(el, "board")).toBe("true");
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(text(el, "board")).toBe("false");
    // Nothing left to close: reveal.js and the present view get the key.
    expect(key({ key: "Escape" }).defaultPrevented).toBe(false);
  });

  test("an Escape meant for an open dialog does not close the whiteboard under it", () => {
    const el = render(harness());
    key({ key: "w" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    el.append(dialog);
    expect(key({ key: "Escape" }, inside).defaultPrevented).toBe(false);
    expect(text(el, "board")).toBe("true");
  });

  test.each(["dialog", "menu", "listbox"])(
    "W and the tool keys do nothing inside an open %s, so its own keys (type-to-find) keep working",
    (role) => {
      const el = render(harness());
      const layer = document.createElement("div");
      layer.setAttribute("role", role);
      const inside = document.createElement("button");
      layer.append(inside);
      el.append(layer);
      for (const k of ["w", "p", "l", "a", "r", "c", "e"]) {
        expect(key({ key: k }, inside).defaultPrevented).toBe(false);
      }
      expect(key({ key: "z", ctrlKey: true }, inside).defaultPrevented).toBe(false);
      expect(text(el, "board")).toBe("false");
      expect(text(el, "mode")).toBe("off");
      // The same keys work on the page again outside it.
      key({ key: "w" });
      expect(text(el, "board")).toBe("true");
    },
  );

  test("Ctrl+R and Ctrl+C keep reloading and copying", () => {
    const el = render(harness());
    expect(key({ key: "r" }).defaultPrevented).toBe(true);
    key({ key: "Escape" });
    expect(key({ key: "r", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key({ key: "c", metaKey: true }).defaultPrevented).toBe(false);
    expect(text(el, "mode")).toBe("off");
  });

  test("Escape with no tool active is left alone, so it still exits fullscreen and the overview", () => {
    render(harness());
    expect(key({ key: "Escape" }).defaultPrevented).toBe(false);
  });

  test("typing in a text field never switches tools, or a search for 'apple' would start drawing", () => {
    const el = render(harness());
    const input = el.querySelector("input[aria-label=Search]")!;
    for (const k of ["p", "l", "a", "e"]) key({ key: k }, input);
    key({ key: "z", ctrlKey: true }, input);
    expect(text(el, "mode")).toBe("off");
    expect(annotationShortcut(new KeyboardEvent("keydown", { key: "p" }))).toEqual({ mode: "pen" });
  });

  test("Ctrl/Cmd+Z undoes and Shift+Ctrl/Cmd+Z redoes, matching every drawing app", () => {
    undo.mockClear();
    redo.mockClear();
    render(harness());
    key({ key: "z", ctrlKey: true });
    key({ key: "z", metaKey: true });
    key({ key: "Z", ctrlKey: true, shiftKey: true });
    expect(undo).toHaveBeenCalledTimes(2);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  test("browser shortcuts with a modifier (Ctrl+P prints) are not taken over", () => {
    const el = render(harness());
    expect(key({ key: "p", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(text(el, "mode")).toBe("off");
  });

  test("the source editor (contenteditable, role=textbox) is a text field too, so typing there never draws", () => {
    const el = render(harness());
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "plaintext-only");
    editor.setAttribute("role", "textbox");
    const line = document.createElement("span");
    editor.append(line);
    el.append(editor);
    key({ key: "p" }, editor);
    key({ key: "l" }, line);
    expect(text(el, "mode")).toBe("off");
  });

  test("after picking a colour the shortcuts still work, because a swatch is a radio button, not a text field", () => {
    const el = render(harness());
    const blue = el.querySelector<HTMLInputElement>('input[aria-label="Blue"]')!;
    act(() => {
      blue.focus();
      blue.click();
    });
    expect(text(el, "color")).toBe("--dw-color-focus");
    expect(document.activeElement).toBe(blue);
    key({ key: "p" }, blue);
    expect(text(el, "mode")).toBe("pen");
  });

  test("a claimed key never reaches reveal.js, or P and L would also change the slide", () => {
    // reveal.js 6 binds P to previous and L to next on a document keydown listener.
    const reveal = vi.fn<(e: KeyboardEvent) => void>();
    document.addEventListener("keydown", reveal);
    try {
      const el = render(harness());
      key({ key: "p" });
      key({ key: "l" });
      key({ key: "Escape" });
      expect(text(el, "mode")).toBe("off");
      expect(reveal).not.toHaveBeenCalled();
      // Keys the layer does not claim still navigate, Escape included once no tool is active.
      key({ key: "ArrowRight" });
      key({ key: "Escape" });
      expect(reveal.mock.calls.map(([e]) => e.key)).toEqual(["ArrowRight", "Escape"]);
    } finally {
      document.removeEventListener("keydown", reveal);
    }
  });
});

describe("annotation toolbar keyboard (WCAG 2.1.1)", () => {
  // The APG toolbar pattern: arrow keys move focus across every control, Enter or Space activates.
  test("every tool and swatch is reachable with arrow keys and chosen with Enter or Space", async () => {
    const el = render(harness());
    act(() => el.querySelector<HTMLElement>('[aria-label="Pen"]')!.focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(label()).toBe("Laser pointer");
    await userEvent.keyboard("{Enter}");
    expect(text(el, "mode")).toBe("laser");

    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(label()).toBe("Ellipse");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(label()).toBe("Vermilion");
    await userEvent.keyboard("{ArrowRight}");
    expect(label()).toBe("Blue");
    await userEvent.keyboard(" ");
    expect(text(el, "color")).toBe("--dw-color-focus");

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(label()).toBe("Whiteboard");
    await userEvent.keyboard("{Enter}");
    expect(text(el, "board")).toBe("true");
    await userEvent.keyboard("{ArrowRight}");
    expect(label()).toBe("Undo mark");
  });
});

/** The toolbar in the edit preview's head, as wide as the deck pane beside the comments panel at 1280 px. */
function NarrowHead() {
  return h(
    "div",
    { className: "docwalk-app", "data-view": "edit" },
    h(
      "div",
      { className: "docwalk-preview-head", style: { width: "402px", boxSizing: "border-box" } },
      h("div", { className: "docwalk-stage-tools" }, h(Harness)),
    ),
  );
}

const visibleNames = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>(".docwalk-annotate-button, .docwalk-annotate-swatch")]
    .filter((c) => c.checkVisibility())
    .map(
      (c) => c.getAttribute("aria-label") ?? c.querySelector("input")?.getAttribute("aria-label"),
    );

const more = (el: HTMLElement) => el.querySelector<HTMLElement>(".docwalk-annotate-more")!;

/** The open More tools menu's item with this name. */
const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find(
    (item) => item.querySelector('[slot="label"]')?.textContent === name,
  );

async function openMore(el: HTMLElement) {
  await userEvent.click(more(el));
  await expect.poll(() => menuItem("Rectangle")).toBeDefined();
}

describe("a stage head too narrow for twelve controls (decision 110)", () => {
  // Twelve controls need 452 px even at 32 px; beside the comments panel at
  // 1280 px the head has 354. Nine keep one row, the rest wait one click away.
  beforeEach(async () => {
    await page.viewport(1280, 800);
  });
  // Vitest's own default, which the other tests in this file run at.
  afterEach(async () => {
    await page.viewport(414, 896);
  });

  test("nine controls keep one row and the More tools menu holds the rest", async () => {
    const el = render(h(NarrowHead));
    expect(visibleNames(el)).toEqual([
      "Pen",
      "Laser pointer",
      "Arrow",
      "Eraser",
      "Vermilion",
      "Blue",
      "Ink",
      "Undo mark",
      "More tools",
    ]);
    const tops = [
      ...el.querySelectorAll<HTMLElement>(".docwalk-annotate-button, .docwalk-annotate-swatch"),
    ]
      .filter((c) => c.checkVisibility())
      .map((c) => Math.round(c.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
    expect(more(el).getAttribute("aria-haspopup")).toBe("true");
    await openMore(el);
    expect(menuItem("Rectangle")?.getAttribute("role")).toBe("menuitemradio");
    expect(menuItem("Ellipse")?.getAttribute("role")).toBe("menuitemradio");
    expect(menuItem("Whiteboard")?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(menuItem("Clear marks")?.getAttribute("role")).toBe("menuitem");
    // The menu teaches the keys the toolbar's tooltips taught.
    expect(menuItem("Rectangle")?.querySelector("kbd")?.textContent).toBe("R");
    expect(menuItem("Ellipse")?.querySelector("kbd")?.textContent).toBe("C");
    expect(menuItem("Whiteboard")?.querySelector("kbd")?.textContent).toBe("W");
  });

  test("a shape picked in the menu shows on its button, and picking it again turns it off", async () => {
    const el = render(h(NarrowHead));
    await openMore(el);
    await userEvent.click(menuItem("Ellipse")!);
    expect(text(el, "mode")).toBe("ellipse");
    // With the ellipse button out of sight, the menu button carries the state.
    await expect.poll(() => more(el).getAttribute("aria-label")).toBe("More tools: Ellipse");
    expect(more(el).hasAttribute("data-active")).toBe(true);
    await openMore(el);
    expect(menuItem("Ellipse")?.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(menuItem("Ellipse")!);
    expect(text(el, "mode")).toBe("off");
    await expect.poll(() => more(el).getAttribute("aria-label")).toBe("More tools");
    expect(more(el).hasAttribute("data-active")).toBe(false);
  });

  test("R, C and W work while their buttons wait in the menu", async () => {
    const el = render(h(NarrowHead));
    key({ key: "r" });
    expect(text(el, "mode")).toBe("rect");
    expect(more(el).getAttribute("aria-label")).toBe("More tools: Rectangle");
    key({ key: "c" });
    expect(more(el).getAttribute("aria-label")).toBe("More tools: Ellipse");
    key({ key: "p" });
    expect(more(el).getAttribute("aria-label")).toBe("More tools");
    key({ key: "w" });
    expect(text(el, "board")).toBe("true");
    await openMore(el);
    expect(menuItem("Whiteboard")?.getAttribute("aria-checked")).toBe("true");
  });

  test("Whiteboard and Clear marks in the menu call through", async () => {
    const el = render(h(NarrowHead));
    await openMore(el);
    await userEvent.click(menuItem("Whiteboard")!);
    expect(text(el, "board")).toBe("true");
    clear.mockClear();
    await openMore(el);
    await userEvent.click(menuItem("Clear marks")!);
    expect(clear).toHaveBeenCalled();
  });

  test("arrow keys skip the controls in the menu and reach its button (WCAG 2.1.1)", async () => {
    const el = render(h(NarrowHead));
    act(() => el.querySelector<HTMLElement>('[aria-label="Pen"]')!.focus());
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(label()).toBe("Eraser");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(label()).toBe("More tools");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.activeElement?.closest('[role="menu"]')).not.toBeNull();
  });
});

// ---- On the dark stage (App renders the toolbar inside .docwalk-stage-tools) ----

type Rgb = [number, number, number];

function rgb(css: string): Rgb {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css);
  if (!m) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG 2 relative luminance. */
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two computed colours. */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The toolbar the way App places it: on the stage, inside the stage-tools remap. */
function StageHarness() {
  return h(
    "div",
    { "data-testid": "stage", style: { background: "var(--dw-color-stage)", padding: "16px" } },
    h("div", { className: "docwalk-stage-tools" }, h(Harness)),
  );
}

const stageColour = () =>
  getComputedStyle(document.querySelector<HTMLElement>('[data-testid="stage"]')!).backgroundColor;

for (const theme of ["light", "dark"] as const) {
  describe(`annotation toolbar on the stage, ${theme} theme`, () => {
    beforeEach(() => {
      document.documentElement.dataset.theme = theme;
    });
    afterEach(() => {
      delete document.documentElement.dataset.theme;
    });

    // WCAG 1.4.11 / 2.4.13: the stage is dark in both themes, so the ring must
    // be the dark-surface focus colour even when the page is light.
    test("the keyboard focus ring stands out from the stage at 3:1 or more", async () => {
      const el = render(h(StageHarness));
      act(() => el.querySelector<HTMLElement>("input[aria-label=Search]")!.focus());
      await userEvent.keyboard("{Tab}");
      expect(label()).toBe("Pen");
      const ring = getComputedStyle(document.activeElement!).outlineColor;
      expect(contrast(ring, stageColour())).toBeGreaterThanOrEqual(3);
    });

    // A pressed button once turned the light page canvas colour with stage ink
    // on it (1.09:1): the icon vanished while Undo or Clear was held down.
    test("a pressed button keeps its icon visible", () => {
      const el = render(h(StageHarness));
      const undoButton = el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!;
      act(() => {
        undoButton.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
          }),
        );
      });
      expect(undoButton.hasAttribute("data-pressed")).toBe(true);
      const style = getComputedStyle(undoButton);
      expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(3);
      act(() => {
        undoButton.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
          }),
        );
      });
    });

    // The Ink pen colour is near-black on a near-black chip (1.16:1); without a
    // light ring presenters cannot see that a third colour exists.
    test("every colour swatch has an edge that stands out from its chip", () => {
      const el = render(h(StageHarness));
      for (const swatch of el.querySelectorAll<HTMLElement>(".docwalk-annotate-swatch")) {
        const dot = swatch.querySelector<HTMLElement>(".docwalk-annotate-swatch-dot")!;
        const chip = getComputedStyle(swatch).backgroundColor;
        const fill = getComputedStyle(dot).backgroundColor;
        const ring = /rgba?\([^)]*\)/.exec(getComputedStyle(dot).boxShadow)?.[0];
        const edge = Math.max(contrast(fill, chip), ring ? contrast(ring, chip) : 0);
        const name = swatch.querySelector("input")?.getAttribute("aria-label");
        expect({ name, edge: edge >= 3 }).toEqual({ name, edge: true });
      }
    });

    // Every other header control reacts to the pointer; these looked inert.
    test("tools, swatches and action buttons react to hover", async () => {
      const el = render(h(StageHarness));
      for (const target of [
        el.querySelector<HTMLElement>('[aria-label="Laser pointer"]')!,
        el.querySelector<HTMLElement>('input[aria-label="Blue"]')!.closest("label")!,
        el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!,
      ]) {
        const before = getComputedStyle(target).borderColor;
        await userEvent.hover(target);
        expect(target.hasAttribute("data-hovered")).toBe(true);
        expect(getComputedStyle(target).borderColor).not.toBe(before);
        await userEvent.unhover(target);
      }
    });
  });
}

describe("annotation toolbar names on hover (icon-only controls)", () => {
  // Laser and Arrow look alike, and Clear marks wipes the slide: a sighted mouse
  // user needs the name, and the tooltip is where the shortcut is taught.
  test("tools, swatches and actions show their name, tools with their shortcut key", async () => {
    const el = render(h(StageHarness));
    const cases: [HTMLElement, RegExp][] = [
      [el.querySelector<HTMLElement>('[aria-label="Laser pointer"]')!, /Laser pointer\s*L/],
      [el.querySelector<HTMLElement>('input[aria-label="Ink"]')!.closest("label")!, /Ink/],
      [el.querySelector<HTMLElement>('[aria-label="Clear marks"]')!, /Clear marks/],
    ];
    for (const [target, name] of cases) {
      await userEvent.hover(target);
      await expect
        .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
        .toMatch(name);
      // Placed against the control it names, not elsewhere on the toolbar.
      const tip = document.querySelector('[role="tooltip"]')!.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      expect(Math.abs(tip.left + tip.width / 2 - (box.left + box.width / 2))).toBeLessThan(
        box.width,
      );
      await userEvent.unhover(target);
      await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull();
    }
  });
});

describe("hidden radio inputs stay inside their swatch", () => {
  // On a phone the three visually hidden radio inputs escaped the scrolling
  // pane and made the whole 100dvh shell scroll by 35px.
  test("a toolbar scrolled out of a pane does not make the page scroll", () => {
    render(
      h(
        "div",
        { style: { height: "100px", overflow: "auto" } },
        h("div", { style: { height: `${window.innerHeight + 200}px` } }),
        h("div", { className: "docwalk-stage-tools" }, h(Harness)),
      ),
    );
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  });
});

const scope = createRef<HTMLDivElement>();

function Scoped() {
  const [mode, setMode] = useState<AnnotationMode>("off");
  useAnnotationShortcuts({ mode, setMode, undo, redo }, true, scope);
  return h(
    Fragment,
    null,
    h("output", { "data-testid": "mode" }, mode),
    h("button", { type: "button" }, "Outside"),
    h("div", { ref: scope }, h("button", { type: "button" }, "Inside")),
  );
}

describe("shortcut scope", () => {
  // In the edit view App scopes the keys to the deck pane, so P typed in the
  // outline stays type-ahead while P on the toolbar picks the pen.
  test("keys outside the scope are left alone; inside, they pick and drop tools", () => {
    const el = render(h(Scoped));
    const outside = el.querySelector<HTMLElement>("button")!;
    const inside = scope.current!.querySelector<HTMLElement>("button")!;
    expect(key({ key: "p" }, outside).defaultPrevented).toBe(false);
    expect(text(el, "mode")).toBe("off");
    key({ key: "p" }, inside);
    expect(text(el, "mode")).toBe("pen");
    key({ key: "Escape" }, inside);
    expect(text(el, "mode")).toBe("off");
  });
});

const platform = (name: string) =>
  Object.defineProperty(navigator, "userAgentData", {
    value: { platform: name },
    configurable: true,
  });

async function undoTip(): Promise<Element> {
  const el = render(harness());
  // From another control, so the pointer really moves onto Undo even if an
  // earlier test left it resting where Undo now renders.
  await userEvent.hover(el.querySelector<HTMLElement>('[aria-label="Search"]')!);
  await userEvent.hover(el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!);
  await expect.poll(() => document.querySelector('[role="tooltip"]')).not.toBeNull();
  return document.querySelector('[role="tooltip"] kbd')!;
}

describe("shortcut hints name the viewer's own modifier key", () => {
  // The undo handler takes Ctrl or ⌘. A Windows or Linux keyboard has no ⌘,
  // so a hint that always shows it teaches a key the viewer cannot press.
  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgentData");
  });

  test("Windows and Linux see Ctrl+Z", async () => {
    platform("Windows");
    const kbd = await undoTip();
    expect(kbd.textContent).toBe("Ctrl+Z");
    expect(kbd.querySelector("svg")).toBeNull();
  });

  test("a Mac sees the Command glyph and Z", async () => {
    platform("macOS");
    const kbd = await undoTip();
    expect(kbd.textContent).toBe("Z");
    expect(kbd.querySelector("svg")).not.toBeNull();
  });
});

describe("a control that slides under a resting pointer keeps its tooltip shut", () => {
  // Present swaps the header for the stage and Undo lands where Present was.
  // Its tooltip opened over the slide with no mouse movement, and where
  // fullscreen is refused it swallowed the Escape meant to leave present mode.
  test("no tooltip until the pointer moves; a move on the control then opens it", async () => {
    const el = render(harness());
    const undoButton = el.querySelector<HTMLElement>('[aria-label="Undo mark"]')!;
    const box = undoButton.getBoundingClientRect();
    const present = document.createElement("button");
    present.textContent = "Present";
    Object.assign(present.style, {
      position: "fixed",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      zIndex: "100",
    });
    present.addEventListener("click", () => present.remove());
    document.body.append(present);

    await userEvent.click(present);
    expect(present.isConnected).toBe(false);
    // Longer than the 500 ms delay plus a frame for the browser's hover update.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(undoButton.matches(":hover")).toBe(true);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    // Escape now reaches the app instead of closing a stray tooltip.
    const escape = vi.fn<(e: KeyboardEvent) => void>();
    window.addEventListener("keydown", escape);
    try {
      await userEvent.keyboard("{Escape}");
      expect(escape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", escape);
    }

    // A real move over the control still names it.
    await userEvent.hover(undoButton, { position: { x: 4, y: 4 } });
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
      .toMatch(/Undo mark/);
  });

  test("moving straight from one named control to the next still opens the next at once", async () => {
    const el = render(h(StageHarness));
    await userEvent.hover(el.querySelector<HTMLElement>('[aria-label="Pen"]')!);
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
      .toMatch(/Pen/);
    await userEvent.hover(el.querySelector<HTMLElement>('[aria-label="Laser pointer"]')!);
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "", { timeout: 300 })
      .toMatch(/Laser pointer/);
  });

  test("keyboard focus still opens the tooltip with the pointer elsewhere", async () => {
    const el = render(harness());
    act(() => el.querySelector<HTMLElement>('[aria-label="Pen"]')!.focus());
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
      .toMatch(/Laser pointer/);
  });
});
