import { describe, expect, test } from "vitest";
import {
  LINE_PIXELS,
  MAX_ZOOM_DELTA,
  panDelta,
  wheelPixels,
  ZOOM_PER_PIXEL,
  zoomFactor,
} from "./wheelGesture";

/**
 * The arithmetic of decision 127: wheel deltas in CSS pixels, and a zoom
 * factor that follows a pinch's size instead of counting its events.
 */

const STAGE = { width: 1200, height: 700 };

describe("wheelPixels", () => {
  test("pixels stay pixels, so a trackpad pans exactly as far as the fingers moved", () => {
    expect(wheelPixels({ deltaX: 3, deltaY: -7, deltaMode: 0 }, STAGE)).toEqual({ x: 3, y: -7 });
  });

  test("a line counts 16 px, so Firefox's line-mode mouse wheel moves as far as Chrome's", () => {
    expect(LINE_PIXELS).toBe(16);
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, STAGE)).toEqual({ x: 0, y: 48 });
  });

  test("a page counts one stage, across for x and down for y", () => {
    expect(wheelPixels({ deltaX: 1, deltaY: -1, deltaMode: 2 }, STAGE)).toEqual({
      x: 1200,
      y: -700,
    });
  });
});

describe("panDelta", () => {
  test("without Shift the picture moves by both axes", () => {
    expect(panDelta({ x: 30, y: 40 }, false)).toEqual({ x: 30, y: 40 });
  });

  test("with Shift a vertical wheel moves sideways only, the way a page scrolls with Shift", () => {
    expect(panDelta({ x: 0, y: 40 }, true)).toEqual({ x: 40, y: 0 });
  });

  test("with Shift a delta the system already turned sideways stays sideways", () => {
    expect(panDelta({ x: 40, y: 0 }, true)).toEqual({ x: 40, y: 0 });
  });
});

describe("zoomFactor", () => {
  test("the factor is exp(-deltaY * 0.01): up zooms out, down zooms in, nothing stays put", () => {
    expect(ZOOM_PER_PIXEL).toBe(0.01);
    expect(zoomFactor(0)).toBe(1);
    expect(zoomFactor(5)).toBeCloseTo(Math.exp(-0.05), 12);
    expect(zoomFactor(-5)).toBeCloseTo(Math.exp(0.05), 12);
  });

  test("one event counts at most 10 px either way, so a mouse notch of 100 px is a small step", () => {
    expect(MAX_ZOOM_DELTA).toBe(10);
    expect(zoomFactor(100)).toBeCloseTo(Math.exp(-0.1), 12);
    expect(zoomFactor(-100)).toBeCloseTo(Math.exp(0.1), 12);
    expect(zoomFactor(Number.NEGATIVE_INFINITY)).toBeCloseTo(Math.exp(0.1), 12);
  });

  test("a pinch of forty small events zooms by its size (about 2.23x), not forty steps", () => {
    // The owner's report: a pinch arrives as dozens of small ctrlKey wheel
    // events, and a fixed step per event zoomed 1.25^40 times over.
    let scale = 1;
    for (let i = 0; i < 40; i++) scale *= zoomFactor(-2);
    expect(scale).toBeCloseTo(Math.exp(0.8), 6);
    expect(scale).toBeGreaterThan(2.2);
    expect(scale).toBeLessThan(2.3);
  });

  test("forty events can never zoom more than e^4, however large each one is", () => {
    let scale = 1;
    for (let i = 0; i < 40; i++) scale *= zoomFactor(-1000);
    expect(scale).toBeLessThanOrEqual(Math.exp(4) + 1e-9);
  });
});
