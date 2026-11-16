import { createElement as h, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
// Same fonts as the app, so heights match what readers see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown } from "../sectioning/sectionize";
import { MAP_LASER_SIZE } from "./laser";
import MapView from "./MapView";

/**
 * Decision 149, the map's own laser. `L` and the app (the palette) switch it
 * through MapView's `laser` prop, as App holds it; Escape switches it off.
 * While it is on, a mouse, pen or one finger points and does nothing else,
 * and the wheel, two fingers and the route's keys work as before. The dot is
 * drawn in screen pixels over the pane, so it keeps one size at every zoom.
 * With the laser off nothing here changes the map: MapView.browser.test.ts
 * and MapRoute.browser.test.ts run unchanged for that.
 */

const outside: { setLaser: ((on: boolean) => void) | null } = { setLaser: null };
let reactRoot: ReactRoot | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  reactRoot?.unmount();
  reactRoot = null;
  outside.setLaser = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

/** `prefers-reduced-motion: reduce` as the view and the laser read it. */
function reduceMotion() {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query.includes("prefers-reduced-motion")
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        } as MediaQueryList)
      : real(query),
  );
}

const para = (label: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${label} paragraph ${i + 1} holds a few words so that it fills a line.`,
  ).join("\n\n");

const DOC = [
  "## Alpha",
  "",
  para("Alpha", 2),
  "",
  "See [the gamma part](#gamma).",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "## Beta",
  "",
  para("Beta", 2),
  "",
  "## Gamma",
  "",
  para("Gamma", 2),
  "",
].join("\n");

const PANE = { width: 1200, height: 700 };

interface Mounted {
  container: HTMLElement;
  pane: HTMLElement;
  layer: HTMLElement;
  /** Every laser state MapView asked for, in order. */
  asked: boolean[];
}

/** MapView with the laser held outside it, as App holds it, once its first placement is shown. */
async function mount(markdown = DOC): Promise<Mounted> {
  await page.viewport(PANE.width + 100, PANE.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${PANE.width}px`,
    height: `${PANE.height}px`,
  });
  document.body.append(container);
  const root = parseMarkdown(markdown);
  const asked: boolean[] = [];
  function Harness() {
    const [laser, setLaser] = useState(false);
    useEffect(() => {
      outside.setLaser = setLaser;
    }, []);
    return h(MapView, {
      root,
      laser,
      onLaserChange: (on: boolean) => {
        asked.push(on);
        setLaser(on);
      },
    });
  }
  const react = createRoot(container);
  reactRoot = react;
  flushSync(() => react.render(h(Harness)));
  const pane = container.querySelector<HTMLElement>(".docwalk-map-pane")!;
  const layer = container.querySelector<HTMLElement>(".docwalk-map-layer")!;
  await expect.poll(() => layer.hasAttribute("data-placed"), { timeout: 20_000 }).toBe(true);
  await frames(3);
  return { container, pane, layer, asked };
}

/** Switches the laser from outside, as the palette entry does through App. */
async function switchLaser(on: boolean) {
  flushSync(() => outside.setLaser?.(on));
  await frames(1);
}

/**
 * Sends `keys` to the focused element; says whether the last key was
 * prevented once dispatched, and whether it reached a listener bubbling on
 * window, where App's own Escape listens.
 */
async function press(keys: string): Promise<{ prevented: boolean; reachedWindow: boolean }> {
  let last: KeyboardEvent | null = null;
  let reachedWindow = false;
  const onCapture = (event: KeyboardEvent) => {
    last = event;
    reachedWindow = false;
  };
  const onBubble = () => {
    reachedWindow = true;
  };
  window.addEventListener("keydown", onCapture, true);
  window.addEventListener("keydown", onBubble);
  try {
    await userEvent.keyboard(keys);
  } finally {
    window.removeEventListener("keydown", onCapture, true);
    window.removeEventListener("keydown", onBubble);
  }
  await frames(2);
  return { prevented: (last as KeyboardEvent | null)?.defaultPrevented ?? false, reachedWindow };
}

const frameEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-map-frame="${CSS.escape(id)}"]`)!;

const currentIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-map-frame][aria-current="true"]')].map(
    (el) => el.dataset["mapFrame"],
  );

const statusOf = (pane: HTMLElement) =>
  pane.querySelector<HTMLElement>('[role="status"]')?.textContent ?? null;

const isOn = (pane: HTMLElement) => pane.hasAttribute("data-laser");

const dot = (root: ParentNode = document) =>
  root.querySelector<SVGCircleElement>(".docwalk-map-laser circle");
const trail = (root: ParentNode = document) =>
  root.querySelector<SVGPathElement>(".docwalk-map-laser path");

/** The layer's transform: the camera, as the view wrote it. */
const cameraOf = (layer: HTMLElement) => layer.style.transform;

function centreOf(el: Element) {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, size: box.width };
}

/** A pointer event of `type` sent to whatever is under the point, as a real pointer is. */
function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
  const target = document.elementFromPoint(x, y) ?? document.body;
  const event = new PointerEvent(type, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

const touch = (type: string, id: number, x: number, y: number) =>
  pointer(type, x, y, { pointerId: id, pointerType: "touch", isPrimary: id === 1 });

/** A point inside the pane, away from its edges. */
function inside(pane: HTMLElement, fx = 0.4, fy = 0.5) {
  const p = pane.getBoundingClientRect();
  return { x: p.left + p.width * fx, y: p.top + p.height * fy };
}

describe("switching the laser (decision 149, Switching it on)", () => {
  beforeEach(reduceMotion);

  test("L on the pane switches it on and off, marks the pane and says so politely", async () => {
    const m = await mount();
    m.pane.focus();
    expect(isOn(m.pane)).toBe(false);
    expect((await press("l")).prevented).toBe(true);
    expect(isOn(m.pane)).toBe(true);
    expect(statusOf(m.pane)).toBe("Laser on");
    await press("l");
    expect(isOn(m.pane)).toBe(false);
    expect(statusOf(m.pane)).toBe("Laser off");
    expect(m.asked).toEqual([true, false]);
  });

  test("the cursor goes while the laser is on, over the frames' text and links too", async () => {
    // The dot replaces the cursor, as on the slides (annotate/layer.css).
    const m = await mount();
    const link = frameEl(m.container, "alpha").querySelector("a")!;
    expect(getComputedStyle(m.pane).cursor).not.toBe("none");
    await switchLaser(true);
    expect(getComputedStyle(m.pane).cursor).toBe("none");
    expect(getComputedStyle(link).cursor).toBe("none");
  });

  test("L is a letter in a text field and is left alone with Ctrl, Cmd, Alt or Shift", async () => {
    // Ctrl/Cmd + L is the browser's address bar; Alt + L may type a character;
    // Shift + L is left alone as the slides' L leaves it (useAnnotationShortcuts).
    const m = await mount();
    const field = document.createElement("input");
    frameEl(m.container, "alpha").append(field);
    field.focus();
    await press("l");
    expect(isOn(m.pane)).toBe(false);
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      const event = new KeyboardEvent("keydown", {
        key: "l",
        [mod]: true,
        bubbles: true,
        cancelable: true,
      });
      m.pane.dispatchEvent(event);
      await frames(1);
      expect(isOn(m.pane), `${mod}`).toBe(false);
      expect(event.defaultPrevented, `${mod}`).toBe(false);
    }
    expect(m.asked).toEqual([]);
  });

  test("Escape switches it off and goes no further; with the laser off the map leaves Escape alone", async () => {
    // App's own Escape (leaving Present) listens on window: an Escape that switched
    // the laser off must not also do that.
    const m = await mount();
    m.pane.focus();
    await press("l");
    const on = await press("{Escape}");
    expect(isOn(m.pane)).toBe(false);
    expect(on.prevented).toBe(true);
    expect(on.reachedWindow).toBe(false);
    expect(statusOf(m.pane)).toBe("Laser off");
    const off = await press("{Escape}");
    expect(off.reachedWindow).toBe(true);
    expect(off.prevented).toBe(false);
  });

  test("switched from outside (the palette), the pane follows and says so", async () => {
    const m = await mount();
    await switchLaser(true);
    expect(isOn(m.pane)).toBe(true);
    expect(statusOf(m.pane)).toBe("Laser on");
    await switchLaser(false);
    expect(isOn(m.pane)).toBe(false);
    expect(statusOf(m.pane)).toBe("Laser off");
  });

  test("off, no overlay exists and a pointer draws nothing", async () => {
    const m = await mount();
    const at = inside(m.pane);
    pointer("pointermove", at.x, at.y);
    await frames(2);
    expect(m.pane.querySelector(".docwalk-map-laser")).toBeNull();
  });
});

describe("pointing with a mouse or pen (decision 149, Pointing)", () => {
  beforeEach(reduceMotion);

  test("the dot follows the pointer in pane pixels and has one size at two zooms", async () => {
    const m = await mount();
    m.pane.focus();
    await press("l");
    const at = inside(m.pane, 0.3, 0.4);
    pointer("pointermove", at.x, at.y);
    await frames(1);
    const first = centreOf(dot()!);
    expect(Math.abs(first.x - at.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(first.y - at.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(first.size - MAP_LASER_SIZE)).toBeLessThanOrEqual(0.5);
    // Zoom in twice: the layer scales, the dot does not.
    const before = cameraOf(m.layer);
    await press("++");
    expect(cameraOf(m.layer)).not.toBe(before);
    const next = inside(m.pane, 0.6, 0.3);
    pointer("pointermove", next.x, next.y);
    await frames(1);
    const second = centreOf(dot()!);
    expect(Math.abs(second.x - next.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(second.y - next.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(second.size - first.size)).toBeLessThanOrEqual(0.5);
  });

  test("the overlay is outside the scaled layer and never takes the pointer", async () => {
    const m = await mount();
    await switchLaser(true);
    const overlay = m.pane.querySelector<SVGSVGElement>(".docwalk-map-laser")!;
    expect(m.layer.contains(overlay)).toBe(false);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(overlay).pointerEvents).toBe("none");
  });

  test("a mouse drag from empty map points: the camera and the current frame stay, nothing is selected", async () => {
    // With the laser off this same drag pans (MapView.browser.test.ts).
    const m = await mount();
    m.pane.focus();
    await press("l");
    const alpha = frameEl(m.container, "alpha");
    const camera = cameraOf(m.layer);
    await userEvent.dragAndDrop(alpha, alpha, {
      sourcePosition: { x: 8, y: 8 },
      targetPosition: { x: 208, y: 108 },
    });
    await frames(2);
    expect(cameraOf(m.layer)).toBe(camera);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expect(isOn(m.pane)).toBe(true);
  });

  test("a mouse drag over text selects nothing and moves nothing", async () => {
    const m = await mount();
    m.pane.focus();
    await press("l");
    const text = frameEl(m.container, "alpha").querySelector<HTMLElement>(".docwalk-slide-body p")!;
    const box = text.getBoundingClientRect();
    const camera = cameraOf(m.layer);
    await userEvent.dragAndDrop(text, text, {
      sourcePosition: { x: 2, y: box.height / 2 },
      targetPosition: { x: box.width * 0.6, y: box.height / 2 },
    });
    await frames(2);
    expect(window.getSelection()?.toString() ?? "").toBe("");
    expect(cameraOf(m.layer)).toBe(camera);
  });

  test("a click on a code block opens no focus view, and a click on the whole map chooses no frame", async () => {
    const m = await mount();
    const pre = frameEl(m.container, "alpha").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    m.pane.focus();
    await press("l");
    await userEvent.click(pre);
    await frames(2);
    expect(document.querySelector(".docwalk-focus")).toBeNull();
    // On the whole map (`0`) a click anywhere in a frame would choose it (decision 145).
    await press("0");
    const camera = cameraOf(m.layer);
    await userEvent.click(frameEl(m.container, "beta").querySelector<HTMLElement>("h2")!);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expect(cameraOf(m.layer)).toBe(camera);
  });

  test("a click on a link follows nothing: no heading is focused and the map stays", async () => {
    const m = await mount();
    m.pane.focus();
    await press("l");
    const hash = location.hash;
    const camera = cameraOf(m.layer);
    await userEvent.click(frameEl(m.container, "alpha").querySelector<HTMLElement>("a")!);
    await frames(2);
    const heading = m.container.querySelector("#user-content-gamma");
    expect(document.activeElement).not.toBe(heading);
    expect(location.hash).toBe(hash);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expect(cameraOf(m.layer)).toBe(camera);
  });

  test("a keyboard activation of a link still follows it while the laser is on", async () => {
    // Only the pointer is the laser's; Enter on a focused link is a key (decision 149).
    const m = await mount();
    await switchLaser(true);
    const link = frameEl(m.container, "alpha").querySelector<HTMLElement>("a")!;
    link.focus();
    await press("{Enter}");
    await expect
      .poll(() => document.activeElement)
      .toBe(m.container.querySelector("#user-content-gamma"));
  });

  test("the dot hides when the pointer leaves the pane and on pointercancel", async () => {
    const m = await mount();
    await switchLaser(true);
    const at = inside(m.pane);
    pointer("pointermove", at.x, at.y);
    expect(dot()).not.toBeNull();
    m.pane.dispatchEvent(
      new PointerEvent("pointerleave", { pointerId: 1, pointerType: "mouse", clientX: 0 }),
    );
    expect(dot()).toBeNull();
    pointer("pointermove", at.x, at.y, { pointerType: "pen" });
    expect(dot(), "a pen points too").not.toBeNull();
    pointer("pointercancel", at.x, at.y, { pointerType: "pen" });
    expect(dot()).toBeNull();
  });

  test("the wheel still pans and ArrowRight still walks the route", async () => {
    const m = await mount();
    m.pane.focus();
    await press("l");
    const at = inside(m.pane);
    const camera = cameraOf(m.layer);
    const target = document.elementFromPoint(at.x, at.y)!;
    target.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: at.x,
        clientY: at.y,
        deltaY: 80,
        bubbles: true,
        cancelable: true,
      }),
    );
    await frames(2);
    expect(cameraOf(m.layer)).not.toBe(camera);
    await press("{ArrowRight}");
    expect(currentIds(m.container)).toEqual(["beta"]);
    expect(isOn(m.pane)).toBe(true);
  });

  test("with reduced motion the map's laser draws the dot alone", async () => {
    const m = await mount();
    await switchLaser(true);
    const at = inside(m.pane);
    for (let i = 0; i < 6; i++) {
      pointer("pointermove", at.x + i * 15, at.y);
      await frame();
    }
    expect(dot()).not.toBeNull();
    expect(trail()).toBeNull();
  });
});

describe("the trail on the map (decision 149)", () => {
  test("without reduced motion a moving mouse leaves the slides' trail", async () => {
    const m = await mount();
    await switchLaser(true);
    const at = inside(m.pane);
    for (let i = 0; i < 6; i++) {
      pointer("pointermove", at.x + i * 15, at.y);
      await frame();
    }
    await frame();
    expect(trail()).not.toBeNull();
  });
});

describe("pointing with a finger (decision 149, Pointing)", () => {
  beforeEach(reduceMotion);
  // Synthetic PointerEvents bypass `touch-action`: these tests prove the
  // wiring, not that a browser delivers the moves.

  test("one finger points and does not pan; the dot goes when it lifts", async () => {
    const m = await mount();
    await switchLaser(true);
    const at = inside(m.pane);
    const camera = cameraOf(m.layer);
    touch("pointerdown", 1, at.x, at.y);
    touch("pointermove", 1, at.x + 40, at.y + 30);
    await frames(2);
    expect(cameraOf(m.layer)).toBe(camera);
    const c = centreOf(dot()!);
    expect(Math.abs(c.x - (at.x + 40))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(c.y - (at.y + 30))).toBeLessThanOrEqual(0.5);
    touch("pointerup", 1, at.x + 40, at.y + 30);
    expect(dot()).toBeNull();
    expect(currentIds(m.container)).toEqual(["alpha"]);
  });

  test("two fingers still zoom, and the dot hides while they are down", async () => {
    const m = await mount();
    await switchLaser(true);
    const alpha = frameEl(m.container, "alpha");
    const before = alpha.getBoundingClientRect().width;
    const at = inside(m.pane);
    touch("pointerdown", 1, at.x - 50, at.y);
    touch("pointermove", 1, at.x - 50, at.y);
    expect(dot()).not.toBeNull();
    touch("pointerdown", 2, at.x + 50, at.y);
    expect(dot()).toBeNull();
    // From 100 px apart to 150 px apart.
    touch("pointermove", 2, at.x + 100, at.y);
    expect(dot()).toBeNull();
    touch("pointerup", 2, at.x + 100, at.y);
    await frames(2);
    // The finger left down neither pans nor points until it lifts.
    const zoomed = cameraOf(m.layer);
    touch("pointermove", 1, at.x - 20, at.y + 20);
    expect(dot()).toBeNull();
    touch("pointerup", 1, at.x - 20, at.y + 20);
    await frames(2);
    expect(cameraOf(m.layer)).toBe(zoomed);
    expect(alpha.getBoundingClientRect().width / before).toBeCloseTo(1.5, 3);
  });
});

describe("leaving the map (decision 149)", () => {
  beforeEach(reduceMotion);

  test("unmounting removes the overlay, and a late pointer event draws nothing and throws nothing", async () => {
    const m = await mount();
    await switchLaser(true);
    const at = inside(m.pane);
    pointer("pointermove", at.x, at.y);
    expect(dot()).not.toBeNull();
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    try {
      flushSync(() => reactRoot?.unmount());
      reactRoot = null;
      expect(document.querySelector(".docwalk-map-laser")).toBeNull();
      for (const type of ["pointermove", "pointerdown", "pointerup", "pointercancel"])
        window.dispatchEvent(
          new PointerEvent(type, { pointerId: 1, pointerType: "mouse", clientX: at.x }),
        );
      await frames(2);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
    expect(dot()).toBeNull();
  });
});
