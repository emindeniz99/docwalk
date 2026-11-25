import { act, createElement as h, useEffect, useState } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
// Same fonts as the app, so heights match what readers see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown } from "../sectioning/sectionize";
import { type Camera, fitFrame } from "./camera";
import { FRAME_WIDTH } from "./layout";
import { MOVE_MS } from "./route";
import MapView, { type MapHandle } from "./MapView";

/**
 * Decision 154, the map's own "Present the map" control. MapView draws the
 * button in the pane, outside the scaled layer, when the app gives it
 * `presenting`; a follow screen's map is given none. While the app says the
 * map is presented, the pane has a new size (the header and the outline are
 * gone), and the map fits its current frame to it, as it does at opening: a
 * map that only clamped its camera would keep the old scale in a pane twice
 * as large, and the presenter would read a small map in a big room.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outside: {
  setOn: ((on: boolean) => void) | null;
  setLaser: ((on: boolean) => void) | null;
  handle: MapHandle | null;
} = { setOn: null, setLaser: null, handle: null };
let reactRoot: ReactRoot | null = null;

afterEach(() => {
  act(() => reactRoot?.unmount());
  reactRoot = null;
  outside.setOn = null;
  outside.setLaser = null;
  outside.handle = null;
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

const DOC = ["## Alpha", "", para("Alpha", 2), "", "## Beta", "", para("Beta", 2), ""].join("\n");

const SMALL = { width: 800, height: 500 };
const LARGE = { width: 1500, height: 900 };

interface Mounted {
  container: HTMLElement;
  pane: HTMLElement;
  layer: HTMLElement;
  /** What the button asked for, in order. */
  asked: string[];
  /** The laser states the map asked the app for, in order. */
  laserAsked: boolean[];
  handle: () => MapHandle | null;
  resize: (size: { width: number; height: number }) => Promise<void>;
  /** The app switching the map's laser. */
  laser: (on: boolean) => Promise<void>;
  /** The app saying the map is (not) presented. */
  present: (on: boolean) => Promise<void>;
}

/** MapView as App mounts it, with or without the presenting control, in a pane of `SMALL`. */
async function mount({ presenting = true }: { presenting?: boolean } = {}): Promise<Mounted> {
  await page.viewport(LARGE.width + 100, LARGE.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${SMALL.width}px`,
    height: `${SMALL.height}px`,
  });
  document.body.append(container);
  const asked: string[] = [];
  const laserAsked: boolean[] = [];
  const mapRoot = parseMarkdown(DOC);
  function Harness() {
    const [on, setOn] = useState(false);
    const [laser, setLaser] = useState(false);
    const [handle, setHandle] = useState<MapHandle | null>(null);
    useEffect(() => {
      outside.setOn = setOn;
      outside.setLaser = setLaser;
    }, []);
    useEffect(() => {
      outside.handle = handle;
    }, [handle]);
    return h(MapView, {
      ref: setHandle,
      root: mapRoot,
      laser,
      onLaserChange: (next: boolean) => laserAsked.push(next),
      ...(presenting
        ? {
            presenting: {
              on,
              start: () => asked.push("start"),
              stop: () => asked.push("stop"),
            },
          }
        : {}),
    });
  }
  const react = createRoot(container);
  reactRoot = react;
  act(() => react.render(h(Harness)));
  const pane = container.querySelector<HTMLElement>(".docwalk-map-pane")!;
  const layer = container.querySelector<HTMLElement>(".docwalk-map-layer")!;
  await expect.poll(() => layer.hasAttribute("data-placed"), { timeout: 20_000 }).toBe(true);
  await frames(3);
  return {
    container,
    pane,
    layer,
    asked,
    laserAsked,
    handle: () => outside.handle,
    resize: async (size) => {
      container.style.width = `${size.width}px`;
      container.style.height = `${size.height}px`;
      await frames(3);
    },
    laser: async (on) => {
      act(() => outside.setLaser?.(on));
      await frames(3);
    },
    present: async (on) => {
      act(() => outside.setOn?.(on));
      await frames(3);
    },
  };
}

const presentButton = (m: Mounted) =>
  [...m.pane.querySelectorAll<HTMLElement>("button")].find((b) =>
    /Present the map|Exit/.test(b.textContent ?? ""),
  );

function cameraOf(layer: HTMLElement): Camera {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
    layer.style.transform,
  );
  if (!match) throw new Error(`no camera in "${layer.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/** What opening the map on the current frame gives in the pane's present size. */
function fittedCurrent(m: Mounted): Camera {
  const el = m.layer.querySelector<HTMLElement>('[data-map-frame][aria-current="true"]')!;
  const rect = {
    x: Number.parseFloat(el.style.left),
    y: Number.parseFloat(el.style.top),
    width: FRAME_WIDTH,
  };
  const bounds = {
    width: Number.parseFloat(m.layer.style.width),
    height: Number.parseFloat(m.layer.style.height),
  };
  return fitFrame(rect, bounds, { width: m.pane.clientWidth, height: m.pane.clientHeight });
}

const sameCamera = (a: Camera, b: Camera) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.scale - b.scale) < 1e-4;

/**
 * The pointer moves onto the button from elsewhere in the pane, so it really moves: a pointer
 * left resting there by an earlier test would open no tooltip (QuietTooltipTrigger).
 */
async function hoverButton(m: Mounted) {
  await userEvent.hover(m.pane);
  await userEvent.hover(presentButton(m)!);
}

describe("the Present the map button (decision 154)", () => {
  test("a map given no presenting control, as a follow screen's is, draws no button", async () => {
    const m = await mount({ presenting: false });
    expect(presentButton(m)).toBeUndefined();
  });

  test("it is a 44 px target in the pane, outside the scaled layer, named by its words", async () => {
    const m = await mount();
    const el = presentButton(m)!;
    expect(el, "a button in the pane").toBeDefined();
    expect(el.textContent).toBe("Present the map");
    expect(m.layer.contains(el), "outside the scaled layer").toBe(false);
    expect(m.pane.contains(el)).toBe(true);
    expect(el.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    // A corner, wholly inside the pane, so it covers no more of the map than its own box.
    const box = el.getBoundingClientRect();
    const pane = m.pane.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(pane.left);
    expect(box.right).toBeLessThanOrEqual(pane.right);
    expect(box.top).toBeGreaterThanOrEqual(pane.top);
    expect(box.bottom).toBeLessThanOrEqual(pane.bottom);
  });

  test("pressing it asks the app to present, and once presented it is Exit, which asks to stop", async () => {
    const m = await mount();
    await userEvent.click(presentButton(m)!);
    expect(m.asked).toEqual(["start"]);
    await m.present(true);
    const exit = presentButton(m)!;
    expect(exit.textContent).toBe("Exit");
    expect(exit.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(exit);
    expect(m.asked).toEqual(["start", "stop"]);
  });

  test("with the laser on a press on the button is still a press: the laser points at nothing there", async () => {
    // The laser swallows a pointer's click on the map (decision 149); Exit must work while the
    // presenter points, or the only way out would be a key.
    const m = await mount();
    await m.present(true);
    await m.laser(true);
    await userEvent.click(presentButton(m)!);
    expect(m.asked).toEqual(["stop"]);
  });

  test("Exit names its key in its tooltip, as Exit does on the slides (decision 133)", async () => {
    // A tablet with no keyboard has the button; a keyboard has the tooltip.
    const m = await mount();
    await m.present(true);
    await hoverButton(m);
    await expect
      .poll(() => document.querySelector('[role="tooltip"]')?.textContent, { timeout: 5_000 })
      .toBe("Exit Esc");
  });

  test("Escape while Exit's tooltip is open still leaves, as on the slides", async () => {
    // React Aria closes an open tooltip on Escape and stops the key at the document, so the
    // app's own Escape never hears it: the button leaves for it (decision 133).
    const m = await mount();
    await m.present(true);
    await hoverButton(m);
    await expect.poll(() => document.querySelector('[role="tooltip"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(m.asked).toEqual(["stop"]);
  });

  test("with the laser on, the Escape Exit's tooltip took goes to the laser, not to Exit", async () => {
    // Presented in the window (full screen refused, or after an earlier Escape) with the laser
    // on: that Escape is the laser's (decisions 149 and 154), and ending the presenting with
    // the laser still on would be the wrong answer to it. The tooltip stops the key before the
    // pane hears it, so the button hands it to the laser.
    const m = await mount();
    await m.present(true);
    await m.laser(true);
    await hoverButton(m);
    await expect.poll(() => document.querySelector('[role="tooltip"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(m.asked, "still presented").toEqual([]);
    expect(m.laserAsked, "the laser asked to go off").toEqual([false]);

    // The laser is off now (the app says so); the next Escape leaves.
    await m.laser(false);
    await hoverButton(m);
    await expect.poll(() => document.querySelector('[role="tooltip"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(m.asked).toEqual(["stop"]);
  });

  test("the pane takes keyboard focus when the app asks for it", async () => {
    const m = await mount();
    act(() => presentButton(m)!.focus());
    act(() => m.handle()?.focus());
    expect(document.activeElement).toBe(m.pane);
  });
});

describe("fitting the current frame to the pane's new size (decision 154)", () => {
  test("presenting refits the current frame to a pane that has grown", async () => {
    const m = await mount();
    const before = cameraOf(m.layer);
    expect(sameCamera(before, fittedCurrent(m)), "fitted at opening").toBe(true);

    await m.resize(LARGE);
    await m.present(true);
    const presented = cameraOf(m.layer);
    expect(presented.scale, "a larger pane shows the frame larger").toBeGreaterThan(before.scale);
    expect(sameCamera(presented, fittedCurrent(m))).toBe(true);
  });

  test("leaving refits it again, once the pane has its windowed size back", async () => {
    // In the app the order is this one: the app says the map is no longer presented, and the pane
    // shrinks after it (the header comes back, the window leaves full screen). A map that refitted
    // only when told would fit the old, large pane and keep that scale in the small one.
    const m = await mount();
    await m.resize(LARGE);
    await m.present(true);
    expect(cameraOf(m.layer).scale).toBeGreaterThan(0.9);

    await m.present(false);
    await m.resize(SMALL);
    expect(sameCamera(cameraOf(m.layer), fittedCurrent(m))).toBe(true);
    expect(cameraOf(m.layer).scale).toBeLessThan(0.7);
  });

  test("a resize with nothing presented only clamps, as before (the control for the test above)", async () => {
    const m = await mount();
    const before = cameraOf(m.layer);
    await m.resize(LARGE);
    expect(cameraOf(m.layer).scale).toBeCloseTo(before.scale, 6);
  });

  test("a resize while presented keeps the frame fitted", async () => {
    // Full screen settles in steps (the header goes, then the window changes size).
    const m = await mount();
    await m.present(true);
    await m.resize(LARGE);
    expect(sameCamera(cameraOf(m.layer), fittedCurrent(m))).toBe(true);
    await m.resize({ width: 1100, height: 700 });
    expect(sameCamera(cameraOf(m.layer), fittedCurrent(m))).toBe(true);
  });

  test("a zoom by hand survives a later resize while presented: it is only clamped", async () => {
    // A notice closing or opening above the map resizes the pane in mid-talk (the banner row
    // stays); the presenter's own zoom must not be thrown away by it.
    const m = await mount();
    await m.present(true);
    await m.resize(LARGE);
    const fitted = cameraOf(m.layer);
    act(() => m.pane.focus());
    await userEvent.keyboard("+");
    await frames(3);
    const zoomed = cameraOf(m.layer);
    expect(zoomed.scale, "zoomed in").toBeGreaterThan(fitted.scale);

    await m.resize({ width: 1400, height: 800 });
    expect(cameraOf(m.layer).scale).toBeCloseTo(zoomed.scale, 6);
    await m.resize(LARGE);
    expect(cameraOf(m.layer).scale).toBeCloseTo(zoomed.scale, 6);
  });

  test("a move along the route fits as before, and a later resize keeps that frame fitted", async () => {
    const m = await mount();
    await m.present(true);
    await m.resize(LARGE);
    act(() => m.pane.focus());
    await userEvent.keyboard("+");
    await frames(3);
    await userEvent.keyboard("{ArrowRight}");
    await new Promise((resolve) => setTimeout(resolve, MOVE_MS + 300));
    await frames(2);
    expect(sameCamera(cameraOf(m.layer), fittedCurrent(m))).toBe(true);

    await m.resize({ width: 1100, height: 700 });
    expect(sameCamera(cameraOf(m.layer), fittedCurrent(m))).toBe(true);
  });
});
