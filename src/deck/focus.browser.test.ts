import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck } from "./Deck";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const DOC =
  "## Diagram\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n## Next\n\nMore text.\n\n## Last\n\nEnd.\n";

function mountDeck(markdown: string) {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  const show = (md: string) =>
    act(() => root!.render(h(Deck, { plan: sectionize(parseMarkdown(md), "auto"), onReady })));
  show(markdown);
  const ready = async (n: number) => {
    await expect
      .poll(() => readies.length, { timeout: 20_000, interval: 10 })
      .toBeGreaterThanOrEqual(n);
  };
  return { container, show, ready, readies };
}

describe("closing the diagram focus view after the deck was rebuilt under it", () => {
  // While the view is open, focus is in the overlay, so a rebuild (an agent
  // write, a disk reload) does not hand focus to the new deck. Closing then
  // focused the old, detached diagram, focus fell to <body>, and reveal.js,
  // which takes keys only while focus is inside the deck, ignored the arrow
  // keys and the presenter's clicker.
  test("focus lands in the new deck and the arrow keys keep stepping slides", async () => {
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const diagram = deck.container.querySelector<HTMLElement>(
      ".reveal .slides section.present .docwalk-diagram",
    )!;
    diagram.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector(".docwalk-focus")).not.toBeNull();

    deck.show(DOC.replace("More text.", "More text, edited."));
    await deck.ready(2);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".docwalk-focus")).toBeNull();

    const rebuilt = deck.container.querySelector<HTMLElement>(".reveal")!;
    expect(rebuilt.contains(document.activeElement)).toBe(true);
    const controller = deck.readies.at(-1)!;
    const before = controller.current()!.index;
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => controller.current()!.index).toBe(before + 1);
  });
});

describe("the diagram view's toolbar before any tour starts", () => {
  async function openDiagramView() {
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const diagram = deck.container.querySelector<HTMLElement>(
      ".reveal .slides section.present .docwalk-diagram",
    )!;
    diagram.focus();
    await userEvent.keyboard("{Enter}");
    const view = document.querySelector<HTMLElement>(".docwalk-focus")!;
    expect(view).not.toBeNull();
    return view;
  }

  // The tour's code loads on its first start, and offline it may never load.
  // The status line must be hidden from the first frame, not once that chunk
  // arrives: before, it was an unstyled flex item and "Tour ended" could show.
  test("the status line is visually hidden although the tour's code has not loaded", async () => {
    const view = await openDiagramView();
    const status = view.querySelector<HTMLElement>(".docwalk-tour-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(getComputedStyle(status).position).toBe("absolute");
    const box = status.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([1, 1]);
    // The count is a toolbar item that is hidden until the tour runs.
    expect(view.querySelector<HTMLElement>(".docwalk-tour-count")!.hidden).toBe(true);
  });

  // At 390 px the toolbar once wrapped, leaving Close alone on a second row.
  test("at 390 px every toolbar button shares one row, each at least 44 px", async () => {
    await page.viewport(390, 844);
    try {
      const view = await openDiagramView();
      const buttons = [
        ...view.querySelectorAll<HTMLButtonElement>(".docwalk-focus-toolbar button"),
      ].filter((b) => !b.hidden);
      // Zoom out, zoom in, Fit, Fullscreen, Sketch, Tour, Close.
      expect(buttons).toHaveLength(7);
      const boxes = buttons.map((b) => b.getBoundingClientRect());
      expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
      for (const box of boxes) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(390);
      }
    } finally {
      await page.viewport(1280, 800);
    }
  });
});
