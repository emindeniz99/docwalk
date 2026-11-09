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
import { fragmentTarget } from "../render/fragments";
import { paginateSlide } from "./paginate";
import { buildSlide, buildSlides } from "./slides";

const SIZE = { width: 1280, height: 720 };

afterEach(() => {
  document.body.replaceChildren();
});

function slideFor(markdown: string): HTMLElement {
  const plan = sectionize(parseMarkdown(markdown));
  return buildSlide(plan.sections[0] as never, { definitions: plan.definitions });
}

const bodyOf = (page: HTMLElement) => page.querySelector(".docwalk-slide-body") as HTMLElement;
const items = (pages: HTMLElement[], selector: string) =>
  pages.flatMap((p) => [...bodyOf(p).querySelectorAll(selector)].map((e) => e.textContent?.trim()));
const headingsOn = (p: HTMLElement) =>
  [...bodyOf(p).querySelectorAll("h2:not(.docwalk-part-title), h3")].map((h) => h.textContent);
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
    // Each part fits a page, so the split happens only at sub-headings: no
    // "· continued" page, and every heading shows once, in order. (The short
    // intro shares the first page with Retries.)
    expect(pages.some((p) => bodyOf(p).querySelector(".docwalk-part-title"))).toBe(false);
    expect(
      pages.flatMap((p) => [...bodyOf(p).querySelectorAll("h2, h3")].map((h) => h.textContent)),
    ).toEqual(["Failure handling", "Retries", "Timeouts", "Poison messages"]);
    const timeouts = pages.find((p) => bodyOf(p).querySelector("h3")?.textContent === "Timeouts");
    expect(timeouts?.querySelector(".docwalk-breadcrumb")?.textContent).toBe(
      "Doc › Failure handling",
    );
  });

  test("short sub-heading parts that fit together share a page instead of one half-empty slide each", () => {
    // One long part forces the split; the short parts around it would each
    // have taken a slide of their own with two lines on it.
    const short = "A short note.\n\n";
    const long = "A paragraph of explanation that takes some room.\n\n".repeat(14);
    const md = `# Doc\n\nx\n\n## Failure handling\n\nintro\n\n### Retries\n\n${short}### Timeouts\n\n${short}### Poison messages\n\n${long}### Alerts\n\n${short}### Dashboards\n\n${short}`;
    const section = sectionize(parseMarkdown(md)).sections[1];
    const pages = paginateSlide(buildSlide(section as never), { size: SIZE });

    // Intro, Retries and Timeouts on the first page; Alerts and Dashboards together after the long part.
    expect(headingsOn(pages[0] as HTMLElement)).toEqual([
      "Failure handling",
      "Retries",
      "Timeouts",
    ]);
    expect(headingsOn(pages.at(-1) as HTMLElement)).toEqual(["Alerts", "Dashboards"]);
    // The merged page that opens with a sub-heading still names its parent.
    expect(pages.at(-1)?.querySelector(".docwalk-breadcrumb")?.textContent).toBe(
      "Doc › Failure handling",
    );
    // The page holding the slide heading needs no parent title in its breadcrumb.
    expect(pages[0]?.querySelector(".docwalk-breadcrumb")?.textContent).toBe("Doc");
    // Merging never trades a fitting page for an overflowing one, and pages stay numbered 1..n.
    expect(fitsAll(pages)).toEqual(pages.map(() => false));
    expect(pages.map((p) => p.dataset["page"])).toEqual(pages.map((_, i) => String(i + 1)));
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

/** Footnote texts in a page's list. */
const notesOn = (page: HTMLElement) =>
  [...page.querySelectorAll("[data-footnotes] > ol > li")].map((li) =>
    (li.querySelector("p")?.firstChild?.textContent ?? "").trim(),
  );
/** Citations in the page's own text, outside its footnote list. */
const citationsOn = (page: HTMLElement) =>
  [...bodyOf(page).querySelectorAll<HTMLAnchorElement>("a[data-footnote-ref]")].filter(
    (a) => !a.closest("[data-footnotes]"),
  );
/** The number a list item shows: its `value`, or its place in an `<ol>` without one. */
const shownNumber = (li: HTMLLIElement) =>
  li.hasAttribute("value") ? li.value : [...(li.parentElement?.children ?? [])].indexOf(li) + 1;

describe("footnotes on split slides (decision 107)", () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");

  test("each page shows the footnotes its own text cites, numbered as on the slide", () => {
    const md = `## Ledger\n\nFirst claim.[^one]\n\n${filler}\n\nLast claim.[^two]\n\n[^one]: Note one.\n[^two]: Note two.\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    expect(pages.length).toBeGreaterThan(1);
    expect(notesOn(pages[0] as HTMLElement)).toEqual(["Note one."]);
    const last = pages.at(-1) as HTMLElement;
    expect(bodyOf(last).textContent).toContain("Last claim.");
    expect(notesOn(last)).toEqual(["Note two."]);
    // The citation reads 2, so the list on that page reads 2 as well.
    const [ref] = citationsOn(last);
    const item = fragmentTarget(last, ref?.getAttribute("href") ?? "") as HTMLLIElement;
    expect(ref?.textContent).toBe("2");
    expect(shownNumber(item)).toBe(2);
    // Pages between them cite nothing and carry no list.
    for (const page of pages.slice(1, -1))
      expect(page.querySelector("[data-footnotes]")).toBeNull();
    expect(fitsAll(pages)).toEqual(pages.map(() => false));
  });

  test("a footnote cited on two pages shows on both; each copy links back to its own page's citation", () => {
    const md = `## Ledger\n\nOpening.[^shared]\n\n${filler}\n\nClosing.[^shared]\n\n[^shared]: The shared note.\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    const withNote = pages.flatMap((p, i) => (notesOn(p).length > 0 ? [i] : []));
    expect(withNote).toEqual([0, pages.length - 1]);
    for (const page of [pages[0], pages.at(-1)] as HTMLElement[]) {
      expect(notesOn(page)).toEqual(["The shared note."]);
      const [ref] = citationsOn(page);
      const item = fragmentTarget(page, ref?.getAttribute("href") ?? "");
      expect(item?.closest("[data-footnotes]")).not.toBeNull();
      const backs = [...(item?.querySelectorAll("a[data-footnote-backref]") ?? [])];
      expect(backs).toHaveLength(1);
      expect(fragmentTarget(page, backs[0]?.getAttribute("href") ?? "")).toBe(ref);
      // The hidden label the citation points at is on the same page.
      const label = ref?.getAttribute("aria-describedby") ?? "";
      expect(page.querySelector(`[id="${CSS.escape(label)}"]`)?.textContent).toBe("Footnotes");
    }
    const ids = pages.flatMap((p) => [...p.querySelectorAll("[id]")].map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a footnote cited inside another one comes along to the page", () => {
    const md = `## Ledger\n\n${filler}\n\nLast claim.[^a]\n\n[^a]: See also.[^b]\n[^b]: The deeper note.\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    expect(pages.length).toBeGreaterThan(1);
    expect(notesOn(pages.at(-1) as HTMLElement)).toEqual(["See also.", "The deeper note."]);
    expect(notesOn(pages[0] as HTMLElement)).toEqual([]);
  });

  test("a raw HTML section marked as a footnote list above the real one is not taken for it", () => {
    // The GitHub schema lets `data-footnotes` through on a <section>, so the
    // author's block can sit above remark-rehype's list. Taking the first match
    // would drop its content from every page (rule 3); the generated list is
    // always the last child.
    const forged =
      '<section data-footnotes class="footnotes"><ol><li>FORGED CONTENT</li></ol></section>';
    const md = `## Ledger\n\nOpening.\n\n${forged}\n\n${filler}\n\nA claim.[^a]\n\n[^a]: The real note.\n`;
    const pages = paginateSlide(slideFor(md), { size: SIZE });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.some((p) => bodyOf(p).textContent?.includes("FORGED CONTENT"))).toBe(true);
    const citing = pages.find((p) => bodyOf(p).textContent?.includes("A claim."));
    expect(notesOn(citing as HTMLElement)).toContain("The real note.");
  });

  test("a slide that fits keeps its footnote list where it was", () => {
    const slide = slideFor("## Short\n\nA claim.[^n]\n\n[^n]: The note.\n");
    expect(paginateSlide(slide, { size: SIZE })).toEqual([slide]);
    expect(notesOn(slide)).toEqual(["The note."]);
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

/** The footnotes a page shows, by generated number, sorted. */
const notesShown = (page: HTMLElement) =>
  [...page.querySelectorAll("[data-footnotes] > ol > li")]
    .map((li) => Number(/\bf(\d+)\b/.exec(li.textContent ?? "")?.[1]))
    .toSorted((a, b) => a - b);

/**
 * Body blocks other than headings: what a page actually shows. A page's
 * footnote list belongs to the blocks that cite it (decision 107), so it is
 * not a block of its own.
 */
const contentOf = (page: HTMLElement) =>
  [...bodyOf(page).children].filter(
    (c) => !/^H[1-6]$/.test(c.tagName) && !c.matches("[data-footnotes]"),
  );

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
 * Footnote `k` reads `f<k>`, and the generator records which token cites it,
 * so each page's list can be checked against the text on that page.
 */
describe("pagination properties", () => {
  /** Which of the generated footnotes the block cites, if any (its last leaf does). */
  type Note = { note: number | null };
  type Block =
    | ({ kind: "p"; words: number } & Note)
    | { kind: "code"; lines: number }
    | ({ kind: "table"; rows: number } & Note)
    | ({ kind: "list"; ordered: boolean; items: number[] } & Note)
    | { kind: "h3" };

  const NOTES = 4;
  const note = fc.oneof(
    { weight: 2, arbitrary: fc.constant(null) },
    fc.integer({ min: 0, max: NOTES - 1 }),
  );
  const block: fc.Arbitrary<Block> = fc.oneof(
    fc.record({ kind: fc.constant("p" as const), words: fc.integer({ min: 1, max: 60 }), note }),
    fc.record({ kind: fc.constant("code" as const), lines: fc.integer({ min: 1, max: 45 }) }),
    fc.record({ kind: fc.constant("table" as const), rows: fc.integer({ min: 1, max: 35 }), note }),
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
      note,
    }),
    fc.record({ kind: fc.constant("h3" as const) }),
  );
  /** Words in each footnote: a short one or a few lines of small type. */
  const noteWords = fc.array(fc.integer({ min: 1, max: 80 }), {
    minLength: NOTES,
    maxLength: NOTES,
  });

  /** Markdown for the generated slide, its tokens in document order, and the footnote each citing token cites. */
  function render(
    blocks: Block[],
    words: number[],
  ): { md: string; tokens: string[]; cites: Map<string, number> } {
    const tokens: string[] = [];
    const cites = new Map<string, number>();
    const tok = () => {
      const t = `t${tokens.length}`;
      tokens.push(t);
      return t;
    };
    /** A token whose leaf cites footnote `k`, when `k` is given. */
    const citing = (k: number | null) => {
      const t = tok();
      if (k === null) return t;
      cites.set(t, k);
      return `${t}[^n${k}]`;
    };
    const fence = (lines: number, indent: string) =>
      [
        `${indent}\`\`\``,
        ...Array.from({ length: lines }, () => `${indent}${tok()}`),
        `${indent}\`\`\``,
      ].join("\n");
    const parts = ["## Slide"];
    for (const [i, b] of blocks.entries()) {
      if (b.kind === "p") {
        const t = tok();
        const leaf = [t, ...Array.from({ length: b.words - 1 }, () => "word")];
        if (b.note !== null) {
          cites.set(t, b.note);
          leaf.push(`[^n${b.note}]`);
        }
        parts.push(leaf.join(" "));
      }
      if (b.kind === "code") parts.push(fence(b.lines, ""));
      if (b.kind === "table") {
        const rows = Array.from({ length: b.rows }, (_, n) => {
          const key = n === b.rows - 1 ? citing(b.note) : tok();
          return `| ${key} | value |`;
        });
        parts.push(["| Key | Value |", "|---|---|", ...rows].join("\n"));
      }
      if (b.kind === "list") {
        const marker = (n: number) => (b.ordered ? `${n + 1}.` : "-");
        const lines = b.items.map((code, n) => {
          const head = `${marker(n)} ${n === b.items.length - 1 ? citing(b.note) : tok()}`;
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
    for (const [k, n] of words.entries()) {
      parts.push(
        `[^n${k}]: ${[`f${k}`, ...Array.from({ length: n - 1 }, () => "note")].join(" ")}`,
      );
    }
    return { md: `${parts.join("\n\n")}\n`, tokens, cites };
  }

  fcTest.prop([fc.array(block, { minLength: 1, maxLength: 8 }), noteWords], { numRuns: 100 })(
    "no content is lost or duplicated; a page either fits or holds one block that cannot be split; no page is a bare title; each page shows exactly the footnotes it cites",
    (blocks, words) => {
      const { md, tokens, cites } = render(blocks, words);
      // Slide level 2 forced, so `###` parts stay inside this one slide.
      const plan = sectionize(parseMarkdown(md), 2);
      const slide = buildSlide(plan.sections[0] as never, { definitions: plan.definitions });
      expect(tokensOf([slide]), "generator: the unsplit slide holds every token").toEqual(tokens);
      const pages = paginateSlide(slide, { size: SIZE });

      expect(tokensOf(pages)).toEqual(tokens);

      // Each page lists the footnotes its own leaves cite, and no others; a
      // citation and its item agree on the number, and every footnote link
      // on a page leads to something on that page.
      for (const page of pages) {
        const cited = [...new Set(tokensOf([page]).flatMap((t) => cites.get(t) ?? []))];
        expect(notesShown(page)).toEqual(cited.toSorted((a, b) => a - b));
        for (const ref of citationsOn(page)) {
          const item = fragmentTarget(page, ref.getAttribute("href") ?? "") as HTMLLIElement;
          expect(item.closest("[data-footnotes]")).not.toBeNull();
          expect(shownNumber(item)).toBe(Number(ref.textContent));
        }
        for (const back of page.querySelectorAll("a[data-footnote-backref]")) {
          expect(fragmentTarget(page, back.getAttribute("href") ?? "")).not.toBeNull();
        }
      }
      const ids = pages.flatMap((p) => [...p.querySelectorAll("[id]")].map((el) => el.id));
      expect(new Set(ids).size, "ids are unique across the pages").toBe(ids.length);

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

    // "Failure handling" overflows and splits at its H3s. Its three short
    // parts used to take a slide each (6 pages, 52 in the deck); since
    // neighbouring parts that fit share a page, they sit on one (4 pages, 50).
    const failure = pages.filter((p) => p.dataset["docwalkId"] === "failure-handling");
    expect(
      failure.map((p) =>
        [...bodyOf(p).querySelectorAll(":scope > h2, :scope > h3")].map((h) => h.textContent),
      ),
    ).toEqual([
      ["Failure handling", "Retries"],
      ["Timeouts"],
      ["Poison messages", "Partial failures", "Duplicate delivery"],
      ["Clock skew"],
    ]);

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
