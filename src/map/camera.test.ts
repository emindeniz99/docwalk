import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  type Camera,
  cameraTransform,
  clamp,
  COORD_LIMIT,
  FIT_MARGIN,
  fitAll,
  fitFrame,
  framesNear,
  MAX_SCALE,
  minScale,
  OVERLAP,
  pan,
  pinch,
  SCALE_FLOOR,
  type Size,
  visibleRect,
  wheel,
  type WheelInput,
  zoomAt,
} from "./camera";
import { FRAME_WIDTH, type MapPlacement, placeFrames } from "./layout";

/**
 * The map's camera (decision 142): one translation and one scale on the
 * frame layer, kept between the scale that fits the whole map and 2, and
 * never further from the map than a strip of it in the pane. Every function
 * is pure, so these run without a DOM.
 */

const PANE: Size = { width: 1000, height: 800 };
const BIG: Size = { width: 8000, height: 6000 };
const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

/** A matcher for a camera equal to `expected` up to rounding. */
const near = (expected: Camera) => ({
  x: expect.closeTo(expected.x, 9),
  y: expect.closeTo(expected.y, 9),
  scale: expect.closeTo(expected.scale, 12),
});

/** Every field finite and the scale positive: a camera the view can draw and divide by. */
const isFiniteCamera = (c: Camera) =>
  Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale) && c.scale > 0;

/** The map point shown at a pane point: the inverse of `translate(x, y) scale(s)`. */
const mapPoint = (c: Camera, p: { x: number; y: number }) => ({
  x: (p.x - c.x) / c.scale,
  y: (p.y - c.y) / c.scale,
});

const wheelInput = (over: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  x: 500,
  y: 400,
  ...over,
});

// A camera in the middle of a big map, far from every limit.
const MIDDLE: Camera = { x: -2000, y: -1500, scale: 0.5 };

describe("cameraTransform", () => {
  test("the translation comes before the scale, so a map point m lands at m * scale + (x, y)", () => {
    // CSS applies the rightmost function first: scale, then translate. With
    // transform-origin 0 0 a map point m is drawn at m * scale + (x, y).
    expect(cameraTransform({ x: 12.5, y: -40, scale: 0.75 })).toBe(
      "translate(12.5px, -40px) scale(0.75)",
    );
  });

  test("a hostile camera still gives a transform CSS can parse", () => {
    expect(cameraTransform({ x: Number.NaN, y: Number.POSITIVE_INFINITY, scale: 0 })).toBe(
      "translate(0px, 0px) scale(1)",
    );
  });
});

describe("minScale", () => {
  test("a big map fits in the pane with a margin on its tightest axis", () => {
    const expected = Math.min(
      (PANE.width - 2 * FIT_MARGIN) / BIG.width,
      (PANE.height - 2 * FIT_MARGIN) / BIG.height,
    );
    expect(minScale(BIG, PANE)).toBeCloseTo(expected, 12);
  });

  test("a map smaller than the pane is not forced to zoom in: the minimum is never above 1", () => {
    // The opening view is never above scale 1 (row 142), so the minimum cannot be either.
    expect(minScale({ width: 300, height: 200 }, PANE)).toBe(1);
  });

  test("the minimum never exceeds the maximum", () => {
    expect(MAX_SCALE).toBe(2);
    expect(minScale({ width: 1, height: 1 }, { width: 1e6, height: 1e6 })).toBeLessThanOrEqual(
      MAX_SCALE,
    );
  });

  test("a pane not laid out yet or a map with no frames gives 1, not 0 or Infinity", () => {
    expect(minScale(BIG, { width: 0, height: 0 })).toBe(1);
    expect(minScale({ width: 0, height: 0 }, PANE)).toBe(1);
    for (const v of BAD) {
      expect(minScale({ width: v, height: v }, PANE)).toBe(1);
      expect(minScale(BIG, { width: v, height: v })).toBe(1);
    }
  });

  test("an axis with no pane or no map does not limit; the other axis still does", () => {
    expect(minScale({ width: 0, height: 6000 }, PANE)).toBeCloseTo(
      (PANE.height - 2 * FIT_MARGIN) / 6000,
      12,
    );
  });

  test("a map too big to fit stops at the floor, so the camera's arithmetic stays finite", () => {
    expect(minScale({ width: 1e12, height: 1e12 }, PANE)).toBe(SCALE_FLOOR);
  });
});

describe("fitFrame: the opening camera", () => {
  const frame = { x: 0, y: 0, width: FRAME_WIDTH, height: 900 };

  test("a frame wider than the pane fits its width with a margin, its top at the pane's top", () => {
    const scale = (PANE.width - 2 * FIT_MARGIN) / FRAME_WIDTH;
    expect(fitFrame(frame, BIG, PANE)).toEqual(near({ x: FIT_MARGIN, y: FIT_MARGIN, scale }));
  });

  test("in a wide pane the scale stays at 1 and the frame is centred across", () => {
    const pane = { width: 2000, height: 1000 };
    expect(fitFrame(frame, BIG, pane)).toEqual(
      near({
        x: (2000 - FRAME_WIDTH) / 2,
        y: FIT_MARGIN,
        scale: 1,
      }),
    );
  });

  test("a frame further in the map is fitted the same way, at its own place", () => {
    const pane = { width: 2000, height: 1000 };
    const later = { x: 2944, y: 784, width: FRAME_WIDTH, height: 720 };
    expect(fitFrame(later, BIG, pane)).toEqual(
      near({
        x: (2000 - FRAME_WIDTH) / 2 - 2944,
        y: FIT_MARGIN - 784,
        scale: 1,
      }),
    );
  });

  test("a pane narrower than four margins keeps half its width for the frame", () => {
    // The margin is at most a quarter of the pane, so a tiny pane still shows the frame.
    const pane = { width: 40, height: 40 };
    expect(fitFrame(frame, BIG, pane).scale).toBeCloseTo(
      Math.max(20 / FRAME_WIDTH, minScale(BIG, pane)),
      12,
    );
  });

  test("a pane not laid out or a broken rectangle gives a finite camera at scale 1", () => {
    const c = fitFrame(frame, BIG, { width: 0, height: 0 });
    expect(isFiniteCamera(c)).toBe(true);
    expect(c.scale).toBe(1);
    for (const v of BAD) {
      const broken = fitFrame({ x: v, y: v, width: v }, BIG, PANE);
      expect(isFiniteCamera(broken)).toBe(true);
    }
  });

  test("the result obeys the camera's limits", () => {
    const c = fitFrame(frame, { width: FRAME_WIDTH, height: 720 }, { width: 1300, height: 800 });
    expect(clamp(c, { width: FRAME_WIDTH, height: 720 }, { width: 1300, height: 800 })).toEqual(c);
  });
});

describe("fitAll", () => {
  test("the whole map is centred at the minimum scale", () => {
    const s = minScale(BIG, PANE);
    expect(fitAll(BIG, PANE)).toEqual(
      near({
        x: (PANE.width - BIG.width * s) / 2,
        y: (PANE.height - BIG.height * s) / 2,
        scale: s,
      }),
    );
  });

  test("a small map is centred at scale 1, not blown up", () => {
    expect(fitAll({ width: 400, height: 200 }, PANE)).toEqual(near({ x: 300, y: 300, scale: 1 }));
  });

  test("an empty map or a pane not laid out gives a finite camera", () => {
    expect(isFiniteCamera(fitAll({ width: 0, height: 0 }, PANE))).toBe(true);
    expect(isFiniteCamera(fitAll(BIG, { width: 0, height: 0 }))).toBe(true);
    expect(
      isFiniteCamera(fitAll({ width: Number.NaN, height: 1 }, { width: Infinity, height: -5 })),
    ).toBe(true);
  });
});

describe("clamp", () => {
  test("a camera inside the limits is left as it is", () => {
    expect(clamp(MIDDLE, BIG, PANE)).toEqual(MIDDLE);
  });

  test("the scale is held between the minimum and 2", () => {
    expect(clamp({ ...MIDDLE, scale: 5 }, BIG, PANE).scale).toBe(MAX_SCALE);
    expect(clamp({ ...MIDDLE, scale: 0.0001 }, BIG, PANE).scale).toBe(minScale(BIG, PANE));
    expect(clamp({ ...MIDDLE, scale: -3 }, BIG, PANE).scale).toBe(minScale(BIG, PANE));
  });

  test("the camera cannot leave the map: a strip of OVERLAP pixels of the map's box stays", () => {
    // Map pushed far right: its left edge stops OVERLAP px before the pane's right edge.
    expect(clamp({ x: 1e6, y: 0, scale: 1 }, BIG, PANE).x).toBe(PANE.width - OVERLAP);
    // Map pushed far up: its bottom edge stops OVERLAP px below the pane's top.
    expect(clamp({ x: 0, y: -1e6, scale: 1 }, BIG, PANE).y).toBe(OVERLAP - BIG.height);
  });

  test("a map smaller than the strip stays whole in the pane, anywhere inside it", () => {
    const tiny = { width: 30, height: 20 };
    expect(clamp({ x: 5000, y: -5000, scale: 1 }, tiny, PANE)).toEqual({ x: 970, y: 0, scale: 1 });
    expect(clamp({ x: 100, y: 200, scale: 1 }, tiny, PANE)).toEqual({ x: 100, y: 200, scale: 1 });
  });

  test("broken numbers become a finite camera inside the limits", () => {
    for (const v of BAD)
      expect(isFiniteCamera(clamp({ x: v, y: v, scale: v }, BIG, PANE))).toBe(true);
    expect(clamp({ x: Number.NaN, y: 0, scale: Number.NaN }, BIG, PANE)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  test("a pane of 0 by 0 or a map of 0 by 0 still has a finite answer", () => {
    expect(isFiniteCamera(clamp(MIDDLE, BIG, { width: 0, height: 0 }))).toBe(true);
    expect(isFiniteCamera(clamp(MIDDLE, { width: 0, height: 0 }, PANE))).toBe(true);
    expect(isFiniteCamera(clamp(MIDDLE, { width: 0, height: 0 }, { width: 0, height: 0 }))).toBe(
      true,
    );
  });
});

describe("pan", () => {
  test("the map moves by the pixels given", () => {
    expect(pan(MIDDLE, 30, -40, BIG, PANE)).toEqual({ x: -1970, y: -1540, scale: 0.5 });
  });

  test("a pan stops where the map would leave the pane", () => {
    expect(pan(MIDDLE, 1e9, 0, BIG, PANE).x).toBe(PANE.width - OVERLAP);
  });

  test("a broken delta does not move the camera", () => {
    for (const v of BAD) expect(pan(MIDDLE, v, v, BIG, PANE)).toEqual(MIDDLE);
  });
});

describe("zoomAt", () => {
  test("the map point under the pointer stays under it", () => {
    const point = { x: 300, y: 200 };
    const before = mapPoint(MIDDLE, point);
    const next = zoomAt(MIDDLE, 1.5, point, BIG, PANE);
    expect(next.scale).toBeCloseTo(0.75, 12);
    const after = mapPoint(next, point);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  test("at the maximum the scale stops and the point under the pointer still stays", () => {
    const point = { x: 300, y: 200 };
    const before = mapPoint(MIDDLE, point);
    const next = zoomAt(MIDDLE, 100, point, BIG, PANE);
    expect(next.scale).toBe(MAX_SCALE);
    expect(mapPoint(next, point).x).toBeCloseTo(before.x, 9);
    expect(mapPoint(next, point).y).toBeCloseTo(before.y, 9);
  });

  test("a broken or non-positive factor does not zoom", () => {
    for (const f of [...BAD, 0, -2])
      expect(zoomAt(MIDDLE, f, { x: 1, y: 2 }, BIG, PANE)).toEqual(MIDDLE);
  });

  test("a broken pointer zooms around the pane's centre", () => {
    const centre = { x: PANE.width / 2, y: PANE.height / 2 };
    expect(zoomAt(MIDDLE, 2, { x: Number.NaN, y: Number.POSITIVE_INFINITY }, BIG, PANE)).toEqual(
      near(zoomAt(MIDDLE, 2, centre, BIG, PANE)),
    );
  });
});

describe("wheel", () => {
  test("a plain wheel pans against the delta, as a page scrolls", () => {
    expect(wheel(MIDDLE, wheelInput({ deltaX: 10, deltaY: 20 }), BIG, PANE)).toEqual({
      x: -2010,
      y: -1520,
      scale: 0.5,
    });
  });

  test("with Shift a vertical wheel pans sideways", () => {
    expect(wheel(MIDDLE, wheelInput({ deltaY: 20, shiftKey: true }), BIG, PANE)).toEqual({
      x: -2020,
      y: -1500,
      scale: 0.5,
    });
  });

  test("a line of a line-mode wheel counts 16 px and a page one pane", () => {
    expect(wheel(MIDDLE, wheelInput({ deltaY: 3, deltaMode: 1 }), BIG, PANE).y).toBe(-1548);
    expect(wheel(MIDDLE, wheelInput({ deltaY: 1, deltaMode: 2 }), BIG, PANE).y).toBe(-2300);
  });

  test("Ctrl or Cmd zooms around the pointer by decision 127's factor", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const input = wheelInput({ deltaY: -5, x: 250, y: 600, ...mod });
      const next = wheel(MIDDLE, input, BIG, PANE);
      expect(next).toEqual(near(zoomAt(MIDDLE, Math.exp(0.05), { x: 250, y: 600 }, BIG, PANE)));
    }
  });

  test("forty small pinch events zoom by about e^0.8, not forty steps", () => {
    // Decision 127: a trackpad pinch arrives as dozens of small ctrlKey wheel events.
    let c = MIDDLE;
    for (let i = 0; i < 40; i++) c = wheel(c, wheelInput({ deltaY: -2, ctrlKey: true }), BIG, PANE);
    expect(c.scale).toBeCloseTo(MIDDLE.scale * Math.exp(0.8), 6);
  });

  test("a broken event leaves the camera where it was", () => {
    for (const v of BAD) {
      expect(wheel(MIDDLE, wheelInput({ deltaX: v, deltaY: v }), BIG, PANE)).toEqual(MIDDLE);
      expect(wheel(MIDDLE, wheelInput({ deltaY: v, ctrlKey: true }), BIG, PANE)).toEqual(MIDDLE);
    }
  });
});

describe("pinch", () => {
  const start: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 400, y: 400 },
    { x: 600, y: 400 },
  ];

  test("fingers spread to twice their distance double the scale around their midpoint", () => {
    const touches = [
      { x: 300, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    const next = pinch(MIDDLE, start, touches, BIG, PANE);
    expect(next.scale).toBeCloseTo(1, 12);
    const before = mapPoint(MIDDLE, { x: 500, y: 400 });
    expect(mapPoint(next, { x: 500, y: 400 }).x).toBeCloseTo(before.x, 9);
    expect(mapPoint(next, { x: 500, y: 400 }).y).toBeCloseTo(before.y, 9);
  });

  test("both fingers moved together pan the map with them", () => {
    const touches = [
      { x: 430, y: 380 },
      { x: 630, y: 380 },
    ] as const;
    expect(pinch(MIDDLE, start, touches, BIG, PANE)).toEqual(
      near({ x: -1970, y: -1520, scale: 0.5 }),
    );
  });

  test("fingers that started on one point only pan, since there is no distance to compare", () => {
    const same = [
      { x: 500, y: 400 },
      { x: 500, y: 400 },
    ] as const;
    const touches = [
      { x: 400, y: 400 },
      { x: 700, y: 400 },
    ] as const;
    expect(pinch(MIDDLE, same, touches, BIG, PANE)).toEqual(
      near({ x: -1950, y: -1500, scale: 0.5 }),
    );
  });

  test("a broken touch leaves the start camera", () => {
    for (const v of BAD) {
      const touches = [
        { x: v, y: 400 },
        { x: 700, y: 400 },
      ] as const;
      expect(pinch(MIDDLE, start, touches, BIG, PANE)).toEqual(MIDDLE);
    }
  });
});

describe("visibleRect", () => {
  test("the pane in map units: the top-left map point and the pane's size over the scale", () => {
    expect(visibleRect(MIDDLE, PANE)).toEqual({ x: 4000, y: 3000, width: 2000, height: 1600 });
  });

  test("a pane not laid out shows nothing; a broken camera reads as the identity", () => {
    expect(visibleRect(MIDDLE, { width: 0, height: 0 })).toEqual({
      x: 4000,
      y: 3000,
      width: 0,
      height: 0,
    });
    expect(visibleRect({ x: Number.NaN, y: 0, scale: Number.NaN }, PANE)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 800,
    });
  });
});

describe("framesNear: which frames Mermaid may draw", () => {
  // Three groups of three frames, 720 units tall each, in one column (decision 174).
  const columns = [0, 1, 2].map((c) => [0, 1, 2].map((r) => ({ id: `c${c}r${r}` })));
  const placement = placeFrames(columns, new Map());

  test("at scale 1 on the first frame, frames within one pane around it are near", () => {
    // Visible: x 0..1000, y 0..800. Grown by one pane: x -1000..2000, y -800..1600.
    // The column's frames start at y 0, 784 and 1568; the next group at 2480.
    const ids = framesNear(placement, { x: 0, y: 0, scale: 1 }, PANE);
    expect(ids).toEqual(["c0r0", "c0r1", "c0r2"]);
  });

  test("a frame further than one pane from the view is not near", () => {
    const ids = framesNear(placement, { x: 0, y: 0, scale: 1 }, PANE);
    expect(ids).not.toContain("c1r0");
    expect(ids).not.toContain("c2r0");
  });

  test("a pane not laid out shows nothing, so nothing is near", () => {
    expect(framesNear(placement, { x: 0, y: 0, scale: 1 }, { width: 0, height: 0 })).toEqual([]);
  });

  test("an empty map has no frames near", () => {
    const empty: MapPlacement = { frames: [], bounds: { width: 0, height: 0 } };
    expect(framesNear(empty, { x: 0, y: 0, scale: 1 }, PANE)).toEqual([]);
  });
});

// ---- Properties ----------------------------------------------------------

// Sizes as a layout or a resize can deliver them, broken ones included.
const length = (max: number, huge = 1e300) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.double({ min: 0, max, noNaN: true }) },
    { weight: 1, arbitrary: fc.constantFrom(0, -1, ...BAD, huge) },
  );
const size = (max: number) =>
  fc.record({ width: length(max), height: length(max) }) as fc.Arbitrary<Size>;

/**
 * The widest pane a browser lays out: Chromium holds a box's size in 1/64 px
 * steps in 32 bits, about 2^25 px, and Firefox stops lower. The pane is read
 * from `clientWidth` and `clientHeight`, so it is never wider. At 1e15 px a
 * double moves in steps of 1/8 px, too coarse to keep a strip of a thin map in
 * view; at 2^25 px the step is under 1e-8 px.
 */
const WIDEST_PANE = 2 ** 25;
const paneSize = fc.record({
  width: length(5000, WIDEST_PANE),
  height: length(5000, WIDEST_PANE),
}) as fc.Arbitrary<Size>;
const anyNumber = fc.oneof(
  { weight: 4, arbitrary: fc.double({ min: -1e5, max: 1e5, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(0, ...BAD, 1e300, -1e300) },
);
const point = fc.record({ x: anyNumber, y: anyNumber });
const op = fc.oneof(
  fc.record({ kind: fc.constant("pan" as const), dx: anyNumber, dy: anyNumber }),
  fc.record({ kind: fc.constant("zoom" as const), factor: anyNumber, at: point }),
  fc.record({
    kind: fc.constant("wheel" as const),
    input: fc.record({
      deltaX: anyNumber,
      deltaY: anyNumber,
      deltaMode: fc.constantFrom(0, 1, 2, 7),
      ctrlKey: fc.boolean(),
      metaKey: fc.boolean(),
      shiftKey: fc.boolean(),
      x: anyNumber,
      y: anyNumber,
    }),
  }),
  fc.record({
    kind: fc.constant("pinch" as const),
    from: fc.tuple(point, point),
    to: fc.tuple(point, point),
  }),
);
const start = fc.record({ x: anyNumber, y: anyNumber, scale: anyNumber });

type Op = typeof op extends fc.Arbitrary<infer T> ? T : never;

const apply = (c: Camera, o: Op, b: Size, p: Size): Camera => {
  switch (o.kind) {
    case "pan":
      return pan(c, o.dx, o.dy, b, p);
    case "zoom":
      return zoomAt(c, o.factor, o.at, b, p);
    case "wheel":
      return wheel(c, o.input, b, p);
    default:
      return pinch(c, o.from, o.to, b, p);
  }
};

/** Read a size the way the camera does: broken or negative is 0, huge is capped. */
const read = (v: number) => (Number.isFinite(v) && v > 0 ? Math.min(v, COORD_LIMIT) : 0);

const holdsLimits = (c: Camera, b: Size, p: Size) => {
  expect(isFiniteCamera(c)).toBe(true);
  const min = minScale(b, p);
  expect(min).toBeLessThanOrEqual(MAX_SCALE);
  expect(c.scale).toBeGreaterThanOrEqual(min);
  expect(c.scale).toBeLessThanOrEqual(MAX_SCALE);
  for (const [pos, mapLen, paneLen] of [
    [c.x, read(b.width), read(p.width)],
    [c.y, read(b.height), read(p.height)],
  ] as const) {
    const scaled = mapLen * c.scale;
    const overlap = Math.min(pos + scaled, paneLen) - Math.max(pos, 0);
    const need = Math.min(OVERLAP, scaled, paneLen);
    expect(overlap).toBeGreaterThanOrEqual(need - 1e-6 * Math.max(1, scaled));
  }
};

/** A zoom by `f` around `at` with no clamp at all, to tell when clamping moved the camera. */
const unclampedZoom = (c: Camera, f: number, at: { x: number; y: number }): Camera => ({
  x: at.x - (at.x - c.x) * f,
  y: at.y - (at.y - c.y) * f,
  scale: c.scale * f,
});
const same = (a: Camera, b: Camera) =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.scale - b.scale) < 1e-12;

describe("properties", () => {
  fcTest.prop([start, fc.array(op, { maxLength: 30 }), size(1e7), paneSize])(
    "after any gestures the camera is finite, its scale within the limits and a strip of the map in view",
    (c0, ops, b, p) => {
      let c = clamp(c0, b, p);
      holdsLimits(c, b, p);
      for (const o of ops) {
        c = apply(c, o, b, p);
        holdsLimits(c, b, p);
      }
    },
  );

  fcTest.prop([start, size(1e7), size(5000)])(
    "clamping twice is clamping once, so zoomAt and pan can clamp their input safely",
    (c0, b, p) => {
      const once = clamp(c0, b, p);
      expect(clamp(once, b, p)).toEqual(once);
    },
  );

  fcTest.prop([size(1e7), paneSize])(
    "the opening and the overview cameras obey the limits",
    (b, p) => {
      holdsLimits(fitAll(b, p), b, p);
      holdsLimits(fitFrame({ x: 0, y: 0, width: FRAME_WIDTH }, b, p), b, p);
    },
  );

  test("a hidden pane, 0 px tall, still gives an opening and an overview inside the limits", () => {
    const b = { width: FRAME_WIDTH, height: 720 };
    for (const p of [
      { width: 1000, height: 0 },
      { width: 0, height: 800 },
    ]) {
      for (const c of [fitAll(b, p), fitFrame({ x: 0, y: 0, width: FRAME_WIDTH }, b, p)]) {
        expect(isFiniteCamera(c)).toBe(true);
        holdsLimits(c, b, p);
      }
    }
  });

  test("a pane wider than any browser lays out still gives a finite camera", () => {
    // Past WIDEST_PANE the strip of the map can be finer than a double's step,
    // so only finiteness and the scale's range are promised there.
    for (const b of [
      { width: 1e-6, height: 0 },
      { width: FRAME_WIDTH, height: 720 },
    ]) {
      const p = { width: 1e300, height: 0 };
      for (const c of [fitAll(b, p), fitFrame({ x: 0, y: 0, width: FRAME_WIDTH }, b, p)]) {
        expect(isFiniteCamera(c)).toBe(true);
        expect(c.scale).toBeGreaterThanOrEqual(minScale(b, p));
        expect(c.scale).toBeLessThanOrEqual(MAX_SCALE);
      }
    }
  });

  // A big map in an ordinary pane, so most zooms are not clamped.
  const roomy = {
    camera: fc.record({
      x: fc.double({ min: -6000, max: 0, noNaN: true }),
      y: fc.double({ min: -6000, max: 0, noNaN: true }),
      scale: fc.double({ min: 0.2, max: 1.5, noNaN: true }),
    }),
    factor: fc.double({ min: 0.5, max: 2, noNaN: true }),
    at: fc.record({
      x: fc.double({ min: 0, max: PANE.width, noNaN: true }),
      y: fc.double({ min: 0, max: PANE.height, noNaN: true }),
    }),
  };
  fcTest.prop([roomy.camera, roomy.factor, roomy.at])(
    "zoomAt keeps the map point under the pointer when the position was not clamped",
    (c0, f, at) => {
      const c = clamp(c0, BIG, PANE);
      const next = zoomAt(c, f, at, BIG, PANE);
      const k = next.scale / c.scale;
      fc.pre(same(next, unclampedZoom(c, k, at)));
      const before = mapPoint(c, at);
      const after = mapPoint(next, at);
      expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
    },
  );

  fcTest.prop([roomy.camera, roomy.factor, roomy.at])(
    "zooming by f and back by 1/f around one point returns to the start when nothing was clamped",
    (c0, f, at) => {
      const c = clamp(c0, BIG, PANE);
      const there = zoomAt(c, f, at, BIG, PANE);
      fc.pre(same(there, unclampedZoom(c, f, at)));
      const back = zoomAt(there, 1 / f, at, BIG, PANE);
      fc.pre(same(back, unclampedZoom(there, 1 / f, at)));
      expect(same(back, c)).toBe(true);
    },
  );

  const placement = fc
    .array(
      fc.array(fc.option(fc.integer({ min: 0, max: 4000 }), { nil: undefined }), {
        minLength: 1,
        maxLength: 6,
      }),
      {
        maxLength: 8,
      },
    )
    .map((cols) => {
      let n = 0;
      const heights = new Map<string, number>();
      const columns = cols.map((col) =>
        col.map((h) => {
          const id = `f${n++}`;
          if (h !== undefined) heights.set(id, h);
          return { id };
        }),
      );
      return placeFrames(columns, heights);
    });

  fcTest.prop([placement, start, size(5000)])(
    "framesNear never misses a frame in view and lists frames in document order",
    (pl, c0, p) => {
      const c = clamp(c0, pl.bounds, p);
      const ids = framesNear(pl, c, p);
      const v = visibleRect(c, p);
      // A pane with no area shows nothing: a rectangle of no area overlaps no frame.
      const shows = v.width > 0 && v.height > 0;
      for (const f of pl.frames) {
        const inView =
          shows &&
          f.x < v.x + v.width &&
          v.x < f.x + f.width &&
          f.y < v.y + v.height &&
          v.y < f.y + f.height;
        if (inView) expect(ids).toContain(f.id);
      }
      const order = pl.frames.map((f) => f.id);
      const indices = ids.map((id) => order.indexOf(id));
      expect(indices.every((i) => i >= 0)).toBe(true);
      expect(indices).toEqual(indices.toSorted((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  fcTest.prop([start, size(1e7)])("visibleRect is finite for any camera and pane", (c, p) => {
    const v = visibleRect(c, p);
    for (const n of [v.x, v.y, v.width, v.height]) expect(Number.isFinite(n)).toBe(true);
  });
});
