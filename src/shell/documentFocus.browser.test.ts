import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { FocusEvent } from "../annotate/mirrorTypes";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { observeFocus } from "../deck/focusEvents";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { DocumentView } from "./DocumentView";

/**
 * Decision 129: the document view opens the focus views of decision 87 with
 * the gestures a slide has. A reader of the whole document could not enlarge
 * a diagram, a listing, a table or an image before.
 */

let root: Root | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

const DOC = [
  "# Guide",
  "",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Name | Where |",
  "| --- | --- |",
  "| Later | [jump](#later) |",
  "| Site | [elsewhere](https://example.invalid/) |",
  "",
  "![Company logo](/icons/icon-192.png)",
  "",
  "## Later",
  "",
  "The end.",
  "",
].join("\n");

/** The reading view in a scrolling pane, once its diagrams are drawn and its image has loaded. */
async function mount(markdown = DOC) {
  const pane = document.createElement("div");
  pane.className = "docwalk-document-pane";
  Object.assign(pane.style, { width: "1000px", height: "600px" });
  document.body.append(pane);
  root = createRoot(pane);
  let drawn = 0;
  const show = (md: string) =>
    root!.render(
      h(DocumentView, {
        root: parseMarkdown(md),
        onRendered: () => {
          drawn++;
        },
      }),
    );
  show(markdown);
  await expect.poll(() => drawn, { timeout: 20_000 }).toBeGreaterThan(0);
  const article = pane.querySelector<HTMLElement>(".docwalk-document")!;
  return { pane, article, show, drawn: () => drawn };
}

/** Keeps the test page from following a link once every other listener has run. */
const stay = (event: Event) => event.preventDefault();

const overlay = () => document.querySelector<HTMLElement>(".docwalk-focus");

/** Waits for the marks a slide's blocks get; a short wait, since they come with the drawing. */
async function marked(article: HTMLElement, selector: string) {
  await expect
    .poll(() => article.querySelector<HTMLElement>(`${selector}[data-docwalk-focus]`), {
      timeout: 3_000,
    })
    .toBeTruthy();
  return article.querySelector<HTMLElement>(selector)!;
}

describe("a click on a block in the document view opens its focus view", () => {
  for (const [kind, selector] of [
    ["diagram", ".docwalk-diagram"],
    ["code", "pre"],
    ["table", "table"],
    ["image", "img"],
  ] as const) {
    test(`a click on the ${kind} opens the ${kind} view, as on a slide`, async () => {
      const { article } = await mount();
      const block =
        kind === "diagram"
          ? article.querySelector<HTMLElement>(selector)!
          : await marked(article, selector);
      await userEvent.click(block);
      expect(overlay()?.dataset["kind"]).toBe(kind);
      expect(overlay()?.getAttribute("role")).toBe("dialog");
    });
  }
});

describe("the keyboard in the document view", () => {
  // Decision 129: the blocks are tab stops, as on a slide, and the view gives focus back.
  for (const selector of ["pre", "table", "img"]) {
    test(`a ${selector} is a named tab stop with the slide's pointer, Enter opens it and Escape returns focus to it`, async () => {
      const { article } = await mount();
      const block = await marked(article, selector);
      expect(block.tabIndex).toBe(0);
      expect(block.getAttribute("aria-label")).toContain("Press Enter");
      expect(getComputedStyle(block).cursor).toBe("zoom-in");
      block.focus();
      await userEvent.keyboard("{Enter}");
      expect(overlay()).not.toBeNull();
      await userEvent.keyboard("{Escape}");
      expect(overlay()).toBeNull();
      expect(document.activeElement).toBe(block);
    });
  }

  test("Enter on a diagram opens its view and Escape returns focus to it", async () => {
    const { article } = await mount();
    const diagram = article.querySelector<HTMLElement>(".docwalk-diagram")!;
    diagram.focus();
    await userEvent.keyboard("{Enter}");
    expect(overlay()?.dataset["kind"]).toBe("diagram");
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(diagram);
  });
});

describe("what a click in the document view does not open (decision 87's exceptions)", () => {
  test("a link inside a table follows the link and opens nothing; a click beside it opens the table", async () => {
    const { article } = await mount();
    const table = await marked(article, "table");
    await userEvent.click(table.querySelector<HTMLElement>("a")!);
    expect(overlay()).toBeNull();
    // The link went to its heading, as the document view's links do.
    expect(document.activeElement?.textContent).toBe("Later");
    await userEvent.click(table.querySelector<HTMLElement>("td")!);
    expect(overlay()?.dataset["kind"]).toBe("table");
  });

  test("a click on an external link inside a table opens nothing", async () => {
    const { article } = await mount();
    const table = await marked(article, "table");
    // The test page must not leave; the link's own default is the browser's, not the view's.
    window.addEventListener("click", stay);
    cleanups.push(() => window.removeEventListener("click", stay));
    await userEvent.click(table.querySelector<HTMLElement>('a[href^="https:"]')!);
    expect(overlay()).toBeNull();
  });

  test("a click that ends a text selection in code opens nothing; a plain click does", async () => {
    const { article } = await mount();
    const pre = await marked(article, "pre");
    getSelection()!.selectAllChildren(pre);
    pre.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).toBeNull();
    getSelection()!.removeAllRanges();
    pre.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()?.dataset["kind"]).toBe("code");
  });
});

describe("followers (decisions 106 and 129)", () => {
  // A block in the document view has no slide address; 106 names a block by its slide.
  test("opening a block in the document view announces nothing to the mirror", async () => {
    const { article } = await mount();
    const events: FocusEvent[] = [];
    cleanups.push(observeFocus((event) => events.push(event)));
    await userEvent.click(await marked(article, "pre"));
    expect(overlay()?.dataset["kind"]).toBe("code");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(article.querySelector<HTMLElement>(".docwalk-diagram")!);
    expect(overlay()?.dataset["kind"]).toBe("diagram");
    expect(events.filter((e) => e.kind === "open" || e.kind === "close")).toEqual([]);
  });
});

describe("closing with the document (decision 129)", () => {
  // The copy in the view is of a document that is gone. On a slide a diagram view outlives a
  // rebuild (decision 87); in the document view every kind closes.
  test("a new render closes an open diagram view", async () => {
    const { article, show, drawn } = await mount();
    await userEvent.click(article.querySelector<HTMLElement>(".docwalk-diagram")!);
    expect(overlay()).not.toBeNull();
    const before = drawn();
    show(DOC.replace("The end.", "The end, edited."));
    await expect.poll(drawn, { timeout: 20_000 }).toBeGreaterThan(before);
    expect(overlay()).toBeNull();
  });

  test("a new render closes an open code view", async () => {
    const { article, show } = await mount();
    await userEvent.click(await marked(article, "pre"));
    expect(overlay()).not.toBeNull();
    show(DOC.replace("The end.", "The end, edited."));
    await expect.poll(overlay).toBeNull();
  });

  test("leaving the document view closes the view, and the page behind is usable again", async () => {
    const { article, pane } = await mount();
    await userEvent.click(article.querySelector<HTMLElement>(".docwalk-diagram")!);
    expect(overlay()).not.toBeNull();
    root!.unmount();
    root = null;
    await expect.poll(overlay).toBeNull();
    expect(pane.inert).toBe(false);
  });
});

/** A deck mounted beside the document view, as App keeps it while the document shows. */
async function mountDeck() {
  const deckBox = document.createElement("div");
  Object.assign(deckBox.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(deckBox);
  const deckRoot = createRoot(deckBox);
  cleanups.push(() => deckRoot.unmount());
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  const show = (md: string) =>
    deckRoot.render(h(Deck, { plan: sectionize(parseMarkdown(md), "auto"), onReady }));
  show(DOC);
  await expect.poll(() => readies.length, { timeout: 20_000 }).toBeGreaterThan(0);
  return { readies, show };
}

describe("the hidden deck beside the document view (decision 129)", () => {
  // App keeps the deck mounted, hidden, while the document view shows. A slide change (a
  // remote, the URL sync after a rebuild) or a rebuild of that deck closed whatever content
  // view was open, so a listing the reader had just opened from the document closed by itself.
  // On a slide, a view still closes on both (focusTargets.browser.test.ts: "a rebuild closes
  // the view and the new deck takes focus", "moving to another slide closes the view and focus
  // lands in the deck").
  test("a slide change of the deck leaves a code view opened from the document open", async () => {
    const deck = await mountDeck();
    const { article } = await mount();
    await userEvent.click(await marked(article, "pre"));
    expect(overlay()?.dataset["kind"]).toBe("code");
    deck.readies.at(-1)!.next();
    await new Promise((r) => setTimeout(r, 50));
    expect(overlay()).not.toBeNull();
  });

  test("a rebuild of the deck leaves a code view opened from the document open", async () => {
    const deck = await mountDeck();
    const { article } = await mount();
    await userEvent.click(await marked(article, "pre"));
    expect(overlay()?.dataset["kind"]).toBe("code");
    deck.show(DOC.replace("The end.", "The end, edited."));
    await expect.poll(() => deck.readies.length, { timeout: 20_000 }).toBeGreaterThan(1);
    expect(overlay()).not.toBeNull();
  });
});
