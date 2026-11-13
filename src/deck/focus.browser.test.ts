import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { FocusEvent } from "../annotate/mirrorTypes";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck } from "./Deck";
import { observeFocus } from "./focusEvents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const DOC =
  "## Diagram\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n## Next\n\nMore text.\n\n## Last\n\nEnd.\n";

function mountDeck(markdown: string) {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  const show = (md: string) =>
    act(() => root!.render(h(Deck, { plan: sectionize(parseMarkdown(md), "auto"), onReady })));
  show(markdown);
  const ready = async (n: number) => {
    await expect
      .poll(() => readies.length, { timeout: 20_000, interval: 10 })
      .toBeGreaterThanOrEqual(n);
  };
  return { container, show, ready, readies };
}

describe("closing the diagram focus view after the deck was rebuilt under it", () => {
  // While the view is open, focus is in the overlay, so a rebuild (an agent
  // write, a disk reload) does not hand focus to the new deck. Closing then
  // focused the old, detached diagram, focus fell to <body>, and reveal.js,
  // which takes keys only while focus is inside the deck, ignored the arrow
  // keys and the presenter's clicker.
  test("focus lands in the new deck and the arrow keys keep stepping slides", async () => {
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const diagram = deck.container.querySelector<HTMLElement>(
      ".reveal .slides section.present .docwalk-diagram",
    )!;
    diagram.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector(".docwalk-focus")).not.toBeNull();

    deck.show(DOC.replace("More text.", "More text, edited."));
    await deck.ready(2);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".docwalk-focus")).toBeNull();

    const rebuilt = deck.container.querySelector<HTMLElement>(".reveal")!;
    expect(rebuilt.contains(document.activeElement)).toBe(true);
    const controller = deck.readies.at(-1)!;
    const before = controller.current()!.index;
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => controller.current()!.index).toBe(before + 1);
  });
});

async function openDiagramView() {
  const deck = mountDeck(DOC);
  await deck.ready(1);
  const diagram = deck.container.querySelector<HTMLElement>(
    ".reveal .slides section.present .docwalk-diagram",
  )!;
  diagram.focus();
  await userEvent.keyboard("{Enter}");
  const view = document.querySelector<HTMLElement>(".docwalk-focus")!;
  expect(view).not.toBeNull();
  return view;
}

describe("the diagram view's toolbar before any tour starts", () => {
  // The tour's code loads on its first start, and offline it may never load.
  // The status line must be hidden from the first frame, not once that chunk
  // arrives: before, it was an unstyled flex item and "Tour ended" could show.
  test("the status line is visually hidden although the tour's code has not loaded", async () => {
    const view = await openDiagramView();
    const status = view.querySelector<HTMLElement>(".docwalk-tour-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(getComputedStyle(status).position).toBe("absolute");
    const box = status.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([1, 1]);
    // The count is a toolbar item that is hidden until the tour runs.
    expect(view.querySelector<HTMLElement>(".docwalk-tour-count")!.hidden).toBe(true);
  });

  // At 390 px the toolbar once wrapped, leaving Close alone on a second row.
  test("at 390 px every toolbar button shares one row, each at least 44 px", async () => {
    await page.viewport(390, 844);
    try {
      const view = await openDiagramView();
      const buttons = [
        ...view.querySelectorAll<HTMLButtonElement>(".docwalk-focus-toolbar button"),
      ].filter((b) => !b.hidden);
      // Zoom out, zoom in, Fit, Fullscreen, Sketch, Tour, Close.
      expect(buttons).toHaveLength(7);
      const boxes = buttons.map((b) => b.getBoundingClientRect());
      expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
      for (const box of boxes) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(390);
      }
    } finally {
      await page.viewport(1280, 800);
    }
  });
});

/*
 * Decision 127: pan and zoom follow the gesture. A trackpad's two-finger
 * scroll is a wheel event with no modifier, and its pinch is dozens of small
 * `ctrlKey` wheel events. The events here are synthetic, so they test what the
 * view does with them, not what a real trackpad sends (ROADMAP owes that check).
 */

/** A listing with lines too wide for a large Fit, so a pinch has room to zoom in. */
const WIDE_CODE = [
  "## Code",
  "",
  "```ts",
  ...Array.from(
    { length: 6 },
    (_, i) => `const value${i} = ${"compute(".repeat(8)}${i}${")".repeat(8)}; // ${"w".repeat(40)}`,
  ),
  "```",
  "",
].join("\n");
const WIDE_TABLE = [
  "## Table",
  "",
  `| ${Array.from({ length: 10 }, (_, i) => `column ${i} wide`).join(" | ")} |`,
  `| ${Array.from({ length: 10 }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: 10 }, (_, i) => `cell ${i} with words`).join(" | ")} |`,
  "",
].join("\n");
const IMAGE = "## Image\n\n![Company logo](/icons/icon-192.png)\n";

const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

/** Opens the focus view of the first block of `kind` on the first slide, the way Enter does. */
async function openKind(markdown: string, kind: "diagram" | "code" | "table" | "image") {
  const deck = mountDeck(markdown);
  await deck.ready(1);
  const selector = kind === "diagram" ? ".docwalk-diagram" : `[data-docwalk-focus="${kind}"]`;
  const slide = () => deck.container.querySelector(".reveal .slides section.present");
  await expect.poll(() => slide()?.querySelector(selector), { timeout: 10_000 }).toBeTruthy();
  const block = slide()!.querySelector<HTMLElement>(selector)!;
  block.focus();
  await userEvent.keyboard("{Enter}");
  const view = document.querySelector<HTMLElement>(".docwalk-focus")!;
  expect(view).not.toBeNull();
  expect(view.dataset["kind"]).toBe(kind);
  // A canvas fits on the next frame (rule 4); measure after it.
  await frames(2);
  const stage = view.querySelector<HTMLElement>(".docwalk-focus-stage")!;
  return { deck, view, stage, block };
}

/** Sends a wheel event to whatever is under the point, as a real wheel would. Returns whether it was prevented. */
function wheelAt(x: number, y: number, init: WheelEventInit): boolean {
  const target = document.elementFromPoint(x, y) ?? document.body;
  const event = new WheelEvent("wheel", {
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...init,
  });
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

/** The picture on a canvas stage: the diagram's SVG or the image. */
const picture = (view: HTMLElement) => view.querySelector<Element>(".docwalk-focus-canvas > *")!;
const textScale = (view: HTMLElement) =>
  Number(
    view
      .querySelector<HTMLElement>(".docwalk-focus-sheet")!
      .style.getPropertyValue("--focus-scale"),
  );

/** A point inside the picture, off its centre, so a zoom around the wrong point shows. */
function pointIn(box: DOMRect) {
  return { x: box.left + box.width * 0.3, y: box.top + box.height * 0.35 };
}

/** Where a point of the picture, given as fractions of its box, is on screen now. */
const at = (box: DOMRect, fx: number, fy: number) => ({
  x: box.left + box.width * fx,
  y: box.top + box.height * fy,
});

for (const [kind, markdown] of [
  ["diagram", DOC],
  ["image", IMAGE],
] as const) {
  describe(`the ${kind} view follows the trackpad (decision 127)`, () => {
    test("a pinch of forty small ctrlKey wheel events zooms by the gesture's size around the pointer, not 1.25x per event", async () => {
      const { view } = await openKind(markdown, kind);
      const before = picture(view).getBoundingClientRect();
      const p = pointIn(before);
      const fx = (p.x - before.left) / before.width;
      const fy = (p.y - before.top) / before.height;
      let prevented = 0;
      for (let i = 0; i < 40; i++)
        if (wheelAt(p.x, p.y, { deltaY: -2, ctrlKey: true })) prevented++;
      expect(prevented, "a pinch must not zoom the page").toBe(40);
      // Panzoom draws on the next frame.
      await frames(1);
      const after = picture(view).getBoundingClientRect();
      // e^0.8 is about 2.23; the old fixed step gave 1.25^40, clamped at 12.
      const ratio = after.width / before.width;
      expect(ratio).toBeGreaterThan(1.5);
      expect(ratio).toBeLessThan(3);
      const moved = at(after, fx, fy);
      expect(Math.abs(moved.x - p.x), "the point under the pointer stays there").toBeLessThan(3);
      expect(Math.abs(moved.y - p.y), "the point under the pointer stays there").toBeLessThan(3);
    });

    test("a plain wheel pans by its delta in screen pixels and does not zoom; with Shift a vertical wheel pans sideways", async () => {
      const { view } = await openKind(markdown, kind);
      const before = picture(view).getBoundingClientRect();
      const p = pointIn(before);
      expect(wheelAt(p.x, p.y, { deltaX: 30, deltaY: 40 }), "the view takes the wheel").toBe(true);
      await frames(1);
      const after = picture(view).getBoundingClientRect();
      expect(after.width).toBeCloseTo(before.width, 3);
      expect(after.left - before.left).toBeCloseTo(-30, 0);
      expect(after.top - before.top).toBeCloseTo(-40, 0);

      expect(wheelAt(p.x, p.y, { deltaY: 40, shiftKey: true })).toBe(true);
      await frames(1);
      const sideways = picture(view).getBoundingClientRect();
      expect(sideways.left - after.left).toBeCloseTo(-40, 0);
      expect(sideways.top - after.top).toBeCloseTo(0, 0);
      expect(sideways.width).toBeCloseTo(before.width, 3);
    });
  });
}

describe("the diagram view tells the mirror about a wheel pan (decisions 106 and 127)", () => {
  // Followers see what the presenter sees: a pan by the wheel is a change of view like a drag.
  test("a plain wheel emits a view event with the new pan", async () => {
    const { view } = await openKind(DOC, "diagram");
    const events: FocusEvent[] = [];
    const stop = observeFocus((event) => events.push(event));
    try {
      const p = pointIn(picture(view).getBoundingClientRect());
      wheelAt(p.x, p.y, { deltaX: 30, deltaY: 40 });
      await frames(1);
      const last = events.filter((e) => e.kind === "view").at(-1);
      expect(last, "a view event after the wheel").toBeDefined();
      expect(last?.kind === "view" && last.x).toBeLessThan(0);
      expect(last?.kind === "view" && last.y).toBeLessThan(0);
      expect(last?.kind === "view" && last.scale).toBeCloseTo(1, 5);
    } finally {
      stop();
    }
  });
});

for (const [kind, markdown] of [
  ["code", WIDE_CODE],
  ["table", WIDE_TABLE],
] as const) {
  describe(`the ${kind} view zooms its type with the gesture (decision 127)`, () => {
    test("forty small ctrlKey wheel events change the type scale smoothly by the gesture's size, not 0.25 per event", async () => {
      const { view, stage } = await openKind(markdown, kind);
      const start = textScale(view);
      const box = stage.getBoundingClientRect();
      const x = box.left + box.width / 3;
      const y = box.top + box.height / 3;
      const seen = [start];
      for (let i = 0; i < 40; i++) {
        expect(wheelAt(x, y, { deltaY: -2, ctrlKey: true }), "a pinch must not zoom the page").toBe(
          true,
        );
        seen.push(textScale(view));
      }
      // Each event moves the scale by e^0.02 at most, never by a quarter step.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]! / seen[i - 1]!).toBeGreaterThanOrEqual(1);
        expect(seen[i]! / seen[i - 1]!).toBeLessThanOrEqual(Math.exp(0.02) + 1e-9);
      }
      const end = seen.at(-1)!;
      expect(end).toBeLessThanOrEqual(4);
      expect(end).toBeGreaterThanOrEqual(0.5);
      expect(end).toBeCloseTo(Math.min(4, start * Math.exp(0.8)), 2);
      expect(end, "the fixture leaves room to zoom in").toBeGreaterThan(start * 1.5);
    });

    test("a plain wheel is left to the browser: not prevented, so native scroll stays, and the scale holds", async () => {
      const { view, stage } = await openKind(markdown, kind);
      const start = textScale(view);
      const box = stage.getBoundingClientRect();
      expect(wheelAt(box.left + 50, box.top + 50, { deltaX: 30, deltaY: 40 })).toBe(false);
      expect(textScale(view)).toBe(start);
    });
  });
}

/** A key pressed on whatever has focus. Returns the event, to read whether it was prevented. */
function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe("the zoom keys leave the browser's own shortcuts alone (decisions 87 and 132)", () => {
  // Ctrl/Cmd + plus, minus and 0 are the browser's page zoom. The view zoomed as well,
  // and a presenter's view sent that zoom to every follower.
  // Short, so Fit lands well inside the type scale's range and a step either way is not clamped.
  const SHORT_CODE = "## Code\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n";

  test("with Ctrl, Cmd or Alt held, +, - and 0 neither zoom nor fit the view, nor take the browser's default", async () => {
    const { view } = await openKind(SHORT_CODE, "code");
    const fit = textScale(view);
    press("-");
    const out = textScale(view);
    expect(out).toBeCloseTo(fit - 0.25, 5);
    const reached: string[] = [];
    const onWindow = (event: KeyboardEvent) => reached.push(event.key);
    window.addEventListener("keydown", onWindow);
    try {
      for (const [key, init] of [
        ["+", { ctrlKey: true }],
        ["=", { ctrlKey: true }],
        ["-", { metaKey: true }],
        ["0", { ctrlKey: true }],
        ["+", { altKey: true }],
      ] as const) {
        const event = press(key, init);
        expect(textScale(view), `${key} with ${Object.keys(init)[0]}`).toBe(out);
        expect(event.defaultPrevented, "the browser's page zoom stays").toBe(false);
      }
      // As before, no key reaches the app's shortcuts behind the view.
      expect(reached).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  test("without a modifier, 0 fits, + and = zoom in (Shift included, as + is Shift+= on many layouts) and - zooms out", async () => {
    const { view } = await openKind(SHORT_CODE, "code");
    const fit = textScale(view);
    expect(fit, "room for a step either way").toBeGreaterThanOrEqual(1.25);
    expect(fit).toBeLessThanOrEqual(3.5);
    press("-");
    expect(textScale(view)).toBeCloseTo(fit - 0.25, 5);
    press("0");
    expect(textScale(view)).toBe(fit);
    press("-");
    press("-");
    press("+", { shiftKey: true });
    expect(textScale(view)).toBeCloseTo(fit - 0.25, 5);
    press("=");
    expect(textScale(view)).toBeCloseTo(fit, 5);
  });
});

describe("Safari's pinch gesture events (decision 127)", () => {
  // WebKit sends gesturestart and gesturechange for a trackpad pinch; left alone they zoom the page.
  test("in a diagram view the scale becomes the start times the gesture's scale, around its point, and the page does not zoom", async () => {
    const { view } = await openKind(DOC, "diagram");
    const before = picture(view).getBoundingClientRect();
    const p = pointIn(before);
    const fx = (p.x - before.left) / before.width;
    const fy = (p.y - before.top) / before.height;
    expect(gestureAt("gesturestart", p.x, p.y, 1)).toBe(true);
    expect(gestureAt("gesturechange", p.x, p.y, 1.2)).toBe(true);
    expect(gestureAt("gesturechange", p.x, p.y, 1.5)).toBe(true);
    await frames(1);
    const after = picture(view).getBoundingClientRect();
    // 1.5 of the start, not 1.2 * 1.5: each change is relative to where the gesture began.
    expect(after.width / before.width).toBeCloseTo(1.5, 2);
    const moved = at(after, fx, fy);
    expect(Math.abs(moved.x - p.x)).toBeLessThan(3);
    expect(Math.abs(moved.y - p.y)).toBeLessThan(3);
  });

  test("in a code view the type scale becomes the start times the gesture's scale", async () => {
    const { view, stage } = await openKind(WIDE_CODE, "code");
    const start = textScale(view);
    const box = stage.getBoundingClientRect();
    const x = box.left + 100;
    const y = box.top + 100;
    expect(gestureAt("gesturestart", x, y, 1)).toBe(true);
    expect(gestureAt("gesturechange", x, y, 1.2)).toBe(true);
    expect(gestureAt("gesturechange", x, y, 1.5)).toBe(true);
    expect(textScale(view)).toBeCloseTo(Math.min(4, start * 1.5), 5);
  });
});

/** A finger on a touch screen, as a pointer event. */
const touch = (type: string, target: Element, id: number, x: number, y: number) =>
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

describe("a two-finger pinch on a touch screen in the code view (decision 127)", () => {
  // The sheet lets the browser pan only (touch-action), so the view sets the type size itself.
  test("two fingers moving apart raise the type scale by the change of their distance", async () => {
    const { view, stage } = await openKind(WIDE_CODE, "code");
    const start = textScale(view);
    const box = stage.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    touch("pointerdown", stage, 1, cx - 50, cy);
    touch("pointerdown", stage, 2, cx + 50, cy);
    touch("pointermove", stage, 2, cx + 100, cy);
    // From 100 px apart to 150 px apart.
    expect(textScale(view)).toBeCloseTo(Math.min(4, start * 1.5), 5);
    touch("pointerup", stage, 2, cx + 100, cy);
    touch("pointerup", stage, 1, cx - 50, cy);
  });

  test("one finger changes nothing: it scrolls, natively", async () => {
    const { view, stage } = await openKind(WIDE_CODE, "code");
    const start = textScale(view);
    const box = stage.getBoundingClientRect();
    touch("pointerdown", stage, 1, box.left + 100, box.top + 100);
    touch("pointermove", stage, 1, box.left + 200, box.top + 160);
    touch("pointerup", stage, 1, box.left + 200, box.top + 160);
    expect(textScale(view)).toBe(start);
  });
});

describe("a Safari gesture is taken or ignored as a whole (decision 127)", () => {
  // On an iPad a two-finger pinch sends pointers and gesture events. The pointers may be
  // cancelled mid-gesture when the browser takes the touch for panning; the gesture's
  // later changes must not then zoom from a scale recorded for some other gesture.
  test("a gesture that began with two fingers down stays ignored after they are cancelled, and a change with no start zooms nothing", async () => {
    const { view, stage } = await openKind(WIDE_CODE, "code");
    const start = textScale(view);
    const box = stage.getBoundingClientRect();
    const x = box.left + 100;
    const y = box.top + 100;
    expect(gestureAt("gesturechange", x, y, 1.3), "the page still does not zoom").toBe(true);
    expect(textScale(view), "no gesturestart since the view opened").toBe(start);

    touch("pointerdown", stage, 1, x - 40, y);
    touch("pointerdown", stage, 2, x + 40, y);
    gestureAt("gesturestart", x, y, 1);
    touch("pointercancel", stage, 1, x - 40, y);
    touch("pointercancel", stage, 2, x + 40, y);
    gestureAt("gesturechange", x, y, 1.1);
    expect(textScale(view), "the gesture began under two fingers").toBe(start);

    // A clean gesture afterwards zooms from where it began.
    gestureAt("gesturestart", x, y, 1);
    gestureAt("gesturechange", x, y, 1.5);
    expect(textScale(view)).toBeCloseTo(Math.min(4, start * 1.5), 5);
  });
});

/** Forty lines too wide and too many for the stage, so it scrolls both ways. */
const BIG_CODE = [
  "## Code",
  "",
  "```text",
  ...Array.from(
    { length: 40 },
    (_, i) => `line ${String(i + 1).padStart(2, "0")} ${"word ".repeat(30)}`,
  ),
  "```",
  "",
].join("\n");
/** A table wider than the stage at Fit, so it scrolls sideways from the start. */
const BIG_TABLE = [
  "## Table",
  "",
  `| ${Array.from({ length: 10 }, (_, i) => `heading number ${i}`).join(" | ")} |`,
  `| ${Array.from({ length: 10 }, () => "---").join(" | ")} |`,
  ...Array.from(
    { length: 12 },
    (_, r) => `| ${Array.from({ length: 10 }, (_c, c) => `row ${r} cell ${c} text`).join(" | ")} |`,
  ),
  "",
].join("\n");

for (const [kind, markdown, selector] of [
  ["code", BIG_CODE, ".docwalk-code-line"],
  ["table", BIG_TABLE, "td, th"],
] as const) {
  describe(`the ${kind} view zooms around the pointer (decision 127)`, () => {
    // Padding, borders and the bar of a line are fixed lengths: a model that scales
    // everything by the zoom ratio lets the text slide away from the pointer.
    test("over a forty-event pinch the line or cell under the pointer stays under it within 2 px", async () => {
      await page.viewport(1280, 800);
      const { view, stage } = await openKind(markdown, kind);
      const box = stage.getBoundingClientRect();
      // A line or cell from the middle of the copy, brought to the middle of the stage.
      const all = [...stage.querySelectorAll<HTMLElement>(selector)];
      const target = all[Math.floor(all.length / 2)]!;
      // Zoom in with the button until the stage scrolls both ways: where it cannot scroll,
      // nothing can hold the point, and the test is about the scroll.
      const zoomIn = view.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
      for (let i = 0; i < 8; i++) {
        if (stage.scrollWidth > stage.clientWidth && stage.scrollHeight > stage.clientHeight) break;
        zoomIn.click();
      }
      expect(stage.scrollWidth, "it scrolls sideways before the pinch").toBeGreaterThan(
        stage.clientWidth,
      );
      expect(stage.scrollHeight, "it scrolls down before the pinch").toBeGreaterThan(
        stage.clientHeight,
      );
      target.scrollIntoView({ block: "center", inline: "center" });
      const start = target.getBoundingClientRect();
      // Off the element's centre, so a zoom around the wrong point shows.
      const x = Math.min(box.right - 20, start.left + start.width * 0.3);
      const y = start.top + start.height * 0.6;
      expect(document.elementFromPoint(x, y)?.closest(selector), "the pointer is over it").toBe(
        target,
      );
      const before = target.getBoundingClientRect();
      const fx = (x - before.left) / before.width;
      const fy = (y - before.top) / before.height;
      for (let i = 0; i < 40; i++) wheelAt(x, y, { deltaY: -2, ctrlKey: true });
      const after = target.getBoundingClientRect();
      expect(after.height / before.height, "the pinch zoomed").toBeGreaterThan(1.5);
      expect(stage.scrollWidth, "it scrolls sideways").toBeGreaterThan(stage.clientWidth);
      expect(stage.scrollHeight, "it scrolls down").toBeGreaterThan(stage.clientHeight);
      expect(Math.abs(after.left + fx * after.width - x)).toBeLessThan(2);
      expect(Math.abs(after.top + fy * after.height - y)).toBeLessThan(2);
    });
  });
}

describe("only the focus overlay takes the wheel (decision 127)", () => {
  // A diagram on a slide or in the document must still let the page scroll past it.
  test("a wheel on a diagram outside the view is not prevented, with or without Ctrl", async () => {
    const deck = mountDeck(DOC);
    await deck.ready(1);
    const diagram = deck.container.querySelector<HTMLElement>(
      ".reveal .slides section.present .docwalk-diagram",
    )!;
    const box = diagram.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    expect(wheelAt(x, y, { deltaY: 40 })).toBe(false);
    expect(wheelAt(x, y, { deltaY: -2, ctrlKey: true })).toBe(false);
    expect(document.querySelector(".docwalk-focus")).toBeNull();
  });
});
