import { fc, test as fcTest } from "@fast-check/vitest";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { type Camera, fitAll, MAX_SCALE, type Size } from "./camera";
import { mapColumns, mapPlan } from "./layout";
import {
  ease,
  firstFrame,
  frameForSection,
  lastFrame,
  MOVE_MS,
  nextFrame,
  placeOf,
  previousFrame,
  routeOrder,
  sectionForFrame,
  tween,
  ZOOM_STEP,
  zoomStep,
} from "./route";

/**
 * The map's route (decision 145): document order through the frames, the two
 * mappings between map frames and deck sections, the camera's move and the
 * keyboard's zoom step. Pure functions, so these run without a DOM.
 */

const fixture = readFileSync(new URL("../../fixtures/ledger-redesign.md", import.meta.url), "utf8");

const PANE: Size = { width: 1000, height: 800 };
const BIG: Size = { width: 8000, height: 6000 };
const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/** Every field finite and the scale positive: a camera the view can draw and divide by. */
const isFiniteCamera = (c: Camera) =>
  Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale) && c.scale > 0;

/** The map point under the pane's centre. */
const centrePoint = (c: Camera, pane: Size) => ({
  x: (pane.width / 2 - c.x) / c.scale,
  y: (pane.height / 2 - c.y) / c.scale,
});

/** The ids of a document's two plans: the deck's at `auto` (or a level) and the map's. */
const plans = (md: string, level: Parameters<typeof sectionize>[1] = "auto") => {
  const root = parseMarkdown(md);
  return { deck: sectionize(root, level).sections, map: mapPlan(root).sections };
};

describe("routeOrder and the steps through it (decision 145, Keys)", () => {
  const order = ["a", "b", "c"];

  test("the order is the columns read left to right, each top to bottom: document order", () => {
    // Right and Down both go to the next frame in document order, so the route
    // is the columns flattened, which mapColumns builds in plan order.
    expect(routeOrder([[{ id: "a" }], [{ id: "b" }, { id: "c" }], [{ id: "d" }]])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(routeOrder([])).toEqual([]);
  });

  test("the fixture's route is its 40 frames in plan order", () => {
    const p = mapPlan(parseMarkdown(fixture));
    const route = routeOrder(mapColumns(p));
    expect(route).toEqual(p.sections.map((s) => s.id));
    expect(route).toHaveLength(40);
  });

  test("next and previous step one frame and stop at the ends without wrapping", () => {
    // Row 145 names no wrap; a presenter pressing Right on the last frame
    // should not land back on the cover.
    expect(nextFrame(order, "a")).toBe("b");
    expect(nextFrame(order, "c")).toBe("c");
    expect(previousFrame(order, "c")).toBe("b");
    expect(previousFrame(order, "a")).toBe("a");
  });

  test("Home and End give the first and the last frame", () => {
    expect(firstFrame(order)).toBe("a");
    expect(lastFrame(order)).toBe("c");
  });

  test("with no current frame, or one no longer on the map, both steps start at the first frame", () => {
    // After an edit removed the current frame, or before one is chosen, the
    // route has no place to step from; starting over at the first frame is the
    // one answer that never skips content, whichever key was pressed.
    for (const current of [null, "gone", ""]) {
      expect(nextFrame(order, current)).toBe("a");
      expect(previousFrame(order, current)).toBe("a");
    }
  });

  test("an empty map has no frame to go to", () => {
    expect(firstFrame([])).toBeNull();
    expect(lastFrame([])).toBeNull();
    expect(nextFrame([], "a")).toBeNull();
    expect(previousFrame([], null)).toBeNull();
  });

  test("a single frame is its own next, previous, first and last", () => {
    expect(nextFrame(["a"], "a")).toBe("a");
    expect(previousFrame(["a"], "a")).toBe("a");
    expect(firstFrame(["a"])).toBe("a");
    expect(lastFrame(["a"])).toBe("a");
  });
});

describe("placeOf: the place in the route for the status (decision 145, Current frame)", () => {
  test("the place is 1-based, as the status reads it: '3 of 40'", () => {
    expect(placeOf(["a", "b", "c"], "a")).toEqual({ index: 1, count: 3 });
    expect(placeOf(["a", "b", "c"], "c")).toEqual({ index: 3, count: 3 });
  });

  test("an unknown id, no id or an empty map has no place, so the status says nothing wrong", () => {
    expect(placeOf(["a"], "b")).toBeNull();
    expect(placeOf(["a"], null)).toBeNull();
    expect(placeOf([], "a")).toBeNull();
  });
});

describe("sectionForFrame: the deck slide that holds a frame's first line (decision 145, Address)", () => {
  test("a frame at the second level gets its column's section, the slide that shows it", () => {
    // Row 140: a deck at L alone shows an L + 1 frame inside its column's slide.
    const { deck, map } = plans("# T\n\nintro\n\n## A\n\na\n\n### B\n\nb\n\n## C\n\nc\n");
    expect(deck.map((s) => s.id)).toEqual(["t", "a", "c"]);
    expect(map.map((s) => s.id)).toEqual(["t", "a", "b", "c"]);
    expect(sectionForFrame(deck, map, "b")).toBe("a");
    expect(sectionForFrame(deck, map, "a")).toBe("a");
    expect(sectionForFrame(deck, map, "c")).toBe("c");
    expect(sectionForFrame(deck, map, "t")).toBe("t");
  });

  test("a part id that differs between the plans is matched by its line", () => {
    // layout.test.ts "part ids differ between the deck and the map by design":
    // the map's x-part-2 is the deck's a-part-2, both opened by the same block.
    const { deck, map } = plans("## A\n\na\n\n### X\n\nx1\n\n---\n\nx2\n");
    expect(sectionForFrame(deck, map, "x")).toBe("a");
    expect(sectionForFrame(deck, map, "x-part-2")).toBe("a-part-2");
  });

  test("a frame before every deck section gets the first deck section", () => {
    // "# Part one" has no text: the deck keeps it only as a breadcrumb, the map
    // as a frame (row 141). It is leading content for the deck.
    const { deck, map } = plans("# Part one\n\n## A\n\na\n\n# Part two\n\n## B\n\nb\n");
    expect(deck.map((s) => s.id)).toEqual(["a", "b"]);
    expect(sectionForFrame(deck, map, "part-one")).toBe("a");
  });

  test("an empty heading in mid-document maps by its line, to the slide before it", () => {
    // Read as row 145 is written: "# Part two" (line 7) lies after A's start
    // (line 3) and before B's (line 9), so the slide that holds its line is A,
    // although the deck shows it as B's breadcrumb. Pinned here; see the report.
    const { deck, map } = plans("# Part one\n\n## A\n\na\n\n# Part two\n\n## B\n\nb\n");
    expect(sectionForFrame(deck, map, "part-two")).toBe("a");
  });

  test("the deck at a deeper level override still finds a slide for every frame", () => {
    // The deck follows the viewer's level (here ####); the map does not.
    const { deck, map } = plans("# T\n\nintro\n\n## A\n\na\n\n### B\n\nb\n\n#### C\n\nc\n", 4);
    expect(deck.map((s) => s.id)).toEqual(["t", "a", "b", "c"]);
    for (const frame of map) expect(sectionForFrame(deck, map, frame.id)).toBe(frame.id);
  });

  test("an unknown frame or an empty deck gives no section", () => {
    const { deck, map } = plans("## A\n\na\n");
    expect(sectionForFrame(deck, map, "gone")).toBeNull();
    expect(sectionForFrame([], map, "a")).toBeNull();
    expect(sectionForFrame(deck, [], "a")).toBeNull();
  });

  test("sections that share a line: the later one in document order holds it", () => {
    // Two sections of one plan never share a line (see the property below):
    // each opens at its own top-level block. For hand-made input the later
    // of the tied sections is chosen, since the earlier one would be empty.
    const deck = [
      { id: "p", line: 1 },
      { id: "q", line: 5 },
      { id: "r", line: 5 },
    ];
    expect(sectionForFrame(deck, [{ id: "f", line: 5 }], "f")).toBe("r");
    expect(sectionForFrame(deck, [{ id: "f", line: 9 }], "f")).toBe("r");
  });

  test("a line of 0 or NaN reads as before every section", () => {
    // NaN compares false with every line, so a broken line falls back to the
    // first section instead of to an arbitrary one.
    const deck = [
      { id: "p", line: 3 },
      { id: "q", line: 5 },
    ];
    expect(sectionForFrame(deck, [{ id: "f", line: 0 }], "f")).toBe("p");
    expect(sectionForFrame(deck, [{ id: "f", line: Number.NaN }], "f")).toBe("p");
    // A deck section with a broken line is never the greatest line at or before.
    const broken = [
      { id: "p", line: 3 },
      { id: "q", line: Number.NaN },
    ];
    expect(sectionForFrame(broken, [{ id: "f", line: 9 }], "f")).toBe("p");
  });
});

describe("frameForSection: the map frame that holds a section's first line (decision 145, Address)", () => {
  test("a slide's link opens its frame; at a deeper level, the frame that holds it", () => {
    const { deck, map } = plans("# T\n\nintro\n\n## A\n\na\n\n### B\n\nb\n\n#### C\n\nc\n", 4);
    expect(map.map((s) => s.id)).toEqual(["t", "a", "b"]);
    expect(frameForSection(map, deck, "a")).toBe("a");
    expect(frameForSection(map, deck, "b")).toBe("b");
    // "#### C" is inside frame B on the map.
    expect(frameForSection(map, deck, "c")).toBe("b");
  });

  test("a deck part maps to the frame its block sits in", () => {
    const { deck, map } = plans("## A\n\na\n\n### X\n\nx1\n\n---\n\nx2\n");
    expect(frameForSection(map, deck, "a-part-2")).toBe("x-part-2");
  });

  test("a section before every frame gets the first frame", () => {
    const map = [
      { id: "f", line: 4 },
      { id: "g", line: 8 },
    ];
    expect(frameForSection(map, [{ id: "s", line: 1 }], "s")).toBe("f");
  });

  test("an unknown section or an empty map gives no frame", () => {
    const { deck, map } = plans("## A\n\na\n");
    expect(frameForSection(map, deck, "gone")).toBeNull();
    expect(frameForSection([], deck, "a")).toBeNull();
    expect(frameForSection(map, [], "a")).toBeNull();
  });
});

describe("ease and MOVE_MS (decision 145, The move)", () => {
  test("the move takes about 300 ms", () => {
    expect(MOVE_MS).toBe(300);
  });

  test("ease starts at 0, ends at 1 and is symmetric around the middle", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(0.25)).toBeCloseTo(1 - ease(0.75), 12);
  });

  test("ease starts and ends slowly: in and out", () => {
    // The first and last tenth of the time cover far less than a tenth of the way.
    expect(ease(0.1)).toBeLessThan(0.05);
    expect(1 - ease(0.9)).toBeLessThan(0.05);
  });

  test("progress outside 0..1 is held to it, and NaN arrives", () => {
    // A late frame (elapsed > MOVE_MS) must land, not overshoot; a broken
    // clock must not leave the camera in between.
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    expect(ease(Number.NaN)).toBe(1);
    expect(ease(Number.POSITIVE_INFINITY)).toBe(1);
    expect(ease(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("tween: the camera on the way (decision 145, The move)", () => {
  const from: Camera = { x: 10, y: 20, scale: 0.25 };
  const to: Camera = { x: -500, y: -300, scale: 1 };

  test("progress 0 is exactly the start and 1 exactly the end", () => {
    // The move ends on the fitted camera, not on a rounding of it.
    expect(tween(from, to, 0, PANE)).toEqual(from);
    expect(tween(from, to, 1, PANE)).toEqual(to);
  });

  test("halfway the scale is the geometric mean, so each step zooms by the same ratio", () => {
    // Row 145: "the scale changing by ratio so the zoom feels even".
    expect(tween(from, to, 0.5, PANE).scale).toBeCloseTo(0.5, 12);
    expect(tween(from, to, 0.25, PANE).scale).toBeCloseTo(0.25 * Math.SQRT2, 12);
  });

  test("halfway the map point under the pane's centre is halfway between its ends", () => {
    const a = centrePoint(from, PANE);
    const b = centrePoint(to, PANE);
    const m = centrePoint(tween(from, to, 0.5, PANE), PANE);
    expect(m.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(m.y).toBeCloseTo((a.y + b.y) / 2, 9);
  });

  test("progress outside 0..1 is held to it, and NaN arrives", () => {
    expect(tween(from, to, -1, PANE)).toEqual(from);
    expect(tween(from, to, 7, PANE)).toEqual(to);
    expect(tween(from, to, Number.NaN, PANE)).toEqual(to);
  });

  test("a broken or non-positive scale at either end jumps to the end", () => {
    // There is no ratio to interpolate; arriving is the safe answer.
    for (const scale of [0, -1, ...BAD]) {
      expect(tween({ ...from, scale }, to, 0.5, PANE)).toEqual(to);
      expect(tween(from, { ...to, scale }, 0.5, PANE)).toEqual({ ...to, scale: 1 });
    }
  });

  test("a broken coordinate at either end jumps to the end, with a broken field read as 0", () => {
    // `to` is drawn as the end; a NaN in it cannot be drawn, so it reads as
    // camera.ts reads one: x or y 0, scale 1.
    for (const bad of BAD) {
      expect(tween({ ...from, x: bad }, to, 0.5, PANE)).toEqual(to);
      expect(tween(from, { ...to, y: bad }, 0.5, PANE)).toEqual({ ...to, y: 0 });
      expect(tween(from, { ...to, y: bad }, 0, PANE)).toEqual({ ...to, y: 0 });
    }
  });

  test("a pane of 0 by 0 or a broken pane interpolates around the origin and stays finite", () => {
    for (const pane of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: -5 },
    ]) {
      const c = tween(from, to, 0.5, pane);
      expect(isFiniteCamera(c)).toBe(true);
      expect(c.scale).toBeCloseTo(0.5, 12);
    }
  });

  test("the same camera at both ends stays put", () => {
    expect(tween(to, to, 0.3, PANE)).toEqual(to);
  });
});

describe("zoomStep: Plus and minus (decision 145, Keys)", () => {
  test("the step is the diagram focus view's: Panzoom's zoomIn with step 0.25 multiplies by e^0.25", () => {
    // Row 145: "a fixed step ... as in the focus views". The diagram view is
    // the one with a camera like the map's (src/deck/focus.ts passes
    // `step: 0.25` to Panzoom); its zoomIn computes `scale * Math.exp(step)`.
    // Read from the sources, so a change in either shows here.
    const focus = readFileSync(new URL("../deck/focus.ts", import.meta.url), "utf8");
    expect(focus).toContain("Panzoom(canvas, { maxScale, minScale, step: 0.25 })");
    const panzoom = readFileSync(
      new URL("../../node_modules/@panzoom/panzoom/dist/panzoom.es.js", import.meta.url),
      "utf8",
    );
    expect(panzoom).toContain("scale * Math.exp((isIn ? 1 : -1) * opts.step)");
    expect(ZOOM_STEP).toBe(Math.exp(0.25));
  });

  test("in and out change the scale by the step around the pane's centre", () => {
    const start = fitAll(BIG, PANE);
    const zoomedIn = zoomStep(start, "in", BIG, PANE);
    expect(zoomedIn.scale).toBeCloseTo(start.scale * ZOOM_STEP, 12);
    const a = centrePoint(start, PANE);
    const b = centrePoint(zoomedIn, PANE);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
    const back = zoomStep(zoomedIn, "out", BIG, PANE);
    expect(back.scale).toBeCloseTo(start.scale, 12);
  });

  test("the scale stops at the camera's limits", () => {
    // Out from the whole map stays at the whole map; in at 2 stays at 2.
    const whole = fitAll(BIG, PANE);
    expect(zoomStep(whole, "out", BIG, PANE)).toEqual(whole);
    const top = { x: 0, y: 0, scale: MAX_SCALE };
    expect(zoomStep(top, "in", BIG, PANE).scale).toBe(MAX_SCALE);
  });

  test("a broken camera or a pane of 0 by 0 still gives a finite camera", () => {
    for (const bad of BAD) {
      expect(isFiniteCamera(zoomStep({ x: bad, y: bad, scale: bad }, "in", BIG, PANE))).toBe(true);
    }
    expect(isFiniteCamera(zoomStep(fitAll(BIG, PANE), "in", BIG, { width: 0, height: 0 }))).toBe(
      true,
    );
  });
});

// ---- Properties ---------------------------------------------------------

// The block generator of src/map/layout.test.ts (from sectionize.test.ts):
// headings, thematic breaks, setext headings, fences holding `---`, comments
// and definitions.
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
const level = fc.constantFrom<Parameters<typeof sectionize>[1]>("auto", 1, 2, 3, 4, [2, 3]);

const coordinate = fc.double({ min: -1e6, max: 1e6, noNaN: true });
const scale = fc.double({ min: 1e-3, max: MAX_SCALE, noNaN: true });
const camera = fc.record({ x: coordinate, y: coordinate, scale });
const pane = fc.record({
  width: fc.double({ min: 0, max: 4000, noNaN: true }),
  height: fc.double({ min: 0, max: 4000, noNaN: true }),
});
const hostile = fc.oneof(fc.double(), fc.constantFrom(0, -1, 1e-300, 1e300, ...BAD));
const anyCamera = fc.record({ x: hostile, y: hostile, scale: hostile });
const anyPane = fc.record({ width: hostile, height: hostile });

describe("properties", () => {
  fcTest.prop([doc, level])(
    "two sections of one plan never share a line, so 'the greatest line at or before' is one section",
    (md, lvl) => {
      // One parsed tree for both plans. Each section opens at its own
      // top-level block and blocks start on lines of their own.
      const { deck, map } = plans(md, lvl);
      for (const sections of [deck, map]) {
        for (let i = 1; i < sections.length; i++) {
          expect(sections[i]!.line).toBeGreaterThan(sections[i - 1]!.line);
        }
      }
    },
  );

  fcTest.prop([doc])("a frame with a deck section of the same id maps to it, both ways", (md) => {
    // Row 145: a frame at the deck's own level is that slide, and a link to
    // a slide that is also a frame opens that frame.
    const { deck, map } = plans(md);
    const deckIds = new Set(deck.map((s) => s.id));
    const mapIds = new Set(map.map((s) => s.id));
    for (const frame of map) {
      if (deckIds.has(frame.id)) expect(sectionForFrame(deck, map, frame.id)).toBe(frame.id);
    }
    for (const section of deck) {
      if (mapIds.has(section.id)) expect(frameForSection(map, deck, section.id)).toBe(section.id);
    }
  });

  fcTest.prop([doc, level])(
    "every frame maps to a deck section and every deck section to a frame, at any deck level",
    (md, lvl) => {
      // The link always follows the current frame, and an address always moves
      // the map, unless one side is empty.
      const { deck, map } = plans(md, lvl);
      const deckIds = deck.map((s) => s.id);
      const mapIds = map.map((s) => s.id);
      for (const frame of map) {
        const id = sectionForFrame(deck, map, frame.id);
        if (deck.length === 0) expect(id).toBeNull();
        else expect(deckIds).toContain(id);
      }
      for (const section of deck) {
        const id = frameForSection(map, deck, section.id);
        if (map.length === 0) expect(id).toBeNull();
        else expect(mapIds).toContain(id);
      }
    },
  );

  fcTest.prop([doc])("the route visits every frame once, in plan order", (md) => {
    const p = mapPlan(parseMarkdown(md));
    const order = routeOrder(mapColumns(p));
    expect(order).toEqual(p.sections.map((s) => s.id));
    // Next from the first frame, repeated, reaches the last frame in count - 1 steps.
    let at = firstFrame(order);
    for (let i = 1; i < order.length; i++) {
      const next = nextFrame(order, at);
      expect(placeOf(order, next)?.index).toBe(i + 1);
      expect(previousFrame(order, next)).toBe(at);
      at = next;
    }
    expect(at).toBe(lastFrame(order));
  });

  fcTest.prop([fc.double(), fc.double()])("ease stays in 0..1 and never goes back", (a, b) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const [ea, eb] = [ease(lo), ease(hi)];
    expect(ea).toBeGreaterThanOrEqual(0);
    expect(eb).toBeLessThanOrEqual(1);
    if (!Number.isNaN(a) && !Number.isNaN(b)) expect(ea).toBeLessThanOrEqual(eb);
  });

  fcTest.prop([anyCamera, anyCamera, hostile, anyPane])(
    "every camera on the way is finite, whatever the input",
    (from, to, t, p) => {
      expect(isFiniteCamera(tween(from, to, t, p))).toBe(true);
    },
  );

  fcTest.prop([camera, camera, fc.double({ min: 0, max: 1, noNaN: true }), pane])(
    "the scale stays between the two ends' scales",
    (from, to, t, p) => {
      const s = tween(from, to, t, p).scale;
      expect(s).toBeGreaterThanOrEqual(Math.min(from.scale, to.scale));
      expect(s).toBeLessThanOrEqual(Math.max(from.scale, to.scale));
    },
  );

  fcTest.prop([camera, camera, fc.double({ min: 0, max: 1, noNaN: true }), pane])(
    "the map point under the pane's centre moves on the straight segment between its ends",
    (from, to, t, p) => {
      // The move reads as one straight glide across the map, not an arc. Up to
      // rounding: the point is rebuilt from x, y and the scale.
      const c = tween(from, to, t, p);
      const a = centrePoint(from, p);
      const b = centrePoint(to, p);
      const m = centrePoint(c, p);
      const tol = (u: number, v: number) =>
        1e-9 * (Math.abs(u) + Math.abs(v) + Math.max(p.width, p.height) / c.scale + 1);
      expect(Math.abs(m.x - (a.x + (b.x - a.x) * t))).toBeLessThanOrEqual(tol(a.x, b.x));
      expect(Math.abs(m.y - (a.y + (b.y - a.y) * t))).toBeLessThanOrEqual(tol(a.y, b.y));
    },
  );

  fcTest.prop([anyCamera, fc.constantFrom("in" as const, "out" as const), anyPane, anyPane])(
    "a zoom step never gives a broken camera",
    (c, direction, bounds, p) => {
      expect(isFiniteCamera(zoomStep(c, direction, bounds, p))).toBe(true);
    },
  );
});
