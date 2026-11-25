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
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { type Camera, cameraTransform, fitAll, fitFrame } from "./camera";
import { FRAME_WIDTH } from "./layout";
import MapView, { type MapHandle } from "./MapView";
import { ZOOM_STEP } from "./route";

/**
 * Decision 145, the route on the map: one current frame, marked for the eye
 * and for assistive technology and announced when it changes; keys and
 * clicks that change it; a camera move to it; and the deck section it maps
 * to, reported to the app and taken from it. Where the camera ends is
 * compared with camera.ts's own fit of the frame's placed rectangle, read
 * back from the layer, never with fixed pixel positions.
 */

const outside: {
  setCurrent: ((id: string | null) => void) | null;
  setRequest: ((request: { sectionId: string; seq: number }) => void) | null;
  handle: MapHandle | null;
} = { setCurrent: null, setRequest: null, handle: null };
let requests = 0;

let reactRoot: ReactRoot | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  reactRoot?.unmount();
  reactRoot = null;
  outside.setCurrent = null;
  outside.setRequest = null;
  outside.handle = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

/**
 * `prefers-reduced-motion: reduce` as the view reads it, at the time of each
 * move. Tests that only check where the camera ends use it; the move's own
 * tests leave the real query alone.
 */
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

/**
 * Three columns; the first and the last have `###` frames under the `##`
 * one, which the deck at `auto` shows inside the column's slide.
 */
const ROUTE = [
  "## Alpha",
  "",
  para("Alpha", 2),
  "",
  "See [the gamma detail](#gamma-detail).",
  "",
  "### Alpha one",
  "",
  para("Alpha one", 2),
  "",
  "### Alpha two",
  "",
  para("Alpha two", 2),
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

const ROUTE_IDS = ["alpha", "alpha-one", "alpha-two", "beta", "gamma", "gamma-detail"];

const PANE = { width: 1200, height: 700 };
/** Room for two frames of a column, so a click can reach the second at reading zoom. */
const TALL_PANE = { width: 1200, height: 1500 };

interface Mounted {
  container: HTMLElement;
  pane: HTMLElement;
  layer: HTMLElement;
  /** Every `onCurrent` call, in order. */
  calls: string[];
  /** The app's current deck section changing from outside (a rebuilt deck, a hash change). */
  setCurrent: (id: string | null) => Promise<void>;
  /**
   * The reader choosing a section in the shell (an outline entry, a palette
   * result), as App's goTo does it: the deck goes there and the map gets a
   * request of its own (decision 148).
   */
  choose: (id: string) => Promise<void>;
  /** The phone remote's Next (1) or Previous (-1) as the presenter hands it to the map (decision 152). */
  step: (direction: 1 | -1) => Promise<boolean>;
}

interface Options {
  current?: string | null;
  size?: { width: number; height: number };
  /**
   * As App does: `onCurrent` moves the deck, whose new current section comes
   * back as `current` once React has rendered.
   */
  feedback?: boolean;
  /** The deck's level; the map sections the document itself. */
  level?: Parameters<typeof sectionize>[1];
  /** The map's laser, as App holds it (decision 149). */
  laser?: boolean;
}

/** MapView with the deck's sections at `auto`, once its first placement is shown. */
async function mountRoute(
  markdown: string,
  { current = null, size = PANE, feedback = false, level = "auto", laser = false }: Options = {},
): Promise<Mounted> {
  await page.viewport(size.width + 100, size.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  const root = parseMarkdown(markdown);
  const deckPlan = sectionize(root, level);
  const deckSections = deckPlan.sections;
  const calls: string[] = [];
  function Harness() {
    const [handle, setHandle] = useState<MapHandle | null>(null);
    useEffect(() => {
      outside.handle = handle;
    }, [handle]);
    const [now, setNow] = useState<string | null>(current);
    const [request, setRequest] = useState<{ sectionId: string; seq: number } | null>(null);
    useEffect(() => {
      outside.setCurrent = setNow;
      outside.setRequest = setRequest;
    }, []);
    return h(MapView, {
      ref: setHandle,
      root,
      current: now,
      deckSections,
      deckLevels: deckPlan.levels,
      request,
      laser,
      onCurrent: (id: string) => {
        calls.push(id);
        if (feedback) setNow(id);
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
  return {
    container,
    pane,
    layer,
    calls,
    setCurrent: async (id) => {
      flushSync(() => outside.setCurrent?.(id));
      await frames(2);
    },
    choose: async (id) => {
      requests += 1;
      const seq = requests;
      flushSync(() => {
        outside.setCurrent?.(id);
        outside.setRequest?.({ sectionId: id, seq });
      });
      await frames(2);
    },
    step: async (direction) => {
      const took = outside.handle!.step(direction);
      await frames(2);
      return took;
    },
  };
}

const frameEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-map-frame="${CSS.escape(id)}"]`)!;

/** The ids of the frames marked current: exactly one, the map's current frame. */
const currentIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-map-frame][aria-current="true"]')].map(
    (el) => el.dataset["mapFrame"],
  );

const statusOf = (pane: HTMLElement) =>
  pane.querySelector<HTMLElement>('[role="status"]')?.textContent ?? null;

const paneSize = (pane: HTMLElement) => ({ width: pane.clientWidth, height: pane.clientHeight });
const boundsOf = (layer: HTMLElement) => ({
  width: Number.parseFloat(layer.style.width),
  height: Number.parseFloat(layer.style.height),
});

/** camera.ts's fit of a frame's placed rectangle, as the opening view fits a frame (decision 142). */
function fittedTo(m: Mounted, id: string): Camera {
  const el = frameEl(m.container, id);
  const rect = {
    x: Number.parseFloat(el.style.left),
    y: Number.parseFloat(el.style.top),
    width: FRAME_WIDTH,
  };
  return fitFrame(rect, boundsOf(m.layer), paneSize(m.pane));
}

/** The whole map centred, as `0` shows it. */
const wholeMap = (m: Mounted) => fitAll(boundsOf(m.layer), paneSize(m.pane));

/** The layer's camera, read back from its transform. */
function cameraOf(layer: HTMLElement): Camera {
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
const same = (a: Camera, b: Camera) =>
  Math.abs(a.x - b.x) < 0.01 &&
  Math.abs(a.y - b.y) < 0.01 &&
  Math.abs(a.scale - b.scale) <= 1e-5 * b.scale;

/** Asserts the layer shows `expected`, naming both cameras when it does not. */
function expectAt(m: Mounted, expected: Camera) {
  const actual = cameraOf(m.layer);
  expect(
    same(actual, expected),
    `layer at ${cameraTransform(actual)}, expected ${cameraTransform(expected)}`,
  ).toBe(true);
}

/** Sends `keys` to the focused element and says whether the last key's default was prevented. */
async function press(keys: string): Promise<boolean> {
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

describe("the opening frame (decision 145, Address)", () => {
  beforeEach(reduceMotion);

  test("the map opens on the frame of the deck's current section, fitted as the opening view fits a frame", async () => {
    const m = await mountRoute(ROUTE, { current: "gamma" });
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
  });

  test("with no current section the map opens on the first frame", async () => {
    const m = await mountRoute(ROUTE);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expectAt(m, fittedTo(m, "alpha"));
  });

  test("a map that opened before the deck had a slide goes to the first section that arrives at once, and later ones with the move", async () => {
    // The map's chunk can load before the deck is built: `current` is null at
    // opening. The deck's first slide is still the opening view; an outline
    // entry after it is the reader's choice and is said.
    const m = await mountRoute(ROUTE);
    await m.setCurrent("alpha");
    expect(currentIds(m.container)).toEqual(["alpha"]);
    await m.setCurrent("beta");
    expect(currentIds(m.container)).toEqual(["beta"]);
    expectAt(m, fittedTo(m, "beta"));
    expect(statusOf(m.pane)).toBe("Beta, 4 of 6");
  });

  test("opening says nothing: the status is empty until the frame changes", async () => {
    // A polite status that spoke on open would talk over the view's own name.
    const m = await mountRoute(ROUTE, { current: "beta" });
    expect(statusOf(m.pane)).toBe("");
  });
});

describe("a map that opened before the deck had a slide (decisions 145 and 148)", () => {
  // Motion is not reduced here, so a move would show as in-between cameras.
  test("the first section to arrive places the map at once and says nothing; the next one moves it and is said", async () => {
    const m = await mountRoute(ROUTE);
    const start = cameraOf(m.layer);
    flushSync(() => outside.setCurrent?.("beta"));
    const beta = fittedTo(m, "beta");
    const first = await recordUntil(m.layer, () => same(cameraOf(m.layer), beta), 3);
    expect(currentIds(m.container)).toEqual(["beta"]);
    expect(same(first.at(-1)!, beta)).toBe(true);
    expect(first.filter((c) => !same(c, start) && !same(c, beta))).toEqual([]);
    expect(statusOf(m.pane)).toBe("");
    flushSync(() => outside.setCurrent?.("gamma"));
    const gamma = fittedTo(m, "gamma");
    const second = await recordUntil(m.layer, () => same(cameraOf(m.layer), gamma));
    expect(same(second.at(-1)!, gamma)).toBe(true);
    expect(second.filter((c) => !same(c, beta) && !same(c, gamma)).length).toBeGreaterThan(0);
    expect(statusOf(m.pane)).toBe("Gamma, 5 of 6");
  });
});

describe("the keys from a frame (decision 145, Keys)", () => {
  beforeEach(reduceMotion);

  /** Key, the deck section the map opens on (or End first for the last frame), the frame reached. */
  const STEPS: [string, string, string][] = [
    ["{ArrowRight}", "alpha", "alpha-one"],
    ["{ArrowDown}", "alpha", "alpha-one"],
    ["{PageDown}", "alpha", "alpha-one"],
    [" ", "alpha", "alpha-one"],
    ["{ArrowLeft}", "beta", "alpha-two"],
    ["{ArrowUp}", "beta", "alpha-two"],
    ["{PageUp}", "beta", "alpha-two"],
    // As on the slides: reveal.js reads Shift + Space as the previous slide.
    ["{Shift>} {/Shift}", "beta", "alpha-two"],
    ["{Home}", "gamma", "alpha"],
    ["{End}", "alpha", "gamma-detail"],
    // No wrap: the ends stay.
    ["{ArrowRight}", "end", "gamma-detail"],
    ["{ArrowLeft}", "alpha", "alpha"],
  ];
  for (const [key, from, to] of STEPS) {
    test(`${key} from ${from} goes to ${to}, fitted, and the key is taken`, async () => {
      // The last frame is a ### frame, no deck section: reached with End.
      const m = await mountRoute(ROUTE, { current: from === "end" ? null : from });
      m.pane.focus();
      if (from === "end") await press("{End}");
      expect(await press(key), "the map handles the key").toBe(true);
      expect(currentIds(m.container)).toEqual([to]);
      expectAt(m, fittedTo(m, to));
    });
  }

  test("every frame is reached once, in document order, by Right alone", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const seen = [currentIds(m.container)[0]];
    for (let i = 1; i < ROUTE_IDS.length; i++) {
      await press("{ArrowRight}");
      seen.push(currentIds(m.container)[0]);
    }
    expect(seen).toEqual(ROUTE_IDS);
  });

  test("Plus, = and minus zoom by the focus views' step around the pane's centre, at once", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const start = cameraOf(m.layer);
    const size = paneSize(m.pane);
    const centre = (c: Camera) => ({
      x: (size.width / 2 - c.x) / c.scale,
      y: (size.height / 2 - c.y) / c.scale,
    });
    expect(await press("+")).toBe(true);
    const zoomed = cameraOf(m.layer);
    expect(zoomed.scale / start.scale).toBeCloseTo(ZOOM_STEP, 4);
    expect(centre(zoomed).x).toBeCloseTo(centre(start).x, 1);
    expect(centre(zoomed).y).toBeCloseTo(centre(start).y, 1);
    await press("-");
    expect(cameraOf(m.layer).scale).toBeCloseTo(start.scale, 4);
    await press("=");
    expect(cameraOf(m.layer).scale / start.scale).toBeCloseTo(ZOOM_STEP, 4);
    // A zoom is no frame change.
    expect(currentIds(m.container)).toEqual(["alpha"]);
  });

  test("with Ctrl, Cmd or Alt the keys are left to the browser and the app", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const before = m.layer.style.transform;
    for (const key of [
      "{Control>}{ArrowRight}{/Control}",
      "{Meta>}{ArrowRight}{/Meta}",
      "{Alt>}{ArrowRight}{/Alt}",
      "{Control>}0{/Control}",
    ]) {
      expect(await press(key), `${key}`).toBe(false);
      expect(currentIds(m.container), `${key}`).toEqual(["alpha"]);
      expect(m.layer.style.transform, `${key}`).toBe(before);
    }
  });

  test("a key typed in a text field moves nothing, in the page or inside a frame", async () => {
    const m = await mountRoute(ROUTE);
    const before = m.layer.style.transform;
    const inPage = document.createElement("input");
    document.body.append(inPage);
    const inFrame = document.createElement("input");
    frameEl(m.container, "alpha").querySelector(".docwalk-slide-body")!.append(inFrame);
    for (const input of [inPage, inFrame]) {
      input.focus();
      expect(await press("{ArrowRight}")).toBe(false);
      await press("0");
      expect(currentIds(m.container)).toEqual(["alpha"]);
      expect(m.layer.style.transform).toBe(before);
    }
  });
});

describe("the whole map (decision 145, Keys)", () => {
  beforeEach(reduceMotion);

  test("0 shows the whole map, centred; 0 again returns to the current frame", async () => {
    const m = await mountRoute(ROUTE, { current: "beta" });
    m.pane.focus();
    expect(await press("0")).toBe(true);
    expectAt(m, wholeMap(m));
    const p = m.pane.getBoundingClientRect();
    for (const id of ROUTE_IDS) {
      const b = frameEl(m.container, id).getBoundingClientRect();
      expect(
        b.left >= p.left && b.right <= p.right && b.top >= p.top && b.bottom <= p.bottom,
        `${id}`,
      ).toBe(true);
    }
    // The current frame stays current, and marked, while the map is whole.
    expect(currentIds(m.container)).toEqual(["beta"]);
    expect(await press("0")).toBe(true);
    expectAt(m, fittedTo(m, "beta"));
  });

  test("0 then Enter returns to the current frame", async () => {
    const m = await mountRoute(ROUTE, { current: "beta" });
    m.pane.focus();
    await press("0");
    expect(await press("{Enter}")).toBe(true);
    expect(currentIds(m.container)).toEqual(["beta"]);
    expectAt(m, fittedTo(m, "beta"));
  });

  for (const [key, to] of [
    ["{ArrowRight}", "gamma"],
    ["{ArrowLeft}", "alpha-two"],
    ["{Home}", "alpha"],
    ["{End}", "gamma-detail"],
  ] as const) {
    test(`0 then ${key} goes to ${to} from the current frame`, async () => {
      const m = await mountRoute(ROUTE, { current: "beta" });
      m.pane.focus();
      await press("0");
      expect(await press(key)).toBe(true);
      expect(currentIds(m.container)).toEqual([to]);
      expectAt(m, fittedTo(m, to));
    });
  }

  test("a zoom ends the whole map: Enter after it is no longer taken", async () => {
    // The chosen rule: the whole map ends with any zoom or pan by the reader
    // or a move to a frame; Enter and 0 again return only from the whole map.
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    await press("0");
    await press("+");
    const zoomed = m.layer.style.transform;
    expect(await press("{Enter}")).toBe(false);
    expect(m.layer.style.transform).toBe(zoomed);
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

describe("keys a focused block uses itself (decision 145, Keys)", () => {
  beforeEach(reduceMotion);

  test("an arrow scrolls a wide code block while it can, and goes to the next frame at its edge", async () => {
    // A keyboard user reads a long line by scrolling the block (decision 144).
    const m = await mountRoute(WIDE);
    const pre = frameEl(m.container, "wide").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.tabIndex, { timeout: 20_000 }).toBe(0);
    expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
    pre.focus();
    expect(await press("{ArrowRight}"), "the block scrolls").toBe(false);
    expect(currentIds(m.container)).toEqual(["wide"]);
    pre.scrollLeft = pre.scrollWidth;
    await frames(1);
    expect(await press("{ArrowRight}"), "at the edge the route takes it").toBe(true);
    expect(currentIds(m.container)).toEqual(["next"]);
  });

  test("Enter on a code block opens the focus view and moves nothing; keys in the view stay there", async () => {
    const m = await mountRoute(WIDE);
    const pre = frameEl(m.container, "wide").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    pre.focus();
    const before = m.layer.style.transform;
    await press("{Enter}");
    const overlay = document.querySelector<HTMLElement>(".docwalk-focus");
    expect(overlay?.dataset["kind"]).toBe("code");
    await press("{ArrowRight}");
    await press("0");
    expect(currentIds(m.container)).toEqual(["wide"]);
    expect(m.layer.style.transform).toBe(before);
    await press("{Escape}");
    expect(document.querySelector(".docwalk-focus")).toBeNull();
  });
});

describe("the current frame's marks (decision 145, Current frame)", () => {
  beforeEach(reduceMotion);

  test("aria-current is on exactly one frame, and moves with the current frame", async () => {
    const m = await mountRoute(ROUTE);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    m.pane.focus();
    await press("{End}");
    expect(currentIds(m.container)).toEqual(["gamma-detail"]);
    expect(frameEl(m.container, "alpha").hasAttribute("aria-current")).toBe(false);
  });

  test("the current frame has a ring of the same screen width at reading zoom and on the whole map", async () => {
    // The layer is scaled; a ring of a fixed map width would vanish when the
    // map is whole. Compared ring to ring, never with a pixel count.
    const m = await mountRoute(ROUTE);
    const el = frameEl(m.container, "alpha");
    const ringOf = () => {
      const style = getComputedStyle(el);
      return {
        style: style.outlineStyle,
        onScreen: Number.parseFloat(style.outlineWidth) * cameraOf(m.layer).scale,
      };
    };
    const reading = ringOf();
    expect(reading.style).not.toBe("none");
    expect(reading.onScreen).toBeGreaterThanOrEqual(1);
    m.pane.focus();
    await press("0");
    const whole = ringOf();
    expect(cameraOf(m.layer).scale).toBeLessThan(0.5);
    // Within a pixel: the engine may snap an outline's width to whole pixels.
    expect(Math.abs(whole.onScreen - reading.onScreen)).toBeLessThan(1);
    expect(getComputedStyle(frameEl(m.container, "beta")).outlineStyle).toBe("none");
  });

  test("the status says the new frame's title and place, once it changes", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    await press("{ArrowRight}");
    expect(statusOf(m.pane)).toBe("Alpha one, 2 of 6");
    await press("{End}");
    expect(statusOf(m.pane)).toBe("Gamma detail, 6 of 6");
    // One status, in the pane and outside the scaled layer.
    expect(m.pane.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(m.layer.querySelector('[role="status"]')).toBeNull();
  });

  test("a frame with no title is named by its place", async () => {
    const m = await mountRoute("Lead text before any heading.\n\n## A\n\nText.\n");
    m.pane.focus();
    await press("{ArrowRight}");
    expect(statusOf(m.pane)).toBe("A, 2 of 2");
    await press("{ArrowLeft}");
    expect(statusOf(m.pane)).toBe("Section 1 of 2");
  });
});

describe("the deck section the map reports and follows (decision 145, Address)", () => {
  beforeEach(reduceMotion);

  test("stepping through a column's ### frames reports nothing; a new column reports its section once", async () => {
    const m = await mountRoute(ROUTE, { current: "alpha", feedback: true });
    m.pane.focus();
    await press("{ArrowRight}");
    await press("{ArrowRight}");
    expect(m.calls).toEqual([]);
    await press("{ArrowRight}");
    expect(m.calls).toEqual(["beta"]);
    await press("{ArrowLeft}");
    expect(m.calls).toEqual(["beta", "alpha"]);
  });

  test("the section coming back from the app does not move the map off a ### frame", async () => {
    // onCurrent -> App -> current: the deck's section is the column's, and the
    // map must stay on the column's third frame, not bounce to its head.
    const m = await mountRoute(ROUTE, { current: "alpha", feedback: true });
    m.pane.focus();
    await press("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowLeft}");
    await frames(3);
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expectAt(m, fittedTo(m, "alpha-two"));
  });

  test("a current section from outside moves the map only when it maps to another section", async () => {
    const m = await mountRoute(ROUTE, { current: "alpha" });
    m.pane.focus();
    await press("{ArrowRight}{ArrowRight}");
    const there = m.layer.style.transform;
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    // The deck's slide comes back unchanged (a rebuilt deck): nothing moves.
    await m.setCurrent(null);
    await m.setCurrent("alpha");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expect(m.layer.style.transform).toBe(there);
    await m.setCurrent("gamma");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
    expect(statusOf(m.pane)).toBe("Gamma, 5 of 6");
    // A section the app chose is not reported back.
    expect(m.calls).toEqual([]);
  });
});

describe("a choice in the shell (decision 148)", () => {
  beforeEach(reduceMotion);

  test("choosing the deck's current section moves the map to its frame, the column's head", async () => {
    // The reader is on a later frame of the column; the outline entry or
    // palette result for the column's section must still take them there.
    const m = await mountRoute(ROUTE, { current: "alpha", feedback: true });
    m.pane.focus();
    await press("{ArrowRight}{ArrowRight}");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    await m.choose("alpha");
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expectAt(m, fittedTo(m, "alpha"));
    expect(statusOf(m.pane)).toBe("Alpha, 1 of 6");
    expect(m.calls).toEqual([]);
  });

  test("the same choice twice moves the map twice", async () => {
    const m = await mountRoute(ROUTE, { current: "beta" });
    await m.choose("beta");
    const p = m.pane.getBoundingClientRect();
    m.pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 200,
        clientX: p.left + 40,
        clientY: p.top + 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    await frames(2);
    expect(same(cameraOf(m.layer), fittedTo(m, "beta"))).toBe(false);
    await m.choose("beta");
    expectAt(m, fittedTo(m, "beta"));
  });
});

describe("focus follows the route (decision 148)", () => {
  beforeEach(reduceMotion);

  test("a key that leaves the frame holding focus moves focus to the pane, and the next key still walks", async () => {
    const m = await mountRoute(ROUTE);
    const link = frameEl(m.container, "alpha").querySelector<HTMLElement>(
      'a[href="#gamma-detail"]',
    )!;
    link.focus();
    await frames(1);
    await press("{ArrowDown}");
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expect(document.activeElement).toBe(m.pane);
    await press("{ArrowDown}");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
  });
});

describe("the deck's slide levels (decision 148)", () => {
  beforeEach(reduceMotion);

  test("under a level override a frame the deck shows as a breadcrumb reports the slide after it", async () => {
    const md = "## Z\n\nz\n\n## A\n\n### A1\n\ntext\n";
    const m = await mountRoute(md, { current: "z", level: 3 });
    m.pane.focus();
    await press("{ArrowRight}");
    expect(currentIds(m.container)).toEqual(["a"]);
    expect(m.calls).toEqual(["a1"]);
  });
});

describe("the pointer (decision 145, Pointer)", () => {
  beforeEach(reduceMotion);

  test("a click on a frame's heading makes it current and moves to it", async () => {
    const m = await mountRoute(ROUTE, { size: TALL_PANE, feedback: true });
    const heading = frameEl(m.container, "alpha-one").querySelector<HTMLElement>("h3")!;
    await userEvent.click(heading);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
  });

  test("a click on a frame's empty area makes it current; a click on its text does not", async () => {
    const m = await mountRoute(ROUTE, { size: TALL_PANE });
    const target = frameEl(m.container, "alpha-one");
    await userEvent.click(target.querySelector<HTMLElement>("p")!);
    await frames(2);
    expect(currentIds(m.container), "text at reading zoom").toEqual(["alpha"]);
    await userEvent.click(target, { position: { x: 8, y: 8 } });
    await frames(2);
    expect(currentIds(m.container), "the frame's padding").toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
  });

  test("a click on the current frame's heading at reading zoom moves nothing", async () => {
    const m = await mountRoute(ROUTE, { size: TALL_PANE });
    const p = m.pane.getBoundingClientRect();
    // Away from the fit, so a move back would show.
    m.pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 30,
        clientX: p.left + 40,
        clientY: p.top + 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    await frames(2);
    const before = m.layer.style.transform;
    await userEvent.click(frameEl(m.container, "alpha").querySelector<HTMLElement>("h2")!);
    await frames(2);
    expect(m.layer.style.transform).toBe(before);
  });

  test("on the whole map a click anywhere in a frame goes there, and opens or follows nothing", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    await press("0");
    // A link in Alpha, which would go to Gamma detail at reading zoom.
    const link = frameEl(m.container, "alpha").querySelector<HTMLElement>(
      'a[href="#gamma-detail"]',
    )!;
    await userEvent.click(link);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expectAt(m, fittedTo(m, "alpha"));
    expect(document.activeElement?.id).not.toBe("user-content-gamma-detail");
    await press("0");
    // Text in Beta: a reader picking a section, not selecting.
    await userEvent.click(frameEl(m.container, "beta").querySelector<HTMLElement>("p")!);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["beta"]);
    expectAt(m, fittedTo(m, "beta"));
  });

  test("on the whole map a click on a code block goes to its frame and opens no focus view", async () => {
    const m = await mountRoute(`${ROUTE}\n## Code\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n`);
    const pre = frameEl(m.container, "code").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    m.pane.focus();
    await press("0");
    await userEvent.click(pre);
    await frames(2);
    expect(document.querySelector(".docwalk-focus")).toBeNull();
    expect(currentIds(m.container)).toEqual(["code"]);
    expectAt(m, fittedTo(m, "code"));
  });

  test("a drag on the whole map pans, chooses no frame and ends the whole map", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    await press("0");
    const beta = frameEl(m.container, "beta");
    await userEvent.dragAndDrop(beta, beta, {
      sourcePosition: { x: 2, y: 2 },
      targetPosition: { x: 82, y: 42 },
    });
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expect(same(cameraOf(m.layer), wholeMap(m))).toBe(false);
    const panned = m.layer.style.transform;
    expect(await press("{Enter}")).toBe(false);
    expect(m.layer.style.transform).toBe(panned);
  });

  test("a selection left from before does not stop a click on the whole map from choosing its frame", async () => {
    // Row 148: only a selection that changed during the press is a drag.
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    getSelection()!.selectAllChildren(frameEl(m.container, "beta").querySelector("p")!);
    await press("0");
    await userEvent.click(frameEl(m.container, "beta"), { position: { x: 1, y: 1 } });
    await frames(2);
    expect(currentIds(m.container)).toEqual(["beta"]);
  });

  test("a selection left from before does not stop a click on a frame's empty area at reading zoom", async () => {
    const m = await mountRoute(ROUTE, { size: TALL_PANE });
    const target = frameEl(m.container, "alpha-one");
    getSelection()!.selectAllChildren(target.querySelector("p")!);
    await userEvent.click(target, { position: { x: 8, y: 8 } });
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
  });

  test("a drag that selects a frame's heading still chooses nothing", async () => {
    const m = await mountRoute(ROUTE, { size: TALL_PANE });
    const heading = frameEl(m.container, "alpha-one").querySelector<HTMLElement>("h3")!;
    const box = heading.getBoundingClientRect();
    await userEvent.dragAndDrop(heading, heading, {
      sourcePosition: { x: 2, y: box.height / 2 },
      targetPosition: { x: box.width * 0.6, y: box.height / 2 },
    });
    await frames(2);
    expect(getSelection()!.toString().length).toBeGreaterThan(3);
    expect(currentIds(m.container)).toEqual(["alpha"]);
  });

  test("a pan released outside the pane does not swallow the next click", async () => {
    // Row 148: no click follows such a pan, so nothing may wait for one.
    const m = await mountRoute(ROUTE);
    const away = document.createElement("div");
    Object.assign(away.style, { width: "200px", height: "40px" });
    document.body.append(away);
    await userEvent.dragAndDrop(frameEl(m.container, "alpha"), away, {
      sourcePosition: { x: 2, y: 2 },
      targetPosition: { x: 100, y: 20 },
    });
    await frames(2);
    const link = frameEl(m.container, "alpha").querySelector<HTMLElement>(
      'a[href="#gamma-detail"]',
    )!;
    link.focus();
    await press("{Enter}");
    await frames(2);
    expect(currentIds(m.container)).toEqual(["gamma-detail"]);
  });
});

describe("links and Tab (decision 145, The move; WCAG 2.4.11)", () => {
  test("a link to a heading in another frame makes that frame current and moves to it", async () => {
    reduceMotion();
    const m = await mountRoute(ROUTE, { feedback: true });
    await userEvent.click(
      frameEl(m.container, "alpha").querySelector<HTMLElement>('a[href="#gamma-detail"]')!,
    );
    await frames(2);
    expect(currentIds(m.container)).toEqual(["gamma-detail"]);
    expect(document.activeElement?.id).toBe("user-content-gamma-detail");
    expect(m.calls).toEqual(["gamma"]);
  });

  test("Tab into a far frame makes that frame current at once, without a move", async () => {
    // The move is not reduced here: focus must never sit off screen while the camera travels.
    const far = [
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
    const m = await mountRoute(far);
    m.pane.focus();
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("the far link");
    expect(currentIds(m.container)).toEqual(["last"]);
    await frames(1);
    const p = m.pane.getBoundingClientRect();
    const b = document.activeElement!.getBoundingClientRect();
    expect(b.left >= p.left && b.right <= p.right && b.top >= p.top && b.bottom <= p.bottom).toBe(
      true,
    );
  });
});

/** A Mermaid block, as the lines of a Markdown document. */
const diagram = (dir: string) => ["```mermaid", `flowchart ${dir}`, "  a --> b", "```"];

/** Records the layer's transform once per animation frame until `done` or `limit` frames. */
async function recordUntil(layer: HTMLElement, done: () => boolean, limit = 120) {
  const seen = [cameraOf(layer)];
  for (let i = 0; i < limit && !done(); i++) {
    await frame();
    seen.push(cameraOf(layer));
  }
  return seen;
}

describe("the move (decision 145, The move)", () => {
  test("the camera passes through in-between places and ends exactly on the frame's fit", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const start = cameraOf(m.layer);
    await userEvent.keyboard("{End}");
    const end = fittedTo(m, "gamma-detail");
    const seen = await recordUntil(m.layer, () => same(cameraOf(m.layer), end));
    expect(same(seen.at(-1)!, end)).toBe(true);
    expect(seen.filter((c) => !same(c, start) && !same(c, end)).length).toBeGreaterThan(0);
    await frames(5);
    expectAt(m, end);
  });

  test("with reduced motion the camera jumps: no place between the two ends", async () => {
    reduceMotion();
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const start = cameraOf(m.layer);
    await userEvent.keyboard("{End}");
    const end = fittedTo(m, "gamma-detail");
    const seen = await recordUntil(m.layer, () => same(cameraOf(m.layer), end), 3);
    expect(same(seen.at(-1)!, end)).toBe(true);
    expect(seen.filter((c) => !same(c, start) && !same(c, end))).toEqual([]);
  });

  test("a wheel during the move stops it where it is and pans from there", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    await userEvent.keyboard("{End}");
    const end = fittedTo(m, "gamma-detail");
    await frames(2);
    const p = m.pane.getBoundingClientRect();
    m.pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 5,
        clientX: p.left + 40,
        clientY: p.top + 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    await frames(30);
    const after = m.layer.style.transform;
    expect(same(cameraOf(m.layer), end)).toBe(false);
    await frames(5);
    expect(m.layer.style.transform).toBe(after);
  });

  test("a move started in a hidden tab, which gets no animation frames, still arrives", async () => {
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const end = fittedTo(m, "gamma-detail");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    cleanups.push(() => {
      delete (document as { hidden?: boolean }).hidden;
    });
    m.pane.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    // Read in the same task: no frame has run, and none would in a hidden tab.
    expect(currentIds(m.container)).toEqual(["gamma-detail"]);
    expectAt(m, end);
    raf.mockRestore();
  });

  test("a frame that moves while the camera travels to it is where the move ends", async () => {
    // A late image or an edit changes a height mid-move; the move must not end on a stale rectangle.
    const m = await mountRoute(ROUTE);
    m.pane.focus();
    const topBefore = Number.parseFloat(frameEl(m.container, "gamma-detail").style.top);
    await userEvent.keyboard("{End}");
    const more = document.createElement("p");
    more.textContent = "A late block. ".repeat(300);
    frameEl(m.container, "gamma").querySelector(".docwalk-slide-body")!.append(more);
    await expect
      .poll(() => Number.parseFloat(frameEl(m.container, "gamma-detail").style.top))
      .toBeGreaterThan(topBefore + 10);
    await frames(30);
    expectAt(m, fittedTo(m, "gamma-detail"));
  });

  test(
    "diagrams are drawn where the move ends, not in the frames it passes",
    { timeout: 60_000 },
    async () => {
      const doc = [
        "## Start",
        "",
        para("Start", 2),
        "",
        ...["One", "Two"].flatMap((n) => [`## Column ${n}`, "", para(n, 2), ""]),
        "## Middle",
        "",
        ...diagram("LR"),
        "",
        ...["Four", "Five"].flatMap((n) => [`## Column ${n}`, "", para(n, 2), ""]),
        "## Last",
        "",
        ...diagram("TD"),
        "",
      ].join("\n");
      const m = await mountRoute(doc);
      m.pane.focus();
      await userEvent.keyboard("{End}");
      const last = frameEl(m.container, "last");
      await expect
        .poll(() => last.querySelector(".docwalk-diagram svg"), { timeout: 20_000 })
        .not.toBeNull();
      const middle = frameEl(m.container, "middle");
      expect(middle.querySelector(".docwalk-diagram")).toBeNull();
      expect(middle.querySelector("pre > code.language-mermaid")).not.toBeNull();
    },
  );
});

/** A `## title` section holding a code block with one long line. */
const WIDE_BLOCK = (title: string) => [
  `## ${title}`,
  "",
  "```text",
  `log ${"key=value ".repeat(60)}`,
  "```",
];

describe("a step from the phone remote (decision 152)", () => {
  beforeEach(reduceMotion);

  /** Step, the deck section the map opens on, the frame reached: the arrow keys' own table. */
  const STEPS: [1 | -1, string, string][] = [
    [1, "alpha", "alpha-one"],
    [1, "alpha-one", "alpha-two"],
    [1, "alpha-two", "beta"],
    [-1, "beta", "alpha-two"],
    [-1, "gamma", "beta"],
    // No wrap: the ends stay.
    [-1, "alpha", "alpha"],
  ];
  for (const [direction, from, to] of STEPS) {
    test(`step ${direction} from ${from} goes to ${to}, fitted, as the arrow key does`, async () => {
      // A ### frame is no deck section: the map opens on its column's head and walks there.
      const head = from.startsWith("alpha-") ? "alpha" : from;
      const m = await mountRoute(ROUTE, { current: head });
      for (let i = ROUTE_IDS.indexOf(head); i < ROUTE_IDS.indexOf(from); i++) await m.step(1);
      expect(currentIds(m.container)).toEqual([from]);
      await m.step(direction);
      expect(currentIds(m.container)).toEqual([to]);
      expectAt(m, fittedTo(m, to));
    });
  }

  test("at the last frame it stays: no wrap, no move, nothing reported", async () => {
    const m = await mountRoute(ROUTE, { feedback: true });
    m.pane.focus();
    await press("{End}");
    const there = m.layer.style.transform;
    const reported = [...m.calls];
    await m.step(1);
    expect(currentIds(m.container)).toEqual(["gamma-detail"]);
    expect(m.layer.style.transform).toBe(there);
    expect(m.calls).toEqual(reported);
  });

  test("every frame is reached once in document order by steps alone, and back again", async () => {
    const m = await mountRoute(ROUTE);
    const seen = [currentIds(m.container)[0]];
    for (let i = 1; i < ROUTE_IDS.length; i++) {
      await m.step(1);
      seen.push(currentIds(m.container)[0]);
    }
    expect(seen).toEqual(ROUTE_IDS);
    for (let i = ROUTE_IDS.length - 2; i >= 0; i--) {
      await m.step(-1);
      expect(currentIds(m.container)).toEqual([ROUTE_IDS[i]]);
    }
  });

  test("a part made by a thematic break is a frame of the route, as it is for the arrow keys", async () => {
    const m = await mountRoute(
      [
        "## A",
        "",
        "Before the break.",
        "",
        "---",
        "",
        "After the break.",
        "",
        "## B",
        "",
        "Text.",
      ].join("\n"),
    );
    const ids = [...m.container.querySelectorAll<HTMLElement>("[data-map-frame]")].map(
      (el) => el.dataset["mapFrame"]!,
    );
    expect(ids).toHaveLength(3);
    await m.step(1);
    expect(currentIds(m.container)).toEqual([ids[1]]);
    await m.step(1);
    expect(currentIds(m.container)).toEqual([ids[2]]);
  });

  test("from the whole map it goes from the current frame, not from the first one", async () => {
    const m = await mountRoute(ROUTE, { current: "beta" });
    m.pane.focus();
    await press("0");
    expectAt(m, wholeMap(m));
    await m.step(1);
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
  });

  test("it moves with keyboard focus in a text field outside the pane, which the arrow keys cannot", async () => {
    // A remote press must not depend on focus: the pane's key rules skip a text field.
    const m = await mountRoute(ROUTE);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(currentIds(m.container)).toEqual(["alpha"]);
    await m.step(1);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
    expect(document.activeElement).toBe(field);
  });

  test("it moves with the laser on, which keeps the pane's keys but must not keep the remote out", async () => {
    const m = await mountRoute(ROUTE, { laser: true });
    expect(m.pane.hasAttribute("data-laser")).toBe(true);
    await m.step(1);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
    expect(m.pane.hasAttribute("data-laser")).toBe(true);
  });

  test("a step inside a column reports nothing; one into another column reports its section once, as the keys do", async () => {
    // The deck follows at section level: the map reports a section, and the
    // deck's address (and so the phone's slide number) changes only then.
    const m = await mountRoute(ROUTE, { current: "alpha", feedback: true });
    await m.step(1);
    await m.step(1);
    expect(m.calls).toEqual([]);
    await m.step(1);
    expect(m.calls).toEqual(["beta"]);
    await m.step(-1);
    expect(m.calls).toEqual(["beta", "alpha"]);
  });

  test("a step at the first or last frame leaves an open code view open, as Next on the last slide does", async () => {
    // Nothing changes on the slides there (no slidechanged), so nothing closes the view.
    const last = await mountRoute(["## First", "", "Text.", "", ...WIDE_BLOCK("Last")].join("\n"));
    last.pane.focus();
    await press("{End}");
    const pre = frameEl(last.container, "last").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    pre.focus();
    await press("{Enter}");
    expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("code");
    const took = await last.step(1);
    expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("code");
    expect(currentIds(last.container)).toEqual(["last"]);
    expect(took, "the map took the step, refitting in place").toBe(true);
  });

  test("a step before the first frame leaves an open code view open", async () => {
    const m = await mountRoute([...WIDE_BLOCK("First"), "", "## Second", "", "Text."].join("\n"));
    const pre = frameEl(m.container, "first").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    pre.focus();
    await press("{Enter}");
    expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("code");
    const took = await m.step(-1);
    expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("code");
    expect(currentIds(m.container)).toEqual(["first"]);
    expect(took, "the map took the step, refitting in place").toBe(true);
  });

  test("a step the map is not ready for says so: false with no camera yet, true once it has one, also at an end", async () => {
    // The pane has no size, so there is no opening view and no camera to move.
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.append(container);
    const held: { current: MapHandle | null } = { current: null };
    const react = createRoot(container);
    reactRoot = react;
    flushSync(() =>
      react.render(
        h(MapView, {
          root: parseMarkdown(ROUTE),
          ref: (instance: MapHandle | null) => {
            held.current = instance;
          },
        }),
      ),
    );
    await frames(3);
    expect(held.current!.step(1)).toBe(false);
    expect(held.current!.step(-1)).toBe(false);

    const m = await mountRoute(ROUTE);
    expect(await m.step(-1), "at the first frame").toBe(true);
    expect(await m.step(1)).toBe(true);
  });

  test("it closes an open code view, as a slide change does on the slides", async () => {
    const m = await mountRoute(WIDE);
    const pre = frameEl(m.container, "wide").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.dataset["docwalkFocus"], { timeout: 20_000 }).toBe("code");
    pre.focus();
    await press("{Enter}");
    expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("code");
    await m.step(1);
    expect(document.querySelector(".docwalk-focus")).toBeNull();
    expect(currentIds(m.container)).toEqual(["next"]);
    expectAt(m, fittedTo(m, "next"));
  });

  test(
    "it leaves an open diagram view open, as a slide change does on the slides",
    { timeout: 60_000 },
    async () => {
      const m = await mountRoute(
        ["## One", "", ...diagram("LR"), "", "## Two", "", para("Two", 2), ""].join("\n"),
      );
      const host = frameEl(m.container, "one");
      await expect
        .poll(() => host.querySelector(".docwalk-diagram svg"), { timeout: 20_000 })
        .not.toBeNull();
      await userEvent.click(host.querySelector<HTMLElement>(".docwalk-diagram")!);
      await expect
        .poll(() => document.querySelector(".docwalk-focus")?.getAttribute("data-kind"))
        .toBe("diagram");
      await m.step(1);
      expect(currentIds(m.container)).toEqual(["two"]);
      expect(document.querySelector(".docwalk-focus")?.getAttribute("data-kind")).toBe("diagram");
    },
  );
});
