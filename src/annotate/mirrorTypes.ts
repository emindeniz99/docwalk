/**
 * What the presenter mirrors to followers and to the presenter window
 * (decision 88): the laser, pen and arrow strokes, and the focus view of a
 * diagram, code block, table or image with its line marks (decision 106).
 * This file has no DOM types and no schema library, so the first-load bundle,
 * the Node-run unit tests and the `docwalk-mcp` agent can all import it.
 *
 * Everything travels in slide units: x over the width and y over the height
 * of the 1280 by 720 slide box, on a grid of `COORD_MAX` steps (0.3 px), so a
 * mark lands on the same spot of the slide on any screen and in any frame.
 */

/** One step more than the grid: 0 is the left or top edge, `COORD_MAX` the right or bottom one. */
export const COORD_MAX = 4096;

/** A point closer than this to the last recorded one (slide px) is not recorded. */
export const MIN_STEP_PX = 2;
/** Slide box the grid spans; the same size as `SLIDE_SIZE` in src/deck/pages.ts. */
export const MIRROR_WIDTH = 1280;
export const MIRROR_HEIGHT = 720;

/** A stroke stops growing here: points beyond it are drawn on the presenter's slide but not sent. */
export const MAX_STROKE_POINTS = 1500;
/** Most points one message carries; a longer stroke goes out as several chunks. */
export const MAX_CHUNK_POINTS = 128;
/** While a pen stroke is being drawn its new points go out this often (about 12 frames a second). */
export const STROKE_FLUSH_MS = 80;

/**
 * What a receiver keeps per slide, and how many slides. A stroke or point
 * over a slide's limit is ignored; a 17th slide is not: the receiver forgets
 * the least recently touched slide to make room (mirrorStore.ts).
 */
export const MAX_SLIDE_STROKES = 200;
export const MAX_SLIDE_POINTS = 30_000;
export const MAX_MARK_SLIDES = 16;
/** Ids in one `drop`. */
export const MAX_DROP_IDS = 64;
/** Ids in one `keep`: every stroke a receiver keeps for a slide (decision 103). */
export const MAX_KEEP_IDS = MAX_SLIDE_STROKES;
/** The longest address a message may carry (the same ceiling as a `goto`). */
export const MAX_SLIDE_ADDRESS_CHARS = 2048;
/** A focus op numbers its block from 1 among the blocks of its kind on the slide; no slide has more of one kind. */
export const MAX_FOCUS_BLOCKS = 1000;
/** Marked lines in one `focus-lines` (decision 106): a presenter who marks more mirrors the first ones. */
export const MAX_MARKED_LINES = 256;
/** The highest line number a `focus-lines` may name. */
export const MAX_CODE_LINES = 100_000;

/** The focus view's zoom range (Panzoom's, in src/deck/focus.ts) and the pan a receiver follows. */
export const FOCUS_SCALE_MIN = 0.1;
export const FOCUS_SCALE_MAX = 12;
export const FOCUS_PAN_LIMIT = 8;

/** The laser goes out at most this often (about 30 messages a second); the same pace as a phone remote's. */
export const MIRROR_LASER_MS = 33;
/** Zoom and pan of the focus view go out at most this often. */
export const MIRROR_FOCUS_VIEW_MS = 100;

/** A phone remote's laser disappears after this long without an update (host.ts), and so does a mirrored one. */
export const MIRROR_LASER_IDLE_MS = 3000;

/**
 * A resync is never sooner than this after the last one (decision 88), and
 * on the room it waits longer the more the last one cost: max(2 s, cost /
 * RESYNC_BYTES_PER_SECOND), so however often followers say hello, resyncs
 * cost the presenter at most about 64 KB of sealed frames a second
 * (decision 103). The presenter window's bridge keeps the 2 s floor.
 */
export const RESYNC_MIN_GAP_MS = 2000;
export const RESYNC_BYTES_PER_SECOND = 64 * 1024;
/** What a signed, sealed room frame adds to the base64 of its op: seal, signature, tag and frame fields (258 measured). */
const FRAME_OVERHEAD_BYTES = 260;
const utf8 = new TextEncoder();

/** About what `op` costs as a signed, sealed room frame; src/remote/crypto.test.ts holds it to the real frames. */
export function mirrorFrameBytes(op: MirrorOp): number {
  return Math.ceil((utf8.encode(JSON.stringify(op)).length * 4) / 3) + FRAME_OVERHEAD_BYTES;
}

/** How long the presenter waits after a resync whose frames cost `bytes` (`mirrorFrameBytes` summed). */
export function resyncGapMs(bytes: number): number {
  return Math.max(RESYNC_MIN_GAP_MS, Math.ceil((bytes * 1000) / RESYNC_BYTES_PER_SECOND));
}

/**
 * Pen colours as keys. A message names a key, never a colour: the receiver
 * maps it to its own design token (`--dw-color-<key>`), so the theme decides
 * the colour and nothing from the wire reaches a style.
 */
export const MARK_COLORS = ["primary", "focus", "ink"] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
export const MARK_TOOLS = ["pen", "arrow"] as const;
export type MarkTool = (typeof MARK_TOOLS)[number];

/** One of the three pen colours' token names (`--dw-color-primary`), as a key; null for anything else. */
export function markColorOf(variable: string): MarkColor | null {
  const key = variable.startsWith("--dw-color-") ? variable.slice("--dw-color-".length) : variable;
  return (MARK_COLORS as readonly string[]).includes(key) ? (key as MarkColor) : null;
}

/** A unit fraction on the grid, clamped to the slide. */
export function quantize(unit: number): number {
  if (!Number.isFinite(unit)) return 0;
  return Math.round(Math.min(1, Math.max(0, unit)) * COORD_MAX);
}

/** The four kinds of focus view (decisions 87 and 106). */
export const FOCUS_VIEW_KINDS = ["diagram", "code", "table", "image"] as const;
export type FocusViewKind = (typeof FOCUS_VIEW_KINDS)[number];

/**
 * The block an open focus view shows: its slide, its kind and its number
 * among the blocks of that kind on the slide, from 1. Never its text or an id.
 */
export interface FocusPlace {
  slide: string;
  block: FocusViewKind;
  n: number;
}

/**
 * `focus-open` names the block with one key for its kind (decision 106): the
 * diagram's shape of decision 88, and the same for code, tables and images.
 */
type FocusOpenOp = { op: "focus-open"; slide: string } & (
  | { diagram: number }
  | { code: number }
  | { table: number }
  | { image: number }
);

/** The `focus-open` op for `place`. */
export function focusOpenOp({ slide, block, n }: FocusPlace): FocusOpenOp {
  switch (block) {
    case "diagram":
      return { op: "focus-open", slide, diagram: n };
    case "code":
      return { op: "focus-open", slide, code: n };
    case "table":
      return { op: "focus-open", slide, table: n };
    case "image":
      return { op: "focus-open", slide, image: n };
  }
}

/** The block a `focus-open` op names. */
export function focusPlaceOf(op: FocusOpenOp): FocusPlace {
  const { slide } = op;
  if ("diagram" in op) return { slide, block: "diagram", n: op.diagram };
  if ("code" in op) return { slide, block: "code", n: op.code };
  if ("table" in op) return { slide, block: "table", n: op.table };
  return { slide, block: "image", n: op.image };
}

/**
 * Marked lines as a `focus-lines` op carries them: whole numbers from 1 to
 * `MAX_CODE_LINES`, each once, ascending, the first `MAX_MARKED_LINES`.
 */
export function markedLines(lines: readonly number[]): number[] {
  const valid = lines.filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_CODE_LINES);
  return [...new Set(valid)].toSorted((a, b) => a - b).slice(0, MAX_MARKED_LINES);
}

/** The ops that travel to a receiver. The same shapes go in a room message and over the bridge. */
export type MirrorOp =
  /** The presenter's laser in slide units (0..1). */
  | { op: "laser"; x: number; y: number }
  | { op: "laser-off" }
  /**
   * A pen or arrow stroke, or a chunk of one. `points` is flat (x0, y0, x1,
   * y1, ...) on the grid; `from` is how many numbers the receiver must hold
   * already (0 starts the stroke, or replaces one with the same id); `end`
   * marks the last chunk.
   */
  | {
      op: "stroke";
      slide: string;
      id: number;
      tool: MarkTool;
      color: MarkColor;
      from: number;
      points: number[];
      end: boolean;
    }
  /** Strokes that are gone from the slide (erased, undone). */
  | { op: "drop"; slide: string; ids: number[] }
  /** Every stroke of the slide is gone. */
  | { op: "clear"; slide: string }
  /**
   * The strokes of the slide that stay; every other one is gone. A resync
   * opens with it and then sends those strokes from 0 (decision 103), so a
   * receiver that has them never shows the slide empty.
   */
  | { op: "keep"; slide: string; ids: number[] }
  /** The presenter opened the focus view on the `n`-th diagram, code block, table or image (from 1) of a slide. */
  | FocusOpenOp
  /**
   * Zoom and position of the open focus view. A diagram or image: the scale
   * over Fit and the pan as a fraction of the stage, so any screen frames
   * alike. Code or a table: the type size over Fit, and how far the view is
   * scrolled across and down as a fraction of how far it can scroll (0..1).
   */
  | { op: "focus-view"; scale: number; x: number; y: number }
  /** The marked lines of the open code view, from 1, ascending (decision 106). */
  | { op: "focus-lines"; lines: number[] }
  | { op: "focus-close" };

/** A mark as the layer reports it (src/annotate/layer.ts) and the feed keeps it. */
export interface MarkStroke {
  id: number;
  tool: MarkTool;
  color: MarkColor;
  /** Flat grid points. */
  points: readonly number[];
}

/** What the annotation layer tells its observers (src/annotate/layer.ts `observe`). */
export type MarkEvent =
  | { kind: "laser"; x: number; y: number }
  | { kind: "laser-off" }
  /** A pen stroke grew (`end` false), or any stroke was committed (`end` true). */
  | ({ kind: "stroke"; slide: string; end: boolean } & MarkStroke)
  /** The stroke in progress was abandoned (a slide change, a too-short arrow). */
  | { kind: "cancel"; id: number }
  /**
   * The strokes that are visible on a slide now. `reset` marks a change of
   * slide: the receiver may hold anything for it, so it is sent in full.
   */
  | { kind: "marks"; slide: string; strokes: readonly MarkStroke[]; reset: boolean };

/** What the focus view tells its observers (src/deck/focusEvents.ts). */
export type FocusEvent =
  | ({ kind: "open" } & FocusPlace)
  | { kind: "view"; scale: number; x: number; y: number }
  /** The lines marked in the open code view now, from 1. */
  | { kind: "lines"; lines: readonly number[] }
  /** The diagram tour's path now, as node numbers from 1; empty when it ended (decision 109). */
  | { kind: "tour"; path: readonly number[] }
  | { kind: "close" };
