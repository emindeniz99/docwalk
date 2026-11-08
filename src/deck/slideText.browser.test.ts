import { afterEach, describe, expect, test } from "vitest";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { createDeckController } from "./controller";
import { buildSlides } from "./slides";
import { slideText } from "./slideText";

afterEach(() => {
  document.body.replaceChildren();
});

const pagesOf = (markdown: string) => buildSlides(sectionize(parseMarkdown(markdown), "auto"));

const reveal = {
  getIndices: () => ({ h: 0 }),
  slide() {},
  next() {},
  prev() {},
  on() {},
  off() {},
};

describe("slideText: the words a reader sees on one page (decision 81)", () => {
  test("block elements are separated, so the last word of one paragraph never fuses with the next", () => {
    const [cover, page] = pagesOf(
      "# Deck\n\n## Alpha\n\nfirst paragraph\n\n- item one\n- item two\n",
    );
    expect(cover).toBeDefined();
    const text = slideText(page!);
    expect(text).toContain("first paragraph item one item two");
  });

  test("inline markup does not split a word", () => {
    const [, page] = pagesOf("# Deck\n\n## Alpha\n\nre**tri**es and `code`s\n");
    expect(slideText(page!)).toContain("retries and codes");
  });

  test("table cells and code lines are separated and searchable", () => {
    const md = [
      "# Deck",
      "",
      "## Alpha",
      "",
      "| Failure | Retry? |",
      "| --- | --- |",
      "| timeout | yes |",
      "",
      "```ts",
      "const retries = 3;",
      "retryBudget(retries);",
      "```",
    ].join("\n");
    const text = slideText(pagesOf(md)[1]!);
    expect(text).toContain("Failure Retry? timeout yes");
    expect(text).toContain("const retries = 3; retryBudget(retries);");
  });

  test("whitespace runs collapse to one space and the ends are trimmed", () => {
    const text = slideText(pagesOf("# Deck\n\n## Alpha\n\na    b\nc\n")[1]!);
    expect(text).not.toMatch(/\s{2}/);
    expect(text).toBe(text.trim());
    expect(text).toContain("a b c");
  });

  test("the breadcrumb, the continued marker and the overflow note are not page text", () => {
    const md = "# Deck\n\n## Alpha\n\nbefore the break\n\n---\n\nafter the break\n";
    const pages = pagesOf(md);
    const parts = pages.filter((p) => p.dataset["title"] === "Alpha");
    expect(parts.length).toBe(2);
    const second = parts[1]!;
    expect(second.querySelector(".docwalk-continued")).not.toBeNull();
    // An overflow note, as flagPages would write it.
    const note = second.querySelector<HTMLElement>(".docwalk-overflow")!;
    note.hidden = false;
    note.textContent = "Does not fit: 40 px too tall.";
    const text = slideText(second);
    expect(text).toContain("after the break");
    expect(text).not.toContain("continued");
    expect(text).not.toContain("Does not fit");
    for (const part of parts) expect(slideText(part)).not.toContain("Deck ›");
  });

  test("a rendered diagram contributes nothing, the paragraph around it does", () => {
    const [, page] = pagesOf("# Deck\n\n## Alpha\n\nabove the diagram\n\nbelow the diagram\n");
    // renderDiagrams swaps the fence for a figure holding the SVG, its stylesheet and labels.
    const figure = document.createElement("figure");
    figure.className = "docwalk-diagram";
    figure.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:red}</style><text>Gateway node</text></svg>';
    page!.querySelector(".docwalk-slide-body")!.append(figure);
    const text = slideText(page!);
    expect(text).toContain("above the diagram below the diagram");
    expect(text).not.toContain("Gateway");
    expect(text).not.toContain("fill");
  });

  test("speaker notes never reach the text (decision 79)", () => {
    const md = "# Deck\n\n## Alpha\n\n<!-- say the secret aloud -->\n\nvisible words\n";
    const text = slideText(pagesOf(md)[1]!);
    expect(text).toContain("visible words");
    expect(text).not.toContain("secret");
  });

  test("hostile markup is text: the sanitized page holds no script, and the text holds no tags", () => {
    const md =
      '# Deck\n\n## Alpha\n\n<img src=x onerror="window.owned = 1"> and `<img src=x onerror=1>`\n';
    const text = slideText(pagesOf(md)[1]!);
    expect(text).toContain("<img src=x onerror=1>");
    expect((window as { owned?: number }).owned).toBeUndefined();
  });

  test("text is NFC, so an accent typed either way finds it", () => {
    const text = slideText(pagesOf("# Deck\n\n## Alpha\n\ncafé\n")[1]!);
    expect(text).toContain("café");
  });
});

describe("SlideInfo.text: read on first use, once", () => {
  test("is read when a search first asks, not when the deck is built, and is kept after that", () => {
    const stage = document.createElement("div");
    const section = document.createElement("section");
    section.dataset["docwalkId"] = "alpha";
    section.dataset["page"] = "2";
    section.innerHTML =
      '<div class="docwalk-slide"><div class="docwalk-slide-body"><p>one</p></div></div>';
    stage.append(section);
    document.body.append(stage);
    const [info] = createDeckController(reveal, [section], stage).slides();
    expect(info?.address).toBe("alpha/2");
    // Changed after the controller exists but before anyone read the text: a lazy read sees it.
    section.querySelector("p")!.textContent = "two";
    expect(info?.text).toBe("two");
    // Read once, kept: a second read does no new walk.
    section.querySelector("p")!.textContent = "three";
    expect(info?.text).toBe("two");
  });
});
