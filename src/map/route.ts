/**
 * The map's route (decision 145): document order through the frames, the two
 * mappings between map frames and deck sections, the camera's in-between
 * positions and the keyboard's zoom step. Pure functions on plain data, so
 * the unit tests run without a DOM; the view composes them.
 *
 * Every input may be degenerate: an empty map, an id no longer on the map, a
 * broken line, a NaN camera, a pane of 0 by 0. No function throws, and none
 * returns a non-finite camera.
 */

import type { Section } from "../sectioning/sectionize";
import { type Camera, type Size, zoomAt } from "./camera";
import type { MapFrame } from "./layout";

/** How long the camera travels to a frame: "about 300 ms" (decision 145). */
export const MOVE_MS = 300;

/**
 * The factor of one Plus or minus press: the diagram focus view's step.
 * `src/deck/focus.ts` gives Panzoom `step: 0.25`, and Panzoom's `zoomIn`
 * multiplies the scale by `Math.exp(step)` (`zoomOut` by its inverse).
 */
export const ZOOM_STEP = Math.exp(0.25);

/** The frame ids in document order: the columns left to right, each top to bottom. */
export function routeOrder(columns: readonly (readonly Pick<MapFrame, "id">[])[]): string[] {
  return columns.flatMap((column) => column.map((frame) => frame.id));
}

/** Home: the first frame, or null on an empty map. */
export function firstFrame(order: readonly string[]): string | null {
  return order[0] ?? null;
}

/** End: the last frame, or null on an empty map. */
export function lastFrame(order: readonly string[]): string | null {
  return order.at(-1) ?? null;
}

/**
 * The frame after `current`; the last frame stays (no wrap). With no current
 * frame, or one no longer on the map, the route starts at the first frame.
 */
export function nextFrame(order: readonly string[], current: string | null): string | null {
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return firstFrame(order);
  return order[Math.min(i + 1, order.length - 1)] ?? null;
}

/**
 * The frame before `current`; the first frame stays (no wrap). With no current
 * frame, or one no longer on the map, the route starts at the first frame.
 */
export function previousFrame(order: readonly string[], current: string | null): string | null {
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return firstFrame(order);
  return order[Math.max(i - 1, 0)] ?? null;
}

/** The frame's place for the status ("3 of 40"): 1-based, or null when it is not on the route. */
export function placeOf(
  order: readonly string[],
  id: string | null,
): { index: number; count: number } | null {
  const i = id === null ? -1 : order.indexOf(id);
  return i < 0 ? null : { index: i + 1, count: order.length };
}

type Located = Pick<Section, "id" | "line">;

/**
 * The id of the section in `sections` that holds source line `line`: the one
 * with the greatest line at or before it, the later one in the list on a tie;
 * the first section when `line` comes before them all (or is NaN, which no
 * line is at or before); null when there are none.
 */
function holder(sections: readonly Located[], line: number): string | null {
  let found: Located | undefined;
  for (const s of sections) {
    if (s.line <= line && (found === undefined || s.line >= found.line)) found = s;
  }
  return (found ?? sections[0])?.id ?? null;
}

/** The line where the section `id` starts, or undefined when no section has that id. */
function lineOf(sections: readonly Located[], id: string): number | undefined {
  return sections.find((s) => s.id === id)?.line;
}

/** A map section as `sectionForFrame` reads it: where it starts, its heading and whether it has text. */
type MapLocated = Pick<Section, "id" | "line" | "heading" | "nodes">;

/**
 * The deck section for the frame `frameId` (decisions 145, 147 and 148,
 * Address). A frame the deck shows only as a breadcrumb (a heading above the
 * deck's lowest slide level `min(deckLevels)`, no text of its own and no deck
 * section of its id) gets the first deck section at or after its line, the
 * slide that carries it, or the last deck section when none follows. Any
 * other frame gets the deck section that holds its first line: the one with
 * the greatest line at or before the frame's, or the first deck section when
 * the frame starts before every one. Null when the deck has no sections or no
 * map section has that id. The two plans section one document, possibly at
 * different levels, so they meet by source line. `deckLevels` is the deck
 * plan's `levels`; with none, every heading is above the slide level, as
 * `sectionize` reads it.
 */
export function sectionForFrame(
  deckSections: readonly Located[],
  mapSections: readonly MapLocated[],
  frameId: string,
  deckLevels: readonly number[],
): string | null {
  const frame = mapSections.find((s) => s.id === frameId);
  if (!frame) return null;
  const lowest = deckLevels.length > 0 ? Math.min(...deckLevels) : Number.POSITIVE_INFINITY;
  const breadcrumb =
    frame.heading !== null &&
    frame.heading.depth < lowest &&
    frame.nodes.length === 0 &&
    !deckSections.some((s) => s.id === frame.id);
  if (breadcrumb) {
    const after = deckSections.find((s) => s.line >= frame.line);
    if (after) return after.id;
    return deckSections.at(-1)?.id ?? null;
  }
  return holder(deckSections, frame.line);
}

/**
 * The map frame that holds the deck section `sectionId`'s first line
 * (decision 145, Address): the frame with the greatest line at or before the
 * section's; the first frame when the section starts before every one; null
 * when the map has no frames or no deck section has that id.
 */
export function frameForSection(
  mapSections: readonly Located[],
  deckSections: readonly Located[],
  sectionId: string,
): string | null {
  const line = lineOf(deckSections, sectionId);
  return line === undefined ? null : holder(mapSections, line);
}

/** Progress held to 0..1; NaN arrives (1). */
function progress(t: number): number {
  return Number.isNaN(t) ? 1 : Math.min(1, Math.max(0, t));
}

/**
 * Ease in and out (a cubic): 0 at 0, 1 at 1, 0.5 at 0.5, never decreasing.
 * Progress outside 0..1 is held to it and NaN reads as 1, so a late or broken
 * clock lands the move. The view calls `tween(from, to, ease(elapsed / MOVE_MS), pane)`.
 */
export function ease(t: number): number {
  const u = progress(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (2 - 2 * u) ** 3 / 2;
}

const sound = (c: Camera) =>
  Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale) && c.scale > 0;

/** A pane length's half: a broken or negative length is 0. */
const half = (v: number) => (Number.isFinite(v) && v > 0 ? v / 2 : 0);

/**
 * The camera at progress `t` of the move from `from` to `to` (decision 145):
 * with the pane's centre `c` and the map point under it at each end
 * `m0 = (c - from.xy) / from.scale` and `m1 = (c - to.xy) / to.scale`,
 *
 *   scale(t) = from.scale * (to.scale / from.scale) ** t   (geometric: even zoom)
 *   m(t)     = m0 + (m1 - m0) * t                          (a straight glide)
 *   xy(t)    = c - m(t) * scale(t)
 *
 * with the scale held between the two ends against rounding. `t` is held to
 * 0..1 (NaN arrives); 0 gives `from` and 1 gives `to`, exactly. A broken field
 * or a non-positive scale at either end gives `to`, a broken field in it read
 * as camera.ts reads one (x or y 0, scale 1); so does an in-between camera
 * that would not be finite. A broken or negative pane length counts as 0.
 */
export function tween(from: Camera, to: Camera, t: number, pane: Size): Camera {
  const end: Camera = {
    x: Number.isFinite(to.x) ? to.x : 0,
    y: Number.isFinite(to.y) ? to.y : 0,
    scale: Number.isFinite(to.scale) && to.scale > 0 ? to.scale : 1,
  };
  if (!sound(from) || !sound(to)) return end;
  const u = progress(t);
  if (u === 0) return { x: from.x, y: from.y, scale: from.scale };
  if (u === 1) return end;
  const cx = half(pane.width);
  const cy = half(pane.height);
  const lo = Math.min(from.scale, to.scale);
  const hi = Math.max(from.scale, to.scale);
  const scale = Math.min(hi, Math.max(lo, from.scale * (to.scale / from.scale) ** u));
  const m0x = (cx - from.x) / from.scale;
  const m0y = (cy - from.y) / from.scale;
  const m1x = (cx - to.x) / to.scale;
  const m1y = (cy - to.y) / to.scale;
  const camera = {
    x: cx - (m0x + (m1x - m0x) * u) * scale,
    y: cy - (m0y + (m1y - m0y) * u) * scale,
    scale,
  };
  return sound(camera) ? camera : end;
}

/**
 * One press of Plus (`"in"`) or minus (`"out"`): the scale multiplied or
 * divided by `ZOOM_STEP` around the pane's centre, through `zoomAt`, so the
 * camera's limits hold. The whole map (`0`) is camera.ts's `fitAll`.
 */
export function zoomStep(
  camera: Camera,
  direction: "in" | "out",
  bounds: Size,
  pane: Size,
): Camera {
  const factor = direction === "in" ? ZOOM_STEP : 1 / ZOOM_STEP;
  return zoomAt(camera, factor, { x: half(pane.width), y: half(pane.height) }, bounds, pane);
}
