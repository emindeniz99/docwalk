import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MirrorFeed } from "./mirrorFeed";
import { MirrorMessageSchema } from "./mirrorSchema";
import { MirrorStore } from "./mirrorStore";
import {
  MAX_CHUNK_POINTS,
  MAX_MARKED_LINES,
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
const box = (id: number, tool: "rect" | "ellipse", over: Partial<MarkStroke> = {}): MarkStroke => ({
  id,
  tool,
  color: "ink",
  points: [400, 500, 3000, 2500],
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
    feed.focus({ kind: "open", slide: "a/1", block: "diagram", n: 2 });
    feed.focus({ kind: "view", scale: 2, x: 0.1, y: -0.1 });
    vi.advanceTimersByTime(500);
    sent.length = 0;
    others.length = 0;
    feed.resync((op) => late.push(op));
    expect(kinds(late)).toEqual([
      "board-close",
      "keep",
      "stroke",
      "stroke",
      "stroke",
      "focus-open",
      "focus-view",
    ]);
    expect(late[1]).toEqual({ op: "keep", slide: "a/1", ids: [1, 2, 3] });
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
    expect(late).toEqual([
      { op: "board-close" },
      { op: "keep", slide: "a/1", ids: [] },
      { op: "focus-close" },
    ]);
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

const ids = (store: MirrorStore, slide = "a/1") => store.strokes(slide).map((s) => s.id);

describe("a resync keeps what receivers hold (decision 103)", () => {
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
    const changed = vi.fn<() => void>();
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

/** A feed on an empty slide, a receiver present from the start, and one that has not joined yet. */
function twoFollowers() {
  const feed = new MirrorFeed();
  const early = new MirrorStore();
  const joined = new MirrorStore();
  feed.addSink((op) => early.apply(op));
  feed.ingest({ kind: "marks", slide: "a/1", strokes: [], reset: true });
  return { feed, early, joined };
}

describe("a resync while a pen stroke is being drawn (decision 103)", () => {
  const all = line(120, 5);
  const progress = (feed: MirrorFeed, n: number) =>
    feed.ingest({
      kind: "stroke",
      slide: "a/1",
      end: false,
      id: 9,
      tool: "pen",
      color: "primary",
      points: all.slice(0, 2 * n),
    });
  const finish = (feed: MirrorFeed) =>
    feed.ingest(committed("a/1", { id: 9, tool: "pen", color: "primary", points: all }));

  test("a follower that joins between two flushes does not cut the stroke on any follower", () => {
    const { feed, early, joined } = twoFollowers();
    progress(feed, 30);
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    // 30 more points are recorded; the next flush has not run.
    progress(feed, 60);
    feed.addSink((op) => joined.apply(op));
    feed.resync();
    progress(feed, 100);
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    finish(feed);
    expect(early.strokes("a/1").map((s) => s.points)).toEqual([all]);
    expect(joined.strokes("a/1").map((s) => s.points)).toEqual([all]);
  });

  test("a resync to one window alone does not cut the stroke on the others either", () => {
    const { feed, early } = twoFollowers();
    const window = new MirrorStore();
    progress(feed, 30);
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    progress(feed, 60);
    feed.resync((op) => window.apply(op));
    feed.addSink((op) => window.apply(op));
    progress(feed, 100);
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    finish(feed);
    expect(early.strokes("a/1").map((s) => s.points)).toEqual([all]);
    expect(window.strokes("a/1").map((s) => s.points)).toEqual([all]);
  });

  test("it sends what every receiver was sent and no more: the next flush sends the rest", () => {
    const { feed } = twoFollowers();
    progress(feed, 30);
    vi.advanceTimersByTime(STROKE_FLUSH_MS + 1);
    progress(feed, 60);
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    const live = strokeOps(late).filter((s) => s.id === 9);
    expect(live.flatMap((s) => s.points)).toEqual(all.slice(0, 60));
    expect(live.every((s) => !s.end)).toBe(true);
    expect(live[0]!.from).toBe(0);
  });

  test("a stroke abandoned after a resync that came before its first flush leaves no ghost", () => {
    const { feed, early, joined } = twoFollowers();
    progress(feed, 30);
    feed.addSink((op) => joined.apply(op));
    feed.resync();
    feed.ingest({ kind: "cancel", id: 9 });
    vi.advanceTimersByTime(500);
    expect(early.strokes("a/1")).toEqual([]);
    expect(joined.strokes("a/1")).toEqual([]);
  });

  test("a resync before the first flush sends nothing of the stroke, since no receiver has any of it", () => {
    const { feed } = twoFollowers();
    progress(feed, 30);
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(strokeOps(late)).toEqual([]);
    expect(late[1]).toEqual({ op: "keep", slide: "a/1", ids: [] });
  });
});

describe("the diagram focus view", () => {
  test("open and close are sent at once; zoom and pan at most every 100 ms, the last one always", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "open", slide: "d/1", block: "diagram", n: 1 });
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

describe("the code, table and image views (decision 106)", () => {
  test("open names the block by its kind and place on the slide, as the diagram's op does", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 2 });
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "table", n: 1 });
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "image", n: 3 });
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "diagram", n: 4 });
    expect(sent).toEqual([
      { op: "focus-open", slide: "c/1", code: 2 },
      { op: "focus-close" },
      { op: "focus-open", slide: "c/1", table: 1 },
      { op: "focus-close" },
      { op: "focus-open", slide: "c/1", image: 3 },
      { op: "focus-close" },
      { op: "focus-open", slide: "c/1", diagram: 4 },
    ]);
  });

  test("marked lines go out at once, ascending and once each, and an unchanged list is not sent again", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 1 });
    feed.focus({ kind: "lines", lines: [4, 1] });
    feed.focus({ kind: "lines", lines: [1, 4, 4] });
    feed.focus({ kind: "lines", lines: [1, 4, 6] });
    feed.focus({ kind: "lines", lines: [] });
    expect(sent.filter((o) => o.op === "focus-lines")).toEqual([
      { op: "focus-lines", lines: [1, 4] },
      { op: "focus-lines", lines: [1, 4, 6] },
      { op: "focus-lines", lines: [] },
    ]);
  });

  test("a presenter who marks more than 256 lines mirrors the first 256, and numbers out of range are left out", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 1 });
    const many = Array.from({ length: 400 }, (_, i) => 400 - i);
    feed.focus({ kind: "lines", lines: [0, -3, 1.5, 200_000, Number.NaN, ...many] });
    const [op] = sent.filter((o) => o.op === "focus-lines");
    expect(op).toEqual({
      op: "focus-lines",
      lines: Array.from({ length: MAX_MARKED_LINES }, (_, i) => i + 1),
    });
    expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });

  test("lines are sent only for an open code view: a table, an image or no view sends none", () => {
    const { feed, sent } = setup();
    feed.focus({ kind: "lines", lines: [1] });
    feed.focus({ kind: "open", slide: "c/1", block: "table", n: 1 });
    feed.focus({ kind: "lines", lines: [1] });
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "image", n: 1 });
    feed.focus({ kind: "lines", lines: [1] });
    expect(sent.filter((o) => o.op === "focus-lines")).toEqual([]);
  });

  test("a new view starts with no marks: the lines of the last one are not resent for it", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "c/1", strokes: [], reset: true });
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 1 });
    feed.focus({ kind: "lines", lines: [2, 3] });
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 2 });
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(late.filter((o) => o.op.startsWith("focus"))).toEqual([
      { op: "focus-open", slide: "c/1", code: 2 },
      { op: "focus-lines", lines: [] },
    ]);
  });

  test("a resync sends the open block, its zoom and scroll, and its marks, empty ones too", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "c/1", strokes: [mark(1)], reset: true });
    feed.focus({ kind: "open", slide: "c/1", block: "code", n: 2 });
    feed.focus({ kind: "view", scale: 1.25, x: 0, y: 0.75 });
    feed.focus({ kind: "lines", lines: [3, 5] });
    vi.advanceTimersByTime(500);
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(kinds(late)).toEqual([
      "board-close",
      "keep",
      "stroke",
      "focus-open",
      "focus-view",
      "focus-lines",
    ]);
    expect(late.slice(3)).toEqual([
      { op: "focus-open", slide: "c/1", code: 2 },
      { op: "focus-view", scale: 1.25, x: 0, y: 0.75 },
      { op: "focus-lines", lines: [3, 5] },
    ]);
    // Cleared marks go out as an empty list, so a follower that held them drops them.
    feed.focus({ kind: "lines", lines: [] });
    late.length = 0;
    feed.resync((op) => late.push(op));
    expect(late.at(-1)).toEqual({ op: "focus-lines", lines: [] });
    // A table or an image view has no marks to send.
    feed.focus({ kind: "close" });
    feed.focus({ kind: "open", slide: "c/1", block: "table", n: 1 });
    late.length = 0;
    feed.resync((op) => late.push(op));
    expect(late.filter((o) => o.op.startsWith("focus"))).toEqual([
      { op: "focus-open", slide: "c/1", table: 1 },
    ]);
  });

  test("a zoom or pan that is not a finite number is not sent and does not replace the last good one", () => {
    // A view measured on a stage with no size divides by zero; every receiver
    // would refuse that op, and each resync would repeat it.
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "c/1", strokes: [], reset: true });
    feed.focus({ kind: "open", slide: "c/1", block: "image", n: 1 });
    feed.focus({ kind: "view", scale: 2, x: 0.25, y: 0 });
    vi.advanceTimersByTime(200);
    feed.focus({ kind: "view", scale: 1, x: Number.NaN, y: Number.NaN });
    feed.focus({ kind: "view", scale: Number.POSITIVE_INFINITY, x: 0, y: 0 });
    vi.advanceTimersByTime(200);
    feed.resync();
    const views = sent.filter((o) => o.op === "focus-view");
    expect(views).toEqual([
      { op: "focus-view", scale: 2, x: 0.25, y: 0 },
      { op: "focus-view", scale: 2, x: 0.25, y: 0 },
    ]);
  });

  test("every focus op it makes passes the schema a receiver checks", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "c/1", strokes: [], reset: true });
    for (const block of ["diagram", "code", "table", "image"] as const) {
      feed.focus({ kind: "open", slide: "c/1", block, n: 1000 });
      feed.focus({ kind: "view", scale: 5.333_333, x: 1, y: 0.123_456 });
      feed.focus({ kind: "lines", lines: [100_000] });
      vi.advanceTimersByTime(200);
      feed.resync();
      feed.focus({ kind: "close" });
    }
    for (const op of ["focus-open", "focus-view", "focus-lines", "focus-close"]) {
      expect(kinds(sent)).toContain(op);
    }
    for (const op of sent) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });
});

describe("the whiteboard and the shapes (decision 110)", () => {
  test("a committed rectangle or ellipse goes out as one stroke op, from 0 and ending, four numbers", () => {
    const { feed, sent } = setup();
    feed.ingest(committed("a/1", box(1, "rect")));
    feed.ingest(committed("a/1", box(2, "ellipse")));
    vi.advanceTimersByTime(500);
    expect(strokeOps(sent)).toEqual([
      {
        op: "stroke",
        slide: "a/1",
        id: 1,
        tool: "rect",
        color: "ink",
        from: 0,
        points: [400, 500, 3000, 2500],
        end: true,
      },
      {
        op: "stroke",
        slide: "a/1",
        id: 2,
        tool: "ellipse",
        color: "ink",
        from: 0,
        points: [400, 500, 3000, 2500],
        end: true,
      },
    ]);
    for (const op of sent) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });

  test("opening the board sends board-open, then the board's marks as a clear and its strokes, in that order", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    sent.length = 0;
    feed.ingest({ kind: "board", slide: "a/1" });
    feed.ingest({
      kind: "marks",
      slide: "a/board",
      strokes: [box(7, "rect"), mark(8)],
      reset: true,
    });
    expect(kinds(sent)).toEqual(["board-open", "clear", "stroke", "stroke"]);
    expect(sent[0]).toEqual({ op: "board-open", slide: "a/1" });
    expect(sent[1]).toEqual({ op: "clear", slide: "a/board" });
    expect(strokeOps(sent).map((s) => [s.slide, s.id, s.tool])).toEqual([
      ["a/board", 7, "rect"],
      ["a/board", 8, "pen"],
    ]);
  });

  test("closing sends board-close, then the slide's marks again", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "board", slide: "a/1" });
    feed.ingest({ kind: "marks", slide: "a/board", strokes: [mark(7)], reset: true });
    sent.length = 0;
    feed.ingest({ kind: "board", slide: null });
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    expect(kinds(sent)).toEqual(["board-close", "clear", "stroke"]);
    expect(sent[0]).toEqual({ op: "board-close" });
  });

  test("a resync with the board open sends board-open first, then keep for the board's strokes", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    feed.ingest({ kind: "board", slide: "a/2" });
    feed.ingest({ kind: "marks", slide: "a/board", strokes: [box(7, "ellipse")], reset: true });
    vi.advanceTimersByTime(500);
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(kinds(late)).toEqual(["board-open", "keep", "stroke", "focus-close"]);
    expect(late[0]).toEqual({ op: "board-open", slide: "a/2" });
    expect(late[1]).toEqual({ op: "keep", slide: "a/board", ids: [7] });
  });

  test("a resync with the board closed sends board-close first, so a follower that missed the close drops the board", () => {
    const { feed } = setup();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    feed.ingest({ kind: "board", slide: "a/1" });
    feed.ingest({ kind: "board", slide: null });
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(late[0]).toEqual({ op: "board-close" });
    expect(late[1]?.op).toBe("keep");
  });

  test("a resync before any marks still says whether the board is open", () => {
    const { feed } = setup();
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(late).toEqual([{ op: "board-close" }, { op: "focus-close" }]);
    feed.ingest({ kind: "board", slide: "a/1" });
    late.length = 0;
    feed.resync((op) => late.push(op));
    expect(late[0]).toEqual({ op: "board-open", slide: "a/1" });
  });

  test("a resync to one sink leaves the others alone", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "board", slide: "a/1" });
    sent.length = 0;
    const late: MirrorOp[] = [];
    feed.resync((op) => late.push(op));
    expect(sent).toEqual([]);
    expect(late[0]).toEqual({ op: "board-open", slide: "a/1" });
  });

  test("a follower that applies the ops in order ends with the board the presenter has", () => {
    const { feed } = setup();
    const follower = new MirrorStore();
    feed.addSink((op) => follower.apply(op));
    feed.ingest({ kind: "board", slide: "a/1" });
    feed.ingest({ kind: "marks", slide: "a/board", strokes: [box(7, "rect")], reset: true });
    expect(follower.board).toBe("a/1");
    expect(follower.strokes("a/board").map((s) => s.tool)).toEqual(["rect"]);
    feed.ingest({ kind: "board", slide: null });
    expect(follower.board).toBeNull();
    // A follower that joined while the board was open, then missed the close.
    const late = new MirrorStore();
    late.apply({ op: "board-open", slide: "a/1" });
    feed.resync((op) => late.apply(op));
    expect(late.board).toBeNull();
  });

  test("every board op it makes passes the schema a receiver checks", () => {
    const { feed, sent } = setup();
    feed.ingest({ kind: "board", slide: "a".repeat(2048) });
    feed.ingest({ kind: "board", slide: null });
    feed.resync();
    expect(sent.some((o) => o.op === "board-open")).toBe(true);
    for (const op of sent) expect(v.is(MirrorMessageSchema, { type: "mirror", ...op })).toBe(true);
  });
});

describe("sinks", () => {
  test("a removed sink hears nothing more, and a feed without sinks keeps its state for the next one", () => {
    const feed = new MirrorFeed();
    feed.ingest({ kind: "marks", slide: "a/1", strokes: [mark(1)], reset: true });
    const heard: MirrorOp[] = [];
    const off = feed.addSink((op) => heard.push(op));
    feed.resync();
    expect(kinds(heard)).toEqual(["board-close", "keep", "stroke", "focus-close"]);
    off();
    heard.length = 0;
    feed.ingest({ kind: "laser", x: 0.5, y: 0.5 });
    expect(heard).toEqual([]);
  });
});

describe("sender and receiver agree (a model check)", () => {
  // A small model of the layer (strokes, undo, redo, erase, clear, slide
  // changes, a pen stroke that grows over several flushes and is then
  // committed or cancelled) drives the feed. Resyncs come at random moments:
  // to every receiver, as when a follower says hello, and to one alone. Two
  // receivers, one present from the start and one that joins at a random
  // moment, must show what the model shows on the current slide after every
  // step, whatever the order of operations; the stroke in progress is the
  // only one they may hold a part of. Checking only at the end missed a cut
  // stroke and a ghost, because a later resync repaired both. The presenter
  // has one pointer, so the layer changes no other mark while the pen is down.
  function run(seed: number) {
    let s = seed;
    // The high bits: an LCG's low bits repeat with a short period, and
    // `s % 16` walked the same 16 rolls, so some sequences never ran.
    const rand = (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.floor((s / 2 ** 32) * n);
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

    /** The pen stroke being drawn: all its points, and how many the layer has reported. */
    let drawing: { id: number; points: number[]; reported: number } | null = null;
    const grow = () => {
      if (!drawing) return;
      drawing.reported = Math.min(drawing.points.length / 2, drawing.reported + 1 + rand(40));
      feed.ingest({
        kind: "stroke",
        slide,
        end: false,
        id: drawing.id,
        tool: "pen",
        color: "primary",
        points: drawing.points.slice(0, 2 * drawing.reported),
      });
    };
    const abandon = () => {
      if (!drawing) return;
      feed.ingest({ kind: "cancel", id: drawing.id });
      drawing = null;
    };
    const commit = () => {
      if (!drawing) return;
      const stroke: MarkStroke = {
        id: drawing.id,
        tool: "pen",
        color: "primary",
        points: drawing.points.slice(0, 2 * Math.max(1, drawing.reported)),
      };
      drawing = null;
      feed.ingest(committed(slide, stroke));
      const entry = of(slide);
      entry.visible.push(stroke);
      entry.undone.length = 0;
      report(false);
    };

    const got = (store: MirrorStore) => store.strokes(slide).map((m) => [m.id, m.tool, m.points]);
    const wanted = () => of(slide).visible.map((m) => [m.id, m.tool, m.points]);
    /** What a receiver shows of the slide, less the stroke in progress. */
    const held = (store: MirrorStore) =>
      got(store).filter(([id]) => drawing === null || id !== drawing.id);
    const check = (when: string) => {
      const want = wanted();
      expect(held(early), `seed ${seed}, ${when}, receiver present from the start`).toEqual(want);
      // Before it joins the late receiver has been sent nothing.
      expect(held(late), `seed ${seed}, ${when}, receiver that joined late`).toEqual(
        lateJoined ? want : [],
      );
    };

    for (let step = 0; step < 160; step++) {
      if (!lateJoined && step >= joinAt) {
        lateJoined = true;
        feed.addSink((op) => late.apply(op));
        feed.resync((op) => late.apply(op));
      }
      const entry = of(slide);
      const roll = rand(16);
      if (roll < 7 && drawing) {
        // The pen is down: it keeps moving, and nothing else changes until it is lifted.
        grow();
      } else if (roll < 3) {
        const stroke = mark(nextId++, 2 + rand(30), { tool: rand(5) === 0 ? "arrow" : "pen" });
        feed.ingest(committed(slide, stroke));
        entry.visible.push(stroke);
        entry.undone.length = 0;
        report(false);
      } else if (roll === 3 && entry.visible.length > 0) {
        entry.undone.push([entry.visible.pop()!]);
        report(false);
      } else if (roll === 4 && entry.undone.length > 0) {
        entry.visible.push(...entry.undone.pop()!);
        report(false);
      } else if (roll === 5 && entry.visible.length > 0) {
        const at = rand(entry.visible.length);
        entry.undone.push(entry.visible.splice(at, 1));
        report(false);
      } else if (roll === 6) {
        entry.visible = [];
        entry.undone = [];
        report(false);
      } else if (roll === 7 || roll === 8) {
        // The layer abandons a stroke in progress when the slide changes.
        abandon();
        slide = slides[rand(slides.length)]!;
        report(true);
      } else if (roll === 9 && !drawing) {
        drawing = { id: nextId++, points: line(40 + rand(300), nextId), reported: 0 };
        grow();
      } else if (roll === 10 || roll === 11) {
        grow();
      } else if (roll === 12) {
        if (rand(2) === 0) commit();
        else abandon();
      } else if (roll === 13) {
        // A follower says hello: everyone is sent the resync.
        feed.resync();
      } else if (roll === 14 && lateJoined) {
        // The presenter window asks alone.
        feed.resync((op) => late.apply(op));
      }
      // A moving pen reports every few milliseconds, several times per 80 ms flush.
      vi.advanceTimersByTime(drawing ? 4 + rand(40) : 10 + rand(110));
      check(`step ${step}`);
    }
    if (rand(2) === 0) commit();
    else abandon();
    vi.advanceTimersByTime(500);
    if (!lateJoined) {
      lateJoined = true;
      feed.addSink((op) => late.apply(op));
      feed.resync((op) => late.apply(op));
    }
    return { want: wanted(), early: got(early), late: got(late) };
  }

  test("after every step of any run both receivers show the model's marks", () => {
    for (let seed = 1; seed <= 200; seed++) {
      // run() also compares after every step.
      const { want, early, late } = run(seed);
      expect(early, `seed ${seed} at the end, receiver present from the start`).toEqual(want);
      expect(late, `seed ${seed} at the end, receiver that joined late`).toEqual(want);
    }
  });
});
