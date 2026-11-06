import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
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
