import {
  MAX_MARK_SLIDES,
  MAX_SLIDE_POINTS,
  MAX_SLIDE_STROKES,
  MAX_STROKE_POINTS,
  focusPlaceOf,
  type FocusPlace,
  type MarkColor,
  type MarkTool,
  type MirrorOp,
} from "./mirrorTypes";

/**
 * What a receiver has been told (decision 88): the presenter's laser, the
 * marks of the slides it has heard about, the whiteboard (decision 110) and
 * the focus view. Followers and
 * the presenter window apply every validated op here and draw from it
 * (mirrorView.ts). The ops passed schema checks already; this file adds the
 * limits that keep a signed but hostile or buggy sender from growing it
 * without bound, and it ignores an op that does not fit what it holds
 * (a chunk that does not continue its stroke, a view with no focus open,
 * marked lines with no code view open).
 * A resync repeats what a receiver may hold already (decision 103); an op
 * that changes nothing tells no listener, so nothing redraws.
 * No DOM types: the Node-run unit tests import it.
 */

export interface StoredStroke {
  id: number;
  tool: MarkTool;
  color: MarkColor;
  /** Flat grid points (x0, y0, x1, y1, ...). */
  points: number[];
}

/** The open focus view: which block, its zoom and position, and for code its marked lines (decision 106). */
export interface FocusMirror extends FocusPlace {
  view: { scale: number; x: number; y: number } | null;
  /** Marked lines, from 1, ascending; always empty for a diagram, table or image. */
  lines: readonly number[];
}

const MAX_STROKE_NUMBERS = 2 * MAX_STROKE_POINTS;
const MAX_SLIDE_NUMBERS = 2 * MAX_SLIDE_POINTS;

const startsWith = (held: readonly number[], start: readonly number[]) =>
  start.length <= held.length && start.every((n, i) => held[i] === n);
const sameList = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && startsWith(a, b);

export class MirrorStore {
  laser: { x: number; y: number } | null = null;
  /** The page the open whiteboard covers (decision 110); its marks are the strokes of the board address. */
  board: string | null = null;
  focus: FocusMirror | null = null;
  /** Least recently touched first, so the first key is the one to forget. */
  private readonly slides = new Map<string, Map<number, StoredStroke>>();
  private readonly listeners = new Set<() => void>();

  get slideCount(): number {
    return this.slides.size;
  }

  /** The strokes of `slide` in drawing order; empty for a slide never heard of. */
  strokes(slide: string): readonly StoredStroke[] {
    const strokes = this.slides.get(slide);
    return strokes ? [...strokes.values()] : [];
  }

  /** Calls `listener` after every op that changed something. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(op: MirrorOp): void {
    let changed = false;
    switch (op.op) {
      case "laser":
        changed = this.laser?.x !== op.x || this.laser?.y !== op.y;
        this.laser = { x: op.x, y: op.y };
        break;
      case "laser-off":
        changed = this.laser !== null;
        this.laser = null;
        break;
      case "stroke":
        changed = this.applyStroke(op);
        break;
      case "drop": {
        const strokes = this.slides.get(op.slide);
        if (!strokes) break;
        for (const id of op.ids) changed = strokes.delete(id) || changed;
        if (strokes.size === 0) this.slides.delete(op.slide);
        break;
      }
      case "clear":
        changed = this.slides.delete(op.slide);
        break;
      case "keep": {
        // Never creates a slide: a keep for one the receiver holds nothing of
        // must not push out a slide that has marks.
        const strokes = this.slides.get(op.slide);
        if (!strokes) break;
        const named = new Set(op.ids);
        for (const id of strokes.keys()) {
          if (!named.has(id)) changed = strokes.delete(id) || changed;
        }
        if (strokes.size === 0) this.slides.delete(op.slide);
        break;
      }
      case "board-open":
        changed = this.board !== op.slide;
        this.board = op.slide;
        break;
      case "board-close":
        changed = this.board !== null;
        this.board = null;
        break;
      case "focus-open": {
        const open = this.focus;
        const place = focusPlaceOf(op);
        if (open?.slide === place.slide && open.block === place.block && open.n === place.n) break;
        this.focus = { ...place, view: null, lines: [] };
        changed = true;
        break;
      }
      case "focus-view": {
        const open = this.focus;
        if (!open) break;
        const { view } = open;
        if (view?.scale === op.scale && view.x === op.x && view.y === op.y) break;
        this.focus = { ...open, view: { scale: op.scale, x: op.x, y: op.y } };
        changed = true;
        break;
      }
      case "focus-lines": {
        const open = this.focus;
        if (open?.block !== "code" || sameList(open.lines, op.lines)) break;
        this.focus = { ...open, lines: [...op.lines] };
        changed = true;
        break;
      }
      case "focus-close":
        changed = this.focus !== null;
        this.focus = null;
        break;
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  private applyStroke(op: Extract<MirrorOp, { op: "stroke" }>): boolean {
    let strokes = this.slides.get(op.slide);
    const known = strokes?.get(op.id);
    const others = strokes
      ? [...strokes.values()].reduce((n, s) => n + (s === known ? 0 : s.points.length), 0)
      : 0;

    let points: number[];
    if (op.from === 0) {
      // A resync sends a stroke again from 0, a chunk at a time (decision 103).
      // A chunk that matches the start of the stroke held changes nothing, so
      // a receiver that has the stroke keeps it whole and redraws nothing.
      const same = known?.tool === op.tool && known.color === op.color;
      if (strokes && known && same && startsWith(known.points, op.points)) {
        // Still touched: a resynced slide is not the next to be forgotten.
        this.slides.delete(op.slide);
        this.slides.set(op.slide, strokes);
        return false;
      }
      points = op.points;
      if (!known && strokes && strokes.size >= MAX_SLIDE_STROKES) return false;
    } else {
      // A chunk goes on from exactly where the stroke stands, and cannot change it.
      if (!known || known.tool !== op.tool || known.color !== op.color) return false;
      if (known.points.length !== op.from) return false;
      points = [...known.points, ...op.points];
    }
    if (points.length > MAX_STROKE_NUMBERS || others + points.length > MAX_SLIDE_NUMBERS) {
      return false;
    }

    if (strokes) {
      // Touched: it is now the last to be forgotten.
      this.slides.delete(op.slide);
    } else {
      strokes = new Map();
      if (this.slides.size >= MAX_MARK_SLIDES) {
        const oldest = this.slides.keys().next().value;
        if (oldest !== undefined) this.slides.delete(oldest);
      }
    }
    this.slides.set(op.slide, strokes);
    // Set on an existing id keeps its place in the drawing order.
    strokes.set(op.id, { id: op.id, tool: op.tool, color: op.color, points });
    return true;
  }
}
