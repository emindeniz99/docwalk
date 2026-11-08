import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MirrorFeed } from "./mirrorFeed";
import { MirrorMessageSchema } from "./mirrorSchema";
import { MirrorStore } from "./mirrorStore";
import {
  MAX_CHUNK_POINTS,
  MAX_SLIDE_POINTS,
  MAX_SLIDE_STROKES,
  MAX_STROKE_POINTS,
  STROKE_FLUSH_MS,
  type MarkEvent,
  type MarkStroke,
  type MirrorOp,
} from "./mirrorTypes";
import * as v from "valibot";

/**
 * The presenter's side of the mirror (decision 88): what the annotation
 * layer reports, cut into messages a relay frame holds, at a rate a network
 * and a phone can take, and kept in step with receivers that join late.
 */

// The clocks the feed reads; the high-resolution timer stays real so the load test can time itself.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

function setup() {
  const sent: MirrorOp[] = [];
  const feed = new MirrorFeed();
  feed.addSink((op) => sent.push(op));
  return { feed, sent };
}
type StrokeOp = Extract<MirrorOp, { op: "stroke" }>;
const strokeOps = (sent: MirrorOp[]) => sent.filter((o): o is StrokeOp => o.op === "stroke");
const kinds = (sent: MirrorOp[]) => sent.map((o) => o.op);

const line = (n: number, seed = 0): number[] =>
  Array.from({ length: n * 2 }, (_, i) => (seed + i * 7) % 4097);
const mark = (id: number, n = 4, over: Partial<MarkStroke> = {}): MarkStroke => ({
  id,
  tool: "pen",
  color: "primary",
  points: line(n, id),
  ...over,
});
const committed = (slide: string, s: MarkStroke): MarkEvent => ({
  kind: "stroke",
  slide,
  end: true,
  ...s,
});

describe("the laser", () => {
  test("keeps the 33 ms throttle: a pointer firing every millisecond sends about 30 messages a second", () => {
    const { feed, sent } = setup();
    for (let t = 0; t < 1000; t++) {
      feed.ingest({ kind: "laser", x: (t % 100) / 100, y: 0.5 });
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(100);
    const lasers = sent.filter((o) => o.op === "laser");
    expect(lasers.length).toBeGreaterThanOrEqual(28);
    expect(lasers.length).toBeLessThanOrEqual(32);
  });

  test("the last point of a movement always goes out, so the dot rests where the pointer stopped", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "laser", x: 0.1, y: 0.1 });
    feed.ingest({ kind: "laser", x: 0.2, y: 0.2 });
    feed.ingest({ kind: "laser", x: 0.9, y: 0.8 });
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({ op: "laser", x: 0.9, y: 0.8 });
  });

  test("laser-off cancels a point that was waiting, so the dot does not come back after it left", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "laser", x: 0.1, y: 0.1 });
    feed.ingest({ kind: "laser", x: 0.2, y: 0.2 });
    feed.ingest({ kind: "laser-off" });
    vi.advanceTimersByTime(200);
    expect(kinds(sent)).toEqual(["laser", "laser-off"]);
  });

  test("a second laser-off in a row is not sent", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "laser", x: 0.1, y: 0.1 });
    feed.ingest({ kind: "laser-off" });
    feed.ingest({ kind: "laser-off" });
    expect(kinds(sent)).toEqual(["laser", "laser-off"]);
  });

  test("positions are rounded to four places, which is below a pixel", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "laser", x: 0.123456789, y: 1 / 3 });
    expect(sent[0]).toEqual({ op: "laser", x: 0.1235, y: 0.3333 });
  });
});

describe("a pen stroke being drawn", () => {
  test("goes out in chunks of at most 128 points, every 80 ms, and every point arrives once and in order", () => {
    const { feed, sent } = setup();
    const all = line(MAX_STROKE_POINTS);
    // A 2 s scribble: the layer reports the stroke after every recorded point.
    const perMs = MAX_STROKE_POINTS / 2000;
    for (let t = 1; t <= 2000; t++) {
      const n = Math.floor(t * perMs);
      feed.ingest({
        kind: "stroke",
        slide: "a/1",
        end: false,
        id: 1,
        tool: "pen",
        color: "primary",
        points: all.slice(0, 2 * n),
      });
      vi.advanceTimersByTime(1);
    }
    feed.ingest(committed("a/1", { id: 1, tool: "pen", color: "primary", points: all }));
    const chunks = strokeOps(sent);
    let next = 0;
    for (const chunk of chunks) {
      expect(chunk.from).toBe(next);
      expect(chunk.points.length).toBeLessThanOrEqual(2 * MAX_CHUNK_POINTS);
      next += chunk.points.length;
    }
    expect(next).toBe(all.length);
    expect(chunks.flatMap((c) => c.points)).toEqual(all);
    expect(chunks.filter((c) => c.end)).toHaveLength(1);
    expect(chunks.at(-1)!.end).toBe(true);
  });

  test("a long scribble costs a bounded number of frames and bytes: the measured load", () => {
    // 5,000 pointer events in 2 s become at most 12.5 frames a second plus the
    // chunk splits, against 2,500 a second if every event were sent.
    const { feed, sent } = setup();
    const all = line(MAX_STROKE_POINTS);
    const start = process.hrtime.bigint();
    for (let t = 1; t <= 5000; t++) {
      const n = Math.min(MAX_STROKE_POINTS, Math.floor((t * MAX_STROKE_POINTS) / 5000));
      feed.ingest({
        kind: "stroke",
        slide: "a/1",
        end: false,
        id: 1,
        tool: "pen",
        color: "primary",
        points: all.slice(0, 2 * n),
      });
      if (t % 5 === 0) vi.advanceTimersByTime(2);
    }
    feed.ingest(committed("a/1", { id: 1, tool: "pen", color: "primary", points: all }));
    const cpuMs = Number(process.hrtime.bigint() - start) / 1e6;
    const frames = strokeOps(sent).length;
    const bytes = sent.reduce(
      (sum, op) => sum + JSON.stringify({ type: "mirror", ...op }).length,
      0,
    );
    // 2 s at one frame per 80 ms is 25 frames, and 1500 points need 12 chunks at the least.
    expect(frames).toBeLessThanOrEqual(2000 / STROKE_FLUSH_MS + 14);
    expect(bytes).toBeLessThan(20_000);
    // Slicing the arrays in the test dominates; the feed itself does O(1) per event.
    expect(cpuMs).toBeLessThan(2000);
    console.info(
      `mirror load: 5000 pointer events -> ${frames} frames, ${bytes} bytes of plaintext, ${cpuMs.toFixed(0)} ms in the test loop`,
    );
  });

  test("every message it makes passes the schema a receiver checks, at the widest numbers", () => {
    const { feed, sent } = setup();
    const widest = Array.from({ length: 2 * MAX_STROKE_POINTS }, () => 4096);
    feed.ingest(committed("a/1", mark(1, MAX_STROKE_POINTS, { points: widest })));
    expect(sent.length).toBeGreaterThan(1);
    for (const op of sent) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });

  test("points beyond the stroke limit are not sent", () => {
    const { feed, sent } = setup();
    feed.ingest(committed("a/1", mark(1, MAX_STROKE_POINTS + 300)));
    expect(strokeOps(sent).reduce((n, c) => n + c.points.length, 0)).toBe(2 * MAX_STROKE_POINTS);
  });

  test("an arrow goes out once, on release, as one 2-point stroke", () => {
    const { feed, sent } = setup();
    feed.ingest(committed("a/1", mark(5, 2, { tool: "arrow" })));
    vi.advanceTimersByTime(500);
    expect(strokeOps(sent)).toHaveLength(1);
    expect(strokeOps(sent)[0]).toMatchObject({ tool: "arrow", from: 0, end: true });
  });

  test("a stroke abandoned after chunks went out is dropped from the receivers", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "stroke", slide: "a/1", end: false, ...mark(3, 10) });
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    feed.ingest({ kind: "cancel", id: 3 });
    expect(sent.at(-1)).toEqual({ op: "drop", slide: "a/1", ids: [3] });
    vi.advanceTimersByTime(500);
    expect(sent.at(-1)).toEqual({ op: "drop", slide: "a/1", ids: [3] });
  });
});

describe("erase, undo, redo and clear", () => {
  test("a stroke that vanished is dropped, and one that came back is sent in full again", () => {
    const { feed, sent } = setup();
    const one = mark(1, 6);
    const two = mark(2, 6);
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    feed.ingest(committed("a/1", one));
    feed.ingest(committed("a/1", two));
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [one, two], reset: false });
    sent.length = 0;
    // Undo
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [one], reset: false });
    expect(sent).toEqual([{ op: "drop", slide: "a/1", ids: [2] }]);
    sent.length = 0;
    // Redo
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [one, two], reset: false });
    expect(strokeOps(sent)).toHaveLength(1);
    expect(strokeOps(sent)[0]).toMatchObject({ id: 2, from: 0, points: two.points, end: true });
  });

  test("an emptied slide is one clear, not a drop of every id", () => {
    const { feed, sent } = setup();
    const strokes = [mark(1), mark(2), mark(3)];
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    for (const s of strokes) feed.ingest(committed("a/1", s));
    feed.ingest({ kind: "marks", slide: "a/1", strokes, reset: false });
    sent.length = 0;
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: false });
    expect(sent).toEqual([{ op: "clear", slide: "a/1" }]);
  });

  test("a stroke still being drawn is not dropped by a marks report that does not list it yet", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    feed.ingest({ kind: "stroke", slide: "a/1", end: false, ...mark(4, 10) });
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    sent.length = 0;
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: false });
    expect(sent.filter((o) => o.op === "drop" || o.op === "clear")).toEqual([]);
  });

  test("drops of more than 64 ids are split, since one message names at most 64", () => {
    const { feed, sent } = setup();
    const strokes = Array.from({ length: 150 }, (_, i) => mark(i + 1, 2));
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    for (const s of strokes) feed.ingest(committed("a/1", s));
    feed.ingest({ kind: "marks", slide: "a/1", strokes, reset: false });
    sent.length = 0;
    feed.ingest({ kind: "marks", slide: "a/1", strokes: strokes.slice(0, 5), reset: false });
    const drops = sent.filter((o) => o.op === "drop");
    expect(drops.length).toBe(3);
    expect(drops.flatMap((d) => d.ids)).toHaveLength(145);
    for (const op of sent) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });
});

describe("a change of slide", () => {
  test("sends clear and the new slide's strokes, so a receiver that missed an erase on it converges", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    sent.length = 0;
    const kept = [mark(1), mark(2)];
    feed.ingest({ kind: "marks", slide: "b/1", strokes: kept, reset: true });
    expect(kinds(sent)).toEqual(["clear", "stroke", "stroke"]);
    expect(sent[0]).toEqual({ op: "clear", slide: "b/1" });
  });

  test("marks dropped from another slide (a rebuilt deck) clear that slide on the receivers", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    feed.ingest({ kind: "marks", slide: "b/1", strokes: [], reset: true });
    sent.length = 0;
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: false });
    expect(sent).toEqual([{ op: "clear", slide: "a/1" }]);
  });
});

describe("a receiver that joins late (resync)", () => {
  test("gets only itself the current slide's strokes, the stroke in progress and the focus state", () => {
    const { feed, sent } = setup();
    const others: MirrorOp[] = [];
    const late: MirrorOp[] = [];
    feed.addSink((op) => others.push(op));
    const done = [mark(1), mark(2)];
    feed.ingest({ kind: "marks", slide: "a/1", strokes: done, reset: true });
    feed.ingest({ kind: "stroke", slide: "a/1", end: false, ...mark(3, 6) });
    feed.focus({ kind: "open", slide: "a/1", diagram: 2 });
    feed.focus({ kind: "view", scale: 2, x: 0.1, y: -0.1 });
    vi.advanceTimersByTime(500);
    sent.length = 0;
    others.length = 0;
    feed.resync((op) => late.push(op));
    expect(kinds(late)).toEqual(["keep", "stroke", "stroke", "stroke", "focus-open", "focus-view"]);
    expect(late[0]).toEqual({ op: "keep", slide: "a/1", ids: [1, 2, 3] });
    expect(strokeOps(late).map((s) => [s.id, s.from, s.end])).toEqual([
      [1, 0, true],
      [2, 0, true],
      [3, 0, false],
    ]);
    expect(sent).toEqual([]);
    expect(others).toEqual([]);
  });

  test("with no focus view open it closes one the receiver may still show", () => {
    const { feed } = setup();
    const late: MirrorOp[] = [];
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    feed.resync((op) => late.push(op));
    expect(late).toEqual([{ op: "keep", slide: "a/1", ids: [] }, { op: "focus-close" }]);
  });

  test("never sends more than 200 strokes or 30,000 points, whatever the slide holds", () => {
    const { feed } = setup();
    const many = Array.from({ length: MAX_SLIDE_STROKES + 50 }, (_, i) => mark(i + 1, 10));
    feed.ingest({ kind: "marks", slide: "a/1", strokes: many, reset: true });
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(strokeOps(late).filter((c) => c.from === 0)).toHaveLength(MAX_SLIDE_STROKES);
    // The newest are kept.
    expect(strokeOps(late).at(-1)!.id).toBe(many.at(-1)!.id);

    const heavy = Array.from({ length: 40 }, (_, i) => mark(i + 1, MAX_STROKE_POINTS));
    feed.ingest({ kind: "marks", slide: "b/1", strokes: heavy, reset: true });
    const again: MirrorOp[] = [];
    feed.resync((op) => again.push(op));
    const points = strokeOps(again).reduce((n, c) => n + c.points.length / 2, 0);
    expect(points).toBeLessThanOrEqual(MAX_SLIDE_POINTS);
  });
});

describe("a resync keeps what receivers hold (decision 103)", () => {
  const ids = (store: MirrorStore, slide = "a/1") => store.strokes(slide).map((s) => s.id);

  test("no receiver loses a mark at any point of it: the strokes replace by id, none is cleared first", () => {
    const { feed } = setup();
    const marks = [mark(1, 40), mark(2, 40), mark(3, 40)];
    feed.ingest({ kind: "marks", slide: "a/1", strokes: marks, reset: true });
    const holder = new MirrorStore();
    for (const m of marks)
      holder.apply({ op: "stroke", slide: "a/1", from: 0, end: true, ...m, points: [...m.points] });
    const seen: number[][] = [];
    feed.resync((op) => {
      holder.apply(op);
      seen.push(ids(holder));
    });
    expect(seen.length).toBeGreaterThan(3);
    for (const after of seen) expect(after).toEqual([1, 2, 3]);
  });

  test("a receiver that holds everything is not told anything changed, so it draws nothing again", () => {
    const { feed } = setup();
    const marks = [mark(1, 40), mark(2, 300)];
    feed.ingest({ kind: "marks", slide: "a/1", strokes: marks, reset: true });
    const holder = new MirrorStore();
    feed.resync((op) => holder.apply(op));
    const changed = vi.fn();
    holder.subscribe(changed);
    feed.resync((op) => holder.apply(op));
    expect(changed).not.toHaveBeenCalled();
    expect(ids(holder)).toEqual([1, 2]);
  });

  test("a stroke the presenter no longer has is removed from a receiver that missed its drop", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1), mark(2)], reset: true });
    const stale = new MirrorStore();
    for (const id of [1, 99, 2])
      stale.apply({
        op: "stroke",
        slide: "a/1",
        id,
        tool: "pen",
        color: "primary",
        from: 0,
        points: [1, 1, 2, 2],
        end: true,
      });
    feed.resync((op) => stale.apply(op));
    expect(ids(stale)).toEqual([1, 2]);
  });

  test("a receiver full of stale strokes still takes the presenter's, because the stale ones go first", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1), mark(2)], reset: true });
    const stale = new MirrorStore();
    for (let id = 100; id < 100 + MAX_SLIDE_STROKES; id++) {
      stale.apply({
        op: "stroke",
        slide: "a/1",
        id,
        tool: "pen",
        color: "primary",
        from: 0,
        points: [1, 1],
        end: true,
      });
    }
    feed.resync((op) => stale.apply(op));
    expect(ids(stale)).toEqual([1, 2]);
  });

  test("other slides on the receiver are left alone", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    const holder = new MirrorStore();
    holder.apply({
      op: "stroke",
      slide: "b/1",
      id: 7,
      tool: "pen",
      color: "primary",
      from: 0,
      points: [1, 1],
      end: true,
    });
    feed.resync((op) => holder.apply(op));
    expect(ids(holder, "b/1")).toEqual([7]);
  });

  test("keep never names more than 200 strokes, the stroke in progress included", () => {
    const { feed } = setup();
    const many = Array.from({ length: MAX_SLIDE_STROKES + 50 }, (_, i) => mark(i + 1, 4));
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
    feed.ingest({ kind: "stroke", slide: "a/1", end: false, ...mark(9000, 30) });
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    feed.ingest({ kind: "marks", slide: "a/1", strokes: many, reset: false });
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    const keep = late.find((o) => o.op === "keep");
    expect(keep?.op === "keep" && keep.ids.length).toBeLessThanOrEqual(MAX_SLIDE_STROKES);
    expect(keep?.op === "keep" && keep.ids).toContain(9000);
    const store = new MirrorStore();
    for (const op of late) store.apply(op);
    expect(ids(store)).toContain(9000);
    expect(store.strokes("a/1").length).toBeLessThanOrEqual(MAX_SLIDE_STROKES);
    for (const op of late) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });
});

describe("the diagram focus view", () => {
  test("open and close are sent at once; zoom and pan at most every 100 ms, the last one always", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "open", slide: "d/1", diagram: 1 });
    for (let i = 1; i <= 50; i++) {
      feed.focus({ kind: "view", scale: 1 + i / 50, x: i / 100, y: 0 });
      vi.advanceTimersByTime(4);
    }
    vi.advanceTimersByTime(200);
    const views = sent.filter((o) => o.op === "focus-view");
    expect(views.length).toBeLessThanOrEqual(4);
    expect(views.at(-1)).toEqual({ op: "focus-view", scale: 2, x: 0.5, y: 0 });
    // A view waiting for its turn is dropped by a close, so it cannot reopen the view's state after it.
    feed.focus({ kind: "view", scale: 3, x: 0, y: 0 });
    feed.focus({ kind: "view", scale: 4, x: 0, y: 0 });
    feed.focus({ kind: "close" });
    vi.advanceTimersByTime(200);
    expect(sent.at(-1)).toEqual({ op: "focus-close" });
    expect(sent.filter((o) => o.op === "focus-view").at(-1)).toEqual({
      op: "focus-view",
      scale: 3,
      x: 0,
      y: 0,
    });
  });
});

describe("sinks", () => {
  test("a removed sink hears nothing more, and a feed without sinks keeps its state for the next one", () => {
    const feed = new MirrorFeed();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    const heard: MirrorOp[] = [];
    const off = feed.addSink((op) => heard.push(op));
    feed.resync();
    expect(kinds(heard)).toEqual(["keep", "stroke", "focus-close"]);
    off();
    heard.length = 0;
    feed.ingest({ kind: "laser", x: 0.5, y: 0.5 });
    expect(heard).toEqual([]);
  });
});

describe("sender and receiver agree (a model check)", () => {
  // A small model of the layer (strokes, undo, redo, erase, clear, slide
  // changes) drives the feed; two receivers, one present from the start and
  // one that asks for a resync at a random moment, must end up showing what
  // the model shows on the current slide, whatever the order of operations.
  function run(seed: number) {
    let s = seed;
    const rand = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
    const feed = new MirrorFeed();
    const early = new MirrorStore();
    const late = new MirrorStore();
    feed.addSink((op) => early.apply(op));
    let lateJoined = false;
    const joinAt = rand(60);

    const slides = ["a/1", "b/1", "c/1"];
    const state = new Map<string, { visible: MarkStroke[]; undone: MarkStroke[][] }>();
    let slide = "a/1";
    let nextId = 1;
    const of = (key: string) => {
      let entry = state.get(key);
      if (!entry) {
        entry = { visible: [], undone: [] };
        state.set(key, entry);
      }
      return entry;
    };
    const report = (reset: boolean) =>
      feed.ingest({ kind: "marks", slide, strokes: [...of(slide).visible], reset });
    report(true);

    for (let step = 0; step < 120; step++) {
      if (!lateJoined && step >= joinAt) {
        lateJoined = true;
        feed.addSink((op) => late.apply(op));
        feed.resync((op) => late.apply(op));
      }
      const entry = of(slide);
      const roll = rand(10);
      if (roll < 4) {
        const stroke = mark(nextId++, 2 + rand(30), { tool: rand(5) === 0 ? "arrow" : "pen" });
        feed.ingest(committed(slide, stroke));
        entry.visible.push(stroke);
        entry.undone.length = 0;
        report(false);
      } else if (roll === 4 && entry.visible.length > 0) {
        entry.undone.push([entry.visible.pop()!]);
        report(false);
      } else if (roll === 5 && entry.undone.length > 0) {
        entry.visible.push(...entry.undone.pop()!);
        report(false);
      } else if (roll === 6 && entry.visible.length > 0) {
        const at = rand(entry.visible.length);
        entry.undone.push(entry.visible.splice(at, 1));
        report(false);
      } else if (roll === 7) {
        entry.visible = [];
        entry.undone = [];
        report(false);
      } else if (roll >= 8) {
        slide = slides[rand(slides.length)]!;
        report(true);
      }
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(500);
    if (!lateJoined) {
      feed.addSink((op) => late.apply(op));
      feed.resync((op) => late.apply(op));
    }
    const want = of(slide).visible.map((m) => [m.id, m.tool, m.points]);
    const got = (store: MirrorStore) => store.strokes(slide).map((m) => [m.id, m.tool, m.points]);
    return { want, early: got(early), late: got(late) };
  }

  test("after any run of operations both receivers show the model's marks", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { want, early, late } = run(seed);
      expect(early, `seed ${seed}, receiver present from the start`).toEqual(want);
      expect(late, `seed ${seed}, receiver that joined late`).toEqual(want);
    }
  });
});
