import { describe, expect, test, vi } from "vitest";
import type { MarkEvent } from "./mirrorTypes";
import {
  DocumentMarks,
  loadMarks,
  markKey,
  marksSaver,
  MAX_DOCUMENT_POINTS,
  MAX_PARSED_NUMBERS,
  MAX_SAVED_SLIDES,
  memoryMarksStore,
  readSlides,
  type MarksStore,
  type SavedStroke,
  type StoredSlide,
} from "./savedMarks";

/**
 * Saved marks (decision 105). What comes back from IndexedDB is input like
 * any other (rule 5): another build, a damaged profile or a script on the
 * same origin may have written it. The reader keeps only records a strict
 * schema accepts, within the caps, so nothing it hands the layer or an
 * export can grow without bound or carry a string into the DOM.
 */

const DOC = "sha256:abc";
const pen = (points: number[] = [100, 100, 200, 220, 300, 260]): SavedStroke => ({
  tool: "pen",
  color: "primary",
  points,
});
const record = (over: Partial<StoredSlide> & Record<string, unknown> = {}): StoredSlide => ({
  doc: DOC,
  slide: "intro/1",
  text: "1a2b3c4d",
  strokes: [pen()],
  ...over,
});
const slides = (records: unknown) => readSlides(DOC, records).map((s) => s.slide);

/** Points arrays that count the coordinates read from them. */
function counted() {
  const state = { reads: 0 };
  const strokes = (count: number, per: number) =>
    Array.from({ length: count }, () =>
      pen(
        new Proxy(
          Array.from({ length: 2 * per }, () => 5),
          {
            get(target, key, receiver) {
              if (typeof key === "string" && /^\d+$/.test(key)) state.reads++;
              return Reflect.get(target, key, receiver) as unknown;
            },
          },
        ),
      ),
    );
  return { state, strokes };
}

describe("reading stored marks back", () => {
  test("a well-formed record reads back as it was saved", () => {
    const arrow: SavedStroke = { tool: "arrow", color: "ink", points: [0, 0, 4096, 4096] };
    expect(readSlides(DOC, [record({ strokes: [pen(), arrow] })])).toEqual([
      { slide: "intro/1", text: "1a2b3c4d", strokes: [pen(), arrow] },
    ]);
  });

  test("a rectangle and an ellipse of four numbers read back as they were saved (decision 110)", () => {
    const rect: SavedStroke = { tool: "rect", color: "primary", points: [400, 300, 3000, 2000] };
    const ellipse: SavedStroke = {
      tool: "ellipse",
      color: "focus",
      points: [3000, 2000, 400, 300],
    };
    expect(readSlides(DOC, [record({ strokes: [rect, ellipse] })])).toEqual([
      { slide: "intro/1", text: "1a2b3c4d", strokes: [rect, ellipse] },
    ]);
  });

  test.each([
    ["an unknown field on the record", record({ html: "<img src=x>" })],
    ["an unknown field on a stroke", record({ strokes: [{ ...pen(), d: "M0 0" } as SavedStroke] })],
    ["a coordinate past the grid", record({ strokes: [pen([0, 0, 4097, 10])] })],
    ["a negative coordinate", record({ strokes: [pen([0, 0, -1, 10])] })],
    ["a fractional coordinate", record({ strokes: [pen([0, 0, 1.5, 10])] })],
    ["NaN", record({ strokes: [pen([0, 0, Number.NaN, 10])] })],
    ["Infinity", record({ strokes: [pen([0, 0, Number.POSITIVE_INFINITY, 10])] })],
    ["a coordinate as text", record({ strokes: [pen([0, 0, "12", 10] as unknown as number[])] })],
    ["an odd number of coordinates", record({ strokes: [pen([0, 0, 10])] })],
    ["a pen stroke with no point", record({ strokes: [pen([])] })],
    [
      "an arrow without both ends",
      record({ strokes: [{ tool: "arrow", color: "ink", points: [0, 0, 10, 10, 20, 20] }] }),
    ],
    [
      "a tool docwalk has no drawing for",
      record({ strokes: [{ ...pen(), tool: "highlighter" } as never] }),
    ],
    [
      "a rectangle of two numbers",
      record({ strokes: [{ tool: "rect", color: "ink", points: [10, 10] }] }),
    ],
    [
      "a rectangle of six numbers",
      record({ strokes: [{ tool: "rect", color: "ink", points: [10, 10, 20, 20, 30, 30] }] }),
    ],
    [
      "an ellipse of two numbers",
      record({ strokes: [{ tool: "ellipse", color: "ink", points: [10, 10] }] }),
    ],
    [
      "an ellipse of six numbers",
      record({ strokes: [{ tool: "ellipse", color: "ink", points: [10, 10, 20, 20, 30, 30] }] }),
    ],
    ["a colour that is not a key", record({ strokes: [{ ...pen(), color: "red" } as never] })],
    ["a colour that is CSS", record({ strokes: [{ ...pen(), color: "url(#x)" } as never] })],
    ["a fingerprint that is not hex", record({ text: "<svg onload=x>" })],
    ["a fingerprint longer than the hash", record({ text: "123456789" })],
    ["an empty address", record({ slide: "" })],
    ["an address past the mirror's limit", record({ slide: `${"a".repeat(2047)}/1` })],
    ["another document's record", record({ doc: "sha256:other" })],
    ["a slide with no stroke", record({ strokes: [] })],
    ["strokes that are not a list", record({ strokes: "[]" as never })],
  ])("refuses %s", (_, bad) => {
    expect(readSlides(DOC, [bad])).toEqual([]);
  });

  test("refuses a stroke over 1500 points, a slide over 200 strokes and one over 30,000 points", () => {
    const long = pen(Array.from({ length: 3002 }, (_, i) => i % 4096));
    const many = Array.from({ length: 201 }, () => pen([1, 1]));
    const heavy = Array.from({ length: 21 }, () => pen(Array.from({ length: 3000 }, () => 7)));
    expect(slides([record({ strokes: [long] })])).toEqual([]);
    expect(slides([record({ strokes: many })])).toEqual([]);
    expect(slides([record({ strokes: heavy })])).toEqual([]);
    // One under each cap reads.
    expect(slides([record({ strokes: many.slice(1) })])).toEqual(["intro/1"]);
    expect(slides([record({ strokes: heavy.slice(1) })])).toEqual(["intro/1"]);
  });

  test("an oversized list is refused by its length, before any item in it is read", () => {
    // A hostile record of thousands or millions of points must not cost a walk over them.
    let reads = 0;
    const points = new Proxy(Array.from<number>({ length: 100_000 }), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(slides([record({ strokes: [pen(points)] })])).toEqual([]);
    expect(reads).toBe(0);
  });

  describe("the cost of reading is bounded before any coordinate is parsed", () => {
    test("a slide over 30,000 points is skipped without reading one of them", () => {
      // 21 strokes of 1,500 points: each stroke is within its cap, the slide is not.
      const { state, strokes } = counted();
      expect(slides([record({ strokes: strokes(21, 1500) })])).toEqual([]);
      expect(state.reads).toBe(0);
    });

    test("a slide that no longer fits the document's budget is skipped without reading", () => {
      // 3 slides of 30,000 points leave 10,000; a 10,500-point slide cannot fit.
      const full = (i: number) =>
        record({
          slide: `h${i}/1`,
          strokes: Array.from({ length: 20 }, () => pen(Array(3000).fill(5))),
        });
      const { state, strokes } = counted();
      const late = record({ slide: "late/1", strokes: strokes(7, 1500) });
      expect(slides([full(1), full(2), full(3), late])).toEqual(["h1/1", "h2/1", "h3/1"]);
      expect(state.reads).toBe(0);
    });

    test("once the document's budget is spent, no later record is parsed", () => {
      const spent = (i: number) =>
        record({
          slide: `h${i}/1`,
          strokes: Array.from({ length: 20 }, () => pen(Array(2500).fill(5))),
        });
      const { state, strokes } = counted();
      const valid = record({ slide: "late/1", strokes: strokes(1, 1) });
      // 4 x 25,000 points is exactly the document's 100,000; the fifth is valid but has no room.
      expect(slides([spent(1), spent(2), spent(3), spent(4), valid])).toHaveLength(4);
      expect(state.reads).toBe(0);
    });

    test("records that fail on their last coordinate stop costing once the parse budget is spent", () => {
      // Each record passes the size pre-check (59,000 numbers) and is refused only by its last
      // coordinate, so a parser that counts only what it keeps would walk all 40 of them.
      const { state, strokes } = counted();
      const damaged = (i: number) => {
        const list = strokes(20, 1475);
        const last = list[19]!.points as number[];
        // The Proxy's set trap is not counted: only reads are.
        last[last.length - 1] = 4097;
        return record({ slide: `d${i}/1`, strokes: list });
      };
      const all = Array.from({ length: 40 }, (_, i) => damaged(i));
      expect(slides(all)).toEqual([]);
      expect(state.reads).toBeLessThanOrEqual(MAX_PARSED_NUMBERS);
      // It did parse some: the budget bounds the walk, it does not skip the reader.
      expect(state.reads).toBeGreaterThan(0);
    });

    test("a record with thousands of unknown keys is refused at its first bad stroke", () => {
      // A strict object walks all of its keys to look for unknown ones; unless the parse stops
      // at the first refused stroke, 200 such strokes cost 200 walks over 5,000 keys.
      let walks = 0;
      const extras = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`extra${i}`, i]));
      const stroke = new Proxy(
        { ...pen(), ...extras },
        {
          ownKeys(target) {
            walks++;
            return Reflect.ownKeys(target);
          },
        },
      );
      const records = Array.from({ length: 20 }, (_, i) =>
        record({
          slide: `x${i}/1`,
          strokes: Array.from({ length: 200 }, () => stroke as SavedStroke),
        }),
      );
      expect(slides(records)).toEqual([]);
      expect(walks).toBeLessThanOrEqual(records.length);
    });

    test("a smaller record after a skipped one still reads", () => {
      const { strokes } = counted();
      const big = record({ slide: "big/1", strokes: strokes(21, 1500) });
      expect(slides([big, record({ slide: "small/1" })])).toEqual(["small/1"]);
    });
  });

  test("a bad record is skipped alone, so one damaged slide does not hide the rest", () => {
    const bad = record({ slide: "risks/1", strokes: [pen([0, 0, 9999, 0])] });
    expect(slides([record(), bad, record({ slide: "rollout/2" })])).toEqual([
      "intro/1",
      "rollout/2",
    ]);
  });

  test("reads at most 500 slides and 100,000 points for one document", () => {
    const tooMany = Array.from({ length: MAX_SAVED_SLIDES + 5 }, (_, i) =>
      record({ slide: `s${i}/1`, strokes: [pen([1, 1])] }),
    );
    expect(slides(tooMany)).toHaveLength(MAX_SAVED_SLIDES);

    // 4 slides of 30,000 points fill the document; the 5th would pass the cap.
    const full = pen(Array.from({ length: 2 * 1500 }, () => 5));
    const heavy = (i: number) =>
      record({ slide: `h${i}/1`, strokes: Array.from({ length: 20 }, () => full) });
    expect(4 * 30_000 > MAX_DOCUMENT_POINTS).toBe(true);
    expect(slides([1, 2, 3, 4].map(heavy))).toEqual(["h1/1", "h2/1", "h3/1"]);
  });

  test("anything but a list of records reads as no marks", () => {
    for (const value of [null, undefined, 42, "[]", { length: 1, 0: record() }]) {
      expect(readSlides(DOC, value)).toEqual([]);
    }
  });
});

describe("the marks of one document", () => {
  const strokes = [pen()];

  test("a slide's marks come back only for the text they were drawn on", async () => {
    const store = memoryMarksStore();
    const marks = await loadMarks(store, DOC, vi.fn());
    marks.put("intro/1", "aa", strokes);
    await marks.settled();

    const again = await loadMarks(store, DOC, vi.fn());
    expect(again.strokes("intro/1", "aa")).toEqual(strokes);
    // The slide's text changed since: a circle around a sentence that moved points at the wrong thing.
    expect(again.strokes("intro/1", "bb")).toEqual([]);
    expect(again.forKey(markKey("intro/1", "aa"), "intro/1")).toEqual(strokes);
    expect(again.forKey(markKey("intro/1", "bb"), "intro/1")).toEqual([]);
    expect(again.size).toBe(1);
  });

  test("an empty slide deletes its record, so cleared slides leave nothing behind", async () => {
    const store = memoryMarksStore();
    const marks = await loadMarks(store, DOC, vi.fn());
    marks.put("intro/1", "aa", strokes);
    marks.put("intro/1", "aa", []);
    await marks.settled();
    expect(marks.size).toBe(0);
    expect(await store.load(DOC)).toEqual([]);
  });

  test("a gesture that draws nothing on a slide whose text changed leaves the waiting record alone (decision 105)", async () => {
    // The marks wait for "aa" to come back. On "bb" the slide shows none of them, so a click with
    // the eraser, an arrow too short to draw or Clear marks reports an empty slide.
    const store = memoryMarksStore();
    const marks = await loadMarks(store, DOC, vi.fn());
    marks.put("intro/1", "aa", strokes);
    marks.put("intro/1", "bb", []);
    await marks.settled();
    expect(marks.strokes("intro/1", "aa")).toEqual(strokes);
    expect(marks.size).toBe(1);
    expect((await loadMarks(store, DOC, vi.fn())).strokes("intro/1", "aa")).toEqual(strokes);
    // Back on the text they were drawn on, an empty slide deletes them as before.
    marks.put("intro/1", "aa", []);
    await marks.settled();
    expect(marks.size).toBe(0);
    expect(await store.load(DOC)).toEqual([]);
  });

  test("a new mark on the changed text replaces the waiting record (decision 105)", async () => {
    const store = memoryMarksStore();
    const marks = await loadMarks(store, DOC, vi.fn());
    marks.put("intro/1", "aa", strokes);
    const fresh = [pen([5, 5, 50, 50])];
    marks.put("intro/1", "bb", fresh);
    await marks.settled();
    expect(marks.strokes("intro/1", "aa")).toEqual([]);
    expect(marks.strokes("intro/1", "bb")).toEqual(fresh);
    expect(readSlides(DOC, await store.load(DOC))).toEqual([
      { slide: "intro/1", text: "bb", strokes: fresh },
    ]);
  });

  test("a save past a cap keeps the last saved marks and says so once", async () => {
    const store = memoryMarksStore();
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(store, DOC, problem);
    marks.put("intro/1", "aa", strokes);
    const crowded = Array.from({ length: 201 }, () => pen([1, 1]));
    expect(marks.put("intro/1", "aa", crowded)).toBe(false);
    expect(marks.put("intro/1", "aa", crowded)).toBe(false);
    await marks.settled();
    expect(problem.mock.calls).toEqual([["full"]]);
    expect((await loadMarks(store, DOC, vi.fn())).strokes("intro/1", "aa")).toEqual(strokes);
  });

  test("a save past the document's points is refused, while a smaller slide still fits", async () => {
    const marks = await loadMarks(memoryMarksStore(), DOC, vi.fn());
    const full = pen(Array.from({ length: 3000 }, () => 5));
    const slide = Array.from({ length: 20 }, () => full);
    expect([1, 2, 3].map((i) => marks.put(`h${i}/1`, "aa", slide))).toEqual([true, true, true]);
    expect(marks.put("h4/1", "aa", slide)).toBe(false);
    expect(marks.put("h4/1", "aa", strokes)).toBe(true);
    // Replacing a slide counts its new strokes, not old and new together.
    expect(marks.put("h1/1", "aa", slide)).toBe(true);
  });

  test("marks saved under a document's old key move to its new key once (decision 120)", async () => {
    // A `?src=` key used to keep the query, where a token can sit.
    const store = memoryMarksStore();
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    await store.put(record({ doc: OLD, slide: "intro/1", text: "aa" }));
    await store.put(
      record({ doc: OLD, slide: "risks/1", text: "bb", strokes: [{ tool: "pen" } as SavedStroke] }),
    );

    const marks = await loadMarks(store, NEW, vi.fn(), OLD);
    expect(marks.strokes("intro/1", "aa")).toEqual([pen()]);
    // Only what the reader accepts moves; the old key holds nothing afterwards.
    expect(readSlides(NEW, await store.load(NEW)).map((s) => s.slide)).toEqual(["intro/1"]);
    expect(await store.load(OLD)).toEqual([]);
  });

  test("the new key's own record of a slide wins over the old key's, and the old key goes (decision 136)", async () => {
    const store = memoryMarksStore();
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    await store.put(record({ doc: OLD, slide: "intro/1", text: "cc" }));
    await store.put(record({ doc: NEW, slide: "intro/1", text: "dd" }));
    const marks = await loadMarks(store, NEW, vi.fn(), OLD);
    expect(marks.strokes("intro/1", "dd")).toEqual([pen()]);
    expect(marks.strokes("intro/1", "cc")).toEqual([]);
    // Decision 120 left this key alone; 136 deletes it, since it may carry a token.
    expect(await store.load(OLD)).toEqual([]);
  });

  test("an old key left beside a new key that has marks is merged and deleted at the next open (decision 136)", async () => {
    // A failed move followed by a mark drawn under the new key made the new key non-empty:
    // no later open looked at the old key again, and the token in it stayed in the database
    // for good. Comments move every time (132).
    const store = memoryMarksStore();
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    await store.put(record({ doc: NEW, slide: "intro/1", text: "dd" }));
    await store.put(record({ doc: OLD, slide: "intro/1", text: "cc" }));
    await store.put(record({ doc: OLD, slide: "risks/1", text: "bb" }));

    const marks = await loadMarks(store, NEW, vi.fn(), OLD);
    // The new key's record of a slide is the later one, so it stays; the old key adds what
    // the new key lacks.
    expect(marks.strokes("intro/1", "dd")).toEqual([pen()]);
    expect(marks.strokes("intro/1", "cc")).toEqual([]);
    expect(marks.strokes("risks/1", "bb")).toEqual([pen()]);
    expect(readSlides(NEW, await store.load(NEW)).map((s) => [s.slide, s.text])).toEqual([
      ["intro/1", "dd"],
      ["risks/1", "bb"],
    ]);
    expect(await store.load(OLD)).toEqual([]);
  });

  test("past the per-document cap the move changes nothing and the old key stays, as for comments", async () => {
    // A move that kept only what fits would drop marks unseen (decision 105's caps).
    const store = memoryMarksStore();
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    const full = Array.from({ length: 20 }, () => pen(Array.from({ length: 3000 }, () => 5)));
    for (const i of [1, 2, 3])
      await store.put(record({ doc: NEW, slide: `h${i}/1`, text: "aa", strokes: full }));
    await store.put(record({ doc: OLD, slide: "h4/1", text: "aa", strokes: full }));

    const marks = await loadMarks(store, NEW, vi.fn(), OLD);
    expect(marks.size).toBe(3);
    expect(readSlides(NEW, await store.load(NEW))).toHaveLength(3);
    expect(readSlides(OLD, await store.load(OLD)).map((s) => s.slide)).toEqual(["h4/1"]);
  });

  test("a move that fails midway leaves the new key empty and the old records in place, so the next open tries again (decisions 120, 132)", async () => {
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    const base = memoryMarksStore();
    await base.put(record({ doc: OLD, slide: "intro/1", text: "aa" }));
    await base.put(record({ doc: OLD, slide: "risks/1", text: "bb" }));
    // A disk with room for one record. Each write is all or nothing, as an IndexedDB
    // transaction is: a write of more than one record fails whole.
    let room = 1;
    const cramped: MarksStore = {
      ...base,
      put: async (r) => {
        if (room-- <= 0) throw new Error("QuotaExceededError");
        await base.put(r);
      },
      clear: async (doc, replacement) => {
        if ((replacement?.length ?? 0) > room) throw new Error("QuotaExceededError");
        await base.clear(doc, replacement);
      },
    };

    const marks = await loadMarks(cramped, NEW, vi.fn(), OLD);
    expect(marks.size).toBe(0);
    expect(await base.load(NEW)).toEqual([]);
    expect(readSlides(OLD, await base.load(OLD)).map((s) => s.slide)).toEqual([
      "intro/1",
      "risks/1",
    ]);

    // With room again, the next open moves both and the key with the token is gone.
    const again = await loadMarks(base, NEW, vi.fn(), OLD);
    expect(again.size).toBe(2);
    expect(readSlides(NEW, await base.load(NEW))).toHaveLength(2);
    expect(await base.load(OLD)).toEqual([]);
  });

  test("an old key that holds nothing valid is cleared, so the query it carries does not stay (decision 132)", async () => {
    const store = memoryMarksStore();
    const OLD = "url:https://docs.example/plan.md?t=secret";
    const NEW = "url:https://docs.example/plan.md";
    await store.put(record({ doc: OLD, strokes: [{ tool: "pen" } as SavedStroke] }));
    const marks = await loadMarks(store, NEW, vi.fn(), OLD);
    expect(marks.size).toBe(0);
    expect(await store.load(OLD)).toEqual([]);
  });

  test("clear deletes every slide of the document, and only of that document", async () => {
    const store = memoryMarksStore();
    const marks = await loadMarks(store, DOC, vi.fn());
    const other = await loadMarks(store, "sha256:other", vi.fn());
    marks.put("intro/1", "aa", strokes);
    marks.put("risks/1", "bb", strokes);
    other.put("intro/1", "aa", strokes);
    const heard = vi.fn<() => void>();
    marks.subscribe(heard);
    expect(await marks.clear()).toBe(true);
    expect(marks.size).toBe(0);
    expect(heard).toHaveBeenCalled();
    expect(await store.load(DOC)).toEqual([]);
    expect(readSlides("sha256:other", await store.load("sha256:other"))).toHaveLength(1);
  });

  test("a store that fails reports it once and the marks stay on screen", async () => {
    const failing: MarksStore = {
      persistent: true,
      load: async () => [],
      put: () => Promise.reject(new Error("QuotaExceededError")),
      remove: () => Promise.reject(new Error("QuotaExceededError")),
      clear: async () => {},
    };
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(failing, DOC, problem);
    marks.put("intro/1", "aa", strokes);
    marks.put("risks/1", "aa", strokes);
    await marks.settled();
    expect(problem.mock.calls).toEqual([["failed"]]);
    expect(marks.strokes("intro/1", "aa")).toEqual(strokes);
  });

  test("a document whose marks cannot be read writes nothing over them", async () => {
    const put = vi.fn<MarksStore["put"]>(async () => {});
    const unreadable: MarksStore = {
      persistent: true,
      load: () => Promise.reject(new Error("UnknownError")),
      put,
      remove: async () => {},
      clear: async () => {},
    };
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(unreadable, DOC, problem);
    marks.put("intro/1", "aa", strokes);
    await marks.settled();
    expect(put).not.toHaveBeenCalled();
    expect(problem.mock.calls).toEqual([["failed"]]);
    // Nor does it say it deleted what it could not reach.
    expect(await marks.clear()).toBe(false);
  });

  test("a document key the schema would refuse saves nothing and says the save failed, not that it is full", async () => {
    const store = memoryMarksStore();
    const put = vi.spyOn(store, "put");
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(store, "k".repeat(4097), problem);
    marks.put("intro/1", "aa", strokes);
    await marks.settled();
    expect(put).not.toHaveBeenCalled();
    expect(problem.mock.calls).toEqual([["failed"]]);
    expect(await marks.clear()).toBe(false);
  });

  test("marks with no document at all keep nothing and say nothing", async () => {
    const marks = new DocumentMarks("", [], null, () => {});
    expect(marks.put("intro/1", "aa", strokes)).toBe(false);
    expect(marks.size).toBe(0);
  });

  test("an address over the limit saves nothing and says the save failed, not that it is full", async () => {
    const store = memoryMarksStore();
    const put = vi.spyOn(store, "put");
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(store, DOC, problem);
    marks.put("a".repeat(2049), "aa", strokes);
    await marks.settled();
    expect(put).not.toHaveBeenCalled();
    expect(problem.mock.calls).toEqual([["failed"]]);
    expect(marks.size).toBe(0);
  });

  test("a key at the limit saves like any other", async () => {
    const store = memoryMarksStore();
    const marks = await loadMarks(store, "k".repeat(4096), vi.fn());
    expect(marks.put("intro/1", "aa", strokes)).toBe(true);
    await marks.settled();
    expect(await store.load("k".repeat(4096))).toHaveLength(1);
  });

  test("a delete the store refuses is not reported as done", async () => {
    const refusing: MarksStore = {
      ...memoryMarksStore(),
      clear: () => Promise.reject(new Error("UnknownError")),
    };
    const problem = vi.fn<(kind: "full" | "failed") => void>();
    const marks = await loadMarks(refusing, DOC, problem);
    expect(await marks.clear()).toBe(false);
    expect(problem.mock.calls).toEqual([["failed"]]);
  });
});

/** A saver over a fresh document, with a spy on what it saves. */
async function saver(prints: Record<string, string> = { "a/1": "aa", "b/1": "bb" }) {
  const marks = await loadMarks(memoryMarksStore(), DOC, vi.fn());
  const put = vi.spyOn(marks, "put");
  const hear = marksSaver(
    () => marks,
    (address) => prints[address],
  );
  return { marks, put, hear };
}

describe("what the layer reports is saved", () => {
  const stroke = { id: 1, ...pen() };
  const marksOf = (slide: string, reset: boolean, list = [stroke]): MarkEvent => ({
    kind: "marks",
    slide,
    strokes: list,
    reset,
  });

  test("a change on the slide on screen saves what that slide shows, without the stroke ids", async () => {
    const { put, hear } = await saver();
    hear(marksOf("a/1", true, []));
    hear(marksOf("a/1", false));
    expect(put.mock.calls).toEqual([["a/1", "aa", [pen()]]]);
  });

  test("a slide change is no change: the slide's marks are already saved", async () => {
    const { put, hear } = await saver();
    hear(marksOf("a/1", true));
    hear(marksOf("b/1", true));
    expect(put).not.toHaveBeenCalled();
  });

  test("a rebuild that drops another slide's marks deletes nothing: a resize may only have moved its page breaks", async () => {
    const { put, hear } = await saver();
    hear(marksOf("a/1", true));
    hear(marksOf("b/1", false, []));
    expect(put).not.toHaveBeenCalled();
  });

  test("nothing is saved for a slide without a fingerprint, nor while no document is open", async () => {
    const { put, hear } = await saver({});
    hear(marksOf("a/1", true));
    hear(marksOf("a/1", false));
    expect(put).not.toHaveBeenCalled();

    const closed = marksSaver(
      () => null,
      () => "aa",
    );
    closed(marksOf("a/1", true));
    expect(() => closed(marksOf("a/1", false))).not.toThrow();
  });

  test("the laser and strokes in progress are not saved; only the marks a slide shows are", async () => {
    const { put, hear } = await saver();
    hear(marksOf("a/1", true));
    hear({ kind: "laser", x: 0.5, y: 0.5 });
    hear({ kind: "stroke", slide: "a/1", end: true, ...stroke });
    hear({ kind: "cancel", id: 1 });
    expect(put).not.toHaveBeenCalled();
  });
});
