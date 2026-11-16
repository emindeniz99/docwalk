import { act, createElement as h } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
// Same fonts as the app, so heights match what readers see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { FocusEvent } from "../annotate/mirrorTypes";
import { observeFocus } from "../deck/focusEvents";
import { parseMarkdown } from "../sectioning/sectionize";
import { FRAME_GAP, FRAME_WIDTH, mapColumns, mapPlan, placeFrames } from "./layout";
import MapView from "./MapView";

/**
 * Decision 142 and its corrections in 143: the map view places the frames
 * where `placeFrames` says, on one layer moved by a camera; the wheel, a
 * trackpad pinch, a mouse drag on empty map, touch and Safari's gesture
 * events move the camera; Mermaid draws only near the view; a height change
 * moves the frames after it in its column. Layout is compared box to box,
 * never against fixed pixel heights.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Mermaid chunk can fail to load (a lost connection, a new deploy), as in
// src/deck/mermaidLoad.browser.test.ts: while `failing` is set, `initialize`
// throws, so the load rejects the way a missing chunk does and the figure is
// marked `data-load-failed` (decision 146). A load that succeeded stays
// loaded for the page and `vi.resetModules()` gives no fresh `mermaid.ts` in
// browser mode, so the load-failure test is the first of this file.
const control = vi.hoisted(() => ({ failing: false }));
vi.mock("mermaid", async (importOriginal) => {
  const real = await importOriginal<typeof import("mermaid")>();
  const mermaid = new Proxy(real.default, {
    get(target, key, receiver) {
      if (control.failing && key === "initialize")
        throw new TypeError("Failed to fetch dynamically imported module");
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...real, default: mermaid };
});

let reactRoot: ReactRoot | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  control.failing = false;
  act(() => reactRoot?.unmount());
  reactRoot = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

const para = (label: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${label} paragraph ${i + 1} holds a few words so that it fills a line.`,
  ).join("\n\n");

/** Three columns, two with a part stacked under the column's first frame. */
const DOC = [
  "## Alpha",
  "",
  para("Alpha", 3),
  "",
  "See [the gamma detail](#gamma-detail).",
  "",
  "### Alpha detail",
  "",
  para("Detail", 12),
  "",
  "## Beta",
  "",
  para("Beta", 2),
  "",
  "## Gamma",
  "",
  para("Gamma", 2),
  "",
  "### Gamma detail",
  "",
  para("Gamma detail", 2),
  "",
].join("\n");

const PANE = { width: 1200, height: 700 };

interface Mounted {
  container: HTMLElement;
  pane: HTMLElement;
  /** Renders `markdown` again in the same view, as an edit does. */
  show: (markdown: string) => void;
}

/**
 * MapView in a pane of `size` CSS px, once its first frame is shown: the view
 * keeps its frames hidden until the first placement, so nothing is seen at a
 * wrong place.
 */
async function mountMap(markdown: string, size = PANE, timeout = 20_000): Promise<Mounted> {
  await page.viewport(size.width + 100, size.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  const root = createRoot(container);
  reactRoot = root;
  const show = (md: string) => act(() => root.render(h(MapView, { root: parseMarkdown(md) })));
  show(markdown);
  const pane = container.querySelector<HTMLElement>(".docwalk-map-pane")!;
  const firstId = mapPlan(parseMarkdown(markdown)).sections[0]!.id;
  await expect
    .poll(
      () =>
        container
          .querySelector<HTMLElement>(`[data-map-frame="${firstId}"]`)
          ?.checkVisibility({ visibilityProperty: true }) ?? false,
      { timeout },
    )
    .toBe(true);
  await frames(2);
  return { container, pane, show };
}

const frameEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-map-frame="${CSS.escape(id)}"]`)!;
const boxOf = (container: HTMLElement, id: string) =>
  frameEl(container, id).getBoundingClientRect();
const allBoxes = (container: HTMLElement) =>
  new Map(
    [...container.querySelectorAll<HTMLElement>("[data-map-frame]")].map((el) => [
      el.dataset["mapFrame"]!,
      el.getBoundingClientRect(),
    ]),
  );

/** The box around every frame on screen: the map's box. */
function mapBox(container: HTMLElement) {
  const boxes = [...allBoxes(container).values()];
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** How far apart two numbers are, for a comparison within a tolerance. */
const off = (actual: number, expected: number) => Math.abs(actual - expected);

/**
 * A wheel event sent to whatever is under the point, as a real wheel is.
 * Returns whether it was prevented. The constructor refuses a non-finite
 * delta, so such a delta is put on the event afterwards, as a broken
 * source could hand it over.
 */
function wheelAt(x: number, y: number, init: WheelEventInit): boolean {
  const target = document.elementFromPoint(x, y) ?? document.body;
  const finite = Object.entries(init).filter(
    ([, v]) => typeof v !== "number" || Number.isFinite(v),
  );
  const event = new WheelEvent("wheel", {
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...Object.fromEntries(finite),
  });
  for (const [key, value] of Object.entries(init))
    if (typeof value === "number" && !Number.isFinite(value))
      Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Safari's pinch: a plain Event with `scale` and the point, as WebKit sends `GestureEvent`. */
function gestureAt(type: "gesturestart" | "gesturechange", x: number, y: number, scale: number) {
  const target = document.elementFromPoint(x, y) ?? document.body;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: x, clientY: y });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A finger on a touch screen, as a pointer event sent to what is under it. */
function touch(type: string, id: number, x: number, y: number) {
  const target = document.elementFromPoint(x, y) ?? document.body;
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: id,
      pointerType: "touch",
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** A point on the first frame's visible part, off its centre, so a zoom around the wrong point shows. */
function pointOn(box: DOMRect, pane: DOMRect) {
  return {
    x: box.left + Math.min(box.width, pane.right - box.left) * 0.3,
    y: box.top + Math.min(box.height, pane.bottom - box.top) * 0.4,
  };
}

const scaleOf = (box: DOMRect) => box.width / FRAME_WIDTH;

describe("a diagram whose code fails to load (decisions 144, 146 and 147)", () => {
  // First in the file: once Mermaid has loaded, it stays loaded for the page.
  test("leaves no unhandled rejection, and its frame is drawn when it comes near again", async () => {
    // Row 147: the figure is marked as not loaded instead of the promise
    // rejecting, and the frame must not count as drawn, or the note stays.
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => window.removeEventListener("unhandledrejection", onRejection));
    control.failing = true;
    const { container, pane } = await mountMap(DIAGRAM_DOC);
    const start = frameEl(container, "start");
    await expect
      .poll(() => start.querySelector("figure.docwalk-diagram[data-load-failed]"), {
        timeout: 20_000,
      })
      .not.toBeNull();
    await frames(10);
    expect(start.querySelector(".docwalk-diagram svg")).toBeNull();
    expect(rejections).toEqual([]);
    control.failing = false;
    const p = pane.getBoundingClientRect();
    wheelAt(p.left + 50, p.top + 50, { deltaY: 5 });
    await expect
      .poll(() => start.querySelector(".docwalk-diagram svg"), { timeout: 20_000 })
      .not.toBeNull();
    expect(start.querySelector("[data-load-failed]")).toBeNull();
  });
});

describe("frames stand where placeFrames puts them (decision 142, Frames)", () => {
  test("columns left to right, a column's frames stacked with the gap, no overlap, document order in the DOM", async () => {
    const { container } = await mountMap(DOC);
    const plan = mapPlan(parseMarkdown(DOC));
    const columns = mapColumns(plan);
    // The frames' own layout heights, as frames.ts measures them.
    const heights = new Map(
      plan.sections.map((s) => [
        s.id,
        Number.parseFloat(getComputedStyle(frameEl(container, s.id)).height),
      ]),
    );
    const placement = placeFrames(columns, heights);
    const boxes = allBoxes(container);
    // Reading order and Tab order follow the document, wherever a frame sits.
    expect([...boxes.keys()]).toEqual(plan.sections.map((s) => s.id));
    const first = placement.frames[0]!;
    const firstBox = boxes.get(first.id)!;
    const s = scaleOf(firstBox);
    const origin = { x: firstBox.left - first.x * s, y: firstBox.top - first.y * s };
    for (const rect of placement.frames) {
      const box = boxes.get(rect.id)!;
      expect(off(box.left, origin.x + rect.x * s), `${rect.id} left`).toBeLessThanOrEqual(1);
      expect(off(box.top, origin.y + rect.y * s), `${rect.id} top`).toBeLessThanOrEqual(1);
      expect(off(box.width, rect.width * s), `${rect.id} width`).toBeLessThanOrEqual(1);
      // A short frame keeps the minimum height on screen too, so its box is its rectangle.
      expect(off(box.height, rect.height * s), `${rect.id} height`).toBeLessThanOrEqual(1);
    }
    expect(columns.length).toBeGreaterThan(1);
    const lefts = columns.map((column) => boxes.get(column[0]!.id)!.left);
    for (let c = 1; c < lefts.length; c++) expect(lefts[c]).toBeGreaterThan(lefts[c - 1]!);
    for (const column of columns) {
      for (let r = 1; r < column.length; r++) {
        const above = boxes.get(column[r - 1]!.id)!;
        const below = boxes.get(column[r]!.id)!;
        expect(off(below.left, above.left), "same column, same left").toBeLessThanOrEqual(0.5);
        expect(
          off(below.top - above.bottom, FRAME_GAP * s),
          "the gap between frames",
        ).toBeLessThanOrEqual(1);
      }
    }
    const list = [...boxes.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const overlap =
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
        expect(overlap, `frames ${i} and ${j} overlap`).toBe(false);
      }
    }
  });
});

describe("the opening view (decision 142, Camera)", () => {
  test("the first frame spans the pane's width inside the margin, its top at the pane's top margin", async () => {
    const { container, pane } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    const first = boxOf(container, "alpha");
    expect(off(first.left, p.left + 24), "left margin").toBeLessThanOrEqual(1);
    expect(off(first.right, p.right - 24), "right margin").toBeLessThanOrEqual(1);
    expect(off(first.top, p.top + 24), "top margin").toBeLessThanOrEqual(1);
    expect(scaleOf(first)).toBeLessThan(1);
  });

  test("in a pane wider than a frame and its margins the first frame is at scale 1, centred", async () => {
    // Decision 142: fitted to the width, never above scale 1.
    const { container, pane } = await mountMap(DOC, { width: 1600, height: 800 });
    const p = pane.getBoundingClientRect();
    const first = boxOf(container, "alpha");
    expect(off(first.width, FRAME_WIDTH), "scale 1").toBeLessThanOrEqual(1);
    expect(off(first.left - p.left, p.right - first.right), "centred").toBeLessThanOrEqual(1);
    expect(off(first.top, p.top + 24), "top margin").toBeLessThanOrEqual(1);
  });
});

describe("the wheel and a trackpad pinch (decisions 127 and 142)", () => {
  test("a plain wheel pans every frame against its delta and sizes nothing; the page does not scroll", async () => {
    const { container, pane } = await mountMap(DOC);
    const before = allBoxes(container);
    const p = pointOn(before.get("alpha")!, pane.getBoundingClientRect());
    expect(wheelAt(p.x, p.y, { deltaX: 30, deltaY: 50 }), "the pane takes the wheel").toBe(true);
    await frames(2);
    for (const [id, box] of allBoxes(container)) {
      const old = before.get(id)!;
      expect(off(box.left, old.left - 30), `${id} left`).toBeLessThanOrEqual(0.5);
      expect(off(box.top, old.top - 50), `${id} top`).toBeLessThanOrEqual(0.5);
      expect(off(box.width, old.width), `${id} width`).toBeLessThanOrEqual(0.01);
      expect(off(box.height, old.height), `${id} height`).toBeLessThanOrEqual(0.01);
    }
  });

  test("with Shift a vertical wheel pans sideways", async () => {
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    wheelAt(p.x, p.y, { deltaY: 50, shiftKey: true });
    await frames(2);
    const after = boxOf(container, "alpha");
    expect(off(after.left, before.left - 50), "sideways").toBeLessThanOrEqual(0.5);
    expect(off(after.top, before.top), "not down").toBeLessThanOrEqual(0.5);
  });

  test("forty small ctrlKey wheel events zoom by the gesture's size around the pointer", async () => {
    // A trackpad pinch arrives as dozens of small ctrlKey wheel events; a fixed step per event zoomed thousands of times.
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    const fx = (p.x - before.left) / before.width;
    const fy = (p.y - before.top) / before.height;
    let prevented = 0;
    for (let i = 0; i < 40; i++) if (wheelAt(p.x, p.y, { deltaY: -1, ctrlKey: true })) prevented++;
    expect(prevented, "a pinch must not zoom the page").toBe(40);
    await frames(2);
    const after = boxOf(container, "alpha");
    expect(scaleOf(after) / scaleOf(before)).toBeCloseTo(Math.exp(0.4), 2);
    expect(
      off(after.left + fx * after.width, p.x),
      "the map point under the pointer, x",
    ).toBeLessThanOrEqual(2);
    expect(
      off(after.top + fy * after.height, p.y),
      "the map point under the pointer, y",
    ).toBeLessThanOrEqual(2);
  });

  test("zoomed far out the whole map fits the pane; zoomed far in the scale stops at 2", async () => {
    // Row 143: the smallest scale fits the whole map with a 24 px margin. A
    // zoom keeps the point under the pointer, so the fitted map need not be
    // centred: the overlap rule may leave part of it past an edge.
    const { container, pane } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    const at = pointOn(boxOf(container, "alpha"), p);
    for (let i = 0; i < 400; i++) wheelAt(at.x, at.y, { deltaY: 10, ctrlKey: true });
    await frames(2);
    const map = mapBox(container);
    const width = map.right - map.left;
    const height = map.bottom - map.top;
    expect(width).toBeLessThanOrEqual(p.width - 48 + 0.5);
    expect(height).toBeLessThanOrEqual(p.height - 48 + 0.5);
    // Fitted, not smaller: one axis fills the pane inside its margins.
    expect(Math.max(width - (p.width - 48), height - (p.height - 48))).toBeGreaterThan(-1);
    const inAt = pointOn(boxOf(container, "alpha"), p);
    for (let i = 0; i < 400; i++) wheelAt(inAt.x, inAt.y, { deltaY: -10, ctrlKey: true });
    await frames(2);
    expect(off(boxOf(container, "alpha").width, FRAME_WIDTH * 2), "scale 2").toBeLessThanOrEqual(1);
  });

  test("the camera cannot leave the map: after a huge pan each way part of the map is in the pane", async () => {
    // Row 143: the map's box and the pane overlap by at least 64 px on each axis.
    const { container, pane } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    for (const delta of [{ deltaX: 1e7 }, { deltaX: -1e7 }, { deltaY: 1e7 }, { deltaY: -1e7 }]) {
      wheelAt(p.left + 50, p.top + 50, delta);
      await frames(2);
      const map = mapBox(container);
      const across = Math.min(map.right, p.right) - Math.max(map.left, p.left);
      const down = Math.min(map.bottom, p.bottom) - Math.max(map.top, p.top);
      expect(across, `${JSON.stringify(delta)}`).toBeGreaterThanOrEqual(63);
      expect(down, `${JSON.stringify(delta)}`).toBeGreaterThanOrEqual(63);
    }
  });

  test("a broken delta (NaN, Infinity) leaves every frame drawn at a finite place", async () => {
    const { container, pane } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    for (const init of [
      { deltaY: Number.NaN },
      { deltaY: Number.POSITIVE_INFINITY },
      { deltaX: Number.NEGATIVE_INFINITY },
      { deltaY: Number.NaN, ctrlKey: true },
      { deltaY: Number.POSITIVE_INFINITY, ctrlKey: true },
    ]) {
      wheelAt(p.left + 50, p.top + 50, init);
      await frames(2);
      const box = boxOf(container, "alpha");
      for (const v of [box.left, box.top, box.width, box.height])
        expect(Number.isFinite(v)).toBe(true);
      expect(box.width).toBeGreaterThan(0);
      const transform = getComputedStyle(frameEl(container, "alpha").parentElement!).transform;
      expect(transform).not.toMatch(/nan|infinity/i);
    }
  });
});

describe("the mouse on the map (decision 142, Camera)", () => {
  test("a drag that starts on empty map (a frame's padding) pans", async () => {
    const { container } = await mountMap(DOC);
    const first = frameEl(container, "alpha");
    const before = allBoxes(container);
    await userEvent.dragAndDrop(first, first, {
      sourcePosition: { x: 8, y: 8 },
      targetPosition: { x: 208, y: 108 },
    });
    await frames(2);
    for (const [id, box] of allBoxes(container)) {
      expect(off(box.left, before.get(id)!.left + 200), `${id} left`).toBeLessThanOrEqual(1);
      expect(off(box.top, before.get(id)!.top + 100), `${id} top`).toBeLessThanOrEqual(1);
    }
  });

  test("a drag that starts on text in a frame selects the text and moves nothing", async () => {
    const { container } = await mountMap(DOC);
    const text = frameEl(container, "alpha").querySelector<HTMLElement>(".docwalk-slide-body p")!;
    const box = text.getBoundingClientRect();
    const before = allBoxes(container);
    await userEvent.dragAndDrop(text, text, {
      sourcePosition: { x: 2, y: box.height / 2 },
      targetPosition: { x: box.width * 0.6, y: box.height / 2 },
    });
    await frames(2);
    expect(window.getSelection()?.toString().length ?? 0).toBeGreaterThan(5);
    for (const [id, after] of allBoxes(container)) {
      expect(off(after.left, before.get(id)!.left), `${id} left`).toBeLessThanOrEqual(0.5);
      expect(off(after.top, before.get(id)!.top), `${id} top`).toBeLessThanOrEqual(0.5);
    }
  });

  test("a click on a link in a frame reaches it: the heading it names is focused and brought into view", async () => {
    // Gamma detail is two columns away, outside the opening view.
    const { container, pane } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    expect(boxOf(container, "gamma-detail").left).toBeGreaterThan(p.right);
    const link = frameEl(container, "alpha").querySelector<HTMLAnchorElement>(
      'a[href="#gamma-detail"]',
    )!;
    await userEvent.click(link);
    const heading = container.querySelector<HTMLElement>("#user-content-gamma-detail")!;
    expect(document.activeElement).toBe(heading);
    await expect
      .poll(() => {
        const b = heading.getBoundingClientRect();
        return b.left >= p.left && b.right <= p.right && b.top >= p.top && b.bottom <= p.bottom;
      })
      .toBe(true);
  });
});

describe("touch on the map (decision 142, Camera)", () => {
  // Synthetic PointerEvents bypass `touch-action`: these tests prove the
  // arithmetic and the wiring, not that a browser delivers the moves.
  test("one finger pans", async () => {
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    touch("pointerdown", 1, p.x, p.y);
    touch("pointermove", 1, p.x + 40, p.y + 30);
    touch("pointerup", 1, p.x + 40, p.y + 30);
    await frames(2);
    const after = boxOf(container, "alpha");
    expect(off(after.left, before.left + 40), "left").toBeLessThanOrEqual(0.5);
    expect(off(after.top, before.top + 30), "top").toBeLessThanOrEqual(0.5);
    expect(off(after.width, before.width), "no zoom").toBeLessThanOrEqual(0.01);
  });

  test("two fingers moving apart zoom by the change of their distance", async () => {
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    touch("pointerdown", 1, p.x - 50, p.y);
    touch("pointerdown", 2, p.x + 50, p.y);
    // From 100 px apart to 150 px apart.
    touch("pointermove", 2, p.x + 100, p.y);
    touch("pointerup", 2, p.x + 100, p.y);
    touch("pointerup", 1, p.x - 50, p.y);
    await frames(2);
    expect(scaleOf(boxOf(container, "alpha")) / scaleOf(before)).toBeCloseTo(1.5, 3);
  });
});

describe("Safari's gesture events (decisions 127 and 128)", () => {
  test("the scale becomes the scale at the gesture's start times its scale, and the page does not zoom", async () => {
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    expect(gestureAt("gesturestart", p.x, p.y, 1)).toBe(true);
    expect(gestureAt("gesturechange", p.x, p.y, 1.2)).toBe(true);
    expect(gestureAt("gesturechange", p.x, p.y, 1.4)).toBe(true);
    await frames(2);
    // 1.4 of the start, not 1.2 * 1.4: each change is relative to where the gesture began.
    expect(scaleOf(boxOf(container, "alpha")) / scaleOf(before)).toBeCloseTo(1.4, 3);
  });

  test("a gesture that began with two fingers down is read from the pointers only", async () => {
    // Decision 128: an iPad pinch sends pointers and gesture events; both would zoom twice.
    const { container, pane } = await mountMap(DOC);
    const before = boxOf(container, "alpha");
    const p = pointOn(before, pane.getBoundingClientRect());
    touch("pointerdown", 1, p.x - 50, p.y);
    touch("pointerdown", 2, p.x + 50, p.y);
    expect(gestureAt("gesturestart", p.x, p.y, 1)).toBe(true);
    touch("pointercancel", 1, p.x - 50, p.y);
    touch("pointercancel", 2, p.x + 50, p.y);
    expect(gestureAt("gesturechange", p.x, p.y, 1.5)).toBe(true);
    await frames(2);
    expect(off(boxOf(container, "alpha").width, before.width), "no zoom").toBeLessThanOrEqual(0.01);
  });
});

const DIAGRAM_DOC = [
  "## Start",
  "",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "",
  ...["One", "Two", "Three", "Four", "Five"].flatMap((name) => [
    `## Column ${name}`,
    "",
    para(name, 2),
    "",
  ]),
  "## Far",
  "",
  para("Far", 14),
  "",
  "```mermaid",
  "flowchart TD",
  "  a --> b",
  "  b --> c",
  "  c --> d",
  "  d --> e",
  "```",
  "",
  "### Far detail",
  "",
  para("Far detail", 2),
  "",
].join("\n");

describe("diagrams are drawn near the view only (decisions 142 and 143, Diagrams)", () => {
  test(
    "a far diagram is its source block until the camera comes near; drawn, its frame grows and the frame below moves",
    { timeout: 60_000 },
    async () => {
      const { container, pane } = await mountMap(DIAGRAM_DOC);
      const start = frameEl(container, "start");
      const far = frameEl(container, "far");
      // A diagram in the first frame is drawn at opening.
      await expect
        .poll(() => start.querySelector(".docwalk-diagram svg"), { timeout: 20_000 })
        .not.toBeNull();
      await frames(3);
      expect(far.querySelector(".docwalk-diagram")).toBeNull();
      expect(far.querySelector("pre > code.language-mermaid")).not.toBeNull();
      const farBefore = far.getBoundingClientRect();
      const offsetBefore = boxOf(container, "far-detail").top - farBefore.top;
      const p = pane.getBoundingClientRect();
      wheelAt(p.left + 50, p.top + 50, { deltaX: farBefore.left - p.left - 24 });
      await expect
        .poll(() => far.querySelector(".docwalk-diagram svg"), { timeout: 20_000 })
        .not.toBeNull();
      await expect
        .poll(() => far.getBoundingClientRect().height, { timeout: 5000 })
        .toBeGreaterThan(farBefore.height + 1);
      await frames(3);
      const farAfter = far.getBoundingClientRect();
      const detail = boxOf(container, "far-detail");
      expect(
        off(detail.top - farAfter.top - offsetBefore, farAfter.height - farBefore.height),
        "the frame below moved by the height difference",
      ).toBeLessThanOrEqual(1);
      expect(
        off(detail.top - farAfter.bottom, FRAME_GAP * scaleOf(farAfter)),
        "the gap",
      ).toBeLessThanOrEqual(1);
    },
  );
});

describe("a height change after opening (decision 142, Measuring)", () => {
  test("moves the frames below it in its column, no frame in other columns, and not the camera", async () => {
    // The chosen rule: the camera is left alone (only clamped to the new
    // bounds), so the frame that changed stays where it is on screen.
    const { container } = await mountMap(DOC);
    const before = allBoxes(container);
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(300);
    frameEl(container, "alpha").querySelector(".docwalk-slide-body")!.append(more);
    await expect
      .poll(() => boxOf(container, "alpha-detail").top - before.get("alpha-detail")!.top)
      .toBeGreaterThan(10);
    await frames(3);
    const after = allBoxes(container);
    const alpha = after.get("alpha")!;
    expect(off(alpha.left, before.get("alpha")!.left), "alpha left").toBeLessThanOrEqual(0.5);
    expect(off(alpha.top, before.get("alpha")!.top), "alpha top").toBeLessThanOrEqual(0.5);
    expect(
      off(
        after.get("alpha-detail")!.top - before.get("alpha-detail")!.top,
        alpha.height - before.get("alpha")!.height,
      ),
      "the frame below moved by the growth",
    ).toBeLessThanOrEqual(1);
    for (const id of ["beta", "gamma", "gamma-detail"]) {
      expect(off(after.get(id)!.left, before.get(id)!.left), `${id} left`).toBeLessThanOrEqual(0.5);
      expect(off(after.get(id)!.top, before.get(id)!.top), `${id} top`).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("an edit (decision 142)", () => {
  test("keeps the camera where it is and shows the new content", async () => {
    const { container, pane, show } = await mountMap(DOC);
    const p = pane.getBoundingClientRect();
    // Move away from the opening view, so going back to it would show.
    wheelAt(p.left + 50, p.top + 50, { deltaX: 300, deltaY: 120 });
    await frames(2);
    const before = boxOf(container, "alpha");
    show(DOC.replace("Gamma paragraph 1", "Gamma paragraph one, edited"));
    await expect.poll(() => container.textContent).toContain("Gamma paragraph one, edited");
    await frames(4);
    const after = boxOf(container, "alpha");
    expect(off(after.left, before.left), "left").toBeLessThanOrEqual(2);
    expect(off(after.top, before.top), "top").toBeLessThanOrEqual(2);
    expect(off(after.width, before.width), "scale").toBeLessThanOrEqual(0.5);
  });
});

const FAR_LINK = [
  ...["One", "Two", "Three", "Four", "Five", "Six"].flatMap((name) => [
    `## Column ${name}`,
    "",
    para(name, 2),
    "",
  ]),
  "## Last",
  "",
  "Read [the far link](https://example.invalid/far) here.",
  "",
].join("\n");

describe("the keyboard on the map (WCAG 2.4.7 and 2.4.11)", () => {
  test("Tab to a link in a far frame brings that frame into view", async () => {
    const { container, pane } = await mountMap(FAR_LINK);
    const p = pane.getBoundingClientRect();
    expect(boxOf(container, "last").left).toBeGreaterThan(p.right);
    pane.focus();
    await userEvent.tab();
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://example.invalid/far"]',
    )!;
    expect(document.activeElement).toBe(link);
    await expect
      .poll(() => {
        const b = link.getBoundingClientRect();
        return b.left >= p.left && b.right <= p.right && b.top >= p.top && b.bottom <= p.bottom;
      })
      .toBe(true);
  });
});

describe("unmounting", () => {
  test("removes the listeners, empties the layer and stops placing the old frames", async () => {
    const { container, pane } = await mountMap(DOC);
    const alpha = frameEl(container, "alpha");
    const layer = alpha.parentElement!;
    const body = alpha.querySelector(".docwalk-slide-body")!;
    const detail = frameEl(container, "alpha-detail");
    const top = detail.style.top;
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    cleanups.push(() => window.removeEventListener("error", onError));
    act(() => reactRoot?.unmount());
    reactRoot = null;
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    pane.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    // React removes the pane; the view itself must empty the layer it filled.
    expect(layer.childElementCount).toBe(0);
    // A frame that grows after unmount moves nothing and throws nothing.
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(300);
    body.append(more);
    await frames(4);
    expect(detail.style.top).toBe(top);
    expect(errors).toEqual([]);
  });
});

const BLOCKS = [
  "## Blocks",
  "",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Name | Where |",
  "| --- | --- |",
  "| Later | [jump](#later) |",
  "",
  "![Company logo](/icons/icon-192.png)",
  "",
  "## Later",
  "",
  "The end.",
  "",
  ...["One", "Two", "Three", "Four", "Five"].flatMap((name) => [
    `## Column ${name}`,
    "",
    para(name, 2),
    "",
  ]),
  "## Far",
  "",
  "```ts",
  "const far = 1;",
  "```",
  "",
].join("\n");

/** Room for the first frame's four blocks inside the pane. */
const TALL_PANE = { width: 1200, height: 1000 };

const overlay = () => document.querySelector<HTMLElement>(".docwalk-focus");

/** A block of the frame once it is a focus target, or a diagram once drawn. */
async function blockIn(container: HTMLElement, frameId: string, selector: string) {
  const frameBox = frameEl(container, frameId);
  const marked =
    selector === ".docwalk-diagram"
      ? ".docwalk-diagram:has(svg)"
      : `${selector}[data-docwalk-focus]`;
  await expect.poll(() => frameBox.querySelector(marked), { timeout: 20_000 }).toBeTruthy();
  return frameBox.querySelector<HTMLElement>(marked)!;
}

/**
 * A real click on `block`, sent through its frame: every code block has the
 * same accessible name, so the block alone is no unique locator.
 */
async function clickBlock(container: HTMLElement, frameId: string, block: HTMLElement) {
  const frameBox = frameEl(container, frameId);
  const f = frameBox.getBoundingClientRect();
  const b = block.getBoundingClientRect();
  await userEvent.click(frameBox, {
    position: { x: b.left - f.left + b.width / 2, y: b.top - f.top + Math.min(b.height / 2, 20) },
  });
}

const KINDS = [
  ["diagram", ".docwalk-diagram"],
  ["code", "pre"],
  ["table", "table"],
  ["image", "img"],
] as const;

describe("blocks open in the focus view from the map (decisions 129 and 144)", () => {
  for (const [kind, selector] of KINDS) {
    test(`a click on the ${kind} in a frame opens the ${kind} view`, async () => {
      const { container } = await mountMap(BLOCKS, TALL_PANE);
      await clickBlock(container, "blocks", await blockIn(container, "blocks", selector));
      expect(overlay()?.dataset["kind"]).toBe(kind);
    });

    test(`Enter on the ${kind} opens its view and Escape returns focus to it`, async () => {
      const { container } = await mountMap(BLOCKS, TALL_PANE);
      const block = await blockIn(container, "blocks", selector);
      block.focus();
      await userEvent.keyboard("{Enter}");
      expect(overlay()?.dataset["kind"]).toBe(kind);
      await userEvent.keyboard("{Escape}");
      expect(overlay()).toBeNull();
      expect(document.activeElement).toBe(block);
    });
  }

  test("a far frame's code block, whose frame has drawn no diagram, is a tab stop that opens", async () => {
    const { container, pane } = await mountMap(BLOCKS, TALL_PANE);
    expect(boxOf(container, "far").left).toBeGreaterThan(pane.getBoundingClientRect().right);
    const pre = await blockIn(container, "far", "pre");
    expect(pre.tabIndex).toBe(0);
    pre.focus();
    await userEvent.keyboard("{Enter}");
    expect(overlay()?.dataset["kind"]).toBe("code");
  });

  test("a link in a table follows the link and opens nothing", async () => {
    const { container } = await mountMap(BLOCKS, TALL_PANE);
    const table = await blockIn(container, "blocks", "table");
    await userEvent.click(table.querySelector<HTMLElement>("a")!);
    expect(overlay()).toBeNull();
    expect(document.activeElement?.textContent).toBe("Later");
  });

  test("opening and closing a block on the map announces nothing to the mirror", async () => {
    // A frame has no slide address (decision 106); the map mirrors nothing yet (decision 144).
    const { container } = await mountMap(BLOCKS, TALL_PANE);
    const events: FocusEvent[] = [];
    cleanups.push(observeFocus((event) => events.push(event)));
    await clickBlock(container, "blocks", await blockIn(container, "blocks", "pre"));
    expect(overlay()?.dataset["kind"]).toBe("code");
    await userEvent.keyboard("{Escape}");
    await clickBlock(container, "blocks", await blockIn(container, "blocks", ".docwalk-diagram"));
    expect(overlay()?.dataset["kind"]).toBe("diagram");
    await userEvent.keyboard("{Escape}");
    expect(events.filter((e) => e.kind === "open" || e.kind === "close")).toEqual([]);
  });

  test("a new render closes an open view, and so does unmounting", async () => {
    const { container, show } = await mountMap(BLOCKS, TALL_PANE);
    await clickBlock(container, "blocks", await blockIn(container, "blocks", ".docwalk-diagram"));
    expect(overlay()).not.toBeNull();
    show(BLOCKS.replace("The end.", "The end, edited."));
    expect(overlay()).toBeNull();
    await clickBlock(container, "blocks", await blockIn(container, "blocks", "pre"));
    expect(overlay()?.dataset["kind"]).toBe("code");
    act(() => reactRoot?.unmount());
    reactRoot = null;
    expect(overlay()).toBeNull();
  });

  test("a finger that taps a block opens it; a finger that pans from it opens nothing", async () => {
    // Synthetic touches send no click of their own, so the test sends the one a browser would.
    const { container } = await mountMap(BLOCKS, TALL_PANE);
    const pre = await blockIn(container, "blocks", "pre");
    const before = boxOf(container, "blocks");
    let b = pre.getBoundingClientRect();
    touch("pointerdown", 1, b.left + 10, b.top + 10);
    touch("pointermove", 1, b.left + 50, b.top + 40);
    touch("pointerup", 1, b.left + 50, b.top + 40);
    pre.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await frames(2);
    expect(overlay(), "a pan is no tap").toBeNull();
    expect(boxOf(container, "blocks").left).toBeCloseTo(before.left + 40, 0);
    b = pre.getBoundingClientRect();
    touch("pointerdown", 2, b.left + 10, b.top + 10);
    touch("pointerup", 2, b.left + 11, b.top + 10);
    pre.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(overlay()?.dataset["kind"]).toBe("code");
  });
});

const WIDE = [
  "## Wide",
  "",
  "```text",
  `log ${"key=value ".repeat(60)}`,
  "```",
  "",
  "## Next",
  "",
  "Text.",
  "",
].join("\n");

describe("boxes that scroll inside a frame (decision 144)", () => {
  test("a wheel over a code block that scrolls sideways moves the map, not the block", async () => {
    const { container } = await mountMap(WIDE);
    const pre = frameEl(container, "wide").querySelector("pre")!;
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    const before = boxOf(container, "wide");
    await userEvent.wheel(pre, { delta: { x: 120 } });
    await frames(3);
    expect(pre.scrollLeft).toBe(0);
    expect(boxOf(container, "wide").left).toBeLessThan(before.left - 50);
  });
});

/** DOC with every frame's text twenty times as long; the frame ids stay. */
const TALL_DOC = DOC.replace(
  /paragraph (\d+) holds/g,
  (_, n: string) => `paragraph ${n} holds ${"many more words, ".repeat(40)}and still`,
);

describe("placing at once (decision 144)", () => {
  test("after a render with taller content no frame lies over another, before anything settles", async () => {
    const { container, show } = await mountMap(DOC);
    show(TALL_DOC);
    // Same task as the render: no report from the new frames has come yet.
    const list = [...allBoxes(container).values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const overlap =
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
        expect(overlap, `frames ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  test("an image that never decodes neither hides the map nor stops it placing a frame that grows", async () => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = () => new Promise<void>(() => undefined);
    cleanups.push(() => {
      HTMLImageElement.prototype.decode = decode;
    });
    const { container, pane } = await mountMap(
      DOC.replace("## Beta", "![Logo](/icons/icon-192.png)\n\n## Beta"),
      PANE,
      3000,
    );
    const p = pane.getBoundingClientRect();
    const alpha = boxOf(container, "alpha");
    expect(alpha.left).toBeCloseTo(p.left + 24, 0);
    expect(alpha.top).toBeCloseTo(p.top + 24, 0);
    const detailTop = boxOf(container, "alpha-detail").top;
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(300);
    frameEl(container, "alpha").querySelector(".docwalk-slide-body")!.append(more);
    await expect.poll(() => boxOf(container, "alpha-detail").top).toBeGreaterThan(detailTop + 10);
  });
});
