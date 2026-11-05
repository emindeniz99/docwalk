import { act, createElement as h, createRef, Fragment, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
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
  useAnnotationShortcuts({ mode, setMode, undo, redo });
  return h(
    Fragment,
    null,
    h("output", { "data-testid": "mode" }, mode),
    h("output", { "data-testid": "color" }, color),
    h("input", { "aria-label": "Search" }),
    h(AnnotationToolbar, {
      mode,
      onModeChange: setMode,
      color,
      onColorChange: setColor,
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
    ];
    expect(controls).toHaveLength(4 + 3 + 2);
    for (const c of controls) {
      const name =
        c.getAttribute("aria-label") ?? c.querySelector("input")?.getAttribute("aria-label");
      expect(name).toBeTruthy();
      const r = c.getBoundingClientRect();
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
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
    expect(label()).toBe("Vermilion");
    await userEvent.keyboard("{ArrowRight}");
    expect(label()).toBe("Blue");
    await userEvent.keyboard(" ");
    expect(text(el, "color")).toBe("--dw-color-focus");

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(label()).toBe("Undo mark");
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
