import {
  MAX_CHUNK_POINTS,
  MAX_DROP_IDS,
  MAX_MARK_SLIDES,
  MAX_SLIDE_POINTS,
  MAX_SLIDE_STROKES,
  MAX_STROKE_POINTS,
  MIRROR_FOCUS_VIEW_MS,
  MIRROR_LASER_MS,
  STROKE_FLUSH_MS,
  focusOpenOp,
  markedLines,
  type FocusEvent,
  type FocusPlace,
  type MarkColor,
  type MarkEvent,
  type MarkStroke,
  type MarkTool,
  type MirrorOp,
} from "./mirrorTypes";

/**
 * The presenter's side of the mirror (decision 88). The annotation layer and
 * the focus view tell it what happens; it turns that into the ops of
 * `mirrorTypes.ts` and hands them to its sinks (the room, the presenter
 * window). It keeps the pace down (laser 33 ms, a live stroke 80 ms, the
 * focus view's zoom and scroll 100 ms), sends a code view's marked lines
 * when they change (decision 106), cuts a stroke into chunks a relay frame holds, and
 * remembers what receivers were told, so an undo is one `drop` and a redo
 * sends the stroke again. A receiver that joins late asks for `resync`.
 *
 * Limits mirror the receiver's (mirrorStore.ts): a slide is mirrored with at
 * most 200 strokes and 30,000 points, and a stroke with 1500. Past that the
 * presenter still draws, and receivers show what fits. No DOM types, so the
 * Node-run unit tests import it.
 */

export type MirrorSink = (op: MirrorOp) => void;

interface Live {
  slide: string;
  tool: MarkTool;
  color: MarkColor;
  /** The stroke's points so far; the layer replaces it as the stroke grows. */
  points: readonly number[];
  /** How many numbers receivers have been sent. */
  sent: number;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
/** Whole points only, and no more than a stroke may hold. */
const usable = (points: readonly number[]) =>
  Math.min(points.length - (points.length % 2), 2 * MAX_STROKE_POINTS);

export class MirrorFeed {
  private readonly sinks = new Set<MirrorSink>();

  private lastLaserAt = Number.NEGATIVE_INFINITY;
  private laserTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingLaser: { x: number; y: number } | null = null;
  private laserShown = false;

  private readonly live = new Map<number, Live>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Per slide, the strokes receivers hold; least recently used slide first. */
  private readonly known = new Map<string, Set<number>>();
  private current: { slide: string; strokes: readonly MarkStroke[] } | null = null;

  private focusOpen: FocusPlace | null = null;
  private focusView: { scale: number; x: number; y: number } | null = null;
  /** The marked lines of an open code view, as last sent. */
  private focusLines: number[] = [];
  private lastViewAt = Number.NEGATIVE_INFINITY;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private viewPending = false;

  /** Adds a receiver of every op from now on. Returns the function that removes it. */
  addSink(sink: MirrorSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** The presenter's laser, from the layer or from a phone remote, in slide units (0..1). */
  laser(x: number, y: number): void {
    const point = { x: round(x, 4), y: round(y, 4) };
    const wait = this.lastLaserAt + MIRROR_LASER_MS - Date.now();
    if (wait > 0) {
      this.pendingLaser = point;
      this.laserTimer ??= setTimeout(() => this.flushLaser(), wait);
      return;
    }
    this.sendLaser(point);
  }

  laserOff(): void {
    // A point still waiting would bring the laser back after it was hidden.
    clearTimeout(this.laserTimer);
    this.laserTimer = undefined;
    this.pendingLaser = null;
    if (!this.laserShown) return;
    this.laserShown = false;
    this.emit({ op: "laser-off" });
  }

  ingest(event: MarkEvent): void {
    switch (event.kind) {
      case "laser":
        this.laser(event.x, event.y);
        break;
      case "laser-off":
        this.laserOff();
        break;
      case "stroke":
        if (event.end) this.commit(event);
        else if (event.tool === "pen") this.progress(event);
        break;
      case "cancel":
        this.cancel(event.id);
        break;
      case "marks":
        this.marks(event);
        break;
    }
  }

  focus(event: FocusEvent): void {
    switch (event.kind) {
      case "open":
        this.focusOpen = { slide: event.slide, block: event.block, n: event.n };
        this.focusView = null;
        this.focusLines = [];
        this.cancelView();
        this.emit(focusOpenOp(this.focusOpen));
        break;
      case "view": {
        // A view measured on a stage with no size is NaN; no receiver would take it.
        if (!this.focusOpen || ![event.scale, event.x, event.y].every(Number.isFinite)) break;
        this.focusView = {
          scale: round(event.scale, 3),
          x: round(event.x, 3),
          y: round(event.y, 3),
        };
        const wait = this.lastViewAt + MIRROR_FOCUS_VIEW_MS - Date.now();
        if (wait > 0) {
          this.viewPending = true;
          this.viewTimer ??= setTimeout(() => this.flushView(), wait);
        } else {
          this.sendView();
        }
        break;
      }
      case "lines": {
        if (this.focusOpen?.block !== "code") break;
        const lines = markedLines(event.lines);
        const same =
          lines.length === this.focusLines.length &&
          lines.every((n, i) => n === this.focusLines[i]);
        if (same) break;
        this.focusLines = lines;
        this.emit({ op: "focus-lines", lines });
        break;
      }
      case "close":
        this.focusOpen = null;
        this.focusView = null;
        this.focusLines = [];
        this.cancelView();
        this.emit({ op: "focus-close" });
        break;
    }
  }

  /**
   * Sends the current slide's marks, the stroke in progress and the focus
   * state (the open block, its zoom and scroll, and for code its marked
   * lines, even none) to `sink` alone, or to every sink without one. Every op is
   * idempotent for a receiver that has them already: it opens with `keep`
   * (decision 103), which removes only what the presenter no longer has,
   * and the strokes that follow replace by id, so no receiver shows the
   * slide empty in between.
   */
  resync(sink?: MirrorSink): void {
    const emit = (op: MirrorOp) => this.emit(op, sink);
    if (this.current) {
      const { slide, strokes } = this.current;
      // Only what every sink has been sent; the next flush sends the rest
      // from `sent`, which a receiver holding more would refuse.
      const live = [...this.live]
        .filter(([, stroke]) => stroke.slide === slide && stroke.sent > 0)
        .map(([id, stroke]) => ({ id, ...stroke, points: stroke.points.slice(0, stroke.sent) }));
      const livePoints = live.reduce((n, stroke) => n + stroke.points.length / 2, 0);
      const done = this.fit(
        strokes,
        MAX_SLIDE_STROKES - live.length,
        MAX_SLIDE_POINTS - livePoints,
      );
      // First: a receiver at its stroke limit then has room for these, and a
      // resync cut off part way leaves no stale mark behind.
      emit({ op: "keep", slide, ids: [...done, ...live].map((stroke) => stroke.id) });
      for (const stroke of done) this.sendChunks(emit, slide, stroke, 0, true);
      for (const stroke of live) this.sendChunks(emit, slide, stroke, 0, false);
    }
    if (this.focusOpen) {
      emit(focusOpenOp(this.focusOpen));
      if (this.focusView) emit({ op: "focus-view", ...this.focusView });
      // Even an empty list: a receiver that missed a Clear holds marks the presenter dropped.
      if (this.focusOpen.block === "code") emit({ op: "focus-lines", lines: [...this.focusLines] });
    } else {
      emit({ op: "focus-close" });
    }
  }

  // ---- laser ---------------------------------------------------------------

  private flushLaser() {
    this.laserTimer = undefined;
    const point = this.pendingLaser;
    this.pendingLaser = null;
    if (point) this.sendLaser(point);
  }

  private sendLaser(point: { x: number; y: number }) {
    this.lastLaserAt = Date.now();
    this.laserShown = true;
    this.emit({ op: "laser", ...point });
  }

  // ---- focus view ----------------------------------------------------------

  private cancelView() {
    clearTimeout(this.viewTimer);
    this.viewTimer = undefined;
    this.viewPending = false;
  }

  private flushView() {
    this.viewTimer = undefined;
    if (this.viewPending) this.sendView();
  }

  private sendView() {
    this.viewPending = false;
    this.lastViewAt = Date.now();
    if (this.focusView) this.emit({ op: "focus-view", ...this.focusView });
  }

  // ---- strokes -------------------------------------------------------------

  private knownOn(slide: string): Set<number> {
    let ids = this.known.get(slide);
    if (ids) {
      // Touched: it is the last slide to be forgotten.
      this.known.delete(slide);
    } else {
      ids = new Set();
      if (this.known.size >= MAX_MARK_SLIDES) {
        const oldest = this.known.keys().next().value;
        if (oldest !== undefined) this.known.delete(oldest);
      }
    }
    this.known.set(slide, ids);
    return ids;
  }

  private mayAdd(slide: string, id: number): boolean {
    const ids = this.knownOn(slide);
    return ids.has(id) || ids.size < MAX_SLIDE_STROKES;
  }

  private progress(event: Extract<MarkEvent, { kind: "stroke" }>) {
    const before = this.live.get(event.id);
    this.live.set(event.id, {
      slide: event.slide,
      tool: event.tool,
      color: event.color,
      points: event.points,
      sent: before?.sent ?? 0,
    });
    this.flushTimer ??= setTimeout(() => this.flushStrokes(), STROKE_FLUSH_MS);
  }

  private flushStrokes() {
    this.flushTimer = undefined;
    for (const [id, live] of this.live) {
      const total = usable(live.points);
      if (total <= live.sent || !this.mayAdd(live.slide, id)) continue;
      this.sendChunks((op) => this.emit(op), live.slide, { id, ...live }, live.sent, false);
      this.knownOn(live.slide).add(id);
      live.sent = total;
    }
  }

  private commit(event: Extract<MarkEvent, { kind: "stroke" }>) {
    const before = this.live.get(event.id);
    this.live.delete(event.id);
    if (this.live.size === 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.mayAdd(event.slide, event.id)) return;
    this.sendChunks((op) => this.emit(op), event.slide, event, before?.sent ?? 0, true);
    this.knownOn(event.slide).add(event.id);
  }

  private cancel(id: number) {
    const live = this.live.get(id);
    this.live.delete(id);
    if (this.live.size === 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!live) return;
    const ids = this.known.get(live.slide);
    if (ids?.delete(id)) this.emit({ op: "drop", slide: live.slide, ids: [id] });
  }

  /** `stroke` ops for the numbers of `stroke` from `from` on; the last one carries `end`. */
  private sendChunks(
    emit: MirrorSink,
    slide: string,
    stroke: { id: number; tool: MarkTool; color: MarkColor; points: readonly number[] },
    from: number,
    end: boolean,
  ) {
    const total = usable(stroke.points);
    let at = Math.min(from, total);
    do {
      const to = Math.min(total, at + 2 * MAX_CHUNK_POINTS);
      const last = to >= total;
      if (to > at || (last && end)) {
        emit({
          op: "stroke",
          slide,
          id: stroke.id,
          tool: stroke.tool,
          color: stroke.color,
          from: at,
          points: stroke.points.slice(at, to),
          end: end && last,
        });
      }
      at = to;
    } while (at < total);
  }

  /** The newest strokes that fit a receiver's limits (less what is reserved), oldest first. */
  private fit(
    strokes: readonly MarkStroke[],
    maxStrokes = MAX_SLIDE_STROKES,
    maxPoints = MAX_SLIDE_POINTS,
  ): MarkStroke[] {
    const picked: MarkStroke[] = [];
    let points = 0;
    for (let i = strokes.length - 1; i >= 0 && picked.length < maxStrokes; i--) {
      const stroke = strokes[i]!;
      points += usable(stroke.points) / 2;
      if (points > maxPoints) break;
      picked.push(stroke);
    }
    return picked.toReversed();
  }

  private marks(event: Extract<MarkEvent, { kind: "marks" }>) {
    const { slide, strokes } = event;
    if (event.reset) {
      this.current = { slide, strokes };
      this.known.delete(slide);
      const ids = this.knownOn(slide);
      this.emit({ op: "clear", slide });
      for (const stroke of this.fit(strokes)) {
        this.sendChunks((op) => this.emit(op), slide, stroke, 0, true);
        ids.add(stroke.id);
      }
      return;
    }
    if (slide !== this.current?.slide) {
      // The marks of a slide that is not on screen were dropped (a rebuilt deck).
      if (this.known.delete(slide)) this.emit({ op: "clear", slide });
      return;
    }
    this.current = { slide, strokes };
    const ids = this.knownOn(slide);
    const visible = new Set(strokes.map((s) => s.id));
    // A stroke being drawn is not in the visible list yet.
    const gone = [...ids].filter((id) => !visible.has(id) && !this.live.has(id));
    if (gone.length > 0) {
      if (gone.length === ids.size && visible.size === 0) {
        this.emit({ op: "clear", slide });
      } else {
        for (let i = 0; i < gone.length; i += MAX_DROP_IDS) {
          this.emit({ op: "drop", slide, ids: gone.slice(i, i + MAX_DROP_IDS) });
        }
      }
      for (const id of gone) ids.delete(id);
    }
    for (const stroke of strokes) {
      if (ids.has(stroke.id) || !this.mayAdd(slide, stroke.id)) continue;
      this.sendChunks((op) => this.emit(op), slide, stroke, 0, true);
      ids.add(stroke.id);
    }
  }

  private emit(op: MirrorOp, only?: MirrorSink) {
    for (const sink of only ? [only] : this.sinks) {
      try {
        sink(op);
      } catch (error) {
        // A sink that throws (a socket closing) must not stop the pointer handler that reported.
        (globalThis as { reportError?: (e: unknown) => void }).reportError?.(error);
      }
    }
  }
}
