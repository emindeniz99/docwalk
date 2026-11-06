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

const DOC = "## One\n\nAlpha.\n\n## Two\n\nBeta.\n\n## Three\n\nGamma.\n";

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

describe("a rebuild while the deck has keyboard focus", () => {
  // reveal.js takes keys only while focus is inside its element, and a
  // rebuild replaces that element. While presenting, a rebuild comes from an
  // agent write, a file changed on disk or a language switch; focus fell to
  // <body> and the next clicker press or arrow key did nothing.
  test("focus moves to the new deck and the arrow keys keep stepping slides", async () => {
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const first = deck.container.querySelector<HTMLElement>(".reveal")!;
    act(() => first.focus());

    deck.show(DOC.replace("Beta.", "Beta, edited."));
    await deck.ready(2);
    const rebuilt = deck.container.querySelector<HTMLElement>(".reveal")!;
    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);

    const controller = deck.readies.at(-1)!;
    const before = controller.current()!.index;
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => controller.current()!.index).toBe(before + 1);
  });

  test("a deck that did not have focus does not take it on a rebuild", async () => {
    // The author is typing in the editor; a rebuild must not steal the caret.
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const input = document.createElement("input");
    document.body.append(input);
    act(() => input.focus());
    deck.show(DOC.replace("Beta.", "Beta, edited."));
    await deck.ready(2);
    expect(document.activeElement).toBe(input);
  });
});
