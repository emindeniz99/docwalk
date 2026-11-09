import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { annotationShortcut } from "../annotate/useAnnotationShortcuts";
import { offline, prepareSlide } from "../export/pages";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { clonePages, type DeckController } from "./controller";
import { Deck } from "./Deck";
import { findBlock, locateBlock } from "./focusTargets";
import { isOverviewKey } from "./useOverviewShortcut";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete (globalThis as { pwned?: number }).pwned;
});

function mountDeck(markdown: string, size = { width: 1280, height: 800 }) {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  root = createRoot(container);
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  const show = (md: string) =>
    act(() => root!.render(h(Deck, { plan: sectionize(parseMarkdown(md), "auto"), onReady })));
  show(markdown);
  const ready = async (n = 1) => {
    await expect
      .poll(() => readies.length, { timeout: 20_000, interval: 10 })
      .toBeGreaterThanOrEqual(n);
  };
  return { container, show, ready, readies };
}

const CODE = [
  "## Code",
  "",
  "```ts",
  "const a = 1;",
  "",
  "function f() {",
  '  return "x";',
  "}",
  "```",
  "",
  "## Next",
  "",
  "More.",
  "",
].join("\n");

const TABLE =
  "## Table\n\n| Region | p50 | p99 |\n| --- | --- | --- |\n| eu | 12 | 80 |\n| us | 15 | 91 |\n\n## Next\n\nMore.\n";
const IMAGE = "## Image\n\n![Company logo](/icons/icon-192.png)\n\n## Next\n\nMore.\n";

const cell = (i: number) => `${"w".repeat(11)}${i % 10}`;
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const WIDE_TABLE = (columns: number) => {
  const head = Array.from({ length: columns }, (_, i) => cell(i));
  return `## Wide\n\n${[row(head), row(head.map(() => "---")), row(head), row(head)].join("\n")}\n`;
};

const overlay = () => document.querySelector<HTMLElement>(".docwalk-focus");
const present = (deck: { container: HTMLElement }) =>
  deck.container.querySelector<HTMLElement>(".reveal .slides section.present")!;
const lines = () => [
  ...document.querySelectorAll<HTMLElement>(".docwalk-focus .docwalk-code-line"),
];
const marked = () => lines().filter((l) => l.getAttribute("aria-pressed") === "true");
const clearButton = () =>
  document.querySelector<HTMLElement>('.docwalk-focus [aria-label="Clear all marked lines"]')!;

const KINDS = [
  { kind: "code", doc: CODE, selector: "pre", label: "Code, full screen" },
  { kind: "table", doc: TABLE, selector: "table", label: "Table, full screen" },
  { kind: "image", doc: IMAGE, selector: "img", label: "Image, full screen" },
] as const;

describe.each(KINDS)("the $kind focus view reuses the diagram view", ({ doc, selector, label }) => {
  test("a click opens it, the Close button closes it and focus returns to the block", async () => {
    // The view is the diagram's: same dialog, same Close button, same focus return.
    const deck = mountDeck(doc);
    await deck.ready();
    const block = present(deck).querySelector<HTMLElement>(selector)!;
    await userEvent.click(block);
    const dialog = overlay()!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe(label);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await userEvent.click(dialog.querySelector<HTMLElement>('[aria-label="Close"]')!);
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(block);
  });

  test("Enter on the focused block opens it and Escape closes it, returning focus", async () => {
    // A block you can only open with the mouse is out of reach for a keyboard user.
    const deck = mountDeck(doc);
    await deck.ready();
    const block = present(deck).querySelector<HTMLElement>(selector)!;
    expect(block.tabIndex).toBe(0);
    block.focus();
    await userEvent.keyboard("{Enter}");
    expect(overlay()).not.toBeNull();
    // The key's default action must not click the Close button the view just focused.
    await new Promise((r) => setTimeout(r, 50));
    expect(overlay()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(block);
  });

  test("Tab stays inside the view and the page behind it is inert", async () => {
    const deck = mountDeck(doc);
    await deck.ready();
    const block = present(deck).querySelector<HTMLElement>(selector)!;
    block.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = overlay()!;
    expect(block.closest("[inert]")).not.toBeNull();
    for (let i = 0; i < 9; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 9; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(block.closest("[inert]")).toBeNull();
  });

  test("arrow keys inside the view do not move the slides", async () => {
    // reveal.js and the clicker steer the deck by arrows; an open view must keep them.
    const deck = mountDeck(doc);
    await deck.ready();
    const controller = deck.readies.at(-1)!;
    const before = controller.current()!.index;
    await userEvent.click(present(deck).querySelector<HTMLElement>(selector)!);
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{PageDown}");
    expect(controller.current()!.index).toBe(before);
    expect(overlay()).not.toBeNull();
  });

  test("a rebuild closes the view and the new deck takes focus", async () => {
    // The copy comes from the old slide; after an edit it would show text the document lost.
    const deck = mountDeck(doc);
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>(selector)!);
    expect(overlay()).not.toBeNull();
    deck.show(doc.replace("More.", "More, edited."));
    await deck.ready(2);
    expect(overlay()).toBeNull();
    expect(deck.container.querySelector(".reveal")!.contains(document.activeElement)).toBe(true);
    expect([...document.body.children].some((el) => (el as HTMLElement).inert)).toBe(false);
  });

  test("moving to another slide closes the view and focus lands in the deck", async () => {
    // A remote or the presenter window can change the slide under an open view.
    const deck = mountDeck(doc);
    await deck.ready();
    const controller = deck.readies.at(-1)!;
    await userEvent.click(present(deck).querySelector<HTMLElement>(selector)!);
    controller.next();
    await expect.poll(() => overlay()).toBeNull();
    expect(deck.container.querySelector(".reveal")!.contains(document.activeElement)).toBe(true);
    expect([...document.body.children].some((el) => (el as HTMLElement).inert)).toBe(false);
  });

  test("the copy carries no id, no tab stop and no mark of the slide", async () => {
    // The slide keeps its ids; a copy beside it must not repeat them (decision 83's known gap).
    const deck = mountDeck(doc);
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>(selector)!);
    const stage = overlay()!.querySelector<HTMLElement>(".docwalk-focus-stage")!;
    expect(stage.querySelector("[id]")).toBeNull();
    expect(stage.querySelector("[data-docwalk-focus]")).toBeNull();
  });
});

describe("what a click on a block does not open", () => {
  test("a link inside a table follows the link and opens nothing", async () => {
    const deck = mountDeck("## T\n\n| A |\n| --- |\n| [home](#t) |\n");
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("table a")!);
    expect(overlay()).toBeNull();
  });

  test("a click that ends a text selection opens nothing", async () => {
    const deck = mountDeck(CODE);
    await deck.ready();
    const pre = present(deck).querySelector<HTMLElement>("pre")!;
    getSelection()!.selectAllChildren(pre);
    pre.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).toBeNull();
  });

  test("an image inside a link is not marked and its link is not taken over", async () => {
    const deck = mountDeck("## L\n\n[![logo](/icons/icon-192.png)](https://example.invalid/)\n");
    await deck.ready();
    const img = present(deck).querySelector<HTMLElement>("img")!;
    expect(img.hasAttribute("data-docwalk-focus")).toBe(false);
  });

  test("a remote image waiting for the viewer is not marked and does not open", async () => {
    // Decision 33: the click loads it. The focus view must not be a way round that.
    const deck = mountDeck("## R\n\n![Chart](https://images.invalid/chart.png)\n");
    await deck.ready();
    const img = present(deck).querySelector<HTMLImageElement>("img")!;
    expect(img.classList.contains("docwalk-blocked-image")).toBe(true);
    expect(img.hasAttribute("data-docwalk-focus")).toBe(false);
    img.focus();
    await userEvent.keyboard("{Enter}");
    img.click();
    expect(overlay()).toBeNull();
    expect(img.getAttribute("src")).not.toBeNull(); // the click loaded it, as before
  });

  test("a code block that is a failed diagram is not a code block", async () => {
    const deck = mountDeck("## D\n\n```mermaid\nnot a diagram ((\n```\n");
    await deck.ready();
    expect(present(deck).querySelector("[data-docwalk-focus=code]")).toBeNull();
  });
});

async function openCode(doc = CODE) {
  const deck = mountDeck(doc);
  await deck.ready();
  await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
  return deck;
}

const bar = (line: HTMLElement) => getComputedStyle(line).borderInlineStartColor;

describe("line marks in code", () => {
  test("each line is its own toggle with a name, and the text is unchanged", async () => {
    // Marking by line needs no line numbers; copying the view must give the original text back.
    const deck = mountDeck(CODE);
    await deck.ready();
    const original = present(deck).querySelector("pre")!.textContent;
    await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
    expect(lines().length).toBe(5);
    expect(
      lines()
        .map((l) => l.textContent)
        .join(""),
    ).toBe(original);
    expect(lines()[0]!.getAttribute("role")).toBe("button");
    expect(lines()[0]!.getAttribute("aria-label")).toBe("Line 1: const a = 1;\n".trimEnd());
    expect(lines()[1]!.getAttribute("aria-label")).toBe("Line 2, empty");
    expect(marked().length).toBe(0);
  });

  test("syntax colours survive the split into lines", async () => {
    await openCode();
    expect(document.querySelector(".docwalk-focus .dw-code-keyword")).not.toBeNull();
    const span = document.querySelector<HTMLElement>(".docwalk-focus .dw-code-keyword")!;
    expect(getComputedStyle(span).color).not.toBe(
      getComputedStyle(document.querySelector(".docwalk-focus pre")!).color,
    );
  });

  test("a click marks a line, a second line joins it, a second click unmarks", async () => {
    await openCode();
    await userEvent.click(lines()[0]!);
    await userEvent.click(lines()[3]!);
    expect(marked()).toEqual([lines()[0], lines()[3]]);
    // A mark is a fill and a bar, not colour alone: the bar differs from an unmarked line's.
    expect(bar(lines()[0]!)).not.toBe(bar(lines()[1]!));
    expect(getComputedStyle(lines()[0]!).backgroundColor).not.toBe(
      getComputedStyle(lines()[1]!).backgroundColor,
    );
    await userEvent.click(lines()[0]!);
    expect(marked()).toEqual([lines()[3]]);
  });

  test("Clear removes every mark and is unavailable while nothing is marked", async () => {
    await openCode();
    expect((clearButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(lines()[1]!);
    await userEvent.click(lines()[2]!);
    expect((clearButton() as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(clearButton());
    expect(marked().length).toBe(0);
    expect((clearButton() as HTMLButtonElement).disabled).toBe(true);
  });

  test("arrow keys move between lines, Space and Enter mark, with one tab stop", async () => {
    await openCode();
    const stops = () => lines().filter((l) => l.tabIndex === 0);
    expect(stops().length).toBe(1);
    lines()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(lines()[2]);
    expect(stops()).toEqual([lines()[2]]);
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(marked()).toEqual([lines()[2], lines()[3]]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(lines()[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(lines().at(-1));
    expect(overlay()).not.toBeNull();
  });

  test("marks belong to the open view: closing and opening again starts clean", async () => {
    // The Markdown and the address stay untouched (rule 1), and nothing outlives the view.
    const deck = await openCode();
    await userEvent.click(lines()[0]!);
    expect(marked().length).toBe(1);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
    expect(marked().length).toBe(0);
    expect(location.hash).toBe("");
  });

  test("a code block with markup in it stays text in the copy", async () => {
    // Rule 5: lines are built from text nodes; markup in the listing never becomes an element.
    const deck = mountDeck(
      '## X\n\n```html\n<img src=x onerror="globalThis.pwned = 1">\n<script>globalThis.pwned = 2</script>\n```\n',
    );
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
    const stage = overlay()!.querySelector<HTMLElement>(".docwalk-focus-stage")!;
    expect(stage.querySelector("img, script")).toBeNull();
    expect(stage.textContent).toContain("<script>globalThis.pwned = 2</script>");
    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("tables", () => {
  test("a table with a footnote link gets no duplicate id and no dead in-page link", async () => {
    const deck = mountDeck("## F\n\n| A |\n| --- |\n| cell[^1] |\n\n[^1]: Note.\n");
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("table")!);
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(overlay()!.querySelector('a[href^="#"]')).toBeNull();
  });

  test("hostile cell markup never runs in the copy", async () => {
    const deck = mountDeck(
      '## H\n\n<table><tr><td><img src="/icons/icon-192.png" onerror="globalThis.pwned = 1">' +
        '<a href="javascript:globalThis.pwned = 2">go</a><script>globalThis.pwned = 3</script>' +
        "</td></tr></table>\n",
    );
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("table")!);
    const copy = overlay()!;
    expect(copy.innerHTML).not.toMatch(/onerror|javascript:|<script/i);
    copy.querySelector<HTMLElement>("a")?.click();
    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  test("a table wider than the slide keeps its note and opens at a size that scrolls sideways", async () => {
    // Measured: with 12-character cells, 6 columns are 1238 px against a 1152 px body.
    // The note stays (rule 3); the view is how the presenter shows the table whole.
    const deck = mountDeck(WIDE_TABLE(8));
    await deck.ready();
    const slide = present(deck);
    const body = slide.querySelector<HTMLElement>(".docwalk-slide-body")!;
    const table = slide.querySelector<HTMLElement>("table")!;
    expect(table.offsetWidth).toBeGreaterThan(body.clientWidth + 4);
    expect(slide.querySelector<HTMLElement>(".docwalk-overflow")!.hidden).toBe(false);
    await userEvent.click(table);
    const stage = overlay()!.querySelector<HTMLElement>(".docwalk-focus-stage")!;
    expect(stage.scrollWidth).toBeGreaterThan(stage.clientWidth);
    stage.scrollLeft = stage.scrollWidth;
    const lastCell = stage.querySelector<HTMLElement>("tr:last-child td:last-child")!;
    const box = lastCell.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(stage.getBoundingClientRect().right + 1);
    // Type no smaller than the slide's own table type (0.75em of 26 px) times the Fit floor.
    expect(parseFloat(getComputedStyle(lastCell).fontSize)).toBeGreaterThanOrEqual(14);
  });

  test("a short table opens larger than it sits on the slide", async () => {
    const deck = mountDeck(TABLE);
    await deck.ready();
    const table = present(deck).querySelector<HTMLElement>("table")!;
    const before = parseFloat(getComputedStyle(table).fontSize);
    await userEvent.click(table);
    const copy = overlay()!.querySelector<HTMLElement>("table")!;
    expect(parseFloat(getComputedStyle(copy).fontSize)).toBeGreaterThan(before);
  });

  test("zoom in and out change the type size and Fit returns to the opening size", async () => {
    const deck = mountDeck(TABLE);
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("table")!);
    const size = () =>
      parseFloat(getComputedStyle(overlay()!.querySelector<HTMLElement>("table")!).fontSize);
    const start = size();
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Zoom in"]')!);
    expect(size()).toBeGreaterThan(start);
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Zoom out"]')!);
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Zoom out"]')!);
    expect(size()).toBeLessThan(start);
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Fit to screen"]')!);
    expect(size()).toBeCloseTo(start, 1);
  });
});

describe("images", () => {
  test("the view draws the image the slide already loaded, from the same address", async () => {
    const deck = mountDeck(IMAGE);
    await deck.ready();
    const img = present(deck).querySelector<HTMLImageElement>("img")!;
    expect(img.complete && img.naturalWidth > 0).toBe(true);
    await userEvent.click(img);
    const copy = overlay()!.querySelector<HTMLImageElement>("img")!;
    expect(copy.src).toBe(img.currentSrc);
    expect(copy.alt).toBe("Company logo");
  });

  test("an image is named for screen readers with its alt text", async () => {
    const deck = mountDeck(IMAGE);
    await deck.ready();
    const img = present(deck).querySelector<HTMLImageElement>("img")!;
    expect(img.getAttribute("role")).toBe("button");
    expect(img.getAttribute("aria-label")).toBe(
      "Company logo. Press Enter to open it full screen.",
    );
  });
});

describe("marks on the slide", () => {
  test("code, tables and images say how to open them", async () => {
    const deck = mountDeck(`${CODE}\n${TABLE.replace("## Table", "## Table")}\n${IMAGE}`);
    await deck.ready();
    const labels = (s: string) =>
      [...deck.container.querySelectorAll<HTMLElement>(s)].map((e) => e.getAttribute("aria-label"));
    expect(labels("pre[data-docwalk-focus]")).toContain(
      "Code. Press Enter to open it full screen.",
    );
    expect(labels("table[data-docwalk-focus]")).toContain(
      "Table. Press Enter to open it full screen.",
    );
  });

  test("a table the author named keeps that name", async () => {
    const deck = mountDeck(
      '## N\n\n<table aria-label="Latency by region"><tr><td>a</td></tr></table>\n',
    );
    await deck.ready();
    const table = present(deck).querySelector<HTMLElement>("table")!;
    expect(table.getAttribute("aria-label")).toBe("Latency by region");
    expect(table.tabIndex).toBe(0);
  });

  test("exports drop the marks: the pages are as they were before this feature", async () => {
    const deck = mountDeck(`${CODE}\n${IMAGE}\n${TABLE}`);
    await deck.ready();
    const [page] = clonePages(deck.readies.at(-1)!);
    prepareSlide(page!.element, offline);
    expect(page!.element.querySelector("[data-docwalk-focus]")).toBeNull();
    for (const el of page!.element.querySelectorAll("pre, table, img")) {
      expect(el.hasAttribute("tabindex")).toBe(false);
      expect(el.hasAttribute("role")).toBe(false);
      expect(el.hasAttribute("aria-label")).toBe(false);
    }
  });
});

function keyIn(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  target.dispatchEvent(event);
  return event;
}

describe("shortcuts do not reach through an open view", () => {
  test("O (overview) and the pen letters ignore keys pressed inside the view", async () => {
    const deck = mountDeck(CODE);
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
    const inside = overlay()!.querySelector<HTMLElement>(".docwalk-code-line")!;
    expect(isOverviewKey(keyIn(inside, "o"))).toBe(false);
    for (const key of ["p", "l", "a", "e", "Escape"]) {
      expect(annotationShortcut(keyIn(inside, key))).toBeNull();
    }
    // Outside the view the same keys still count.
    expect(isOverviewKey(keyIn(document.body, "o"))).toBe(true);
    expect(annotationShortcut(keyIn(document.body, "p"))).toEqual({ mode: "pen" });
  });

  test("a key pressed in the view does not travel to listeners on the window", async () => {
    const deck = mountDeck(CODE);
    await deck.ready();
    await userEvent.click(present(deck).querySelector<HTMLElement>("pre")!);
    const seen: string[] = [];
    const listen = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", listen);
    lines()[0]!.focus();
    await userEvent.keyboard("o{ArrowDown}");
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual([]);
  });
});

/** A stage of pages as the deck builds it: `pages` lists each page's address and its inner HTML. */
function stageOf(pages: [string, string][]) {
  const stage = document.createElement("div");
  for (const [address, html] of pages) {
    const [id, page] = address.split("/");
    const section = document.createElement("section");
    section.dataset["docwalkId"] = id!;
    section.dataset["page"] = page!;
    section.innerHTML = html;
    stage.append(section);
  }
  document.body.append(stage);
  return stage;
}
const at = (stage: HTMLElement, address: string, selector: string, i: number) =>
  [...stage.querySelectorAll("section")]
    .find((s) => s.dataset["docwalkId"] + "/" + s.dataset["page"] === address)!
    .querySelectorAll<HTMLElement>(selector)[i]!;

describe("where a block sits (decision 106)", () => {
  test("code blocks, images and diagrams are numbered across the pages of their section, because they never split", () => {
    // The same section paginated two ways must give the same number to the same listing.
    const wide = stageOf([
      ["s/1", "<img><pre>A</pre><pre>B</pre>"],
      ["s/2", "<pre>C</pre><img>"],
      ["t/1", "<pre>other</pre>"],
    ]);
    const c = at(wide, "s/2", "pre", 0);
    expect(locateBlock(c, "code")).toEqual({ slide: "s/2", block: "code", n: 3 });
    expect(locateBlock(at(wide, "s/2", "img", 0), "image")).toEqual({
      slide: "s/2",
      block: "image",
      n: 2,
    });
    // Another section starts again at 1.
    expect(locateBlock(at(wide, "t/1", "pre", 0), "code")).toEqual({
      slide: "t/1",
      block: "code",
      n: 1,
    });
    const diagrams = stageOf([
      ["d/1", '<div class="docwalk-diagram"></div>'],
      ["d/2", '<div class="docwalk-diagram"></div>'],
    ]);
    expect(locateBlock(at(diagrams, "d/2", ".docwalk-diagram", 0), "diagram")?.n).toBe(2);
  });

  test("the number finds the same listing on a deck that paginates the section differently", () => {
    const theirs = stageOf([
      ["s/1", "<p>placeholder</p><pre>A</pre><pre>B</pre>"],
      ["s/2", "<pre>C</pre><pre>D</pre>"],
    ]);
    // Named on the presenter's page 2, found on this deck's page 1 or 2 alike.
    expect(findBlock(theirs, { slide: "s/2", block: "code", n: 3 })).toBe(
      at(theirs, "s/2", "pre", 0),
    );
    expect(findBlock(theirs, { slide: "s/3", block: "code", n: 2 })).toBe(
      at(theirs, "s/1", "pre", 1),
    );
    expect(findBlock(theirs, { slide: "s/1", block: "code", n: 5 })).toBeNull();
    expect(findBlock(theirs, { slide: "nowhere/1", block: "code", n: 1 })).toBeNull();
  });

  test("a table can split, so it is numbered on its own page", () => {
    const stage = stageOf([
      ["s/1", "<table></table><table></table>"],
      ["s/2", "<table></table>"],
    ]);
    const last = at(stage, "s/2", "table", 0);
    expect(locateBlock(last, "table")).toEqual({ slide: "s/2", block: "table", n: 1 });
    expect(findBlock(stage, { slide: "s/2", block: "table", n: 1 })).toBe(last);
    expect(findBlock(stage, { slide: "s/1", block: "table", n: 2 })).toBe(
      at(stage, "s/1", "table", 1),
    );
  });
});
