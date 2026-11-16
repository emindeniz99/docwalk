import { fc, test as fcTest } from "@fast-check/vitest";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseMarkdown, sectionize, type SectionPlan } from "../sectioning/sectionize";
import {
  COLUMN_GAP,
  FRAME_GAP,
  FRAME_WIDTH,
  type FrameRect,
  mapColumns,
  mapPlan,
  MIN_FRAME_HEIGHT,
  placeFrames,
} from "./layout";

const fixture = readFileSync(new URL("../../fixtures/ledger-redesign.md", import.meta.url), "utf8");

// The map's own plan: the document's level L and L + 1 (decision 140), never
// the viewer's level override.
const plan = (md: string) => mapPlan(parseMarkdown(md));
const columnIds = (p: SectionPlan) => mapColumns(p).map((column) => column.map((f) => f.id));
const kinds = (p: SectionPlan) => p.sections.map((s) => `${s.kind}:${s.id}`);

describe("mapPlan: the map sections one level deeper than the deck (decision 140)", () => {
  test("L skips the document title, as auto does, so a README maps at ## and ###", () => {
    const p = plan("# Title\n\nintro\n\n## A\n\na\n\n### B\n\nb\n");
    expect(p.levels).toEqual([2, 3]);
    expect(kinds(p)).toEqual(["cover:title", "content:a", "content:b"]);
  });

  test("the cover frame has the id of the deck's cover slide, with or without an intro", () => {
    // Row 140: a frame's id is the id a slide has. The deck keeps an empty cover.
    for (const md of [
      "# Ledger\n\nIntro.\n\n## A\n\na\n\n### A1\n\nx\n",
      "# Ledger\n\n## A\n\na\n\n### A1\n\nx\n",
    ]) {
      const root = parseMarkdown(md);
      expect(sectionize(root, "auto").sections[0]?.id).toBe("ledger");
      expect(kinds(mapPlan(root))).toEqual(["cover:ledger", "content:a", "content:a1"]);
      expect(columnIds(mapPlan(root))).toEqual([["ledger"], ["a", "a1"]]);
    }
  });

  test("with no heading at L + 1 the map plan is the deck's auto plan", () => {
    for (const md of ["# Ledger\n\nIntro.\n\n## A\n\na\n", "one\n\n---\n\ntwo\n", ""]) {
      const root = parseMarkdown(md);
      expect(mapPlan(root)).toEqual(sectionize(root, "auto"));
    }
  });

  test("any top-level heading at L + 1 adds that level, whatever follows it (decision 141)", () => {
    // Row 141 reads 140 as written, wider than autoSlideLevel's test: "### B"
    // and "### D" open frames although a #### heading follows each.
    const p = plan("## A\n\na\n\n### B\n\n#### C\n\nc\n\n### D\n\n#### E\n\ne\n");
    expect(p.levels).toEqual([2, 3]);
    expect(columnIds(p)).toEqual([["a", "b", "d"]]);
    // An L + 1 heading as the last block is an empty frame holding its heading.
    const q = plan("## A\n\na\n\n### B\n");
    expect(q.levels).toEqual([2, 3]);
    expect(columnIds(q)).toEqual([["a", "b"]]);
    expect(q.sections[1]?.nodes).toEqual([]);
  });

  test("a heading at L + 1 inside a quote or a list opens no frame, and L = 6 has no L + 1", () => {
    expect(plan("## A\n\na\n\n> ### Q\n\n- ### R\n").levels).toEqual([2]);
    expect(plan("###### A\n\na\n\n###### B\n\nb\n").levels).toEqual([6]);
  });

  test("a heading above L with no text keeps its frame and opens its column (decision 141)", () => {
    // "# Part two" has no text of its own: the deck drops it as a breadcrumb,
    // the map keeps it as a frame that holds the heading alone.
    const p = plan("## A\n\na\n\n# Part two\n\n### Sub\n\ns\n\n## B\n\nb\n");
    expect(columnIds(p)).toEqual([["a"], ["part-two", "sub"], ["b"]]);
    expect(p.sections[1]).toMatchObject({ kind: "title", id: "part-two", nodes: [] });
  });

  test("a thematic-break part under an empty heading above L stays in that heading's column", () => {
    // The part keeps the id the deck gives it: keeping the empty section does
    // not change the part numbering.
    const md = "## A\n\na\n\n# Part two\n\n---\n\nx\n\n## B\n\nb\n";
    const root = parseMarkdown(md);
    expect(kinds(sectionize(root, "auto"))).toEqual([
      "content:a",
      "content:part-two-part-2",
      "content:b",
    ]);
    expect(columnIds(mapPlan(root))).toEqual([["a"], ["part-two", "part-two-part-2"], ["b"]]);
  });

  test("a part above L whose only text sits under an L + 1 heading keeps its frame", () => {
    // The deck at auto keeps "# Part one" as a title slide holding "### Sub".
    // At [2, 3] "### Sub" opens its own section and "# Part one" holds its
    // heading alone, with the slide's id. "# Part two" has no text: a frame too.
    const md = "# Part one\n\n### Sub\n\ns\n\n## A\n\na\n\n# Part two\n\n## B\n\nb\n";
    const root = parseMarkdown(md);
    expect(kinds(sectionize(root, "auto"))).toEqual(["title:part-one", "content:a", "content:b"]);
    expect(kinds(mapPlan(root))).toEqual([
      "title:part-one",
      "content:sub",
      "content:a",
      "title:part-two",
      "content:b",
    ]);
    expect(columnIds(mapPlan(root))).toEqual([["part-one", "sub"], ["a"], ["part-two"], ["b"]]);
  });

  test("consecutive empty headings above L get a frame and a column each", () => {
    expect(columnIds(plan("# One\n\n# Two\n\n## A\n\na\n"))).toEqual([["one"], ["two"], ["a"]]);
  });

  test("a document with headings but no L gets the auto plan, one column", () => {
    // "## A" is followed by a thematic break, so autoSlideLevel finds no level;
    // with no L there is nothing "above L" (row 140: the plan of 139).
    const root = parseMarkdown("## A\n\n---\n\nx\n");
    const p = mapPlan(root);
    expect(p.levels).toEqual([]);
    expect(p).toEqual(sectionize(root, "auto"));
    expect(columnIds(p)).toEqual([["a-part-2"]]);
  });

  test("part ids differ between the deck and the map by design", () => {
    // The one known difference: a part continues the last section opened, and
    // the map opens more sections. Step 3's address mapping has to handle it.
    const root = parseMarkdown("## A\n\na\n\n### X\n\nx1\n\n---\n\nx2\n");
    expect(sectionize(root, "auto").sections.map((s) => s.id)).toEqual(["a", "a-part-2"]);
    expect(mapPlan(root).sections.map((s) => s.id)).toEqual(["a", "x", "x-part-2"]);
  });
});

describe("mapColumns: columns from the map plan (decisions 139 and 140)", () => {
  test("a README-shaped document: the cover, then one column per ## with its ### stacked", () => {
    const md = [
      "# Ledger",
      "Intro.",
      "## One",
      "a",
      "## Two",
      "b",
      "### Two A",
      "c",
      "### Two B",
      "d",
      "## Three",
      "e",
    ].join("\n\n");
    const p = plan(md);
    expect(p.levels).toEqual([2, 3]);
    expect(columnIds(p)).toEqual([["ledger"], ["one"], ["two", "two-a", "two-b"], ["three"]]);
    expect(mapColumns(p)[2]).toEqual([
      { id: "two", title: "Two", depth: 2 },
      { id: "two-a", title: "Two A", depth: 3 },
      { id: "two-b", title: "Two B", depth: 3 },
    ]);
  });

  test("a document whose sections are # headings gets one column per #", () => {
    const p = plan("# A\n\na\n\n# B\n\nb\n");
    expect(p.levels).toEqual([1]);
    expect(columnIds(p)).toEqual([["a"], ["b"]]);
  });

  test("a document of ## headings only has no leading column", () => {
    expect(columnIds(plan("## A\n\na\n\n## B\n\nb\n"))).toEqual([["a"], ["b"]]);
  });

  test("content above the first heading forms the first column", () => {
    expect(columnIds(plan("Some text.\n\n## A\n\na\n"))).toEqual([["intro"], ["a"]]);
  });

  test("thematic-break parts stack under the section they continue", () => {
    const md = "# T\n\nintro\n\n---\n\nmore\n\n## A\n\na1\n\n---\n\na2\n\n## B\n\nb\n";
    const columns = mapColumns(plan(md));
    expect(columns.map((c) => c.map((f) => f.id))).toEqual([
      ["t", "t-part-2"],
      ["a", "a-part-2"],
      ["b"],
    ]);
    // A part has no heading of its own and carries the title of what it continues.
    expect(columns[1]?.[1]).toEqual({ id: "a-part-2", title: "A", depth: null });
  });

  test("a part after a ### frame stacks in the same column, after that frame", () => {
    const md = "## A\n\na\n\n### X\n\nx1\n\n---\n\nx2\n\n## B\n\nb\n";
    expect(columnIds(plan(md))).toEqual([["a", "x", "x-part-2"], ["b"]]);
  });

  test("parts before the first heading stay in the first column", () => {
    expect(columnIds(plan("one\n\n---\n\ntwo\n\n## A\n\na\n"))).toEqual([
      ["intro", "slide-2"],
      ["a"],
    ]);
  });

  test("a document with no headings is one column", () => {
    const p = plan("one\n\n---\n\ntwo\n\n***\n\nthree\n");
    expect(p.levels).toEqual([]);
    expect(columnIds(p)).toEqual([["intro", "slide-2", "slide-3"]]);
  });

  test("an empty document, or one of comments only, has no columns", () => {
    expect(mapColumns(plan(""))).toEqual([]);
    expect(mapColumns(plan("<!-- markdownlint-disable MD041 -->\n"))).toEqual([]);
  });

  test("headings below L + 1 open no frame, so they stay inside theirs", () => {
    const p = plan("## A\n\na\n\n#### Deep\n\nd\n\n## B\n\nb\n");
    expect(p.levels).toEqual([2]);
    expect(columnIds(p)).toEqual([["a"], ["b"]]);
    const q = plan("## A\n\na\n\n### X\n\nx\n\n#### Deep\n\nd\n");
    expect(q.levels).toEqual([2, 3]);
    expect(columnIds(q)).toEqual([["a", "x"]]);
  });

  test("a part heading above L in mid-document opens a column of its own", () => {
    // "# Part two" is above the slide level and carries its own text (the
    // #### note), so the plan keeps it as a `title` section; row 140 lets a
    // heading at L or above open a column.
    const md = "# Part one\n\n## A\n\na\n\n# Part two\n\n#### Note\n\nn\n\n## B\n\nb\n";
    // "# Part one" has no text of its own, so it is a frame of its own too (141).
    const p = plan(md);
    expect(kinds(p)).toEqual(["title:part-one", "content:a", "title:part-two", "content:b"]);
    expect(columnIds(p)).toEqual([["part-one"], ["a"], ["part-two"], ["b"]]);
  });

  test("the acceptance fixture: 23 columns and 40 frames", () => {
    // The fixture has a cover, 22 ## headings (21 ATX and one setext heading in
    // the appendix) and 17 ### headings, each followed by text; its one
    // thematic break sits right before a heading, so it makes no part.
    // Columns: the cover's plus one per ## = 23. Frames: 1 + 22 + 17 = 40.
    const p = plan(fixture);
    const columns = columnIds(p);
    expect(p.levels).toEqual([2, 3]);
    expect(columns.flat()).toEqual(p.sections.map((s) => s.id));
    expect(columns).toHaveLength(23);
    expect(columns.flat()).toHaveLength(40);
    expect(p.sections.filter((s) => s.heading?.depth === 2)).toHaveLength(22);
    expect(p.sections.filter((s) => s.heading?.depth === 3)).toHaveLength(17);
    expect(columns[0]).toEqual(["ledgerline-payment-ledger-redesign"]);
    expect(columns.find((c) => c[0] === "failure-handling")).toEqual([
      "failure-handling",
      "retries",
      "timeouts",
      "poison-messages",
      "partial-failures",
      "duplicate-delivery",
      "clock-skew",
    ]);
  });
});

describe("placeFrames: rectangles from measured heights (decision 139)", () => {
  test("frames are one slide wide, so text on the map has its slide size", () => {
    // Compared with the literal: src/deck/pages.ts imports DOM measuring code,
    // which the Node unit project's tsconfig (no DOM lib) cannot type-check.
    expect(FRAME_WIDTH).toBe(1280);
  });

  test("columns run left to right, frames top to bottom, with the fixed gaps", () => {
    const columns = [[{ id: "a" }, { id: "b" }], [{ id: "c" }]];
    const heights = new Map([
      ["a", 1000],
      ["b", 2000],
      ["c", 900],
    ]);
    const { frames, bounds } = placeFrames(columns, heights);
    expect(frames).toEqual([
      { id: "a", x: 0, y: 0, width: FRAME_WIDTH, height: 1000, column: 0, row: 0 },
      {
        id: "b",
        x: 0,
        y: 1000 + FRAME_GAP,
        width: FRAME_WIDTH,
        height: 2000,
        column: 0,
        row: 1,
      },
      {
        id: "c",
        x: FRAME_WIDTH + COLUMN_GAP,
        y: 0,
        width: FRAME_WIDTH,
        height: 900,
        column: 1,
        row: 0,
      },
    ]);
    expect(bounds).toEqual({ width: 2 * FRAME_WIDTH + COLUMN_GAP, height: 3000 + FRAME_GAP });
  });

  test("a short, missing, NaN, negative or infinite height gets the minimum", () => {
    // A frame must stay visible and clickable on the map even when it was not
    // measured (yet) or the measurement is broken.
    const ids = ["short", "missing", "nan", "negative", "infinite"];
    const heights = new Map([
      ["short", 10],
      ["nan", Number.NaN],
      ["negative", -50],
      ["infinite", Number.POSITIVE_INFINITY],
    ]);
    const { frames } = placeFrames([ids.map((id) => ({ id }))], heights);
    expect(frames.map((f) => f.height)).toEqual(ids.map(() => MIN_FRAME_HEIGHT));
  });

  test("a fractional height is rounded up, so no content is cut and edges stay whole", () => {
    // Rule 3: rounding down could clip up to a unit of the frame's last line.
    const { frames } = placeFrames(
      [[{ id: "a" }, { id: "b" }]],
      new Map([
        ["a", 1000.2],
        ["b", 1500],
      ]),
    );
    expect(frames.map((f) => [f.y, f.height])).toEqual([
      [0, 1001],
      [1001 + FRAME_GAP, 1500],
    ]);
  });

  test("no frames give an empty box", () => {
    expect(placeFrames([], new Map())).toEqual({ frames: [], bounds: { width: 0, height: 0 } });
  });

  test("the gap between columns is wider than the gap between frames", () => {
    // A column's frames belong together; the eye groups them by distance.
    expect(COLUMN_GAP).toBeGreaterThan(FRAME_GAP);
  });
});

// ---- Properties ---------------------------------------------------------

// The block generator of src/sectioning/sectionize.test.ts: headings, thematic
// breaks, setext headings, fences holding `---`, comments and definitions.
const block = fc.oneof(
  fc.integer({ min: 1, max: 4 }).map((d) => `${"#".repeat(d)} Heading ${d}`),
  fc.constantFrom("A paragraph.", "- item\n- item", "| a | b |\n|---|---|\n| 1 | 2 |"),
  fc.constant("---"),
  fc.constant("```\ncode\n---\nmore\n```"),
  fc.constant("Setext heading\n---"),
  fc.constantFrom("## 🚀", "### ???", "Text with a note.[^a]", "[^a]: The note.", "[r]: /x"),
  fc.constantFrom("<!-- A speaker note. -->", "<!-- markdownlint-disable MD041 -->"),
  fc.constantFrom("> ### Heading 3", "- ## Heading 2", "[^b]: Note.\n\n    ## Heading 2"),
);
const doc = fc.array(block, { minLength: 0, maxLength: 25 }).map((blocks) => blocks.join("\n\n"));

// Heights as a measurement can deliver them, broken ones included. "Huge" stays
// below 2^53 / (frames per column), so sums are exact doubles.
const height = fc.oneof(
  fc.integer({ min: 0, max: 5000 }),
  fc.integer({ min: 5000, max: 1e12 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);
// Columns of frames with unique ids, and a height (or none) for each frame.
const layout = fc
  .array(fc.array(fc.option(height, { nil: undefined }), { minLength: 1, maxLength: 6 }), {
    maxLength: 8,
  })
  .map((cols) => {
    let n = 0;
    const heights = new Map<string, number>();
    const columns = cols.map((col) =>
      col.map((h) => {
        const id = `f${n++}`;
        if (h !== undefined) heights.set(id, h);
        return { id };
      }),
    );
    return { columns, heights };
  });

const overlap = (a: FrameRect, b: FrameRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("properties", () => {
  fcTest.prop([doc])("every section of the plan is in exactly one frame, in plan order", (md) => {
    const p = plan(md);
    const columns = mapColumns(p);
    expect(columns.flat().map((f) => f.id)).toEqual(p.sections.map((s) => s.id));
  });

  fcTest.prop([doc])("no column is empty", (md) => {
    for (const column of mapColumns(plan(md))) expect(column.length).toBeGreaterThan(0);
  });

  fcTest.prop([doc])("every column after the first opens with a heading at L or above", (md) => {
    // One parsed tree: the frame's id finds its section, and the section's
    // heading node is compared by its depth. Every other frame is deeper or a part.
    const p = plan(md);
    const byId = new Map(p.sections.map((s) => [s.id, s]));
    const level = p.levels[0] as number;
    mapColumns(p).forEach((column, c) => {
      column.forEach((frame, row) => {
        const depth = byId.get(frame.id)?.heading?.depth;
        const opens = depth !== undefined && depth <= level;
        expect(opens).toBe(row === 0 && (c > 0 || opens));
      });
    });
  });

  fcTest.prop([doc])("every frame id is unique", (md) => {
    const ids = mapColumns(plan(md))
      .flat()
      .map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  fcTest.prop([doc])(
    "every heading at L or above is a section of the map, with the deck's id where the deck has it",
    (md) => {
      // Row 140: a frame's id is the id a slide has; row 141: every heading at
      // or above L has a frame. One tree for both plans, so nodes compare by
      // identity. Parts are left out: their ids differ between the two plans
      // by design (see "part ids differ between the deck and the map").
      const root = parseMarkdown(md);
      const deck = sectionize(root, "auto");
      const map = mapPlan(root);
      expect(map.levels[0]).toBe(deck.levels[0]);
      expect(map.titleHeading).toBe(deck.titleHeading);
      const level = deck.levels[0];
      if (level === undefined) {
        expect(map).toEqual(deck);
        return;
      }
      const upTo = (p: SectionPlan) =>
        p.sections.filter((s) => s.heading && s.heading.depth <= level);
      const mapped = upTo(map);
      expect(mapped.map((s) => s.heading)).toEqual(
        root.children.filter((n) => n.type === "heading" && n.depth <= level),
      );
      for (const section of upTo(deck)) {
        const same = mapped.find((s) => s.heading === section.heading);
        expect(same?.id).toBe(section.id);
        expect(same?.kind).toBe(section.kind);
      }
    },
  );

  fcTest.prop([doc])(
    "mapColumns takes any plan: the deck's at [1, 2, 3] with no cover keeps every section once",
    (md) => {
      const p = sectionize(parseMarkdown(md), [1, 2, 3]);
      const columns = mapColumns(p);
      expect(columns.flat().map((f) => f.id)).toEqual(p.sections.map((s) => s.id));
      for (const column of columns) expect(column.length).toBeGreaterThan(0);
    },
  );

  fcTest.prop([layout])("no two frames overlap", ({ columns, heights }) => {
    const { frames } = placeFrames(columns, heights);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        expect(overlap(frames[i]!, frames[j]!)).toBe(false);
      }
    }
  });

  fcTest.prop([layout])(
    "frames come in document order, one per input frame, with exact gaps",
    ({ columns, heights }) => {
      const { frames } = placeFrames(columns, heights);
      expect(frames.map((f) => f.id)).toEqual(columns.flat().map((f) => f.id));
      columns.forEach((column, c) => {
        const placed = frames.filter((f) => f.column === c);
        expect(placed.map((f) => f.row)).toEqual(column.map((_, r) => r));
        expect(placed[0]?.y).toBe(0);
        for (const f of placed) expect(f.x).toBe(c * (FRAME_WIDTH + COLUMN_GAP));
        for (let r = 1; r < placed.length; r++) {
          const above = placed[r - 1]!;
          expect(placed[r]!.y).toBe(above.y + above.height + FRAME_GAP);
        }
      });
    },
  );

  fcTest.prop([layout])(
    "every frame is one slide wide and at least the minimum tall, in whole units",
    ({ columns, heights }) => {
      for (const f of placeFrames(columns, heights).frames) {
        expect(f.width).toBe(FRAME_WIDTH);
        expect(f.height).toBeGreaterThanOrEqual(MIN_FRAME_HEIGHT);
        expect(Number.isInteger(f.height)).toBe(true);
        const measured = heights.get(f.id);
        if (measured !== undefined && Number.isFinite(measured) && measured > MIN_FRAME_HEIGHT) {
          expect(f.height).toBe(Math.ceil(measured));
        }
      }
    },
  );

  fcTest.prop([layout])(
    "the box contains every frame and touches the outermost ones",
    ({ columns, heights }) => {
      const { frames, bounds } = placeFrames(columns, heights);
      for (const f of frames) {
        expect(f.x).toBeGreaterThanOrEqual(0);
        expect(f.y).toBeGreaterThanOrEqual(0);
        expect(f.x + f.width).toBeLessThanOrEqual(bounds.width);
        expect(f.y + f.height).toBeLessThanOrEqual(bounds.height);
      }
      expect(bounds.width).toBe(Math.max(0, ...frames.map((f) => f.x + f.width)));
      expect(bounds.height).toBe(Math.max(0, ...frames.map((f) => f.y + f.height)));
    },
  );

  fcTest.prop([layout, fc.nat(), height])(
    "changing one frame's height moves nothing before it in document order",
    ({ columns, heights }, pick, newHeight) => {
      const order = columns.flat();
      fc.pre(order.length > 0);
      const k = pick % order.length;
      const before = placeFrames(columns, heights).frames;
      const edited = new Map(heights).set(order[k]!.id, newHeight);
      const after = placeFrames(columns, edited).frames;
      expect(after.slice(0, k)).toEqual(before.slice(0, k));
    },
  );
});
