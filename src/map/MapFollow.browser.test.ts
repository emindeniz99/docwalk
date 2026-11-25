import { createElement as h, useEffect, useMemo, useState } from "react";
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
import { type Camera, cameraTransform, fitFrame } from "./camera";
import { FRAME_WIDTH } from "./layout";
import MapView from "./MapView";

/**
 * Decision 150, the map on a follow screen. App gives the map the
 * presenter's section as `current` and sets `follow`; the map follows that
 * section with 145's move until the follower moves the map themselves. Any
 * pan, zoom, route key or click that chooses a frame starts a roam: the
 * presenter's changes stop moving the map, a "Back to presenter" button
 * shows in the pane, and that button or Escape returns to the presenter's
 * section. A follower's map reports nothing (it must not move the follower's
 * deck, which stays on the presenter's slide) and has no laser. Where the
 * camera ends is compared with camera.ts's fit of the frame's placed
 * rectangle, never with fixed pixel positions.
 */

const ROAMING = "Roaming the map on your own. Press Escape to go back to the presenter.";
const BACK = "Following the presenter again";

const outside: {
  setCurrent: ((id: string | null) => void) | null;
  setPresenter: ((at: { section: string | null; frame: string | null }) => void) | null;
  setDocument: ((markdown: string) => void) | null;
} = { setCurrent: null, setPresenter: null, setDocument: null };
let reactRoot: ReactRoot | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  reactRoot?.unmount();
  reactRoot = null;
  outside.setCurrent = null;
  outside.setPresenter = null;
  outside.setDocument = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function frames(n: number) {
  for (let i = 0; i < n; i++) await frame();
}

/** `prefers-reduced-motion: reduce`: these tests check where the camera ends, not the move. */
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

/** Three columns; the first has two `###` frames, which the deck at `auto` shows inside its slide. */
const DOC = [
  "## Alpha",
  "",
  para("Alpha", 2),
  "",
  "```ts",
  "const answer = 42;",
  "```",
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
  "See [the alpha part](#alpha).",
  "",
].join("\n");

const PANE = { width: 1200, height: 700 };
/** Room for two frames of a column, so a click can reach the second at reading zoom. */
const TALL_PANE = { width: 1200, height: 1500 };

interface Mounted {
  container: HTMLElement;
  pane: HTMLElement;
  layer: HTMLElement;
  /** Every `onCurrent` call: a follower's map must make none. */
  calls: string[];
  /** Every laser state the map asked App for. */
  asked: boolean[];
  /**
   * The presenter's section changing, as App passes it from the room's state,
   * with the frame the state names (decision 153), if any.
   */
  presenter: (id: string, frame?: string | null) => Promise<void>;
  /** The follower's document changing, as when the presenter's link finishes loading. */
  setDocument: (markdown: string) => Promise<void>;
}

/** MapView as App mounts it on a follow screen (`follow`), or as the presenter's own map. */
async function mount({
  current = "alpha",
  frame: presenterFrame = null,
  follow = true,
  size = PANE,
  doc = DOC,
}: {
  current?: string;
  frame?: string | null;
  follow?: boolean;
  size?: { width: number; height: number };
  doc?: string;
} = {}) {
  await page.viewport(size.width + 100, size.height + 100);
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  const calls: string[] = [];
  const asked: boolean[] = [];
  function Harness() {
    const [shown, setShown] = useState<{ section: string | null; frame: string | null }>({
      section: current,
      frame: presenterFrame,
    });
    const [markdown, setMarkdown] = useState(doc);
    const root = useMemo(() => parseMarkdown(markdown), [markdown]);
    const deckPlan = useMemo(() => sectionize(root, "auto"), [root]);
    useEffect(() => {
      outside.setCurrent = (id) => setShown({ section: id, frame: null });
      outside.setPresenter = setShown;
      outside.setDocument = setMarkdown;
    }, []);
    return h(MapView, {
      root,
      current: shown.section,
      frame: shown.frame,
      deckSections: deckPlan.sections,
      deckLevels: deckPlan.levels,
      follow,
      onCurrent: (id: string) => calls.push(id),
      laser: false,
      onLaserChange: (on: boolean) => asked.push(on),
    });
  }
  const react = createRoot(container);
  reactRoot = react;
  flushSync(() => react.render(h(Harness)));
  const pane = container.querySelector<HTMLElement>(".docwalk-map-pane")!;
  const layer = container.querySelector<HTMLElement>(".docwalk-map-layer")!;
  await expect.poll(() => layer.hasAttribute("data-placed"), { timeout: 20_000 }).toBe(true);
  await frames(3);
  const mounted: Mounted = {
    container,
    pane,
    layer,
    calls,
    asked,
    presenter: async (id, frame = null) => {
      flushSync(() => outside.setPresenter?.({ section: id, frame }));
      await frames(2);
    },
    setDocument: async (markdown) => {
      flushSync(() => outside.setDocument?.(markdown));
      await frames(3);
    },
  };
  return mounted;
}

const frameEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-map-frame="${CSS.escape(id)}"]`)!;

const currentIds = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-map-frame][aria-current="true"]')].map(
    (el) => el.dataset["mapFrame"],
  );

const statusOf = (pane: HTMLElement) =>
  pane.querySelector<HTMLElement>('[role="status"]')?.textContent ?? null;

/** The "Back to presenter" button, or null while the follower follows. */
const backButton = (pane: HTMLElement) =>
  [...pane.querySelectorAll("button")].find((b) => b.textContent === "Back to presenter") ?? null;

function fittedTo(m: Mounted, id: string): Camera {
  const el = frameEl(m.container, id);
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

function cameraOf(layer: HTMLElement): Camera {
  const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
    layer.style.transform,
  );
  if (!match) throw new Error(`no camera in "${layer.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/** The style keeps six significant digits of each number, so the comparison allows that rounding. */
const same = (a: Camera, b: Camera) =>
  Math.abs(a.x - b.x) < 0.01 &&
  Math.abs(a.y - b.y) < 0.01 &&
  Math.abs(a.scale - b.scale) <= 1e-5 * b.scale;

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
  window.addEventListener("keydown", onKey);
  try {
    await userEvent.keyboard(keys);
  } finally {
    window.removeEventListener("keydown", onKey);
  }
  await frames(2);
  return prevented;
}

/** A point in the pane, in client coordinates. */
function at(pane: HTMLElement, fx: number, fy: number) {
  const p = pane.getBoundingClientRect();
  return { clientX: p.left + p.width * fx, clientY: p.top + p.height * fy };
}

async function wheel(pane: HTMLElement, init: WheelEventInit) {
  pane.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, ...at(pane, 0.5, 0.5), ...init }),
  );
  await frames(2);
}

/** A mouse drag that starts on the pane itself, empty map (decision 142). */
async function drag(pane: HTMLElement) {
  const from = at(pane, 0.5, 0.02);
  const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0 };
  pane.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...from }));
  for (let i = 1; i <= 5; i++)
    pane.dispatchEvent(
      new PointerEvent("pointermove", {
        ...base,
        clientX: from.clientX - 20 * i,
        clientY: from.clientY + 10 * i,
      }),
    );
  pane.dispatchEvent(
    new PointerEvent("pointerup", { ...base, clientX: from.clientX - 100, clientY: from.clientY }),
  );
  await frames(2);
}

/** Starts a roam with the Right key, from focus on the pane. */
async function roamByKey(m: Mounted) {
  m.pane.focus();
  await press("{ArrowRight}");
  expect(currentIds(m.container)).toEqual(["alpha-one"]);
  expect(backButton(m.pane)).not.toBeNull();
}

describe("following the presenter (decision 150, What a follower sees)", () => {
  beforeEach(reduceMotion);

  test("the map opens on the frame of the presenter's section and reports nothing", async () => {
    const m = await mount({ current: "beta" });
    expect(currentIds(m.container)).toEqual(["beta"]);
    expectAt(m, fittedTo(m, "beta"));
    expect(backButton(m.pane)).toBeNull();
    expect(m.calls).toEqual([]);
  });

  test("each change of the presenter's section moves the map to its frame", async () => {
    const m = await mount({ current: "alpha" });
    await m.presenter("gamma");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
    await m.presenter("beta");
    expectAt(m, fittedTo(m, "beta"));
    expect(backButton(m.pane)).toBeNull();
    expect(m.calls).toEqual([]);
  });

  test("Escape while following does nothing and is left to the page", async () => {
    const m = await mount({ current: "beta" });
    m.pane.focus();
    expect(await press("{Escape}")).toBe(false);
    expectAt(m, fittedTo(m, "beta"));
    expect(backButton(m.pane)).toBeNull();
  });
});

describe("following the presenter's frame (decision 153, The room)", () => {
  beforeEach(reduceMotion);

  test("the presenter's section alpha with the frame alpha-one puts the follower on alpha-one", async () => {
    // The state's `current` is the column's section; the frame says which of its frames.
    const m = await mount({ current: "alpha", frame: "alpha-one" });
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
    expect(backButton(m.pane)).toBeNull();
    expect(m.calls, "a follower's map still reports nothing").toEqual([]);
  });

  test("a change of frame inside one section moves the map, and a state with no frame goes back to the section's frame", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-one" });
    await m.presenter("alpha", "alpha-two");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expectAt(m, fittedTo(m, "alpha-two"));
    // A state that carries no frame (an older presenter, or one whose state was too large).
    await m.presenter("alpha", null);
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expectAt(m, fittedTo(m, "alpha"));
    await m.presenter("beta", null);
    expect(currentIds(m.container)).toEqual(["beta"]);
    await m.presenter("alpha", "alpha-one");
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expect(m.calls).toEqual([]);
  });

  test("a frame this map does not have falls back to the frame of the presenter's section", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-nine" });
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expectAt(m, fittedTo(m, "alpha"));
    await m.presenter("beta", "alpha-nine");
    expect(currentIds(m.container)).toEqual(["beta"]);
  });

  test("the frame is a frame id and nothing else: a section's name that is no frame id of the map changes nothing", async () => {
    const m = await mount({ current: "beta", frame: "not-a-frame-here" });
    expect(currentIds(m.container)).toEqual(["beta"]);
    expectAt(m, fittedTo(m, "beta"));
  });

  test("Back to presenter ends a roam on the presenter's frame, not on the column's first frame", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-one" });
    m.pane.focus();
    await press("{ArrowRight}");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expect(backButton(m.pane)).not.toBeNull();
    backButton(m.pane)!.focus();
    await press("{Enter}");
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expectAt(m, fittedTo(m, "alpha-one"));
    expect(backButton(m.pane)).toBeNull();
  });

  test("Escape ends a roam on the presenter's latest frame, whichever the follower roamed to", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-one" });
    m.pane.focus();
    await press("{End}");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    // The presenter walked on while the follower roamed: the map did not move.
    await m.presenter("alpha", "alpha-two");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    await press("{Escape}");
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expectAt(m, fittedTo(m, "alpha-two"));
    expect(statusOf(m.pane)).toBe(BACK);
  });

  test("while the follower roams, the presenter's frames do not move the map", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-one" });
    await wheel(m.pane, { deltaY: 200 });
    const held = cameraOf(m.layer);
    await m.presenter("alpha", "alpha-two");
    expect(same(cameraOf(m.layer), held)).toBe(true);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
  });

  test("a follower whose document has not caught up shows the frame of the section until its map has the presenter's frame", async () => {
    // The follower loads the presenter's document after the first state: the
    // heading is still "Alpha twoo" here, so the frame alpha-two is not on this map.
    const m = await mount({
      current: "alpha",
      frame: "alpha-two",
      doc: DOC.replace("### Alpha two", "### Alpha twoo"),
    });
    expect(currentIds(m.container)).toEqual(["alpha"]);
    await m.setDocument(DOC);
    expect(currentIds(m.container)).toEqual(["alpha-two"]);
    expectAt(m, fittedTo(m, "alpha-two"));
  });

  test("the presenter's own map ignores a frame it is handed: only a follower follows one", async () => {
    const m = await mount({ current: "alpha", frame: "alpha-one", follow: false });
    expect(currentIds(m.container)).toEqual(["alpha"]);
  });
});

describe("roaming (decision 150, Roaming)", () => {
  beforeEach(reduceMotion);

  const STARTS: [string, (m: Mounted) => Promise<void>][] = [
    ["a wheel pan", (m) => wheel(m.pane, { deltaY: 120 })],
    ["a Ctrl + wheel zoom", (m) => wheel(m.pane, { deltaY: 120, ctrlKey: true })],
    ["a mouse drag on empty map", (m) => drag(m.pane)],
    [
      "the zoom key",
      async (m) => {
        m.pane.focus();
        await press("-");
      },
    ],
    [
      "a route key",
      async (m) => {
        m.pane.focus();
        await press("{ArrowRight}");
      },
    ],
    [
      "the whole-map key",
      async (m) => {
        m.pane.focus();
        await press("0");
      },
    ],
  ];

  for (const [name, start] of STARTS) {
    test(`${name} starts a roam: the button shows, the status says it, and the presenter no longer moves the map`, async () => {
      const m = await mount({ current: "alpha" });
      await start(m);
      expect(backButton(m.pane)).not.toBeNull();
      expect(statusOf(m.pane)).toBe(ROAMING);
      const held = cameraOf(m.layer);
      const heldFrame = currentIds(m.container);
      await m.presenter("gamma");
      expect(same(cameraOf(m.layer), held), "the camera stays where the follower put it").toBe(
        true,
      );
      expect(currentIds(m.container)).toEqual(heldFrame);
      expect(m.calls, "a follower's map reports nothing").toEqual([]);
    });
  }

  test("a click on another frame's heading starts a roam on that frame", async () => {
    const m = await mount({ current: "alpha", size: TALL_PANE });
    const heading = frameEl(m.container, "alpha-one").querySelector<HTMLElement>("h3")!;
    await userEvent.click(heading);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["alpha-one"]);
    expect(backButton(m.pane)).not.toBeNull();
    expect(m.calls).toEqual([]);
  });

  test("the button returns to the presenter's latest section, goes, and leaves focus on the pane", async () => {
    const m = await mount({ current: "alpha" });
    await roamByKey(m);
    await m.presenter("beta");
    await m.presenter("gamma");
    backButton(m.pane)!.focus();
    await press("{Enter}");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
    expect(backButton(m.pane)).toBeNull();
    expect(statusOf(m.pane)).toBe(BACK);
    // The button is gone; focus must not fall to <body>.
    expect(document.activeElement).toBe(m.pane);
    // Following again: the presenter's next change moves the map.
    await m.presenter("beta");
    expectAt(m, fittedTo(m, "beta"));
    expect(m.calls).toEqual([]);
  });

  test("a pointer click on the button returns as well", async () => {
    const m = await mount({ current: "beta" });
    await wheel(m.pane, { deltaY: 200 });
    await userEvent.click(backButton(m.pane)!);
    await frames(2);
    expectAt(m, fittedTo(m, "beta"));
    expect(backButton(m.pane)).toBeNull();
  });

  test("Escape on the map ends the roam and moves to the presenter's section", async () => {
    const m = await mount({ current: "alpha" });
    await roamByKey(m);
    await m.presenter("gamma");
    expect(await press("{Escape}")).toBe(true);
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
    expect(backButton(m.pane)).toBeNull();
    expect(statusOf(m.pane)).toBe(BACK);
  });

  test("with a focus view open, Escape closes the view and the roam goes on", async () => {
    const m = await mount({ current: "beta", size: TALL_PANE });
    m.pane.focus();
    await press("{Home}");
    expect(currentIds(m.container)).toEqual(["alpha"]);
    const pre = frameEl(m.container, "alpha").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.hasAttribute("data-docwalk-focus"), { timeout: 20_000 }).toBe(true);
    pre.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector(".docwalk-focus")).not.toBeNull();
    await press("{Escape}");
    expect(document.querySelector(".docwalk-focus")).toBeNull();
    expect(currentIds(m.container)).toEqual(["alpha"]);
    expect(backButton(m.pane), "the view's Escape is the view's").not.toBeNull();
    await press("{Escape}");
    expect(currentIds(m.container)).toEqual(["beta"]);
    expect(backButton(m.pane)).toBeNull();
  });

  test("the button is a 44 px target outside the scaled layer, the first Tab stop after the pane", async () => {
    const m = await mount({ current: "alpha" });
    await roamByKey(m);
    const button = backButton(m.pane)!;
    expect(m.layer.contains(button)).toBe(false);
    expect(m.pane.contains(button)).toBe(true);
    const box = button.getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // Inside the pane, whatever the camera does.
    const p = m.pane.getBoundingClientRect();
    expect(box.left >= p.left && box.right <= p.right).toBe(true);
    expect(box.top >= p.top && box.bottom <= p.bottom).toBe(true);
    m.pane.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
  });
});

describe("what a follower's map does not do", () => {
  beforeEach(reduceMotion);

  test("L switches no laser on a follower's map", async () => {
    const m = await mount({ current: "alpha" });
    m.pane.focus();
    expect(await press("l")).toBe(false);
    expect(m.asked).toEqual([]);
    expect(m.pane.hasAttribute("data-laser")).toBe(false);
  });

  test("walking the route reports no section, so the follower's deck stays on the presenter's slide", async () => {
    const m = await mount({ current: "alpha" });
    m.pane.focus();
    await press("{End}");
    await press("{ArrowLeft}");
    await press("{Home}");
    expect(m.calls).toEqual([]);
  });

  test("the presenter's own map is unchanged: a pan shows no button and the presenter's section still moves it", async () => {
    const m = await mount({ current: "alpha", follow: false });
    await wheel(m.pane, { deltaY: 120 });
    expect(backButton(m.pane)).toBeNull();
    expect(statusOf(m.pane)).not.toBe(ROAMING);
    await m.presenter("gamma");
    expectAt(m, fittedTo(m, "gamma"));
    m.pane.focus();
    await press("{ArrowLeft}");
    expect(m.calls).toEqual(["beta"]);
  });
});

/** A touch pointer event of `type` on `el` at a client point, as a finger sends it. */
function touchOn(el: Element, type: string, x: number, y: number, id = 11) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: id,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("after the review of row 150", () => {
  beforeEach(reduceMotion);

  test("a roam started by the wheel with focus on <body> takes focus to the pane, so Escape ends it", async () => {
    const m = await mount({ current: "alpha" });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await wheel(m.pane, { deltaY: 200 });
    expect(backButton(m.pane)).not.toBeNull();
    expect(document.activeElement).toBe(m.pane);
    await m.presenter("gamma");
    await press("{Escape}");
    expectAt(m, fittedTo(m, "gamma"));
    expect(backButton(m.pane)).toBeNull();
  });

  test("a roam started by the wheel with focus on a button outside the pane, as the bar's theme button, ends with Escape too", async () => {
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "Theme";
    document.body.append(outsideButton);
    const m = await mount({ current: "beta" });
    outsideButton.focus();
    await wheel(m.pane, { deltaY: 200 });
    expect(document.activeElement).toBe(m.pane);
    await press("{Escape}");
    expectAt(m, fittedTo(m, "beta"));
    expect(backButton(m.pane)).toBeNull();
  });

  test("closing the follower's own focus view after the presenter moved starts no roam: the map stays on the presenter's frame", async () => {
    const m = await mount({ current: "alpha" });
    const pre = frameEl(m.container, "alpha").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.hasAttribute("data-docwalk-focus"), { timeout: 20_000 }).toBe(true);
    pre.focus();
    await frames(2);
    expect(backButton(m.pane), "focusing a block in the current frame is no roam").toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector(".docwalk-focus")).not.toBeNull();
    await m.presenter("gamma");
    expect(currentIds(m.container)).toEqual(["gamma"]);
    await press("{Escape}");
    expect(document.querySelector(".docwalk-focus")).toBeNull();
    expect(backButton(m.pane)).toBeNull();
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expectAt(m, fittedTo(m, "gamma"));
    expect(document.activeElement).toBe(m.pane);
    await m.presenter("beta");
    expectAt(m, fittedTo(m, "beta"));
  });

  test("Tab into a far frame still starts a roam", async () => {
    const m = await mount({ current: "alpha" });
    const pre = frameEl(m.container, "alpha").querySelector<HTMLElement>("pre")!;
    await expect.poll(() => pre.hasAttribute("data-docwalk-focus"), { timeout: 20_000 }).toBe(true);
    pre.focus();
    await frames(2);
    const link = frameEl(m.container, "gamma").querySelector<HTMLElement>("a")!;
    for (let i = 0; i < 10 && document.activeElement !== link; i++) await userEvent.tab();
    expect(document.activeElement).toBe(link);
    await frames(2);
    expect(currentIds(m.container)).toEqual(["gamma"]);
    expect(backButton(m.pane)).not.toBeNull();
  });

  test("a finger that moves 2 px and lifts starts no roam", async () => {
    const m = await mount({ current: "alpha" });
    const { clientX: x, clientY: y } = at(m.pane, 0.5, 0.5);
    const target = document.elementFromPoint(x, y)!;
    touchOn(target, "pointerdown", x, y);
    touchOn(target, "pointermove", x + 2, y);
    touchOn(target, "pointerup", x + 2, y);
    await frames(2);
    expect(backButton(m.pane)).toBeNull();
    expect(statusOf(m.pane)).not.toBe(ROAMING);
  });

  test("a finger that drags 20 px starts a roam", async () => {
    const m = await mount({ current: "alpha" });
    const { clientX: x, clientY: y } = at(m.pane, 0.5, 0.5);
    const target = document.elementFromPoint(x, y)!;
    touchOn(target, "pointerdown", x, y);
    for (let i = 1; i <= 4; i++) touchOn(target, "pointermove", x + 5 * i, y);
    touchOn(target, "pointerup", x + 20, y);
    await frames(2);
    expect(backButton(m.pane)).not.toBeNull();
  });

  test("a finger on the button pans nothing, and a tap on it ends the roam", async () => {
    const m = await mount({ current: "beta" });
    await wheel(m.pane, { deltaY: 200 });
    const button = backButton(m.pane)!;
    const b = button.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const held = cameraOf(m.layer);
    touchOn(button, "pointerdown", x, y, 12);
    touchOn(button, "pointermove", x + 30, y - 30, 12);
    touchOn(button, "pointerup", x + 30, y - 30, 12);
    await frames(2);
    expect(same(cameraOf(m.layer), held), "a finger that starts on the button pans nothing").toBe(
      true,
    );
    touchOn(button, "pointerdown", x, y, 13);
    touchOn(button, "pointerup", x, y, 13);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    await frames(2);
    expect(backButton(m.pane)).toBeNull();
    expectAt(m, fittedTo(m, "beta"));
  });
});
