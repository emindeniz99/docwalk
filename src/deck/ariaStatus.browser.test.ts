import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck } from "./Deck";

let root: Root | null = null;

/** reveal.js's polite live region: what a screen reader announces on each slide change. */
const status = () => document.querySelector(".reveal .aria-status")?.textContent ?? "";

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

describe("reveal.js's slide announcement (aria-live)", () => {
  test("a diagram slide is announced by its words, never by the diagram's CSS", async () => {
    // reveal builds the polite announcement from the slide's text nodes and
    // skips only aria-hidden or display:none elements. Mermaid styles each
    // SVG with a <style> element, so a screen reader heard thousands of
    // characters of selectors and colours on every diagram slide.
    const container = document.createElement("div");
    Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
    document.body.append(container);
    root = createRoot(container);
    let controller: DeckController | null = null;
    const markdown =
      "## Intro\n\nOpening words.\n\n## Flow\n\n```mermaid\nflowchart LR\n  Ledger --> Journal\n```\n";
    root.render(
      h(Deck, {
        plan: sectionize(parseMarkdown(markdown), "auto"),
        onReady: (c: DeckController | null) => {
          if (c) controller = c;
        },
      }),
    );
    await expect.poll(() => controller, { timeout: 20_000, interval: 10 }).not.toBeNull();
    (controller as unknown as DeckController).next();
    await expect.poll(status).toContain("Flow");
    expect(status()).toContain("Ledger");
    expect(status()).not.toMatch(/[{}]|font-family/);
  });
});
