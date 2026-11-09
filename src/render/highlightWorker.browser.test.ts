import { afterEach, expect, test } from "vitest";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown } from "../sectioning/sectionize";
import { highlightCode } from "./highlight";
import { nodesToHtml } from "./toHtml";

/**
 * Decision 43's open budget, through decision 76. A grammar compiles its
 * patterns on its first block: about 300 ms for the fixture's SQL and
 * TypeScript blocks, all of it on the page's thread, ahead of Mermaid's
 * renders, so the deck measured that much later. Shiki now runs in a worker
 * and the page only builds the spans.
 *
 * Its own file: the page keeps one highlighting worker per document, and this
 * test needs the first one to be its own.
 */

const RealWorker = window.Worker;

afterEach(() => {
  window.Worker = RealWorker;
  document.body.replaceChildren();
});

function render(markdown: string): HTMLElement {
  const box = document.createElement("div");
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(box);
  return box;
}

/** A worker that takes every message and answers none: a regex that never returns. */
class SilentWorker extends EventTarget {
  static started: SilentWorker[] = [];
  messages: unknown[] = [];
  terminated = false;
  constructor() {
    super();
    SilentWorker.started.push(this);
  }
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
}

test("blocks are tokenized in a worker; a worker that never answers is stopped and the next build starts another", async () => {
  window.Worker = SilentWorker as unknown as typeof Worker;
  const box = render("```ts\nconst a = 1;\n```\n");
  const code = box.querySelector("pre > code")!;
  // The deck waits its timeout, then measures with the block plain (decision 76).
  await highlightCode(box, { timeoutMs: 100 });
  expect(code.children.length).toBe(0);
  // The grammar goes to the worker once its chunk has loaded; the page then
  // stops the silent worker instead of waiting on it.
  await expect.poll(() => SilentWorker.started[0]?.messages.length).toBeGreaterThan(0);
  await expect.poll(() => SilentWorker.started[0]?.terminated, { timeout: 10_000 }).toBe(true);
  expect(code.children.length).toBe(0);

  const names: (string | undefined)[] = [];
  window.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      names.push(options?.name);
    }
  };
  await highlightCode(box);
  expect(names).toEqual(["docwalk-shiki"]);
  expect(code.querySelector(".dw-code-keyword")?.textContent).toBe("const");
  expect(code.textContent).toBe("const a = 1;\n");
}, 20_000);
