import { expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { type Camera, cameraTransform, fitFrame } from "./camera";
import { FRAME_WIDTH } from "./layout";

/**
 * What the map's browser tests share: the helpers whose copies were the same
 * line for line, or the same up to a parameter. A helper whose copies differ
 * in behaviour (each file's `mount`, `press` of MapLaser, `touch`, `DOC`)
 * stays in its test file, so a reader sees what that file's tests run on.
 */

/** The pane most tests open the map in. */
export const PANE = { width: 1200, height: 700 };

export const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

export const para = (label: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${label} paragraph ${i + 1} holds a few words so that it fills a line.`,
  ).join("\n\n");

/**
 * `prefers-reduced-motion: reduce` as the view reads it, at the time of each
 * move. Tests that only check where the camera ends use it; the move's own
 * tests leave the real query alone. Needs `vi.restoreAllMocks()` after each test.
 */
export function reduceMotion() {
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

// The Mermaid chunk can fail to load (a lost connection, a new deploy), as in
// src/deck/mermaidLoad.browser.test.ts: while `failing` is set, `initialize`
// throws, so the load rejects the way a missing chunk does and the figure is
// marked `data-load-failed` (decision 146). A load that succeeded stays
// loaded for the page and `vi.resetModules()` gives no fresh `mermaid.ts` in
// browser mode, so a load-failure test is the first of its file. `vi.mock`
// stays in the test file, which hands the real module to `failableMermaid`:
//
//   vi.mock("mermaid", async (importOriginal) =>
//     (await import("./testMap")).failableMermaid(await importOriginal<typeof import("mermaid")>()),
//   );
export const mermaidLoad = { failing: false };

export function failableMermaid(real: typeof import("mermaid")) {
  const mermaid = new Proxy(real.default, {
    get(target, key, receiver) {
      if (mermaidLoad.failing && key === "initialize")
        throw new TypeError("Failed to fetch dynamically imported module");
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...real, default: mermaid };
}

/** The parts of a mounted map the camera helpers read. */
export interface MapParts {
  container: HTMLElement;
  pane: HTMLElement;
  layer: HTMLElement;
}

/**
 * An empty grid container of `size` CSS px, in a viewport 100 px larger than
 * `viewport` (default `size`), for a test to render MapView into.
 */
export async function mapContainer(
  size: { width: number; height: number },
  viewport = size,
): Promise<HTMLElement> {
  await page.viewport(viewport.width + 100, viewport.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  return container;
}

/** The pane and the layer of the map rendered into `container`, once the layer has its first placement. */
export async function placedMap(container: HTMLElement) {
  const pane = container.querySelector<HTMLElement>(".docwalk-map-pane")!;
  const layer = container.querySelector<HTMLElement>(".docwalk-map-layer")!;
  await expect.poll(() => layer.hasAttribute("data-placed"), { timeout: 20_000 }).toBe(true);
  await frames(3);
  return { pane, layer };
}

export const frameEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-map-frame="${CSS.escape(id)}"]`)!;

/** The ids of the frames marked current: exactly one, the map's current frame. */
export const currentIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-map-frame][aria-current="true"]')].map(
    (el) => el.dataset["mapFrame"],
  );

export const statusOf = (pane: HTMLElement) =>
  pane.querySelector<HTMLElement>('[role="status"]')?.textContent ?? null;

export const paneSize = (pane: HTMLElement) => ({
  width: pane.clientWidth,
  height: pane.clientHeight,
});
export const boundsOf = (layer: HTMLElement) => ({
  width: Number.parseFloat(layer.style.width),
  height: Number.parseFloat(layer.style.height),
});

/** camera.ts's fit of a frame's placed rectangle, as the opening view fits a frame (decision 142). */
export function fittedTo(m: MapParts, id: string): Camera {
  const el = frameEl(m.container, id);
  const rect = {
    x: Number.parseFloat(el.style.left),
    y: Number.parseFloat(el.style.top),
    width: FRAME_WIDTH,
  };
  return fitFrame(rect, boundsOf(m.layer), paneSize(m.pane));
}

/** The layer's camera, read back from its transform. */
export function cameraOf(layer: HTMLElement): Camera {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
    layer.style.transform,
  );
  if (!match) throw new Error(`no camera in "${layer.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/**
 * Whether two cameras draw the same: the style keeps six significant digits
 * of each number (`scale(0.272727)`), so the comparison allows that rounding.
 */
export const same = (a: Camera, b: Camera) =>
  Math.abs(a.x - b.x) < 0.01 &&
  Math.abs(a.y - b.y) < 0.01 &&
  Math.abs(a.scale - b.scale) <= 1e-5 * b.scale;

/** Asserts the layer shows `expected`, naming both cameras when it does not. */
export function expectAt(m: MapParts, expected: Camera) {
  const actual = cameraOf(m.layer);
  expect(
    same(actual, expected),
    `layer at ${cameraTransform(actual)}, expected ${cameraTransform(expected)}`,
  ).toBe(true);
}

/** Sends `keys` to the focused element and says whether the last key's default was prevented. */
export async function press(keys: string): Promise<boolean> {
  let prevented = false;
  const onKey = (event: KeyboardEvent) => {
    prevented = event.defaultPrevented;
  };
  // Bubbling on window runs after the pane's own listener.
  window.addEventListener("keydown", onKey);
  try {
    await userEvent.keyboard(keys);
  } finally {
    window.removeEventListener("keydown", onKey);
  }
  await frames(2);
  return prevented;
}
