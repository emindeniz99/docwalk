/**
 * The map's camera (decision 142): one transform on the frame layer, a
 * translation and a scale. Pure functions on plain numbers, so the unit tests
 * run without a DOM; the view composes them.
 *
 * Every input may be hostile or not ready: a pane of 0 by 0 before layout, a
 * map with no frames, NaN or Infinity from a bad event. No function returns
 * NaN or a non-finite number.
 */

import {
  panDelta,
  type Point,
  type WheelDelta,
  wheelPixels,
  zoomDelta,
  zoomFactor,
} from "../deck/wheelGesture";
import type { FrameRect, MapPlacement } from "./layout";

/**
 * Where the map is drawn in the pane. `x` and `y` are where the map's origin
 * (0, 0) lands, in CSS pixels from the pane's top-left corner, and `scale` is
 * CSS pixels per map unit. A map point `m` is drawn at `m * scale + (x, y)`,
 * and the pane point `p` shows the map point `(p - (x, y)) / scale`. This is
 * the CSS transform `translate(x px, y px) scale(scale)` on a layer with
 * `transform-origin: 0 0`; `cameraTransform` writes it.
 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The largest scale (decision 142). */
export const MAX_SCALE = 2;

/**
 * The smallest scale whatever the map's size. A map too big to fit above it
 * stops here, so dividing by the scale never overflows. A map 1000 panes
 * across is far beyond any document.
 */
export const SCALE_FLOOR = 1e-3;

/**
 * Lengths and coordinates are held to this size either way, far beyond any
 * map or screen, so every product and quotient here stays finite.
 */
export const COORD_LIMIT = 1e15;

/**
 * CSS pixels kept between a fitted frame or map and the pane's edges, so a
 * frame's border is not flush with the pane and does not read as cut off
 * (rule 3). At most a quarter of the pane, so a tiny pane keeps half its
 * size for the content.
 */
export const FIT_MARGIN = 24;

/**
 * "At least a part of the map's box stays in the pane" (decision 142): on
 * each axis the map's box and the pane overlap by at least this many CSS
 * pixels, or by the whole map or the whole pane when either is shorter. A map
 * shorter than this on an axis therefore stays whole in the pane on that axis,
 * anywhere inside it.
 */
export const OVERLAP = 64;

export interface WheelInput extends WheelDelta {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** The pointer's position in the pane, in CSS pixels from its top-left corner. */
  x: number;
  y: number;
}

/** A length: broken or negative is 0, huge is held to the limit. */
function length(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.min(v, COORD_LIMIT) : 0;
}

/** A coordinate: broken is 0 (or the fallback), huge is held to the limit. */
function coord(v: number, fallback = 0): number {
  return Number.isFinite(v) ? Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, v)) : fallback;
}

function sizeOf(s: Size): Size {
  return { width: length(s.width), height: length(s.height) };
}

/** The margin on one axis of the pane. */
function margin(pane: number): number {
  return Math.min(FIT_MARGIN, pane / 4);
}

/** A camera that can be drawn without bounds: a broken scale is 1, a tiny one the floor. */
function readable(c: Camera): Camera {
  const scale = Number.isFinite(c.scale) && c.scale > 0 ? Math.max(c.scale, SCALE_FLOOR) : 1;
  return { x: coord(c.x), y: coord(c.y), scale };
}

/** The CSS transform for a camera, translation first; a broken field reads as the identity's. */
export function cameraTransform(camera: Camera): string {
  const { x, y, scale } = readable(camera);
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

/**
 * The smallest scale: the one that fits the whole map, with `FIT_MARGIN`
 * around it, in the pane, but never above 1 (a small map is not blown up)
 * and never below `SCALE_FLOOR`. An axis with no pane or no map does not
 * limit; with neither axis limiting it is 1.
 */
export function minScale(bounds: Size, pane: Size): number {
  const b = sizeOf(bounds);
  const p = sizeOf(pane);
  let fit = 1;
  if (p.width > 0 && b.width > 0) fit = Math.min(fit, (p.width - 2 * margin(p.width)) / b.width);
  if (p.height > 0 && b.height > 0)
    fit = Math.min(fit, (p.height - 2 * margin(p.height)) / b.height);
  return Math.max(SCALE_FLOOR, fit);
}

/** One axis of the overlap rule: the range of positions that keeps `OVERLAP` of the map in the pane. */
function clampAxis(pos: number, mapLength: number, pane: number, scale: number): number {
  const scaled = mapLength * scale;
  const overlap = Math.min(OVERLAP, scaled, pane);
  return Math.min(pane - overlap, Math.max(overlap - scaled, coord(pos)));
}

function clampScale(scale: number, min: number): number {
  const s = Number.isNaN(scale) ? 1 : scale;
  return Math.min(MAX_SCALE, Math.max(min, s));
}

/**
 * The camera inside its limits: the scale between `minScale` and `MAX_SCALE`
 * (NaN reads as 1), then the position moved the least it must for the map's
 * box and the pane to overlap by `OVERLAP` on each axis (a broken coordinate
 * reads as 0). Clamping a clamped camera changes nothing.
 */
export function clamp(camera: Camera, bounds: Size, pane: Size): Camera {
  const b = sizeOf(bounds);
  const p = sizeOf(pane);
  const scale = clampScale(camera.scale, minScale(b, p));
  return {
    x: clampAxis(camera.x, b.width, p.width, scale),
    y: clampAxis(camera.y, b.height, p.height, scale),
    scale,
  };
}

/**
 * The opening camera (decision 142): the frame fitted to the pane's width
 * inside `FIT_MARGIN`, never above scale 1, its top `FIT_MARGIN` below the
 * pane's top and centred across. A pane with no width or a frame with no
 * width gives scale 1. The result is clamped.
 */
export function fitFrame(
  rect: Pick<FrameRect, "x" | "y" | "width">,
  bounds: Size,
  pane: Size,
): Camera {
  const p = sizeOf(pane);
  const width = length(rect.width);
  const inner = p.width - 2 * margin(p.width);
  const scale = p.width > 0 && width > 0 ? Math.min(1, inner / width) : 1;
  const camera = {
    x: (p.width - width * scale) / 2 - coord(rect.x) * scale,
    y: margin(p.height) - coord(rect.y) * scale,
    scale,
  };
  return clamp(camera, bounds, pane);
}

/** The whole map centred in the pane at `minScale`, clamped. */
export function fitAll(bounds: Size, pane: Size): Camera {
  const b = sizeOf(bounds);
  const p = sizeOf(pane);
  const scale = minScale(b, p);
  const camera = {
    x: (p.width - b.width * scale) / 2,
    y: (p.height - b.height * scale) / 2,
    scale,
  };
  return clamp(camera, b, p);
}

/** The map moved by (dx, dy) CSS pixels, clamped; a broken delta does not move it. */
export function pan(camera: Camera, dx: number, dy: number, bounds: Size, pane: Size): Camera {
  const c = clamp(camera, bounds, pane);
  return clamp({ x: c.x + coord(dx), y: c.y + coord(dy), scale: c.scale }, bounds, pane);
}

/**
 * The scale multiplied by `factor` around the pane point `point`: the scale
 * is clamped first, and the map point under `point` stays under it unless
 * the overlap rule then moves the camera. A broken or non-positive factor
 * does not zoom; a broken pointer coordinate reads as the pane's centre.
 */
export function zoomAt(
  camera: Camera,
  factor: number,
  point: Point,
  bounds: Size,
  pane: Size,
): Camera {
  const p = sizeOf(pane);
  const c = clamp(camera, bounds, p);
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const scale = clampScale(c.scale * f, minScale(bounds, p));
  const k = scale / c.scale;
  const px = coord(point.x, p.width / 2);
  const py = coord(point.y, p.height / 2);
  return clamp({ x: px - (px - c.x) * k, y: py - (py - c.y) * k, scale }, bounds, p);
}

/**
 * One wheel event (decisions 127 and 142): without Ctrl/Cmd it pans against
 * the delta, as a page scrolls, and with Shift a vertical wheel pans
 * sideways; with Ctrl/Cmd, which is also how a trackpad pinch arrives, it
 * zooms around the pointer by `zoomFactor`. A broken delta counts as 0.
 */
export function wheel(camera: Camera, input: WheelInput, bounds: Size, pane: Size): Camera {
  const raw = wheelPixels(input, sizeOf(pane));
  const pixels = { x: coord(raw.x), y: coord(raw.y) };
  if (input.ctrlKey || input.metaKey) {
    const factor = zoomFactor(zoomDelta(pixels));
    return zoomAt(camera, factor, { x: input.x, y: input.y }, bounds, pane);
  }
  const delta = panDelta(pixels, input.shiftKey);
  return pan(camera, -delta.x, -delta.y, bounds, pane);
}

/**
 * Two fingers from `startTouches` (with `startCamera`) to `touches`: the
 * scale follows the ratio of the fingers' distances and the map point under
 * the start midpoint sits under the current midpoint, then the result is
 * clamped. Fingers that started on one point only pan. A broken touch
 * coordinate gives the start camera, clamped.
 */
export function pinch(
  startCamera: Camera,
  startTouches: readonly [Point, Point],
  touches: readonly [Point, Point],
  bounds: Size,
  pane: Size,
): Camera {
  const c = clamp(startCamera, bounds, pane);
  const all = [...startTouches, ...touches];
  if (!all.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y))) return c;
  const [a0, b0, a1, b1] = all.map((t) => ({ x: coord(t.x), y: coord(t.y) })) as [
    Point,
    Point,
    Point,
    Point,
  ];
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const ratio = d0 > 0 ? d1 / d0 : 1;
  const scale = clampScale(c.scale * ratio, minScale(bounds, pane));
  const k = scale / c.scale;
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  return clamp({ x: m1.x - (m0.x - c.x) * k, y: m1.y - (m0.y - c.y) * k, scale }, bounds, pane);
}

/**
 * What the pane shows, in map units: the map point at the pane's top-left
 * corner and the pane's size over the scale. A broken camera field reads as
 * the identity's; a pane not laid out gives a rectangle of 0 by 0.
 */
export function visibleRect(camera: Camera, pane: Size): Size & Point {
  const { x, y, scale } = readable(camera);
  const p = sizeOf(pane);
  return {
    x: (0 - x) / scale,
    y: (0 - y) / scale,
    width: p.width / scale,
    height: p.height / scale,
  };
}

/**
 * The ids of the frames within one viewport of what the camera shows
 * (decision 142's lazy diagrams): every frame whose rectangle overlaps the
 * visible rectangle grown by its own size in every direction, in document
 * order. A pane not laid out shows nothing, so nothing is near.
 */
export function framesNear(
  placement: Pick<MapPlacement, "frames">,
  camera: Camera,
  pane: Size,
): string[] {
  const v = visibleRect(camera, pane);
  if (v.width <= 0 || v.height <= 0) return [];
  // Grown edge by edge, so the grown rectangle holds the visible one under rounding.
  const left = v.x - v.width;
  const right = v.x + v.width + v.width;
  const top = v.y - v.height;
  const bottom = v.y + v.height + v.height;
  return placement.frames
    .filter((f) => f.x < right && left < f.x + f.width && f.y < bottom && top < f.y + f.height)
    .map((f) => f.id);
}

/**
 * The frame a height change keeps in place (decision 155): `current` while any
 * of it is in the pane, otherwise the first frame in document order that is.
 * `frames` are the rectangles as they were before the change, seen by
 * `camera`. Null when no frame is in the pane or the pane has no area.
 */
export function anchorFrame(
  frames: readonly FrameRect[],
  camera: Camera,
  pane: Size,
  current: string | null,
): string | null {
  const v = visibleRect(camera, pane);
  if (v.width <= 0 || v.height <= 0) return null;
  const shown = (f: FrameRect) =>
    f.x < v.x + v.width && v.x < f.x + f.width && f.y < v.y + v.height && v.y < f.y + f.height;
  const kept = current === null ? undefined : frames.find((f) => f.id === current);
  if (kept && shown(kept)) return kept.id;
  return frames.find(shown)?.id ?? null;
}

/**
 * The camera moved so a frame that stood at `fromY` and now stands at `toY`
 * keeps the place of its top on screen (decision 155). Only `y` changes; a
 * broken number leaves the camera as it is.
 */
export function holdTop(camera: Camera, fromY: number, toY: number): Camera {
  const { x, y, scale } = readable(camera);
  const shift = (fromY - toY) * scale;
  return Number.isFinite(shift) ? { x, y: y + shift, scale } : { x, y, scale };
}
