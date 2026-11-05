import { fc, test as fcTest } from "@fast-check/vitest";
import { afterEach, describe, expect, test } from "vitest";
import fixture from "../../fixtures/ledger-redesign.md?raw";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
// Same fonts as the app, so measurements and pagination match what users see.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { fitDiagrams, measureOffscreen, settled, slideBodySize } from "./measure";
import { renderDiagrams } from "./mermaid";
import { paginateSlide } from "./paginate";
import { buildSlide, buildSlides } from "./slides";

const SIZE = { width: 1280, height: 720 };

afterEach(() => {
  document.body.replaceChildren();
});

function slideFor(markdown: string): HTMLElement {
  const section = sectionize(parseMarkdown(markdown)).sections[0];
  return buildSlide(section as never);
}

const bodyOf = (page: HTMLElement) => page.querySelector(".docwalk-slide-body") as HTMLElement;
const items = (pages: HTMLElement[], selector: string) =>
  pages.flatMap((p) => [...bodyOf(p).querySelectorAll(selector)].map((e) => e.textContent?.trim()));
const fitsAll = (pages: HTMLElement[]) =>
  measureOffscreen(pages.map(bodyOf), SIZE).map((m) => m.overflows);

describe("semantic pagination", () => {
  test("a slide that fits is returned unchanged", () => {
    const slide = slideFor("## Short\n\nOne paragraph.\n");
    expect(paginateSlide(slide, { size: SIZE })).toEqual([slide]);
  });

  test("a long list splits between items: every item kept once, in order, every page fits", () => {
    const n = 60;
    const md = `## Problems\n\n${Array.from({ length: n }, (_, i) => `1. Problem number ${i + 1}`).join("\n")}\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    expect(pages.length).toBeGreaterThan(1);
    expect(items(pages, "li")).toEqual(
      Array.from({ length: n }, (_, i) => `Problem number ${i + 1}`),
    );
    expect(fitsAll(pages)).toEqual(pages.map(() => false));
    // Numbering continues across pages instead of restarting at 1.
    const secondList = bodyOf(pages[1] as HTMLElement).querySelector("ol");
    expect(Number(secondList?.getAttribute("start"))).toBeGreaterThan(1);
  });

  test("continuation pages are titled '· continued' and keep the breadcrumb", () => {
    const md = `# Doc\n\nintro\n\n## Problems\n\n${"- item\n".repeat(60)}`;
    const section = sectionize(parseMarkdown(md)).sections[1];
    const pages = paginateSlide(buildSlide(section as never), { size: SIZE });
    expect(bodyOf(pages[1] as HTMLElement).querySelector(".docwalk-part-title")?.textContent).toBe(
      "Problems · continued",
    );
    expect(pages.every((p) => p.querySelector(".docwalk-breadcrumb")?.textContent === "Doc")).toBe(
      true,
    );
    expect(pages.map((p) => p.dataset["page"])).toEqual(pages.map((_, i) => String(i + 1)));
  });

  test("a long table splits by row and repeats its header on every page", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `| flag.${i} | value ${i} |`).join("\n");
    const pages = paginateSlide(slideFor(`## Flags\n\n| Flag | Default |\n|---|---|\n${rows}\n`), {
      size: SIZE,
    });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(bodyOf(page).querySelector("thead")?.textContent).toContain("Flag");
    }
    expect(items(pages, "tbody td:first-child")).toEqual(
      Array.from({ length: 50 }, (_, i) => `flag.${i}`),
    );
    expect(fitsAll(pages)).toEqual(pages.map(() => false));
  });

  test("an overflowing section splits at its sub-headings first, parent title in the breadcrumb", () => {
    const filler = "A paragraph of explanation that takes some room.\n\n".repeat(6);
    const md = `# Doc\n\nx\n\n## Failure handling\n\nintro\n\n### Retries\n\n${filler}### Timeouts\n\n${filler}### Poison messages\n\n${filler}`;
    const section = sectionize(parseMarkdown(md)).sections[1];
    const pages = paginateSlide(buildSlide(section as never), { size: SIZE });
    const firstHeadings = pages.map((p) => bodyOf(p).querySelector("h2, h3")?.textContent);
    expect(firstHeadings).toEqual(
      expect.arrayContaining(["Failure handling", "Retries", "Timeouts", "Poison messages"]),
    );
    const retries = pages.find((p) => bodyOf(p).querySelector("h3")?.textContent === "Retries");
    expect(retries?.querySelector(".docwalk-breadcrumb")?.textContent).toBe(
      "Doc › Failure handling",
    );
  });

  test("a heading with no text before its first sub-heading does not become a title-only page", () => {
    const filler = "A paragraph of explanation that takes some room.\n\n".repeat(7);
    const md = `## Failure handling\n\n### Retries\n\n${filler}### Timeouts\n\n${filler}`;
    // Slide level 2 as in the fixture, where other H2s carry text; alone, Pandoc's rule would pick H3.
    const section = sectionize(parseMarkdown(md), 2).sections[0];
    const pages = paginateSlide(buildSlide(section as never), { size: SIZE });
    const first = bodyOf(pages[0] as HTMLElement);
    expect(first.querySelector("h2")?.textContent).toBe("Failure handling");
    expect(first.querySelector("h3")?.textContent).toBe("Retries");
    expect(first.querySelectorAll("p").length).toBeGreaterThan(0);
  });

  test("an atomic block taller than a slide gets its own page and keeps its overflow", () => {
    const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const md = `## Config\n\nBefore.\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter.\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    const withCode = pages.filter((p) => bodyOf(p).querySelector("pre"));
    expect(withCode).toHaveLength(1);
    expect(
      bodyOf(withCode[0] as HTMLElement)
        .querySelector("pre")
        ?.textContent?.trimEnd(),
    ).toBe(code);
    // Honest: the code page still overflows, so its diagnostic will show. Nothing was cut.
    expect(measureOffscreen([bodyOf(withCode[0] as HTMLElement)], SIZE)[0]?.overflows).toBe(true);
    expect(items(pages, "p")).toEqual(["Before.", "After."]);
  });

  test("a list whose first item is taller than a slide still splits: the short items after it get pages that fit", () => {
    // A numbered procedure whose first step holds a long code block. The tall
    // step can only overflow on its own; the 25 steps after it must not be
    // buried under it, and the slide title must not sit alone on a page.
    const code = Array.from({ length: 60 }, (_, i) => `    line ${i}`).join("\n");
    const rest = Array.from({ length: 25 }, (_, i) => `${i + 2}. Step ${i + 2}`).join("\n");
    const md = `## Steps\n\n1. Step 1\n\n    \`\`\`\n${code}\n    \`\`\`\n\n${rest}\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    const overflows = fitsAll(pages);

    const itemsPerPage = pages.map((p) => bodyOf(p).querySelectorAll("li").length);
    // The title shares a page with step 1, which overflows alone; no other page overflows.
    expect(itemsPerPage[0]).toBe(1);
    expect(itemsPerPage.filter((_, i) => overflows[i])).toEqual([1]);
    // Numbering continues after the tall step.
    expect(
      bodyOf(pages[1] as HTMLElement)
        .querySelector("ol")
        ?.getAttribute("start"),
    ).toBe("2");
  });
});

const tokensOf = (pages: HTMLElement[]) =>
  pages.flatMap((p) => {
    const body = bodyOf(p).cloneNode(true) as HTMLElement;
    for (const t of body.querySelectorAll(".docwalk-part-title")) t.remove();
    // Text nodes joined with spaces: textContent would glue "Slide" and "t0" into one word.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const text: string[] = [];
    while (walker.nextNode()) text.push(walker.currentNode.textContent ?? "");
    return text.join(" ").match(/\bt\d+\b/g) ?? [];
  });

/** Body blocks other than headings: what a page actually shows. */
const contentOf = (page: HTMLElement) =>
  [...bodyOf(page).children].filter((c) => !/^H[1-6]$/.test(c.tagName));

/** A block pagination cannot split any further. */
const indivisible = (b: Element) =>
  /^(UL|OL)$/.test(b.tagName)
    ? b.querySelectorAll(":scope > li").length === 1
    : b.tagName === "TABLE"
      ? b.querySelectorAll("tbody > tr").length === 1
      : true;

/**
 * Decision 40: pagination is checked as properties over generated slides, not
 * only on hand-picked examples, because the failure modes (a lost list item, a
 * duplicated table row, a slide that scrolls for metres) come from shapes
 * nobody thought to write down. Every leaf carries a unique token `t<n>`, so
 * one ordered comparison proves nothing was lost, duplicated or reordered.
 */
describe("pagination properties", () => {
  type Block =
    | { kind: "p"; words: number }
    | { kind: "code"; lines: number }
    | { kind: "table"; rows: number }
    | { kind: "list"; ordered: boolean; items: number[] }
    | { kind: "h3" };

  const block: fc.Arbitrary<Block> = fc.oneof(
    fc.record({ kind: fc.constant("p" as const), words: fc.integer({ min: 1, max: 60 }) }),
    fc.record({ kind: fc.constant("code" as const), lines: fc.integer({ min: 1, max: 45 }) }),
    fc.record({ kind: fc.constant("table" as const), rows: fc.integer({ min: 1, max: 35 }) }),
    fc.record({
      kind: fc.constant("list" as const),
      ordered: fc.boolean(),
      // Lines of code inside each item: mostly none, sometimes taller than a slide.
      items: fc.array(
        fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, fc.integer({ min: 1, max: 45 })),
        {
          minLength: 1,
          maxLength: 30,
        },
      ),
    }),
    fc.record({ kind: fc.constant("h3" as const) }),
  );

  /** Markdown for the generated slide, and the tokens it holds in document order. */
  function render(blocks: Block[]): { md: string; tokens: string[] } {
    const tokens: string[] = [];
    const tok = () => {
      const t = `t${tokens.length}`;
      tokens.push(t);
      return t;
    };
    const fence = (lines: number, indent: string) =>
      [
        `${indent}\`\`\``,
        ...Array.from({ length: lines }, () => `${indent}${tok()}`),
        `${indent}\`\`\``,
      ].join("\n");
    const parts = ["## Slide"];
    for (const [i, b] of blocks.entries()) {
      if (b.kind === "p") parts.push([tok(), ...Array(b.words - 1).fill("word")].join(" "));
      if (b.kind === "code") parts.push(fence(b.lines, ""));
      if (b.kind === "table") {
        const rows = Array.from({ length: b.rows }, () => `| ${tok()} | value |`);
        parts.push(["| Key | Value |", "|---|---|", ...rows].join("\n"));
      }
      if (b.kind === "list") {
        const marker = (n: number) => (b.ordered ? `${n + 1}.` : "-");
        const lines = b.items.map((code, n) => {
          const head = `${marker(n)} ${tok()}`;
          const indent = " ".repeat(marker(n).length + 1);
          return code > 0 ? `${head}\n\n${fence(code, indent)}\n` : head;
        });
        parts.push(lines.join("\n"));
      }
      // A sub-heading always has a block after it, so no group is a bare heading by construction.
      if (b.kind === "h3") parts.push(`### Part ${tok()}`, `${tok()} intro`);
      if (i < blocks.length - 1 && b.kind === "list" && blocks[i + 1]?.kind === "list") {
        parts.push("<!-- -->"); // keeps two adjacent lists from merging into one
      }
    }
    return { md: `${parts.join("\n\n")}\n`, tokens };
  }

  fcTest.prop([fc.array(block, { minLength: 1, maxLength: 8 })], { numRuns: 100 })(
    "no content is lost or duplicated; a page either fits or holds one block that cannot be split; no page is a bare title",
    (blocks) => {
      const { md, tokens } = render(blocks);
      // Slide level 2 forced, so `###` parts stay inside this one slide.
      const slide = buildSlide(sectionize(parseMarkdown(md), 2).sections[0] as never);
      expect(tokensOf([slide]), "generator: the unsplit slide holds every token").toEqual(tokens);
      const pages = paginateSlide(slide, { size: SIZE });

      expect(tokensOf(pages)).toEqual(tokens);

      // An overflowing page carries the diagnostic, so it must be as small as
      // pagination can make it: one block that cannot be split further.
      const overflows = fitsAll(pages);
      const problems = pages.flatMap((page, i) => {
        const content = contentOf(page);
        if (content.length === 0) return [`page ${i + 1} is title-only`];
        if (!overflows[i]) return [];
        if (content.length > 1) return [`page ${i + 1} overflows with ${content.length} blocks`];
        const only = content[0] as Element;
        return indivisible(only)
          ? []
          : [`page ${i + 1} overflows with a splittable ${only.tagName}`];
      });
      expect(problems).toEqual([]);
    },
    60_000,
  );
});

describe("acceptance fixture", () => {
  test("after pagination only atomic content overflows, and no text is lost", async () => {
    const slides = buildSlides(sectionize(parseMarkdown(fixture)));
    const container = document.createElement("div");
    container.append(...slides);
    document.body.append(container);
    await renderDiagrams(container);
    fitDiagrams(container, slideBodySize(SIZE));
    await settled(container);

    const textOf = (els: HTMLElement[]) =>
      els
        .flatMap((s) => [...bodyOf(s).querySelectorAll("li, td, p, pre")])
        .map((e) => e.textContent?.trim())
        .filter((t) => t && !t.endsWith("· continued"));
    const before = textOf(slides);

    const pages = slides.flatMap((s) => paginateSlide(s, { size: SIZE }));
    expect(pages.length).toBeGreaterThan(slides.length);
    expect(textOf(pages)).toEqual(before);

    const measurements = measureOffscreen(pages.map(bodyOf), SIZE);
    const stillOverflowing = pages.filter((_, i) => measurements[i]?.overflows);
    for (const page of stillOverflowing) {
      // Whatever still overflows must be a single atomic block or a too-wide element.
      const blocks = [...bodyOf(page).children].filter(
        (c) => !c.classList.contains("docwalk-part-title"),
      );
      const atomic = blocks.some((b) =>
        ["PRE", "FIGURE", "TABLE", "BLOCKQUOTE", "DETAILS"].includes(b.tagName),
      );
      expect(atomic, `${page.dataset["docwalkId"]}/${page.dataset["page"]}`).toBe(true);
    }
  });
});
