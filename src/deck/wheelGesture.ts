/**
 * Wheel and pinch arithmetic for the focus views (decision 127). Pure
 * functions on plain numbers, so the unit tests run without a DOM.
 */

/** CSS pixels in one line of a wheel in `deltaMode` 1 (Firefox's mouse wheel). */
export const LINE_PIXELS = 16;
/** How much one pixel of `deltaY` zooms: the factor is `exp(-deltaY * ZOOM_PER_PIXEL)`. */
export const ZOOM_PER_PIXEL = 0.01;
/** One event's `deltaY` counts at most this many pixels either way, so a mouse notch is a small step. */
export const MAX_ZOOM_DELTA = 10;

export interface WheelDelta {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages, as `WheelEvent.deltaMode`. */
  deltaMode: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A wheel delta in CSS pixels: a line is 16 px and a page is one `page` across or down. */
export function wheelPixels(delta: WheelDelta, page: { width: number; height: number }): Point {
  if (delta.deltaMode === 1)
    return { x: delta.deltaX * LINE_PIXELS, y: delta.deltaY * LINE_PIXELS };
  if (delta.deltaMode === 2) return { x: delta.deltaX * page.width, y: delta.deltaY * page.height };
  return { x: delta.deltaX, y: delta.deltaY };
}

/** How far a wheel pans, in pixels. With Shift a vertical wheel pans sideways. */
export function panDelta(pixels: Point, shift: boolean): Point {
  if (!shift) return pixels;
  return { x: pixels.x !== 0 ? pixels.x : pixels.y, y: 0 };
}

/**
 * The delta a zoom reads, in pixels: the vertical one, or the horizontal one when there is no
 * vertical one, because macOS turns Shift + wheel sideways (Panzoom's zoomWithWheel did the same).
 */
export function zoomDelta(pixels: Point): number {
  return pixels.y !== 0 ? pixels.y : pixels.x;
}

/** The scale factor of one zoom wheel event, from its `deltaY` in pixels. */
export function zoomFactor(deltaY: number): number {
  const held = Math.min(MAX_ZOOM_DELTA, Math.max(-MAX_ZOOM_DELTA, deltaY));
  return Math.exp(-held * ZOOM_PER_PIXEL);
}
