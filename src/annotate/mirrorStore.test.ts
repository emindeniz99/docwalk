import { describe, expect, test, vi } from "vitest";
import { MirrorStore } from "./mirrorStore";
import {
  MAX_MARK_SLIDES,
  MAX_SLIDE_POINTS,
  MAX_SLIDE_STROKES,
  MAX_STROKE_POINTS,
  type MirrorOp,
} from "./mirrorTypes";

/**
 * The receiver's side of the mirror (decision 88). Followers and the
 * presenter window feed it every op that arrives validated; it must stay
 * small and well-formed whatever a signed sender, a repeating relay or a
 * reconnect throws at it.
 */

type StrokeOp = Extract<MirrorOp, { op: "stroke" }>;
const stroke = (over: Partial<StrokeOp> = {}): StrokeOp => ({
  op: "stroke",
  slide: "a/1",
  id: 1,
  tool: "pen",
  color: "primary",
  from: 0,
  points: [10, 10, 20, 20],
  end: false,
  ...over,
});
const ids = (store: MirrorStore, slide = "a/1") => store.strokes(slide).map((s) => s.id);

describe("strokes", () => {
  test("chunks of one stroke join in order, so a live stroke grows on the follower", () => {
    const store = new MirrorStore();
    store.apply(stroke());
    store.apply(stroke({ from: 4, points: [30, 30], end: false }));
    store.apply(stroke({ from: 6, points: [40, 40], end: true }));
    expect(store.strokes("a/1")).toEqual([
      { id: 1, tool: "pen", color: "primary", points: [10, 10, 20, 20, 30, 30, 40, 40] },
    ]);
  });

  test("a chunk that does not continue the stroke is ignored, so a missed chunk cannot corrupt it", () => {
    const store = new MirrorStore();
    store.apply(stroke());
    store.apply(stroke({ from: 8, points: [50, 50] }));
    store.apply(stroke({ id: 2, from: 2, points: [1, 1] }));
    expect(store.strokes("a/1")[0]!.points).toEqual([10, 10, 20, 20]);
    expect(ids(store)).toEqual([1]);
  });

  test("a chunk that changes the tool or colour of a stroke is ignored", () => {
    const store = new MirrorStore();
    store.apply(stroke());
    store.apply(stroke({ from: 4, points: [30, 30], tool: "arrow" }));
    store.apply(stroke({ from: 4, points: [30, 30], color: "ink" }));
    expect(store.strokes("a/1")[0]!.points).toEqual([10, 10, 20, 20]);
  });

  test("a stroke sent again from 0 replaces itself and keeps its place: a resync changes nothing", () => {
    const store = new MirrorStore();
    store.apply(stroke({ id: 1 }));
    store.apply(stroke({ id: 2 }));
    store.apply(stroke({ id: 1, points: [5, 5, 6, 6], end: true }));
    expect(ids(store)).toEqual([1, 2]);
    expect(store.strokes("a/1")[0]!.points).toEqual([5, 5, 6, 6]);
  });

  test("drop removes the named strokes and clear removes the slide's, whichever slide is on screen", () => {
    const store = new MirrorStore();
    for (const id of [1, 2, 3]) store.apply(stroke({ id }));
    store.apply(stroke({ slide: "b/1", id: 9 }));
    store.apply({ op: "drop", slide: "a/1", ids: [2, 77] });
    expect(ids(store)).toEqual([1, 3]);
    store.apply({ op: "clear", slide: "a/1" });
    expect(ids(store)).toEqual([]);
    expect(ids(store, "b/1")).toEqual([9]);
  });

  test("marks belong to their address: another slide's strokes are not in this one's list", () => {
    const store = new MirrorStore();
    store.apply(stroke({ slide: "a/1" }));
    expect(store.strokes("a/2")).toEqual([]);
    expect(store.strokes("never/1")).toEqual([]);
  });
});

describe("a resync that keeps what the receiver holds (decision 103)", () => {
  test("keep removes the slide's strokes it does not name and leaves the rest of the slide and other slides alone", () => {
    const store = new MirrorStore();
    for (const id of [1, 2, 3]) store.apply(stroke({ id }));
    store.apply(stroke({ slide: "b/1", id: 9 }));
    store.apply({ op: "keep", slide: "a/1", ids: [3, 1, 77] });
    expect(ids(store)).toEqual([1, 3]);
    expect(ids(store, "b/1")).toEqual([9]);
  });

  test("keep with no ids empties the slide, so it no longer counts against the 16 slides", () => {
    const store = new MirrorStore();
    store.apply(stroke({ slide: "a/1" }));
    store.apply(stroke({ slide: "b/1" }));
    store.apply({ op: "keep", slide: "a/1", ids: [] });
    expect(ids(store)).toEqual([]);
    expect(store.slideCount).toBe(1);
  });

  test("keep for a slide the receiver holds nothing of changes nothing and makes no room for itself", () => {
    // A keep must not create a slide entry: 16 of them would push out the real ones.
    const store = new MirrorStore();
    for (let n = 0; n < MAX_MARK_SLIDES; n++) store.apply(stroke({ slide: `s${n}/1` }));
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    store.apply({ op: "keep", slide: "never/1", ids: [1] });
    expect(store.slideCount).toBe(MAX_MARK_SLIDES);
    expect(ids(store, "s0/1")).toEqual([1]);
    expect(heard).not.toHaveBeenCalled();
  });

  test("a keep that names every stroke and a stroke sent again unchanged tell nobody, so nothing redraws", () => {
    const store = new MirrorStore();
    const long = Array.from({ length: 600 }, (_, i) => i % 4096);
    store.apply(stroke({ id: 1, points: long.slice(0, 256) }));
    store.apply(stroke({ id: 1, from: 256, points: long.slice(256, 512) }));
    store.apply(stroke({ id: 1, from: 512, points: long.slice(512), end: true }));
    store.apply(stroke({ id: 2 }));
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    // The resync of a stroke that took three chunks: each matches what is held.
    store.apply({ op: "keep", slide: "a/1", ids: [1, 2] });
    store.apply(stroke({ id: 1, points: long.slice(0, 256) }));
    store.apply(stroke({ id: 1, from: 256, points: long.slice(256, 512) }));
    store.apply(stroke({ id: 1, from: 512, points: long.slice(512), end: true }));
    store.apply(stroke({ id: 2 }));
    expect(heard).not.toHaveBeenCalled();
    expect(store.strokes("a/1")[0]!.points).toEqual(long);
  });

  test("a stroke from 0 that differs from the held one still replaces it, even at the same length", () => {
    const store = new MirrorStore();
    store.apply(stroke({ id: 1, points: [10, 10, 20, 20] }));
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    store.apply(stroke({ id: 1, points: [30, 30, 40, 40] }));
    expect(store.strokes("a/1")[0]!.points).toEqual([30, 30, 40, 40]);
    expect(heard).toHaveBeenCalledOnce();
  });

  test("a stroke sent again unchanged still counts as touched, so a resynced slide is not the next forgotten", () => {
    const store = new MirrorStore();
    for (let n = 0; n < MAX_MARK_SLIDES; n++) store.apply(stroke({ slide: `s${n}/1` }));
    store.apply(stroke({ slide: "s0/1" }));
    store.apply(stroke({ slide: "new/1" }));
    expect(ids(store, "s0/1")).toEqual([1]);
    expect(ids(store, "s1/1")).toEqual([]);
  });
});

describe("limits (a signed sender is still bounded)", () => {
  test("a stroke stops growing at the point limit", () => {
    const store = new MirrorStore();
    const chunk = Array.from({ length: 256 }, () => 1);
    let from = 0;
    while (from < 2 * MAX_STROKE_POINTS + 512) {
      const room = 2 * MAX_STROKE_POINTS - from + 256;
      store.apply(stroke({ from, points: chunk.slice(0, Math.min(256, room)) }));
      from += 256;
    }
    expect(store.strokes("a/1")[0]!.points.length).toBeLessThanOrEqual(2 * MAX_STROKE_POINTS);
  });

  test("a slide keeps at most 200 strokes: the next new one is ignored, a known one still updates", () => {
    const store = new MirrorStore();
    for (let id = 0; id < MAX_SLIDE_STROKES + 10; id++) store.apply(stroke({ id }));
    expect(store.strokes("a/1")).toHaveLength(MAX_SLIDE_STROKES);
    store.apply(stroke({ id: 0, points: [7, 7], end: true }));
    expect(store.strokes("a/1")[0]!.points).toEqual([7, 7]);
  });

  test("a slide keeps at most 30,000 points, so a few long strokes cannot fill memory", () => {
    const store = new MirrorStore();
    const long = Array.from({ length: 256 }, () => 3);
    for (let id = 0; id < 60; id++) {
      for (let from = 0; from < 2 * MAX_STROKE_POINTS; from += 256) {
        const room = 2 * MAX_STROKE_POINTS - from;
        store.apply(stroke({ id, from, points: long.slice(0, Math.min(256, room)) }));
      }
    }
    const total = store.strokes("a/1").reduce((sum, s) => sum + s.points.length / 2, 0);
    expect(total).toBeLessThanOrEqual(MAX_SLIDE_POINTS);
  });

  test("only the 16 most recently touched slides are remembered", () => {
    const store = new MirrorStore();
    for (let n = 0; n < MAX_MARK_SLIDES + 5; n++) store.apply(stroke({ slide: `s${n}/1` }));
    expect(store.strokes("s0/1")).toEqual([]);
    expect(store.strokes(`s${MAX_MARK_SLIDES + 4}/1`)).toHaveLength(1);
    expect(store.slideCount).toBe(MAX_MARK_SLIDES);
  });
});

describe("laser and focus", () => {
  test("the laser is a point until laser-off", () => {
    const store = new MirrorStore();
    store.apply({ op: "laser", x: 0.25, y: 0.5 });
    expect(store.laser).toEqual({ x: 0.25, y: 0.5 });
    store.apply({ op: "laser-off" });
    expect(store.laser).toBeNull();
  });

  test("the focus view opens, follows zoom and pan, and closes; a view with nothing open is dropped", () => {
    const store = new MirrorStore();
    store.apply({ op: "focus-view", scale: 2, x: 0, y: 0 });
    expect(store.focus).toBeNull();
    store.apply({ op: "focus-open", slide: "d/1", diagram: 2 });
    expect(store.focus).toEqual({ slide: "d/1", block: "diagram", n: 2, view: null, lines: [] });
    store.apply({ op: "focus-view", scale: 2.5, x: -0.25, y: 0.1 });
    expect(store.focus?.view).toEqual({ scale: 2.5, x: -0.25, y: 0.1 });
    store.apply({ op: "focus-open", slide: "d/1", diagram: 2 });
    expect(store.focus?.view).toEqual({ scale: 2.5, x: -0.25, y: 0.1 });
    store.apply({ op: "focus-open", slide: "d/1", diagram: 3 });
    expect(store.focus).toEqual({ slide: "d/1", block: "diagram", n: 3, view: null, lines: [] });
    store.apply({ op: "focus-close" });
    expect(store.focus).toBeNull();
  });
});

describe("the code, table and image views (decision 106)", () => {
  test("a block is held by its kind and place, and a new block starts with no view and no marks", () => {
    const store = new MirrorStore();
    store.apply({ op: "focus-open", slide: "c/1", code: 2 });
    expect(store.focus).toEqual({ slide: "c/1", block: "code", n: 2, view: null, lines: [] });
    store.apply({ op: "focus-view", scale: 1.5, x: 0, y: 0.5 });
    store.apply({ op: "focus-lines", lines: [1, 3] });
    // The same block again (a resync) keeps what the view holds.
    store.apply({ op: "focus-open", slide: "c/1", code: 2 });
    expect(store.focus).toEqual({
      slide: "c/1",
      block: "code",
      n: 2,
      view: { scale: 1.5, x: 0, y: 0.5 },
      lines: [1, 3],
    });
    // Another kind at the same place is another block.
    store.apply({ op: "focus-open", slide: "c/1", table: 2 });
    expect(store.focus).toEqual({ slide: "c/1", block: "table", n: 2, view: null, lines: [] });
    store.apply({ op: "focus-open", slide: "c/1", image: 1 });
    expect(store.focus).toEqual({ slide: "c/1", block: "image", n: 1, view: null, lines: [] });
    store.apply({ op: "focus-open", slide: "c/1", diagram: 1 });
    expect(store.focus).toEqual({ slide: "c/1", block: "diagram", n: 1, view: null, lines: [] });
  });

  test("marked lines are taken only while a code view is open, and each list replaces the last", () => {
    const store = new MirrorStore();
    store.apply({ op: "focus-lines", lines: [1] });
    expect(store.focus).toBeNull();
    store.apply({ op: "focus-open", slide: "c/1", table: 1 });
    store.apply({ op: "focus-lines", lines: [1] });
    expect(store.focus?.lines).toEqual([]);
    store.apply({ op: "focus-open", slide: "c/1", code: 1 });
    store.apply({ op: "focus-lines", lines: [2, 5, 9] });
    expect(store.focus?.lines).toEqual([2, 5, 9]);
    store.apply({ op: "focus-lines", lines: [5] });
    expect(store.focus?.lines).toEqual([5]);
    store.apply({ op: "focus-lines", lines: [] });
    expect(store.focus?.lines).toEqual([]);
    store.apply({ op: "focus-close" });
    store.apply({ op: "focus-lines", lines: [1] });
    expect(store.focus).toBeNull();
  });

  test("the store keeps its own copy of the lines, so the sender's array cannot change it later", () => {
    const store = new MirrorStore();
    store.apply({ op: "focus-open", slide: "c/1", code: 1 });
    const lines = [1, 2];
    store.apply({ op: "focus-lines", lines });
    lines.push(3);
    expect(store.focus?.lines).toEqual([1, 2]);
  });

  test("a resync that repeats the open view, its zoom and its marks tells no listener, so nothing redraws", () => {
    const store = new MirrorStore();
    store.apply({ op: "focus-open", slide: "c/1", code: 1 });
    store.apply({ op: "focus-view", scale: 2, x: 0.5, y: 0.25 });
    store.apply({ op: "focus-lines", lines: [4, 7] });
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    store.apply({ op: "focus-open", slide: "c/1", code: 1 });
    store.apply({ op: "focus-view", scale: 2, x: 0.5, y: 0.25 });
    store.apply({ op: "focus-lines", lines: [4, 7] });
    expect(heard).not.toHaveBeenCalled();
    store.apply({ op: "focus-lines", lines: [4] });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("the whiteboard (decision 110)", () => {
  test("board-open holds the page the board covers, board-close clears it, and a store starts with none", () => {
    const store = new MirrorStore();
    expect(store.board).toBeNull();
    store.apply({ op: "board-open", slide: "a/2" });
    expect(store.board).toBe("a/2");
    store.apply({ op: "board-close" });
    expect(store.board).toBeNull();
  });

  test("a board opened over another page replaces the first one, and the first's marks stay", () => {
    const store = new MirrorStore();
    store.apply(stroke({ slide: "a/board", end: true }));
    store.apply({ op: "board-open", slide: "a/1" });
    store.apply({ op: "board-open", slide: "a/2" });
    expect(store.board).toBe("a/2");
    expect(ids(store, "a/board")).toEqual([1]);
  });

  test("a repeated open, and a close with no board open, tell nobody: a resync redraws nothing", () => {
    const store = new MirrorStore();
    const heard = vi.fn<() => void>();
    store.subscribe(heard);
    store.apply({ op: "board-close" });
    expect(heard).not.toHaveBeenCalled();
    store.apply({ op: "board-open", slide: "a/1" });
    expect(heard).toHaveBeenCalledTimes(1);
    store.apply({ op: "board-open", slide: "a/1" });
    expect(heard).toHaveBeenCalledTimes(1);
    store.apply({ op: "board-open", slide: "a/2" });
    expect(heard).toHaveBeenCalledTimes(2);
    store.apply({ op: "board-close" });
    store.apply({ op: "board-close" });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  test("the board's marks are held under its own address, beside the page's, and closing keeps them", () => {
    const store = new MirrorStore();
    store.apply(stroke({ slide: "a/1", id: 1 }));
    store.apply({ op: "board-open", slide: "a/1" });
    store.apply(stroke({ slide: "a/board", id: 2, end: true }));
    store.apply({ op: "board-close" });
    expect(ids(store, "a/1")).toEqual([1]);
    expect(ids(store, "a/board")).toEqual([2]);
  });

  test("a rectangle and an ellipse are held like an arrow, whole", () => {
    const store = new MirrorStore();
    store.apply(stroke({ id: 1, tool: "rect", points: [10, 20, 300, 400], end: true }));
    store.apply(stroke({ id: 2, tool: "ellipse", points: [30, 40, 500, 600], end: true }));
    expect(store.strokes("a/1").map((s) => [s.tool, s.points])).toEqual([
      ["rect", [10, 20, 300, 400]],
      ["ellipse", [30, 40, 500, 600]],
    ]);
  });
});

describe("change notices", () => {
  test("listeners hear every change once and nothing for an op that changed nothing", () => {
    const store = new MirrorStore();
    const heard = vi.fn<() => void>();
    const off = store.subscribe(heard);
    store.apply(stroke());
    expect(heard).toHaveBeenCalledTimes(1);
    store.apply(stroke({ from: 9, points: [1, 1] }));
    store.apply({ op: "drop", slide: "a/1", ids: [404] });
    store.apply({ op: "laser-off" });
    store.apply({ op: "focus-close" });
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    store.apply({ op: "laser", x: 0, y: 0 });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
