import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { highlightCode, type CodeLanguage, type Tokenize } from "./highlight";
import { nodesToHtml } from "./toHtml";

/**
 * Decision 76: highlighting is an extra, never a gate. Offline with a grammar
 * that was never cached, or on a network that stalls, the deck must still
 * build and measure, with plain blocks.
 */

const { loadTokenizer } = vi.hoisted(() => ({
  loadTokenizer: vi.fn<(languages: CodeLanguage[]) => Promise<Tokenize>>(),
}));
vi.mock("./shiki", () => ({ loadTokenizer }));

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  loadTokenizer.mockReset();
});

const MARKDOWN = "## Code\n\n```ts\nconst a = 1;\n```\n";

function render(markdown: string): HTMLElement {
  const box = document.createElement("div");
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(box);
  return box;
}

describe("when the grammars cannot be had", () => {
  test("a failed load leaves blocks plain, and the next render asks again", async () => {
    loadTokenizer.mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    const box = render(MARKDOWN);
    const before = box.innerHTML;
    await expect(highlightCode(box)).resolves.toBeUndefined();
    expect(box.innerHTML).toBe(before);
    await highlightCode(box);
    expect(loadTokenizer).toHaveBeenCalledTimes(2);
  });

  test("a load that hangs gives up after the timeout", async () => {
    loadTokenizer.mockReturnValue(new Promise(() => undefined));
    const box = render(MARKDOWN);
    const before = box.innerHTML;
    const started = performance.now();
    await highlightCode(box, { timeoutMs: 100 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(box.innerHTML).toBe(before);
  });

  test("the deck still builds, with the block plain", async () => {
    loadTokenizer.mockRejectedValue(new TypeError("offline"));
    const container = document.createElement("div");
    Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
    document.body.append(container);
    root = createRoot(container);
    let controller: DeckController | null = null;
    root.render(
      h(Deck, {
        plan: sectionize(parseMarkdown(MARKDOWN), "auto"),
        onReady: (c: DeckController | null) => {
          controller = c;
        },
      }),
    );
    await expect.poll(() => controller, { timeout: 20_000 }).not.toBeNull();
    const code = container.querySelector(".reveal .slides pre > code")!;
    expect(code.textContent).toBe("const a = 1;\n");
    expect(code.children.length).toBe(0);
  });
});
