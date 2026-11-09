import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { createAnnotationLayer, LASER_TRAIL_MS } from "./layer";
import { quantize, type MarkEvent } from "./mirrorTypes";
import type { SavedStroke } from "./savedMarks";
import type { AnnotationLayer } from "./types";

let layer: AnnotationLayer | null = null;

afterEach(() => {
  layer?.destroy();
  layer = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** A 400x300 slide stand-in with a button where a diagram node would be. */
function mount(): { host: HTMLElement; target: HTMLButtonElement } {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0" });
  const target = document.createElement("button");
  target.textContent = "Diagram node";
  Object.assign(target.style, { position: "absolute", left: "150px", top: "120px" });
  host.append(target);
  document.body.append(host);
  layer = createAnnotationLayer(host);
  return { host, target };
}

/** The drawing surface of the current slide; every visited slide keeps one. */
const DRAW = '.docwalk-annotate-draw[data-active="true"]';

function pointer(type: string, el: EventTarget, x: number, y: number) {
  const rect = (el instanceof Element ? el : document.body).getBoundingClientRect();
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

/** A stroke from synthetic pointer events, the same path drauu takes for mouse, touch and stylus. */
function stroke(host: HTMLElement, from: [number, number], to: [number, number]) {
  const svg = host.querySelector(DRAW) as SVGSVGElement;
  pointer("pointerdown", svg, ...from);
  for (let i = 1; i <= 8; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / 8;
    const y = from[1] + ((to[1] - from[1]) * i) / 8;
    pointer("pointermove", svg, x, y);
  }
  pointer("pointerup", svg, ...to);
}

const marks = (host: HTMLElement) => (host.querySelector(DRAW) as SVGSVGElement).children.length;

function centre(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

describe("annotation layer (decision 29)", () => {
  test("mode off lets clicks reach the slide, so diagrams stay explorable between drawings", () => {
    const { target } = mount();
    const clicked = vi.fn<() => void>();
    target.addEventListener("click", clicked);

    expect(document.elementFromPoint(...centre(target))).toBe(target);
    target.click();
    expect(clicked).toHaveBeenCalledOnce();

    // The same point is covered while a tool is active, so the check above can fail.
    layer!.setMode("pen");
    expect(document.elementFromPoint(...centre(target))).not.toBe(target);
    layer!.setMode("off");
    expect(document.elementFromPoint(...centre(target))).toBe(target);
  });

  test("a pen stroke from pointer events leaves an SVG mark over the slide", () => {
    const { host } = mount();
    layer!.setColor("currentColor");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    const path = host.querySelector(`${DRAW} path`);
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")?.length ?? 0).toBeGreaterThan(10);
  });

  test("before any setColor the pen draws in the accent, not the host's text colour", () => {
    // On the dark stage the host's text colour is light, so currentColor ink would vanish on a white slide.
    const { host } = mount();
    host.style.color = "white";
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    const fill = host.querySelector(`${DRAW} path`)!.getAttribute("fill");
    expect(fill).toBe(getComputedStyle(host).getPropertyValue("--dw-color-primary").trim());
    expect(fill).not.toBe("");
  });

  test("the arrow tool draws a line with an arrowhead, so a presenter can point at a node", () => {
    const { host } = mount();
    layer!.setMode("arrow");
    stroke(host, [20, 20], [200, 120]);
    const line = host.querySelector(`${DRAW} line`);
    expect(line?.getAttribute("marker-end")).toMatch(/^url\(/);
  });

  test("each slide keeps its own marks: switching slides hides them and coming back restores them", () => {
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);

    layer!.setKey("design/1");
    expect(marks(host)).toBe(0);
    stroke(host, [30, 200], [300, 200]);
    stroke(host, [30, 250], [300, 250]);
    expect(marks(host)).toBe(2);

    layer!.setKey("intro/1");
    expect(marks(host)).toBe(1);
    layer!.setKey("design/1");
    expect(marks(host)).toBe(2);
  });

  test("undo history survives a slide switch, so a presenter can undo a mark after coming back to its slide", () => {
    // Presenters often step ahead and back while talking. Saving and reloading
    // the drawing on each switch used to drop the undo stack: the marks came
    // back, but undo did nothing.
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    stroke(host, [20, 200], [200, 220]);

    layer!.setKey("design/1");
    stroke(host, [30, 250], [300, 250]);
    layer!.setKey("intro/1");
    expect(marks(host)).toBe(2);

    layer!.undo();
    expect(marks(host)).toBe(1);
    layer!.redo();
    expect(marks(host)).toBe(2);
    // Undo on one slide never reaches into another slide's marks.
    layer!.undo();
    layer!.undo();
    layer!.undo();
    expect(marks(host)).toBe(0);
    layer!.setKey("design/1");
    expect(marks(host)).toBe(1);
  });

  test("only the current slide's marks are visible, and only its surface takes the pen", () => {
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    layer!.setKey("design/1");
    const surfaces = [...host.querySelectorAll<SVGSVGElement>(".docwalk-annotate-draw")];
    expect(surfaces).toHaveLength(2);
    expect(surfaces.map((s) => getComputedStyle(s).display)).toEqual(["none", "block"]);
    // A colour or tool chosen on one slide is the one used on the next.
    layer!.setColor("rgb(1, 2, 3)");
    layer!.setKey("intro/1");
    stroke(host, [20, 200], [200, 220]);
    expect(host.querySelector(`${DRAW} path:last-child`)?.getAttribute("fill")).toBe(
      "rgb(1, 2, 3)",
    );
  });

  test("undo removes the last mark, redo brings it back, clear empties the slide", () => {
    const { host } = mount();
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    stroke(host, [20, 200], [200, 220]);
    expect(marks(host)).toBe(2);

    layer!.undo();
    expect(marks(host)).toBe(1);
    layer!.redo();
    expect(marks(host)).toBe(2);
    layer!.clear();
    expect(marks(host)).toBe(0);
  });

  test("the eraser removes a mark it crosses", () => {
    const { host } = mount();
    layer!.setMode("pen");
    stroke(host, [50, 150], [350, 150]);
    expect(marks(host)).toBe(1);
    layer!.setMode("eraser");
    stroke(host, [200, 50], [200, 250]);
    expect(marks(host)).toBe(0);
  });

  test("the laser trail removes itself shortly after the pointer stops, leaving the slide clean", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const { host } = mount();
    layer!.setMode("laser");
    const laser = host.querySelector(".docwalk-annotate-laser") as SVGSVGElement;
    for (let i = 0; i < 10; i++) pointer("pointermove", laser, 40 + i * 20, 100);

    await expect.poll(() => laser.querySelector("path")).not.toBeNull();
    // Laser marks are never committed to the drawing.
    expect(marks(host)).toBe(0);
    await expect.poll(() => laser.childElementCount, { timeout: LASER_TRAIL_MS + 1000 }).toBe(0);
  });

  test("under reduced motion the laser has no trail and vanishes at once when the pointer lifts", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { host } = mount();
    layer!.setMode("laser");
    const laser = host.querySelector(".docwalk-annotate-laser") as SVGSVGElement;
    pointer("pointerdown", laser, 100, 100);
    pointer("pointermove", laser, 120, 100);
    expect(laser.querySelector("circle")).not.toBeNull();
    expect(laser.querySelector("path")).toBeNull();
    pointer("pointerup", laser, 120, 100);
    expect(laser.childElementCount).toBe(0);
  });

  test("moveTo carries every slide's marks and undo history to a rebuilt stage", () => {
    // An agent write, a file reloaded from disk or a language switch rebuilds
    // the deck mid-talk, and the new deck has a new stage element. The
    // presenter's marks used to vanish with the old one.
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    layer!.setKey("design/1");
    stroke(host, [30, 200], [300, 200]);

    const rebuilt = document.createElement("div");
    Object.assign(rebuilt.style, { width: "400px", height: "300px" });
    document.body.append(rebuilt);
    layer!.moveTo(rebuilt);
    expect(host.querySelector(".docwalk-annotate")).toBeNull();
    expect(host.style.position).toBe("");
    expect(rebuilt.style.position).toBe("relative");
    expect(marks(rebuilt)).toBe(1);
    layer!.setKey("intro/1");
    expect(marks(rebuilt)).toBe(1);
    // The pen still draws on the new stage, and undo still reaches the old mark.
    stroke(rebuilt, [20, 200], [200, 220]);
    expect(marks(rebuilt)).toBe(2);
    layer!.undo();
    layer!.undo();
    expect(marks(rebuilt)).toBe(0);
  });

  test("retain drops the marks of slides that are gone, keeping the others and the current one", () => {
    // A mark drawn over text that has since changed points at the wrong thing,
    // so a rebuild keeps marks only for slides it still has.
    const { host } = mount();
    layer!.setMode("pen");
    for (const key of ["intro/1", "design/1", "risks/1"]) {
      layer!.setKey(key);
      stroke(host, [20, 20], [200, 120]);
    }
    layer!.retain(["intro/1"]);
    expect(marks(host)).toBe(1); // "risks/1" is current, so it stays until the slide changes
    layer!.setKey("design/1");
    expect(marks(host)).toBe(0);
    layer!.setKey("intro/1");
    expect(marks(host)).toBe(1);
    expect(host.querySelectorAll(".docwalk-annotate-draw").length).toBe(3);
  });

  test("destroy removes the overlay and restores the host, so remounting the deck leaves nothing behind", () => {
    const { host } = mount();
    expect(host.style.position).toBe("relative");
    layer!.destroy();
    layer = null;
    expect(host.querySelector(".docwalk-annotate")).toBeNull();
    expect(host.style.position).toBe("");
  });
});

describe("what the layer reports to the mirror (decision 88)", () => {
  /** Observes the layer on a slide `a/1` and collects what it reports. */
  function observed() {
    const result = mount();
    const events: MarkEvent[] = [];
    layer!.observe((event) => events.push(event));
    layer!.setKey("a/1#abc", "a/1");
    events.length = 0;
    return { ...result, events };
  }
  const ends = (events: MarkEvent[]) =>
    events.flatMap((e) => (e.kind === "stroke" && e.end ? [e] : []));
  const lastMarks = (events: MarkEvent[]) =>
    events.flatMap((e) => (e.kind === "marks" ? [e] : [])).at(-1);

  test("a pen stroke is reported in slide units, from where it began to where it was released", () => {
    // The 400 by 300 stand-in is a slide here: (40, 30) is a tenth of each way.
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    const [done] = ends(events);
    expect(done).toMatchObject({ slide: "a/1", tool: "pen", color: "primary", end: true });
    const points = done!.points;
    expect(points.length).toBeGreaterThanOrEqual(10);
    expect(points.length % 2).toBe(0);
    expect(Math.abs(points[0]! - quantize(0.1))).toBeLessThanOrEqual(2);
    expect(Math.abs(points[1]! - quantize(0.1))).toBeLessThanOrEqual(2);
    expect(Math.abs(points.at(-2)! - quantize(0.9))).toBeLessThanOrEqual(2);
    expect(Math.abs(points.at(-1)! - quantize(0.9))).toBeLessThanOrEqual(2);
  });

  test("the stroke grows in the open while it is drawn, so a follower sees it as it goes", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    const growing = events.flatMap((e) => (e.kind === "stroke" && !e.end ? [e] : []));
    expect(growing.length).toBeGreaterThan(3);
    // One stroke, one id, from first point to last.
    expect(new Set(events.flatMap((e) => (e.kind === "stroke" ? [e.id] : []))).size).toBe(1);
  });

  test("a point within 2 slide px of the last is not recorded, so a slow hand does not flood the wire", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    const svg = host.querySelector(DRAW) as SVGSVGElement;
    pointer("pointerdown", svg, 100, 100);
    // 0.05 css px steps on a 400 px slide are 0.16 slide px: far below the 2 px rule.
    for (let i = 1; i <= 40; i++) pointer("pointermove", svg, 100 + i * 0.05, 100);
    pointer("pointerup", svg, 102, 100);
    const [done] = ends(events);
    expect(done!.points.length / 2).toBeLessThan(8);
  });

  test("the colour key travels, never the colour", () => {
    const { host, events } = observed();
    layer!.setColor("rgb(1, 2, 3)", "ink");
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    expect(ends(events)[0]).toMatchObject({ color: "ink" });
    expect(JSON.stringify(events)).not.toContain("rgb(");
  });

  test("an arrow is reported once, on release, with the line the drawing shows", () => {
    const { host, events } = observed();
    layer!.setMode("arrow");
    stroke(host, [40, 30], [360, 270]);
    const strokes = events.flatMap((e) => (e.kind === "stroke" ? [e] : []));
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ tool: "arrow", end: true });
    expect(strokes[0]!.points).toHaveLength(4);
    expect(Math.abs(strokes[0]!.points[0]! - quantize(0.1))).toBeLessThanOrEqual(2);
    expect(Math.abs(strokes[0]!.points[3]! - quantize(0.9))).toBeLessThanOrEqual(2);
  });

  test("an arrow too short to draw is not reported as a mark", () => {
    const { host, events } = observed();
    layer!.setMode("arrow");
    stroke(host, [40, 30], [41, 31]);
    expect(ends(events)).toEqual([]);
    expect(lastMarks(events)?.strokes ?? []).toEqual([]);
  });

  test("undo, redo and clear report the marks that are visible after them", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    stroke(host, [40, 270], [360, 30]);
    expect(lastMarks(events)?.strokes).toHaveLength(2);
    layer!.undo();
    expect(lastMarks(events)).toMatchObject({ slide: "a/1", reset: false });
    expect(lastMarks(events)?.strokes).toHaveLength(1);
    layer!.redo();
    expect(lastMarks(events)?.strokes).toHaveLength(2);
    layer!.clear();
    expect(lastMarks(events)?.strokes).toHaveLength(0);
  });

  test("a redone stroke is the same stroke: same id, same points", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    const before = lastMarks(events)!.strokes[0]!;
    layer!.undo();
    layer!.redo();
    const after = lastMarks(events)!.strokes[0]!;
    expect(after.id).toBe(before.id);
    expect(after.points).toEqual(before.points);
  });

  test("the eraser reports what is left", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 150], [360, 150]);
    expect(lastMarks(events)?.strokes).toHaveLength(1);
    layer!.setMode("eraser");
    stroke(host, [200, 40], [200, 260]);
    expect(lastMarks(events)?.strokes).toHaveLength(0);
  });

  test("a change of slide reports that slide's marks with reset, so a receiver is brought up to date", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    layer!.setKey("b/1#def", "b/1");
    expect(lastMarks(events)).toMatchObject({ slide: "b/1", strokes: [], reset: true });
    layer!.setKey("a/1#abc", "a/1");
    expect(lastMarks(events)).toMatchObject({ slide: "a/1", reset: true });
    expect(lastMarks(events)?.strokes).toHaveLength(1);
  });

  test("a stroke cut short by a change of slide is cancelled, not left half drawn on the receivers", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    const svg = host.querySelector(DRAW) as SVGSVGElement;
    pointer("pointerdown", svg, 40, 30);
    pointer("pointermove", svg, 100, 80);
    layer!.setKey("b/1#def", "b/1");
    expect(events.some((e) => e.kind === "cancel")).toBe(true);
    expect(ends(events)).toEqual([]);
  });

  test("marks dropped by a rebuild are reported for their slide, but not for the slide on screen", () => {
    const { host, events } = observed();
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    layer!.setKey("b/1#def", "b/1");
    events.length = 0;
    layer!.retain(["b/1#def"]);
    expect(events).toEqual([{ kind: "marks", slide: "a/1", strokes: [], reset: false }]);
  });

  test("the laser is reported in slide units and ends when the pointer leaves", () => {
    const { host, events } = observed();
    layer!.setMode("laser");
    const surface = host.querySelector(".docwalk-annotate-laser") as SVGSVGElement;
    pointer("pointermove", surface, 100, 225);
    const points = events.flatMap((e) => (e.kind === "laser" ? [e] : []));
    expect(points).toHaveLength(1);
    expect(points[0]!.x).toBeCloseTo(0.25, 2);
    expect(points[0]!.y).toBeCloseTo(0.75, 2);
    pointer("pointerleave", surface, 100, 225);
    expect(events.at(-1)).toEqual({ kind: "laser-off" });
  });

  test("an observer that stops listening hears nothing more", () => {
    const { host } = mount();
    const heard: MarkEvent[] = [];
    const stop = layer!.observe((event) => heard.push(event));
    layer!.setKey("a/1#abc", "a/1");
    stop();
    heard.length = 0;
    layer!.setMode("pen");
    stroke(host, [40, 30], [360, 270]);
    expect(heard).toEqual([]);
  });
});

/** Observes the layer on a slide `a/1` and collects what it reports. */
function observeShapes(options?: Parameters<typeof createAnnotationLayer>[1]) {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0" });
  document.body.append(host);
  layer = createAnnotationLayer(host, options);
  const events: MarkEvent[] = [];
  layer.observe((event) => events.push(event));
  layer.setKey("a/1#abc", "a/1");
  events.length = 0;
  return { host, events };
}
const shapeEnds = (events: MarkEvent[]) =>
  events.flatMap((e) => (e.kind === "stroke" && e.end ? [e] : []));
const lastShapeMarks = (events: MarkEvent[]) =>
  events.flatMap((e) => (e.kind === "marks" ? [e] : [])).at(-1);
const key = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, init));
/** The grid number of a pixel along the 400 by 300 slide stand-in. */
const gx = (px: number) => quantize(px / 400);
const gy = (px: number) => quantize(px / 300);
const near = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((n, i) => expect(Math.abs(n - expected[i]!)).toBeLessThanOrEqual(2));
};

describe("rectangles and ellipses (decision 110)", () => {
  test("a rectangle dragged bottom-right to top-left reports the same four numbers as the opposite drag", () => {
    // The corners are the box, not the drag: a receiver draws the same rectangle either way.
    const { host, events } = observeShapes();
    layer!.setMode("rect");
    stroke(host, [40, 30], [360, 270]);
    stroke(host, [360, 270], [40, 30]);
    const [forward, backward] = shapeEnds(events);
    expect(forward).toMatchObject({ slide: "a/1", tool: "rect", color: "primary", end: true });
    near(forward!.points, [gx(40), gy(30), gx(360), gy(270)]);
    expect(backward).toMatchObject({ tool: "rect" });
    expect(backward!.points).toEqual(forward!.points);
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(2);
  });

  test("an ellipse is reported as the corners of its box", () => {
    const { host, events } = observeShapes();
    layer!.setMode("ellipse");
    stroke(host, [360, 270], [40, 30]);
    const [done] = shapeEnds(events);
    expect(done).toMatchObject({ tool: "ellipse", end: true });
    near(done!.points, [gx(40), gy(30), gx(360), gy(270)]);
    const ellipse = host.querySelector(`${DRAW} ellipse`)!;
    expect(Number(ellipse.getAttribute("rx"))).toBeCloseTo(160, 0);
    expect(Number(ellipse.getAttribute("ry"))).toBeCloseTo(120, 0);
  });

  test.each(["rect", "ellipse"] as const)(
    "the %s tool covers the slide to take the drag, and mode off gives it back",
    (tool) => {
      // Without the CSS rule the drag would reach the slide's own elements.
      const { host } = observeShapes();
      const target = document.createElement("button");
      target.textContent = "Under the marks";
      Object.assign(target.style, { position: "absolute", left: "150px", top: "120px" });
      host.append(target);
      expect(document.elementFromPoint(...centre(target))).toBe(target);
      layer!.setMode(tool);
      expect(document.elementFromPoint(...centre(target))).toBe(host.querySelector(DRAW));
      expect(getComputedStyle(host.querySelector(DRAW)!).touchAction).toBe("none");
      layer!.setMode("off");
      expect(document.elementFromPoint(...centre(target))).toBe(target);
    },
  );

  test("a shape is one stroke on release: nothing goes out while it is dragged", () => {
    const { host, events } = observeShapes();
    layer!.setMode("rect");
    stroke(host, [40, 30], [360, 270]);
    const strokes = events.flatMap((e) => (e.kind === "stroke" ? [e] : []));
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ end: true });
  });

  test("Shift gives equal sides, in both shapes", () => {
    const { host, events } = observeShapes();
    key("keydown", { key: "Shift", shiftKey: true });
    layer!.setMode("rect");
    stroke(host, [40, 30], [360, 100]);
    layer!.setMode("ellipse");
    stroke(host, [40, 150], [360, 220]);
    key("keyup", { key: "Shift", shiftKey: false });
    const [rect, ellipse] = shapeEnds(events);
    expect(rect).toBeDefined();
    expect(ellipse).toBeDefined();
    // The shorter side, 70 px, rules both.
    near(rect!.points, [gx(40), gy(30), gx(110), gy(100)]);
    near(ellipse!.points, [gx(40), gy(150), gx(110), gy(220)]);
  });

  test("a click without movement reports no shape and leaves no mark", () => {
    const { host, events } = observeShapes();
    layer!.setMode("rect");
    const svg = host.querySelector(DRAW) as SVGSVGElement;
    pointer("pointerdown", svg, 100, 100);
    pointer("pointerup", svg, 100, 100);
    layer!.setMode("ellipse");
    pointer("pointerdown", svg, 100, 100);
    pointer("pointerup", svg, 100, 100);
    expect(shapeEnds(events)).toEqual([]);
    expect(marks(host)).toBe(0);
    expect(lastShapeMarks(events)?.strokes ?? []).toEqual([]);
  });

  test("the eraser across a rectangle's edge removes it and reports what is left", () => {
    const { host, events } = observeShapes();
    layer!.setMode("rect");
    stroke(host, [100, 80], [300, 220]);
    stroke(host, [40, 250], [120, 290]);
    expect(lastShapeMarks(events)?.strokes).toHaveLength(2);
    layer!.setMode("eraser");
    // A vertical swipe through the first rectangle's top edge, clear of the second.
    stroke(host, [200, 40], [200, 120]);
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(1);
    expect(lastShapeMarks(events)?.strokes).toHaveLength(1);
    expect(lastShapeMarks(events)?.strokes[0]).toMatchObject({ tool: "rect" });
  });

  test("the eraser reaches an ellipse too", () => {
    const { host, events } = observeShapes();
    layer!.setMode("ellipse");
    stroke(host, [100, 80], [300, 220]);
    layer!.setMode("eraser");
    stroke(host, [200, 40], [200, 120]);
    expect(host.querySelectorAll(`${DRAW} ellipse`)).toHaveLength(0);
    expect(lastShapeMarks(events)?.strokes).toHaveLength(0);
  });

  test("undo and redo take a shape away and bring back the same stroke", () => {
    const { host, events } = observeShapes();
    layer!.setMode("rect");
    stroke(host, [40, 30], [360, 270]);
    const before = lastShapeMarks(events)!.strokes[0]!;
    layer!.undo();
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(0);
    expect(lastShapeMarks(events)?.strokes).toHaveLength(0);
    layer!.redo();
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(1);
    expect(lastShapeMarks(events)?.strokes[0]).toEqual(before);
  });

  test("a saved rectangle comes back as a <rect> that the eraser reaches and undo leaves alone", () => {
    const saved = [{ tool: "rect", color: "ink", points: [1024, 1024, 3072, 3072] }] as const;
    const { host, events } = observeShapes({ saved: () => saved });
    const rect = host.querySelector(`${DRAW} rect`)!;
    expect(rect).not.toBeNull();
    expect(Number(rect.getAttribute("x"))).toBeCloseTo(100, 0);
    expect(Number(rect.getAttribute("width"))).toBeCloseTo(200, 0);
    expect(rect.getAttribute("fill")).toBe("none");
    expect(rect.getAttribute("stroke")).toBe(
      getComputedStyle(host).getPropertyValue("--dw-color-ink").trim(),
    );
    layer!.undo();
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(1);
    layer!.setMode("eraser");
    stroke(host, [200, 20], [200, 110]);
    expect(host.querySelectorAll(`${DRAW} rect`)).toHaveLength(0);
    expect(lastShapeMarks(events)?.strokes).toHaveLength(0);
  });
});

/**
 * The deck's DOM as the layer sees it: a control before the stage, a
 * `.reveal > .slides` host with two pages that fill it, and a control after.
 * The first page holds a link and is the current one, as in reveal.js.
 */
function deckHost() {
  const before = document.createElement("button");
  before.textContent = "before";
  const reveal = document.createElement("div");
  reveal.className = "reveal";
  reveal.tabIndex = 0;
  const host = document.createElement("div");
  host.className = "slides";
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0", position: "relative" });
  host.innerHTML = `
    <section class="present" style="position:absolute;inset:0"><a href="#x">page link</a></section>
    <section inert style="position:absolute;inset:0"><a href="#y">hidden link</a></section>`;
  reveal.append(host);
  const after = document.createElement("button");
  after.textContent = "after";
  document.body.append(before, reveal, after);
  const page = host.querySelector("section.present") as HTMLElement;
  return { before, after, reveal, host, page };
}

const BOARD = { key: "a/board#0", address: "a/board" } as const;

function openBoardDeck(options?: Parameters<typeof createAnnotationLayer>[1]) {
  const dom = deckHost();
  layer = createAnnotationLayer(dom.host, options);
  const events: MarkEvent[] = [];
  layer.observe((event) => events.push(event));
  layer.setKey("a/1#abc", "a/1");
  events.length = 0;
  return { ...dom, events };
}
const boardPaper = (host: HTMLElement) =>
  host.querySelector(".docwalk-annotate-board") as HTMLElement;
/** The kinds heard, without the laser-off a change of slide always sends. */
const heardKinds = (events: MarkEvent[]) =>
  events.map((e) => e.kind).filter((kind) => kind !== "laser-off");

describe("the whiteboard (decision 110)", () => {
  test("with the board open the slide's centre is the paper or a draw surface, never the page", () => {
    const { host, page } = openBoardDeck();
    const point = centre(page);
    expect(document.elementFromPoint(...point)).toBe(page);
    layer!.setBoard(BOARD);
    expect(layer!.board()).toBe("a/board");
    const hit = document.elementFromPoint(...point)!;
    expect(hit).toBe(boardPaper(host));
    layer!.setMode("pen");
    expect(document.elementFromPoint(...point)).toBe(host.querySelector(DRAW));
    expect(page.contains(document.elementFromPoint(...point))).toBe(false);
  });

  test("the paper is the slide's colour, and gone once the board closes", () => {
    const { host, page } = openBoardDeck();
    layer!.setBoard(BOARD);
    const probe = document.createElement("span");
    probe.style.color = "var(--dw-color-slide)";
    document.body.append(probe);
    expect(getComputedStyle(boardPaper(host)).backgroundColor).toBe(getComputedStyle(probe).color);
    layer!.setBoard(null);
    expect(layer!.board()).toBeNull();
    expect(document.elementFromPoint(...centre(page))).toBe(page);
  });

  test("a stroke on the board is gone from view after close and back on reopen", () => {
    const { host } = openBoardDeck();
    layer!.setBoard(BOARD);
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);
    layer!.setBoard(null);
    expect(marks(host)).toBe(0);
    layer!.setBoard(BOARD);
    expect(marks(host)).toBe(1);
  });

  test("the slide's marks are back after close, and undo on the board leaves the slide's history alone", () => {
    const { host } = openBoardDeck();
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);
    layer!.setBoard(BOARD);
    expect(marks(host)).toBe(0);
    stroke(host, [30, 200], [300, 200]);
    layer!.undo();
    expect(marks(host)).toBe(0);
    // Nothing left to undo on the board: this must not reach the slide's stroke.
    layer!.undo();
    layer!.setBoard(null);
    expect(marks(host)).toBe(1);
    layer!.undo();
    expect(marks(host)).toBe(0);
  });

  test("opening reports the board over the page, then the board's marks as a reset; closing reports null, then the slide's marks", () => {
    const { host, events } = openBoardDeck();
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    events.length = 0;
    layer!.setBoard(BOARD);
    expect(events).toEqual([
      { kind: "board", slide: "a/1" },
      { kind: "marks", slide: "a/board", strokes: [], reset: true },
    ]);
    events.length = 0;
    stroke(host, [30, 200], [300, 200]);
    const done = events.flatMap((e) => (e.kind === "stroke" && e.end ? [e] : []));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ slide: "a/board", tool: "pen" });
    events.length = 0;
    layer!.setBoard(null);
    expect(heardKinds(events)).toEqual(["board", "marks"]);
    expect(events[0]).toEqual({ kind: "board", slide: null });
    expect(events[1]).toMatchObject({ kind: "marks", slide: "a/1", reset: true });
    expect((events[1] as Extract<MarkEvent, { kind: "marks" }>).strokes).toHaveLength(1);
  });

  test("a board's shapes are four numbers under the board's address", () => {
    const { host, events } = openBoardDeck();
    layer!.setBoard(BOARD);
    layer!.setMode("rect");
    events.length = 0;
    stroke(host, [40, 30], [360, 270]);
    const done = events.flatMap((e) => (e.kind === "stroke" && e.end ? [e] : []));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ slide: "a/board", tool: "rect" });
    expect(done[0]!.points).toHaveLength(4);
  });

  test("a setKey to another address closes the board first and reports null", () => {
    const { host, events, page } = openBoardDeck();
    layer!.setBoard(BOARD);
    events.length = 0;
    layer!.setKey("b/1#def", "b/1");
    expect(layer!.board()).toBeNull();
    expect(heardKinds(events)).toEqual(["board", "marks"]);
    expect(events[0]).toEqual({ kind: "board", slide: null });
    expect(events.find((e) => e.kind === "marks")).toMatchObject({ slide: "b/1", reset: true });
    // No reset for the old slide in between: the receiver goes from the board to the new slide.
    expect(events.filter((e) => e.kind === "marks")).toHaveLength(1);
    expect(host.querySelector(".docwalk-annotate")?.hasAttribute("data-board")).toBe(false);
    expect(page.inert).toBe(false);
  });

  test("a setKey with the same address and a new key leaves the board open and says nothing", () => {
    // A rebuild while typing in the editor changes the key, not the page.
    const { host, events } = openBoardDeck();
    layer!.setBoard(BOARD);
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    events.length = 0;
    layer!.setKey("a/1#new", "a/1");
    expect(layer!.board()).toBe("a/board");
    expect(heardKinds(events)).toEqual([]);
    expect(marks(host)).toBe(1);
    // The slide under the board is the new key's, empty.
    layer!.setBoard(null);
    expect(marks(host)).toBe(0);
  });

  test("Tab cannot reach a link on the covered page, and focus inside it goes to .reveal", async () => {
    const { before, after, page, reveal } = openBoardDeck();
    page.querySelector("a")!.focus();
    layer!.setBoard(BOARD);
    expect(document.activeElement).toBe(reveal);
    before.focus();
    const visited: Element[] = [];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      visited.push(document.activeElement!);
    }
    expect(visited.some((el) => page.contains(el))).toBe(false);
    expect(visited).toContain(after);
    layer!.setBoard(null);
    expect(page.inert).toBe(false);
  });

  test("a board's saved marks are asked for by its key and address on the first open only", () => {
    const saved = vi.fn<(key: string, address: string) => SavedStroke[]>((savedKey) =>
      savedKey === BOARD.key
        ? [{ tool: "ellipse", color: "ink", points: [1024, 1024, 3072, 3072] }]
        : [],
    );
    const { host } = openBoardDeck({ saved });
    expect(saved).toHaveBeenCalledWith("a/1#abc", "a/1");
    layer!.setBoard(BOARD);
    expect(saved).toHaveBeenCalledWith(BOARD.key, BOARD.address);
    expect(host.querySelectorAll(`${DRAW} ellipse`)).toHaveLength(1);
    layer!.setBoard(null);
    layer!.setBoard(BOARD);
    expect(saved.mock.calls.filter(([calledKey]) => calledKey === BOARD.key)).toHaveLength(1);
    expect(host.querySelectorAll(`${DRAW} ellipse`)).toHaveLength(1);
  });

  test("retain keeps both the slide's and the open board's marks", () => {
    const { host } = openBoardDeck();
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    layer!.setBoard(BOARD);
    stroke(host, [30, 200], [300, 200]);
    layer!.retain([]);
    expect(marks(host)).toBe(1);
    layer!.setBoard(null);
    expect(marks(host)).toBe(1);
  });

  test("moveTo covers the new stage's current page and uncovers the old one; destroy uncovers", () => {
    const { page, host } = openBoardDeck();
    layer!.setBoard(BOARD);
    expect(page.inert).toBe(true);
    document.body.replaceChildren();
    const next = deckHost();
    layer!.moveTo(next.host);
    expect(next.page.inert).toBe(true);
    expect(page.inert).toBe(false);
    expect(host.querySelector(".docwalk-annotate")).toBeNull();
    layer!.destroy();
    layer = null;
    expect(next.page.inert).toBe(false);
  });

  test("a stroke cut short by closing the board is cancelled, not left half drawn on the receivers", () => {
    const { host, events } = openBoardDeck();
    layer!.setBoard(BOARD);
    layer!.setMode("pen");
    const svg = host.querySelector(DRAW) as SVGSVGElement;
    pointer("pointerdown", svg, 40, 30);
    pointer("pointermove", svg, 100, 80);
    events.length = 0;
    layer!.setBoard(null);
    expect(events.some((e) => e.kind === "cancel")).toBe(true);
    expect(events.some((e) => e.kind === "stroke" && e.end)).toBe(false);
  });

  test("setBoard before the first key does nothing", () => {
    const dom = deckHost();
    layer = createAnnotationLayer(dom.host);
    layer.setBoard(BOARD);
    expect(layer.board()).toBeNull();
    expect(dom.page.inert).toBe(false);
  });
});

/** The two things the layer asks of the stylus module, held by the test. */
function stylus(initial: { draws?: boolean; pen?: boolean } = {}) {
  const state = { draws: initial.draws ?? true, pen: initial.pen ?? false };
  const listeners = new Set<() => void>();
  return {
    state,
    input: {
      stylusDraws: () => state.draws,
      penInUse: () => state.pen,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    /** A change of the setting or of the latch, as the stylus module announces it. */
    change: (next: Partial<typeof state>) => {
      Object.assign(state, next);
      for (const listener of listeners) listener();
    },
  };
}

/** One pointer's down, moves and up, aimed at `target` (the slide, or a surface). */
function drag(
  target: Element,
  type: "mouse" | "pen" | "touch",
  from: [number, number],
  to: [number, number],
  { steps = 8, id = 7 }: { steps?: number; id?: number } = {},
) {
  const rect = target.getBoundingClientRect();
  const at = (name: string, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent(name, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: type,
        isPrimary: true,
        button: 0,
        buttons: name === "pointerup" ? 0 : 1,
        pressure: 0.5,
        clientX: rect.left + x,
        clientY: rect.top + y,
      }),
    );
  at("pointerdown", ...from);
  for (let i = 1; i <= steps; i++) {
    at(
      "pointermove",
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    );
  }
  at("pointerup", ...to);
}

const strokes = (events: MarkEvent[]) =>
  events.flatMap((e) => (e.kind === "stroke" && e.end ? [e] : []));

function mountStylus(initial?: { draws?: boolean; pen?: boolean }) {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0" });
  document.body.append(host);
  const held = stylus(initial);
  layer = createAnnotationLayer(host, { input: held.input });
  const events: MarkEvent[] = [];
  layer.observe((event) => events.push(event));
  layer.setKey("a/1#abc", "a/1");
  events.length = 0;
  return { host, events, ...held };
}

describe("stylus input (decision 110)", () => {
  test("with no tool a pen drag past 4 px draws a pen stroke from where it went down", () => {
    const { host, events } = mountStylus();
    drag(host, "pen", [40, 30], [360, 270]);
    const [done] = strokes(events);
    expect(done).toMatchObject({ slide: "a/1", tool: "pen", color: "primary", end: true });
    // The stroke starts at the pen-down point (a tenth of each way), not 4 px along.
    expect(Math.abs(done!.points[0]! - quantize(0.1))).toBeLessThanOrEqual(2);
    expect(Math.abs(done!.points[1]! - quantize(0.1))).toBeLessThanOrEqual(2);
    expect(marks(host)).toBe(1);
    expect(layer!.mode()).toBe("off");
  });

  test("a pen tap, a mouse drag and a touch drag with no tool draw nothing", () => {
    const { host, events } = mountStylus();
    drag(host, "pen", [40, 30], [42, 31], { steps: 2 });
    drag(host, "mouse", [40, 30], [360, 270]);
    drag(host, "touch", [40, 30], [360, 270]);
    expect(strokes(events)).toEqual([]);
    expect(marks(host)).toBe(0);
  });

  test("a mouse drag right after a pen drag still draws nothing: the pen's stroke is over", () => {
    const { host, events } = mountStylus();
    drag(host, "pen", [40, 30], [200, 150]);
    drag(host, "mouse", [40, 200], [300, 200], { id: 1 });
    expect(strokes(events)).toHaveLength(1);
    expect(marks(host)).toBe(1);
  });

  test("with the setting off a pen acts as a mouse: a drag in mode off draws nothing", () => {
    const { host, events } = mountStylus({ draws: false });
    drag(host, "pen", [40, 30], [360, 270]);
    expect(strokes(events)).toEqual([]);
    expect(marks(host)).toBe(0);
  });

  test("turning the setting off while mounted stops the pen drag, and on again brings it back", () => {
    const { host, events, change } = mountStylus();
    change({ draws: false });
    drag(host, "pen", [40, 30], [360, 270]);
    expect(strokes(events)).toEqual([]);
    change({ draws: true });
    drag(host, "pen", [40, 30], [360, 270]);
    expect(strokes(events)).toHaveLength(1);
  });

  test("with a tool chosen the pen uses that tool, once", () => {
    const { host, events } = mountStylus();
    layer!.setMode("arrow");
    drag(host.querySelector(DRAW)!, "pen", [40, 30], [360, 270]);
    const done = strokes(events);
    expect(done.map((s) => s.tool)).toEqual(["arrow"]);
    expect(marks(host)).toBe(1);
  });

  test("once a pen is in use a finger draws nothing with the pen tool, and its touch reaches the page for reveal.js to swipe", () => {
    const { host, change } = mountStylus();
    const swipes = vi.fn<(event: Event) => void>();
    host.addEventListener("pointerdown", swipes);
    layer!.setMode("pen");
    // Before any pen, a finger draws as it always did.
    drag(host.querySelector(DRAW)!, "touch", [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);
    swipes.mockClear();
    change({ pen: true });
    drag(host.querySelector(DRAW)!, "touch", [20, 200], [300, 200]);
    expect(marks(host)).toBe(1);
    expect(swipes).toHaveBeenCalledOnce();
    // The pen and the mouse still draw.
    drag(host.querySelector(DRAW)!, "pen", [20, 250], [300, 250]);
    drag(host.querySelector(DRAW)!, "mouse", [20, 270], [300, 270], { id: 1 });
    expect(marks(host)).toBe(3);
  });

  test("with the setting off a finger keeps drawing, whether or not a pen was seen", () => {
    const { host } = mountStylus({ draws: false, pen: true });
    layer!.setMode("pen");
    drag(host.querySelector(DRAW)!, "touch", [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);
  });

  test("the laser ignores a finger while a pen is in use, and follows the pen and the mouse", () => {
    const { host, events, change } = mountStylus({ pen: true });
    layer!.setMode("laser");
    const surface = host.querySelector<SVGSVGElement>(".docwalk-annotate-laser")!;
    const lasers = () => events.filter((e) => e.kind === "laser").length;
    drag(surface, "touch", [20, 20], [200, 120]);
    expect(lasers()).toBe(0);
    drag(surface, "pen", [20, 20], [200, 120]);
    expect(lasers()).toBeGreaterThan(0);
    events.length = 0;
    change({ pen: false });
    drag(surface, "touch", [20, 20], [200, 120]);
    expect(lasers()).toBeGreaterThan(0);
  });

  test("a pen drag that begins on the whiteboard draws on the board", () => {
    const { host, events } = mountStylus();
    layer!.setBoard({ key: "a/board#0", address: "a/board" });
    events.length = 0;
    drag(host, "pen", [40, 30], [360, 270]);
    expect(strokes(events).map((s) => s.slide)).toEqual(["a/board"]);
    expect(marks(host)).toBe(1);
  });

  test("a layer made without the stylus option keeps every pointer as before", () => {
    const { host } = mount();
    drag(host, "pen", [40, 30], [360, 270]);
    expect(marks(host)).toBe(0);
    layer!.setMode("pen");
    drag(host.querySelector(DRAW)!, "touch", [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);
  });
});

/** A finger's down and two moves on the active surface, with no pointerup yet. */
function fingerDown(host: HTMLElement, id: number) {
  const svg = host.querySelector(DRAW)!;
  const rect = svg.getBoundingClientRect();
  const at = (type: string, x: number, y: number) =>
    svg.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: "touch",
        isPrimary: true,
        pressure: 0.5,
        clientX: rect.left + x,
        clientY: rect.top + y,
      }),
    );
  at("pointerdown", 20, 20);
  at("pointermove", 60, 40);
  at("pointermove", 100, 60);
  return () => at("pointerup", 100, 60);
}

/** A whole stroke by finger `id`, as drawn once the layer is free again. */
function finger(host: HTMLElement, id: number) {
  fingerDown(host, id)();
}

describe("a stroke cut off by a change of drawing (decision 110)", () => {
  test("closing the board mid-stroke leaves the board drawing to the next finger", () => {
    const { host } = openBoardDeck();
    layer!.setMode("pen");
    layer!.setBoard(BOARD);
    const lift = fingerDown(host, 31);
    layer!.setBoard(null);
    lift();
    layer!.setBoard(BOARD);
    finger(host, 32);
    expect(marks(host)).toBe(1);
  });

  test("opening the board mid-stroke on the slide leaves the slide drawing to the next finger", () => {
    const { host } = openBoardDeck();
    layer!.setMode("pen");
    const lift = fingerDown(host, 31);
    layer!.setBoard(BOARD);
    lift();
    layer!.setBoard(null);
    finger(host, 32);
    expect(marks(host)).toBe(1);
  });

  test("a change of slide mid-stroke leaves the slide drawing to the next finger", () => {
    const { host } = openBoardDeck();
    layer!.setMode("pen");
    const lift = fingerDown(host, 31);
    layer!.setKey("b/1#def", "b/1");
    lift();
    layer!.setKey("a/1#abc", "a/1");
    finger(host, 32);
    expect(marks(host)).toBe(1);
  });
});
