import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { highlightCode, LATE_HIGHLIGHT_MS, type CodeLanguage, type Tokenize } from "./highlight";
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

describe("a tokenizer that answers nonsense", () => {
  // The tokens come from a worker, as data. Nonsense must leave the block
  // plain and let the deck go on to measure (rule 4), never reject.
  test.each([
    ["lines that are not arrays", () => ({ lines: 1 })],
    [
      "a kind outside the colour classes",
      (text: string) => [[{ text, kind: "keyword docwalk-diagram" }]],
    ],
  ])("%s", async (_name, answer) => {
    loadTokenizer.mockResolvedValue(answer as unknown as Tokenize);
    const box = render(MARKDOWN);
    const before = box.innerHTML;
    await expect(highlightCode(box)).resolves.toBeUndefined();
    expect(box.innerHTML).toBe(before);
  });
});

/** A tokenizer that marks `const` as a keyword and leaves the rest of each line plain. */
const markConst: Tokenize = (text) =>
  text.split("\n").map((line) =>
    line.startsWith("const")
      ? [
          { text: "const", kind: "keyword" as const },
          { text: line.slice("const".length), kind: null },
        ]
      : [{ text: line, kind: null }],
  );

/** A load the test settles itself, so no real wait stands between the steps. */
function controllable() {
  let settle!: (tokenize: Tokenize) => void;
  let fail!: (reason: unknown) => void;
  const load = new Promise<Tokenize>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  loadTokenizer.mockReturnValue(load);
  return { settle, fail };
}

/** Runs the build to its timeout, lands the grammar `afterMs` later, and lets the pass run. */
async function landAfter(afterMs: number): Promise<Element> {
  vi.useFakeTimers();
  const load = controllable();
  const box = render(MARKDOWN);
  const code = box.querySelector("pre > code")!;
  const done = highlightCode(box, { timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  await done;
  await vi.advanceTimersByTimeAsync(afterMs - 100);
  load.settle(markConst);
  await vi.advanceTimersByTimeAsync(10);
  return code;
}

/**
 * Decision 115: a grammar that lands after the timeout colours its blocks in
 * place. `highlightCode` still resolves at the timeout, so the deck measures
 * on time (rule 4); colour changes no metric (76), so nothing is rebuilt.
 */
describe("a grammar that arrives after the timeout", () => {
  test("colours the block in place, while highlightCode has long since resolved", async () => {
    loadTokenizer.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(markConst), 300)),
    );
    const box = render(MARKDOWN);
    const code = box.querySelector("pre > code")!;
    const text = code.textContent;
    await highlightCode(box, { timeoutMs: 100 });
    expect(code.querySelector(".dw-code-keyword")).toBeNull();
    await expect.poll(() => code.querySelector(".dw-code-keyword")?.textContent).toBe("const");
    expect(code.textContent).toBe(text);
  });

  test("a build that stopped is left plain when the grammar lands", async () => {
    const load = controllable();
    const box = render(MARKDOWN);
    let stopped = false;
    await highlightCode(box, { timeoutMs: 50, stop: () => stopped });
    stopped = true;
    load.settle(markConst);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(box.querySelector("pre > code")!.children.length).toBe(0);
  });

  test("colours the block's copy when pagination replaced the element meanwhile", async () => {
    const load = controllable();
    const box = render(MARKDOWN);
    await highlightCode(box, { timeoutMs: 50 });
    // paginateSlide clones a split section into new elements.
    const original = box.querySelector("pre")!;
    const copy = original.cloneNode(true) as HTMLElement;
    original.replaceWith(copy);
    load.settle(markConst);
    await expect.poll(() => copy.querySelector(".dw-code-keyword")?.textContent).toBe("const");
    expect(original.querySelector(".dw-code-keyword")).toBeNull();
  });

  test("a block coloured in the meantime is not coloured twice", async () => {
    const load = controllable();
    const box = render(MARKDOWN);
    await highlightCode(box, { timeoutMs: 50 });
    const code = box.querySelector("pre > code")!;
    const tokenize = vi.fn<Tokenize>(markConst);
    code.replaceChildren(Object.assign(document.createElement("span"), { textContent: "x" }));
    load.settle(tokenize);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tokenize).not.toHaveBeenCalled();
  });

  test("a load that fails after the timeout leaves the block plain and raises nothing", async () => {
    const unhandled = vi.fn<() => void>();
    window.addEventListener("unhandledrejection", unhandled);
    try {
      const load = controllable();
      const box = render(MARKDOWN);
      await highlightCode(box, { timeoutMs: 50 });
      load.fail(new TypeError("offline"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(box.querySelector("pre > code")!.children.length).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  describe("the 60 s cutoff", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("a grammar that lands within 60 s of the timeout still colours", async () => {
      const code = await landAfter(LATE_HIGHLIGHT_MS - 1000);
      expect(code.querySelector(".dw-code-keyword")?.textContent).toBe("const");
    });

    test("a grammar that lands later colours nothing", async () => {
      const code = await landAfter(LATE_HIGHLIGHT_MS + 1000 + 100);
      expect(code.children.length).toBe(0);
    });
  });

  test("the deck colours the block without a rebuild, and its page keeps its size", async () => {
    // The deck waits the default 5 s, so the grammar lands just after.
    loadTokenizer.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(markConst), 5500)),
    );
    const container = document.createElement("div");
    Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
    document.body.append(container);
    root = createRoot(container);
    const ready: (DeckController | null)[] = [];
    root.render(
      h(Deck, {
        plan: sectionize(parseMarkdown(MARKDOWN), "auto"),
        onReady: (c: DeckController | null) => {
          ready.push(c);
        },
      }),
    );
    await expect.poll(() => ready.some(Boolean), { timeout: 20_000 }).toBe(true);
    const code = container.querySelector(".reveal .slides pre > code")!;
    const pre = code.parentElement!;
    const page = pre.closest("section")!;
    expect(code.children.length).toBe(0);
    const size = () => [pre, page].map((el) => JSON.stringify(el.getBoundingClientRect()));
    const before = size();
    const readyCalls = ready.length;
    await expect
      .poll(() => container.querySelector(".reveal .slides .dw-code-keyword")?.textContent, {
        timeout: 10_000,
      })
      .toBe("const");
    expect(ready.length).toBe(readyCalls);
    expect(size()).toEqual(before);
    expect(code.textContent).toBe("const a = 1;\n");
  }, 30_000);
});
