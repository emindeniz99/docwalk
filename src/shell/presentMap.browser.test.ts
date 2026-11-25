import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { App } from "../App";
import { releaseDraft } from "../share/draft";
import { DRAFT_STORAGE_KEY } from "../share/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Decision 154, presenting the map full screen, in the assembled app. The
 * button, the palette entry and the leaving rules live across App, the
 * presenting hook, the app's keys and the map, so the whole page runs. A test
 * browser cannot make a page full screen on demand (the test frame has no
 * `allowfullscreen`), so `requestFullscreen` is a stand-in that does what a
 * browser does to the page: sets `document.fullscreenElement` and fires
 * `fullscreenchange`; "the browser keeps Escape" is `leave()`. The real thing
 * runs in e2e/map.spec.ts.
 */

const DOC =
  "# Map checks\n\n## First point\n\nAlpha paragraph.\n\n## Second point\n\nBeta paragraph.\n\n## Third point\n\nGamma paragraph.\n";

let root: Root | null = null;
const startUrl = location.href;

beforeEach(async () => {
  await page.viewport(1280, 800);
  localStorage.setItem(
    DRAFT_STORAGE_KEY,
    JSON.stringify({ markdown: DOC, source: { kind: "paste" } }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(navigator, "wakeLock");
  history.replaceState(null, "", startUrl);
  document.body.replaceChildren();
  localStorage.clear();
  releaseDraft();
});

const fire = () => document.dispatchEvent(new Event("fullscreenchange"));

/** A page that can go full screen, as a browser makes it, or refuses to. */
function stubFullscreen({ refuse = false } = {}) {
  let element: Element | null = null;
  const requested: Element[] = [];
  vi.spyOn(Element.prototype, "requestFullscreen").mockImplementation(async function (
    this: Element,
  ) {
    requested.push(this);
    if (refuse) throw new TypeError("Fullscreen is refused here");
    element = requested.at(-1) ?? null;
    fire();
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
  vi.spyOn(document, "exitFullscreen").mockImplementation(async () => {
    element = null;
    fire();
  });
  return {
    requested,
    /** What the browser does with Escape in full screen: leaves it, and the page never sees the key. */
    leave() {
      element = null;
      fire();
    },
  };
}

/** A screen wake lock that counts what was asked and what was let go. */
function stubWakeLock() {
  const state = { requests: 0, released: 0 };
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        state.requests++;
        const sentinel = new EventTarget();
        return Object.assign(sentinel, {
          release: async () => {
            state.released++;
            sentinel.dispatchEvent(new Event("release"));
          },
        });
      },
    },
  });
  return state;
}

async function mountApp() {
  const container = document.createElement("div");
  container.style.height = "800px";
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(App)));
  await expect
    .poll(() => container.querySelector(".docwalk-statusbar")?.textContent, { timeout: 30_000 })
    .toMatch(/\d+ slides/);
  return container;
}

const app = (el: HTMLElement) => el.querySelector<HTMLElement>(".docwalk-app")!;
const pane = () => document.querySelector<HTMLElement>(".docwalk-map-pane");
const viewChoice = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent === name)!;
const presentMapButton = () =>
  [...document.querySelectorAll<HTMLElement>(".docwalk-map-pane button")].find(
    (b) => b.textContent === "Present the map",
  );
const exitButton = () =>
  [...document.querySelectorAll<HTMLElement>(".docwalk-map-pane button")].find(
    (b) => b.textContent === "Exit",
  );
const currentFrame = () =>
  document
    .querySelector<HTMLElement>('.docwalk-map-pane [data-map-frame][aria-current="true"]')
    ?.getAttribute("data-map-frame");
/** Whether an element takes any room on the page, as the reader sees it. */
const shown = (el: Element | null) => el !== null && el.getClientRects().length > 0;
const header = (el: HTMLElement) => el.querySelector(".docwalk-toolbar");
const statusbar = (el: HTMLElement) => el.querySelector(".docwalk-statusbar");
const outline = (el: HTMLElement) => el.querySelector(".docwalk-sidebar");
const pageView = () => new URLSearchParams(location.search).get("view");

const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
    i.textContent?.includes(text),
  );

/** Opens the palette and types `query`, then waits until the list has been filtered by it. */
async function searchPalette(query: string) {
  await userEvent.keyboard("{Control>}k{/Control}");
  await userEvent.keyboard(query);
  await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
  // A command the query cannot match is gone once the list is filtered.
  await expect.poll(() => menuItem("Share")).toBeUndefined();
}

async function openMap(el: HTMLElement) {
  await userEvent.click(viewChoice(el, "Map"));
  await expect.poll(() => app(el).getAttribute("data-view")).toBe("map");
  await expect
    .poll(() => pane()?.querySelector(".docwalk-map-layer")?.hasAttribute("data-placed"), {
      timeout: 20_000,
    })
    .toBe(true);
}

/** Opens the map, walks one frame on so "the same frame" means something, and presents. */
async function presentSecondFrame(el: HTMLElement) {
  await openMap(el);
  const first = currentFrame();
  pane()!.focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(currentFrame).not.toBe(first);
  await userEvent.click(presentMapButton()!);
}

describe("where the button shows", () => {
  test("only on the presenter's map: not on the editor, the document view or the slides", async () => {
    stubFullscreen();
    const el = await mountApp();
    const anywhere = () =>
      [...el.querySelectorAll("button")].some((b) => b.textContent === "Present the map");
    expect(anywhere(), "edit").toBe(false);
    await userEvent.click(viewChoice(el, "Document"));
    await expect.poll(() => app(el).getAttribute("data-view")).toBe("document");
    expect(anywhere(), "document").toBe(false);
    await openMap(el);
    expect(presentMapButton(), "map").toBeDefined();
    // Present keeps opening the slides, also from the map (decision 154).
    await userEvent.click(
      [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Present")!,
    );
    await expect.poll(() => app(el).getAttribute("data-view")).toBe("present");
    expect(anywhere(), "slides").toBe(false);
    expect(pane()).toBeNull();
  });
});

describe("presenting the map", () => {
  test("puts the page root in full screen, shows the map pane alone, keeps view=map and focuses the pane", async () => {
    const fullscreen = stubFullscreen();
    const el = await mountApp();
    await openMap(el);
    expect(shown(header(el)) && shown(statusbar(el)) && shown(outline(el)), "windowed").toBe(true);
    const paneBefore = pane()!.getBoundingClientRect();

    await userEvent.click(presentMapButton()!);

    await expect.poll(() => fullscreen.requested[0]).toBe(document.documentElement);
    await expect.poll(() => shown(header(el))).toBe(false);
    expect(shown(statusbar(el)), "no status bar").toBe(false);
    expect(outline(el), "no outline").toBeNull();
    expect(shown(pane()), "the map pane stays").toBe(true);
    const paneNow = pane()!.getBoundingClientRect();
    expect(paneNow.width).toBeGreaterThan(paneBefore.width);
    expect(paneNow.height).toBeGreaterThan(paneBefore.height);
    // The link keeps the map: a reload opens it windowed (a link cannot start full screen).
    expect(pageView()).toBe("map");
    expect(app(el).getAttribute("data-view")).toBe("map");
    // The route keys work at once.
    await expect.poll(() => document.activeElement).toBe(pane());
    // The button is Exit now, with its key in the tooltip, and the pane still names a current frame.
    expect(presentMapButton()).toBeUndefined();
    expect(exitButton()).toBeDefined();
    expect(currentFrame()).toBeTruthy();
  });

  test("fits the current frame into the pane's new size", async () => {
    stubFullscreen();
    const el = await mountApp();
    await openMap(el);
    await userEvent.click(presentMapButton()!);
    await expect.poll(() => shown(header(el))).toBe(false);
    const p = pane()!.getBoundingClientRect();
    const f = document
      .querySelector<HTMLElement>('.docwalk-map-pane [data-map-frame][aria-current="true"]')!
      .getBoundingClientRect();
    // Fitted as at opening: inside the pane, centred across it, near its top.
    await expect
      .poll(() => Math.abs(f.left + f.width / 2 - (p.left + p.width / 2)))
      .toBeLessThan(2);
    expect(f.left).toBeGreaterThanOrEqual(p.left);
    expect(f.right).toBeLessThanOrEqual(p.right + 0.5);
  });

  test("the route, the laser and the focus view work as in the map view", async () => {
    stubFullscreen();
    const el = await mountApp();
    await openMap(el);
    await userEvent.click(presentMapButton()!);
    await expect.poll(() => document.activeElement).toBe(pane());
    const first = currentFrame();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(currentFrame).not.toBe(first);
    await userEvent.keyboard("l");
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(true);
  });

  test("keeps the screen awake while it is presented and lets go on leaving", async () => {
    stubFullscreen();
    const lock = stubWakeLock();
    const el = await mountApp();
    await openMap(el);
    expect(lock.requests, "none while windowed").toBe(0);
    await userEvent.click(presentMapButton()!);
    await expect.poll(() => lock.requests).toBe(1);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => lock.released).toBe(1);
    await expect.poll(() => presentMapButton()).toBeDefined();
  });

  test("the palette offers it on the map only, and runs it", async () => {
    const fullscreen = stubFullscreen();
    const el = await mountApp();
    await searchPalette("Present the map");
    expect(menuItem("Present the map"), "edit").toBeUndefined();
    // Escape on a filled search box clears it; on an empty one it closes the palette.
    await userEvent.keyboard("{Escape}{Escape}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();

    await openMap(el);
    await searchPalette("Present the map");
    await expect.poll(() => menuItem("Present the map")).toBeDefined();
    await userEvent.click(menuItem("Present the map")!);
    await expect.poll(() => fullscreen.requested[0]).toBe(document.documentElement);
    await expect.poll(() => shown(header(el))).toBe(false);
    expect(pageView()).toBe("map");
    // Presented, there is nothing to present again: Exit and Escape leave.
    await searchPalette("Present the map");
    expect(menuItem("Present the map"), "presented").toBeUndefined();
  });
});

describe("leaving", () => {
  test("Exit returns to the map view with its header, on the same frame", async () => {
    stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => shown(header(el))).toBe(false);
    const frame = currentFrame();

    await userEvent.click(exitButton()!);

    await expect.poll(() => shown(header(el))).toBe(true);
    expect(document.fullscreenElement, "left full screen").toBeNull();
    expect(app(el).getAttribute("data-view")).toBe("map");
    expect(shown(outline(el)) && shown(statusbar(el))).toBe(true);
    expect(currentFrame()).toBe(frame);
    expect(presentMapButton(), "the button is Present the map again").toBeDefined();
    expect(pageView()).toBe("map");
    // Not the editor, where Escape on the slides lands (decision 154).
    expect(el.querySelector(".cm-content")).toBeNull();
  });

  test("Escape returns to the map view, not the editor, on the same frame", async () => {
    stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => shown(header(el))).toBe(false);
    const frame = currentFrame();

    await userEvent.keyboard("{Escape}");

    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");
    expect(currentFrame()).toBe(frame);
    expect(document.fullscreenElement).toBeNull();
  });

  test("leaving full screen the browser's way, as its own Escape does, returns to the map view too", async () => {
    const fullscreen = stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => shown(header(el))).toBe(false);
    const frame = currentFrame();

    fullscreen.leave();

    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");
    expect(currentFrame()).toBe(frame);
  });

  test("an Escape that closes an open dialog leaves the map presented, in the window or in full screen", async () => {
    const fullscreen = stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => shown(header(el))).toBe(false);

    // In the window: the dialog takes the key.
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(shown(header(el)), "still presented").toBe(false);

    // In full screen the browser keeps that Escape and the page hears only the change.
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
    fullscreen.leave();
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(shown(header(el)), "presented, windowed").toBe(false);
    expect(app(el).getAttribute("data-view")).toBe("map");
    expect(exitButton(), "Exit is still there").toBeDefined();

    // The next Escape leaves.
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");
  });

  test("an Escape that the map's laser was waiting for turns it off and leaves the map presented", async () => {
    const fullscreen = stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => document.activeElement).toBe(pane());
    await userEvent.keyboard("l");
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(true);

    // In the window the pane takes the key.
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(false);
    expect(shown(header(el)), "still presented").toBe(false);

    // In full screen the browser keeps it: the laser goes off and the map stays, windowed.
    await userEvent.keyboard("l");
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(true);
    fullscreen.leave();
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(false);
    expect(shown(header(el)), "presented, windowed").toBe(false);
    expect(exitButton()).toBeDefined();

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown(header(el))).toBe(true);
  });

  test("Exit leaves for good with the laser on: only a key's Escape is the laser's", async () => {
    stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => document.activeElement).toBe(pane());
    await userEvent.keyboard("l");
    await expect.poll(() => pane()!.hasAttribute("data-laser")).toBe(true);

    await userEvent.click(exitButton()!);

    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");
    expect(document.fullscreenElement).toBeNull();
    expect(presentMapButton()).toBeDefined();
  });

  test("leaving the map for another view while it is presented ends the presenting", async () => {
    stubFullscreen();
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => shown(header(el))).toBe(false);
    // The palette's Show document command, as there is no header to switch views with.
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("Show document");
    await expect.poll(() => menuItem("Show document")).toBeDefined();
    await userEvent.click(menuItem("Show document")!);
    await expect.poll(() => app(el).getAttribute("data-view")).toBe("document");
    await expect.poll(() => shown(header(el))).toBe(true);
  });
});

describe("when full screen is refused (iOS, an iframe)", () => {
  test("the map still fills the window, and Exit and Escape still leave", async () => {
    const fullscreen = stubFullscreen({ refuse: true });
    const el = await mountApp();
    await presentSecondFrame(el);
    await expect.poll(() => fullscreen.requested[0]).toBe(document.documentElement);
    await expect.poll(() => shown(header(el))).toBe(false);
    expect(shown(statusbar(el))).toBe(false);
    expect(outline(el)).toBeNull();
    expect(pageView()).toBe("map");
    // The pane is focused even though the request failed.
    await expect.poll(() => document.activeElement).toBe(pane());

    await userEvent.click(exitButton()!);
    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");

    await userEvent.click(presentMapButton()!);
    await expect.poll(() => shown(header(el))).toBe(false);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => shown(header(el))).toBe(true);
    expect(app(el).getAttribute("data-view")).toBe("map");
  });
});
