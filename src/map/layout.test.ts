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
  MIN_FRAME_HEIGHT,
  placeFrames,
} from "./layout";

const fixture = readFileSync(new URL("../../fixtures/ledger-redesign.md", import.meta.url), "utf8");

// The map reads the plan at the document's own level, never the viewer's override (decision 139).
const plan = (md: string) => sectionize(parseMarkdown(md), "auto");
const columnIds = (p: SectionPlan) => mapColumns(p).map((column) => column.map((f) => f.id));

describe("mapColumns: columns from the section plan (decision 139)", () => {
  test("a README-shaped document: the cover is the first column, each ## opens one", () => {
    // Under `auto` the plan has one slide level, so ### parts stay inside their
    // ## section's frame: they are content of that section, not sections.
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
    expect(p.levels).toEqual([2]);
    expect(columnIds(p)).toEqual([["ledger"], ["one"], ["two"], ["three"]]);
    expect(mapColumns(p)[2]).toEqual([{ id: "two", title: "Two", depth: 2 }]);
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

  test("#### headings open no slide, so they open no column", () => {
    const p = plan("## A\n\na\n\n#### Deep\n\nd\n\n## B\n\nb\n");
    expect(p.levels).toEqual([2]);
    expect(columnIds(p)).toEqual([["a"], ["b"]]);
  });

  test("a title section in mid-document joins the column before it (the lead's call)", () => {
    // "# Part two" is above the slide level and carries its own content (the
    // #### note), so the plan keeps it as a `title` section. Row 139 opens a
    // column only at levels[0], so it stacks under "## A". Whether it should
    // open a column of its own instead is the lead's call; this pins the
    // literal reading of the row.
    const md = "# Part one\n\n## A\n\na\n\n# Part two\n\n#### Note\n\nn\n\n## B\n\nb\n";
    const p = plan(md);
    expect(p.sections.map((s) => `${s.kind}:${s.id}`)).toEqual([
      "content:a",
      "title:part-two",
      "content:b",
    ]);
    expect(columnIds(p)).toEqual([["a", "part-two"], ["b"]]);
  });

  test("the acceptance fixture: every section once, one column per ## plus the cover", () => {
    const p = plan(fixture);
    const columns = columnIds(p);
    expect(columns.flat()).toEqual(p.sections.map((s) => s.id));
    const opening = p.sections.filter((s) => s.heading?.depth === p.levels[0]).length;
    const leading = p.sections[0]?.heading?.depth === p.levels[0] ? 0 : 1;
    expect(columns).toHaveLength(opening + leading);
    expect(columns[0]?.[0]).toBe("ledgerline-payment-ledger-redesign");
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

  fcTest.prop([doc])("every column after the first opens with a heading at levels[0]", (md) => {
    // One parsed tree: the frame's id finds its section, and the section's
    // heading node is compared by its depth.
    const p = plan(md);
    const byId = new Map(p.sections.map((s) => [s.id, s]));
    for (const column of mapColumns(p).slice(1)) {
      const first = byId.get(column[0]!.id);
      expect(first?.heading?.depth).toBe(p.levels[0]);
    }
  });

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
