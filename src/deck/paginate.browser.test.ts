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
