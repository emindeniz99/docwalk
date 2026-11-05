import { fc, test as fcTest } from "@fast-check/vitest";
import { readFileSync } from "node:fs";
import type { RootContent } from "mdast";
import { describe, expect, test } from "vitest";
import { autoSlideLevel, parseMarkdown, sectionize, type SectionPlan } from "./sectionize";

const fixture = readFileSync(new URL("../../fixtures/ledger-redesign.md", import.meta.url), "utf8");

const plan = (md: string, option?: Parameters<typeof sectionize>[1]) =>
  sectionize(parseMarkdown(md), option);
const ids = (p: SectionPlan) => p.sections.map((s) => s.id);
const titles = (p: SectionPlan) => p.sections.map((s) => s.title);

describe("auto slide level (Pandoc's rule, document title skipped)", () => {
  test("a README-shaped doc (one H1 title, H2 sections) gets H2 slides with no configuration", () => {
    const md = "# Project\n\nIntro.\n\n## Install\n\nSteps.\n\n## Usage\n\nMore.\n";
    const p = plan(md);
    expect(p.levels).toEqual([2]);
    expect(p.sections.map((s) => s.kind)).toEqual(["cover", "content", "content"]);
  });

  test("several H1s with content mean H1 is the slide level", () => {
    expect(autoSlideLevel(parseMarkdown("# A\n\ntext\n\n# B\n\ntext\n"))).toBe(1);
  });

  test("a heading followed directly by a deeper heading does not set the level", () => {
    // H2 is only a grouping heading here; the content lives under H3.
    const md = "## Group\n### One\n\ntext\n\n### Two\n\ntext\n\n## Other\n### Three\n\ntext\n";
    const p = plan(md);
    expect(p.levels).toEqual([3]);
    expect(titles(p)).toEqual(["One", "Two", "Three"]);
    expect(p.sections[2]?.breadcrumb).toEqual(["Other"]);
  });

  test("a document without headings has no level and splits only on thematic breaks", () => {
    const p = plan("one\n\n---\n\ntwo\n\n***\n\nthree\n");
    expect(p.levels).toEqual([]);
    expect(p.sections).toHaveLength(3);
  });
});

describe("title slides and breadcrumbs", () => {
  test("under auto, an H1 with its own text makes H1 the slide level (Pandoc's rule)", () => {
    // Overflowing H1 slides are split one level down later (decision 17).
    const p = plan("# Part one\n\nWhy.\n\n## A\n\na\n\n# Part two\n\n## B\n\nb\n");
    expect(p.levels).toEqual([1]);
    expect(titles(p)).toEqual(["Part one", "Part two"]);
  });

  test("a heading above the slide level gets a title slide only when it has its own text", () => {
    const md = [
      "# Part one",
      "Why part one matters.",
      "## A",
      "a",
      "# Part two",
      "## B",
      "b",
      "## C",
      "c",
    ].join("\n\n");
    const p = plan(md, 2);
    expect(p.levels).toEqual([2]);
    expect(p.sections.map((s) => `${s.kind}:${s.title}`)).toEqual([
      "title:Part one",
      "content:A",
      "content:B",
      "content:C",
    ]);
    // "Part two" has no text of its own, so it lives on only as a breadcrumb.
    expect(p.sections[2]?.breadcrumb).toEqual(["Part two"]);
  });

  test("deeper headings stay inside their slide", () => {
    const p = plan("## Failure handling\n\nintro\n\n### Retries\n\nr\n\n### Timeouts\n\nt\n");
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0]?.nodes.filter((n) => n.type === "heading")).toHaveLength(2);
  });
});

describe("thematic breaks", () => {
  test("a break forces a slide that keeps the section's title and gets a stable part id", () => {
    const p = plan("## Rollout\n\nstep one\n\n---\n\nstep two\n\n---\n\n### Later\n\nstep three\n");
    expect(ids(p)).toEqual(["rollout", "rollout-part-2", "rollout-part-3"]);
    expect(titles(p)).toEqual(["Rollout", "Rollout", "Rollout"]);
  });

  test("a break right before a heading leaves no empty slide", () => {
    const p = plan("## A\n\na\n\n***\n\n## B\n\nb\n");
    expect(ids(p)).toEqual(["a", "b"]);
  });

  test("hyphens under a paragraph make a setext heading, not a break", () => {
    // Regex splitters (reveal.js's Markdown plugin, deckrun) get this wrong.
    const p = plan("## A\n\nintro\n\nThis paragraph becomes a heading\n---\n\nbody\n");
    expect(titles(p)).toEqual(["A", "This paragraph becomes a heading"]);
  });

  test("hyphens inside a code fence are code", () => {
    const p = plan("## Config\n\n```yaml\na: 1\n---\nb: 2\n```\n");
    expect(p.sections).toHaveLength(1);
    expect(p.sections[0]?.nodes[0]?.type).toBe("code");
  });
});

describe("ids", () => {
  test("section ids are the GitHub anchors, so links from GitHub land on the right slide", () => {
    const p = plan("## Request flow: authorize and capture\n\nx\n\n## Data model\n\ny\n");
    expect(ids(p)).toEqual(["request-flow-authorize-and-capture", "data-model"]);
  });

  test("duplicate headings get GitHub's numbering, counted across deep headings too", () => {
    const p = plan("## Notes\n\na\n\n### Notes\n\nb\n\n## Notes\n\nc\n");
    expect(ids(p)).toEqual(["notes", "notes-2"]);
  });
});

describe("level override", () => {
  test("a fixed level ignores the document title rule", () => {
    const p = plan("# Doc\n\nintro\n\n## A\n\na\n\n### A1\n\nx\n", 3);
    expect(p.levels).toEqual([3]);
    // Doc and A both carry text of their own, so both get title slides.
    expect(p.sections.map((s) => `${s.kind}:${s.title}`)).toEqual([
      "title:Doc",
      "title:A",
      "content:A1",
    ]);
  });

  test("a single H2 with H3s below it is a section, not a document title", () => {
    const p = plan("## Failure handling\n\nintro\n\n### Retries\n\nr\n");
    expect(p.titleHeading).toBeNull();
    expect(p.levels).toEqual([2]);
  });

  test("a list of levels starts slides only at those levels (Marp's headingDivider shape)", () => {
    const p = plan("# One\n\nx\n\n## Inline\n\ny\n\n### Three\n\nz\n", [1, 3]);
    expect(titles(p)).toEqual(["One", "Three"]);
    expect(p.sections[0]?.nodes.some((n) => n.type === "heading")).toBe(true);
  });
});

describe("acceptance fixture", () => {
  const p = plan(fixture);

  test("the fixture's H1 is the cover and H2 is the slide level", () => {
    expect(p.levels).toEqual([2]);
    expect(p.sections[0]?.kind).toBe("cover");
    expect(p.sections[0]?.title).toBe("Ledgerline: payment ledger redesign");
  });

  test("every H2 becomes one slide, plus the setext trap in the appendix", () => {
    const h2 = fixture.split("\n").filter((l) => l.startsWith("## ")).length;
    expect(p.sections.filter((s) => s.kind === "content")).toHaveLength(h2 + 1);
    // The setext heading spans three source lines; soft breaks read as spaces.
    expect(ids(p)).toContain(
      "the-next-line-is-three-hyphens-directly-under-this-paragraph-with-no-blank-line-between-commonmark-reads-that-as-a-level-2-setext-heading-not-as-a-slide-break-so-this-whole-paragraph-becomes-a-heading",
    );
  });

  test("the H2 slides carry the document title as breadcrumb", () => {
    const failure = p.sections.find((s) => s.id === "failure-handling");
    expect(failure?.breadcrumb).toEqual(["Ledgerline: payment ledger redesign"]);
    expect(failure?.nodes.filter((n) => n.type === "heading").map((n) => n.depth)).toEqual([
      3, 3, 3, 3, 3, 3,
    ]);
  });
});

// ---- Properties ---------------------------------------------------------

const block = fc.oneof(
  fc.integer({ min: 1, max: 4 }).map((d) => `${"#".repeat(d)} Heading ${d}`),
  fc.constantFrom("A paragraph.", "- item\n- item", "| a | b |\n|---|---|\n| 1 | 2 |"),
  fc.constant("---"),
  fc.constant("```\ncode\n---\nmore\n```"),
  fc.constant("Setext heading\n---"),
);
const doc = fc.array(block, { minLength: 0, maxLength: 25 }).map((blocks) => blocks.join("\n\n"));
const option = fc.oneof(
  fc.constant("auto" as const),
  fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<1 | 2 | 3 | 4>,
);

const emittedNodes = (p: SectionPlan): RootContent[] =>
  p.sections.flatMap((s) => (s.heading ? [s.heading, ...s.nodes] : s.nodes));

describe("properties", () => {
  fcTest.prop([doc, option])("no content is lost or duplicated, and order is kept", (md, opt) => {
    const root = parseMarkdown(md);
    const p = sectionize(root, opt);
    const emitted = emittedNodes(p);
    const minLevel = Math.min(...p.levels);
    // Only thematic breaks (slide markers) and title-level headings without
    // text of their own (kept as breadcrumbs) may be left out.
    const expected = root.children.filter(
      (n) =>
        n.type !== "thematicBreak" &&
        (emitted.includes(n) || !(n.type === "heading" && n.depth < minLevel)),
    );
    expect(emitted).toEqual(expected);
  });

  fcTest.prop([doc, option])("section ids are unique", (md, opt) => {
    const p = plan(md, opt);
    expect(new Set(ids(p)).size).toBe(p.sections.length);
  });

  fcTest.prop([doc])("sections appear in document order", (md) => {
    const lines = plan(md).sections.map((s) => s.line);
    expect(lines).toEqual(lines.toSorted((a, b) => a - b));
  });

  fcTest.prop([doc, option])(
    "every content section opens at a slide level or continues one",
    (md, opt) => {
      const p = sectionize(parseMarkdown(md), opt);
      for (const s of p.sections) {
        if (s.kind === "content" && s.heading) expect(p.levels).toContain(s.heading.depth);
        if (s.kind === "title") expect(s.nodes.length).toBeGreaterThan(0);
      }
    },
  );
});
