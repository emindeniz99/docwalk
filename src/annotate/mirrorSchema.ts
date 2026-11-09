import * as v from "valibot";
import {
  COORD_MAX,
  FOCUS_PAN_LIMIT,
  FOCUS_SCALE_MAX,
  FOCUS_SCALE_MIN,
  MARK_COLORS,
  MARK_TOOLS,
  MAX_CHUNK_POINTS,
  MAX_CODE_LINES,
  MAX_DROP_IDS,
  MAX_FOCUS_BLOCKS,
  MAX_KEEP_IDS,
  MAX_MARKED_LINES,
  MAX_SLIDE_ADDRESS_CHARS,
  MAX_STROKE_POINTS,
  type MirrorOp,
} from "./mirrorTypes";
import { MAX_TOUR_NODES, MAX_TOUR_STEPS } from "../deck/tourModel";

/**
 * The schema of every mirror op (decisions 88, 103, 106, 109 and 110), checked where the ops arrive:
 * in a room message after it decrypts (src/remote/crypto.ts) and on the
 * presenter bridge (src/presenter/bridge.ts). Strict: a field it does not
 * name fails the whole message, so nothing a sender adds can ride along.
 * Every value is a number, a boolean, a picklist or an address that the
 * receiver only compares; no string reaches the DOM.
 */

const Slide = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SLIDE_ADDRESS_CHARS));
const Unit = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
const Coord = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(COORD_MAX));
const StrokeId = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 ** 31 - 1));
const Pan = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(-FOCUS_PAN_LIMIT),
  v.maxValue(FOCUS_PAN_LIMIT),
);

/** A block's number among the blocks of its kind on its slide (decision 106). */
const Place = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FOCUS_BLOCKS));
const Line = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CODE_LINES));
/** A node's number among the nodes of its diagram, in drawing order (decision 109). */
const TourNode = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TOUR_NODES));
const focusOpen = { type: v.literal("mirror"), op: v.literal("focus-open"), slide: Slide };

const Points = v.pipe(
  v.array(Coord),
  v.maxLength(2 * MAX_CHUNK_POINTS),
  v.check((list) => list.length % 2 === 0, "points come in pairs"),
);

/** The `mirror` part of a room message and of a bridge message, as `{ type: "mirror", op, ... }`. */
export const MirrorMessageSchema = v.variant("op", [
  v.strictObject({ type: v.literal("mirror"), op: v.literal("laser"), x: Unit, y: Unit }),
  v.strictObject({ type: v.literal("mirror"), op: v.literal("laser-off") }),
  v.pipe(
    v.strictObject({
      type: v.literal("mirror"),
      op: v.literal("stroke"),
      slide: Slide,
      id: StrokeId,
      tool: v.picklist(MARK_TOOLS),
      color: v.picklist(MARK_COLORS),
      from: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 * MAX_STROKE_POINTS)),
      points: Points,
      end: v.boolean(),
    }),
    v.check((m) => m.from % 2 === 0, "from counts whole points"),
    v.check((m) => m.from + m.points.length <= 2 * MAX_STROKE_POINTS, "stroke too long"),
    v.check((m) => m.points.length > 0 || m.end, "an empty chunk has to end the stroke"),
    // A shape is its two corners, sent whole (decision 110): a hostile sender cannot grow or cut one.
    v.check(
      (m) => m.tool === "pen" || (m.from === 0 && m.points.length === 4 && m.end),
      "a shape is one chunk of four numbers",
    ),
  ),
  v.strictObject({
    type: v.literal("mirror"),
    op: v.literal("drop"),
    slide: Slide,
    ids: v.pipe(v.array(StrokeId), v.minLength(1), v.maxLength(MAX_DROP_IDS)),
  }),
  v.strictObject({ type: v.literal("mirror"), op: v.literal("clear"), slide: Slide }),
  v.strictObject({
    type: v.literal("mirror"),
    op: v.literal("keep"),
    slide: Slide,
    ids: v.pipe(v.array(StrokeId), v.maxLength(MAX_KEEP_IDS)),
  }),
  v.strictObject({ type: v.literal("mirror"), op: v.literal("board-open"), slide: Slide }),
  v.strictObject({ type: v.literal("mirror"), op: v.literal("board-close") }),
  // One key names the block's kind (decision 106); a message with two, or none, fails.
  v.strictObject({ ...focusOpen, diagram: Place }),
  v.strictObject({ ...focusOpen, code: Place }),
  v.strictObject({ ...focusOpen, table: Place }),
  v.strictObject({ ...focusOpen, image: Place }),
  v.strictObject({
    type: v.literal("mirror"),
    op: v.literal("focus-view"),
    scale: v.pipe(v.number(), v.finite(), v.minValue(FOCUS_SCALE_MIN), v.maxValue(FOCUS_SCALE_MAX)),
    x: Pan,
    y: Pan,
  }),
  v.strictObject({
    type: v.literal("mirror"),
    op: v.literal("focus-lines"),
    lines: v.pipe(
      v.array(Line),
      v.maxLength(MAX_MARKED_LINES),
      v.check((list) => list.every((n, i) => i === 0 || n > list[i - 1]!), "lines ascend"),
    ),
  }),
  v.strictObject({
    type: v.literal("mirror"),
    op: v.literal("focus-tour"),
    path: v.pipe(v.array(TourNode), v.maxLength(MAX_TOUR_STEPS)),
  }),
  v.strictObject({ type: v.literal("mirror"), op: v.literal("focus-close") }),
]) satisfies v.GenericSchema<unknown, { type: "mirror" } & MirrorOp>;
