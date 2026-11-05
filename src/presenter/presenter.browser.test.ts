import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import {
  DISCONNECT_AFTER_MS,
  startPresenterBridge,
  type ChannelFactory,
  type PresenterState,
} from "./bridge";
import { formatElapsed, PresenterView } from "./PresenterView";
import { openPresenterWindow } from "./window";

const MARKDOWN = [
  "# Ledger notes",
  "",
  "Intro.",
  "",
  "## Alpha section",
  "",
  "Text A.",
  "",
  "## Beta section",
  "",
  "Text B.",
  "",
  "## Gamma section",
  "",
  "Text C.",
].join("\n");

// Short sections fit one page each, so every address is `<id>/1`.
const ADDRESSES = sectionize(parseMarkdown(MARKDOWN), "auto").sections.map((s) => `${s.id}/1`);
const [, ALPHA, BETA] = ADDRESSES as [string, string, string, string];

let root: Root | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  root?.unmount();
  root = null;
  for (const c of cleanups.splice(0)) c();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderView(channel?: ChannelFactory): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(h(PresenterView, channel ? { channel } : {}));
  return container;
}

/** A channel the test drives by hand, to play an audience that goes away or misbehaves. */
function fakeChannel() {
  const listeners: ((data: unknown) => void)[] = [];
  const factory: ChannelFactory = () => ({
    postMessage: () => {},
    listen: (listener) => listeners.push(listener),
    close: () => {
      listeners.length = 0;
    },
  });
  return {
    factory,
    /** Delivers once the view has connected: React runs effects after the first paint. */
    async deliver(data: unknown) {
      await expect.poll(() => listeners.length).toBeGreaterThan(0);
      for (const listener of listeners) listener(data);
    },
  };
}

const status = (el: HTMLElement) => el.querySelector('[role="status"]')?.textContent ?? "";

/** The real audience side, over the real BroadcastChannel. */
function startAudience(state: PresenterState) {
  const goTo = vi.fn<(address: string) => boolean>(() => true);
  const step = vi.fn<(direction: 1 | -1) => void>();
  cleanups.push(
    startPresenterBridge({ getState: () => state, goTo, step, subscribe: () => () => {} }),
  );
  return { goTo, step };
}

const caption = (el: HTMLElement, cls: string) =>
  el.querySelector(`.${cls} .docwalk-presenter-title`)?.textContent ?? "";
const previewHeading = (el: HTMLElement, cls: string) =>
  el.querySelector(`.${cls} .docwalk-presenter-canvas h2`)?.textContent ?? "";

describe("presenter view", () => {
  test("says it is waiting until the audience answers, so a blank window is never mistaken for a broken one", async () => {
    const el = renderView();
    await expect.poll(() => el.textContent).toContain("Waiting for the audience window");
    expect(el.querySelector(".docwalk-presenter-canvas")).toBeNull();
  });

  test("shows the current and next slides from the audience's state and drives the audience back", async () => {
    const audience = startAudience({
      markdown: MARKDOWN,
      level: "auto",
      current: ALPHA,
      addresses: ADDRESSES,
      startedAt: Date.now() - 65_000,
    });
    const el = renderView();

    // The previews are rebuilt from the Markdown: the slide clones carry the real headings.
    await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Alpha section");
    expect(previewHeading(el, "docwalk-presenter-next")).toBe("Beta section");
    expect(caption(el, "docwalk-presenter-current")).toBe("Alpha section");
    expect(caption(el, "docwalk-presenter-next")).toBe("Beta section");
    expect(el.querySelector('[aria-label="Slide position"]')?.textContent).toBe(
      `2 / ${ADDRESSES.length}`,
    );
    // Previews must never take focus or clicks away from the presenter.
    expect(el.querySelector(".docwalk-presenter-canvas")?.hasAttribute("inert")).toBe(true);

    // The presenter asks; the audience window, which owns the deck, moves.
    el.querySelector<HTMLElement>('[aria-label="Next slide"]')?.click();
    await expect.poll(() => audience.step.mock.calls).toEqual([[1]]);

    // Clickers and arrow keys work without focusing a button first.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    await expect.poll(() => audience.step.mock.calls).toEqual([[1], [-1]]);

    const beta = [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.includes("Beta section"),
    );
    beta?.click();
    await expect.poll(() => audience.goTo.mock.calls).toEqual([[BETA]]);

    // After a jump, focus sits in the slide list. A clicker's PageDown must
    // still move the deck, or the presenter loses the clicker mid-talk.
    beta?.focus();
    beta?.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    await expect.poll(() => audience.step.mock.calls).toEqual([[1], [-1], [1]]);
    // Up/Down stay with the list, for browsing ahead without moving the room.
    beta?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(audience.step.mock.calls).toHaveLength(3);
  });

  test("names its window, so the presenter can tell it from the audience window when sharing a screen", async () => {
    const before = document.title;
    renderView();
    await expect.poll(() => document.title).toMatch(/presenter/i);
    root?.unmount();
    root = null;
    expect(document.title).toBe(before);
  });

  test("says when the audience stops answering, keeps the last slide, and recovers when it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    const state = {
      type: "state",
      markdown: MARKDOWN,
      level: "auto",
      current: ALPHA,
      addresses: ADDRESSES,
      startedAt: Date.now(),
    };
    await channel.deliver(state);
    await expect.poll(() => caption(el, "docwalk-presenter-current")).toBe("Alpha section");
    expect(status(el)).not.toMatch(/disconnected/i);

    // The audience window closed: no state for DISCONNECT_AFTER_MS.
    vi.advanceTimersByTime(DISCONNECT_AFTER_MS + 1);
    await expect.poll(() => status(el)).toMatch(/disconnected/i);
    expect(caption(el, "docwalk-presenter-current")).toBe("Alpha section");

    await channel.deliver(state);
    await expect.poll(() => status(el)).not.toMatch(/disconnected/i);
  });

  test("renders Mermaid diagrams in the previews, as the audience sees them", async () => {
    const markdown =
      "# Flows\n\nIntro.\n\n## Pipeline\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
    const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((s) => `${s.id}/1`);
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver({
      type: "state",
      markdown,
      level: "auto",
      current: addresses[1],
      addresses,
      startedAt: Date.now(),
    });
    await expect
      .poll(() => el.querySelector(".docwalk-presenter-current .docwalk-presenter-canvas svg"), {
        timeout: 15_000,
      })
      .not.toBeNull();
  }, 20_000);

  test("previews show the same overflow note as the deck, so a slide the room cannot read never looks fine here", async () => {
    // A code block is atomic (decision 19): taller than a slide, it overflows
    // on its own page and the audience deck flags it. The presenter, who is
    // the one who must react, needs to see that flag too.
    const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const markdown = `# Notes\n\nIntro.\n\n## Config\n\n\`\`\`\n${code}\n\`\`\`\n\n## Short\n\nFine.\n`;
    const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((s) => `${s.id}/1`);
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver({
      type: "state",
      markdown,
      level: "auto",
      current: addresses[1],
      addresses,
      startedAt: Date.now(),
    });
    const note = (cls: string) =>
      el.querySelector<HTMLElement>(`.${cls} .docwalk-presenter-canvas .docwalk-overflow`);
    await expect.poll(() => note("docwalk-presenter-current")?.hidden).toBe(false);
    expect(note("docwalk-presenter-current")?.textContent).toMatch(/Does not fit: \d+ px too tall/);
    // The slide that fits keeps its note hidden: the flag means something.
    expect(note("docwalk-presenter-next")?.hidden).toBe(true);
  });

  test("previews go through the same sanitizer as the deck: any same-origin tab can post a state", async () => {
    const markdown = [
      "# Notes",
      "",
      "Intro.",
      "",
      "## Alpha section",
      "",
      '<img src="x" onerror="globalThis.docwalkPwned = 1">',
      "",
      "<script>globalThis.docwalkPwned = 1</script>",
      "",
      "[link](javascript:globalThis.docwalkPwned=1)",
    ].join("\n");
    const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((s) => `${s.id}/1`);
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver({
      type: "state",
      markdown,
      level: "auto",
      current: addresses[1],
      addresses,
      startedAt: Date.now(),
    });
    await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Alpha section");
    const canvas = el.querySelector(".docwalk-presenter-current .docwalk-presenter-canvas");
    expect(canvas?.querySelector("[onerror], script, a[href^='javascript']")).toBeNull();
    expect((globalThis as { docwalkPwned?: number }).docwalkPwned).toBeUndefined();
  });

  test("controls meet the 44px touch target and carry accessible names", async () => {
    startAudience({
      markdown: MARKDOWN,
      level: "auto",
      current: ALPHA,
      addresses: ADDRESSES,
      startedAt: Date.now(),
    });
    const el = renderView();
    await expect.poll(() => el.querySelectorAll(".docwalk-presenter-control").length).toBe(2);
    for (const button of el.querySelectorAll<HTMLElement>(".docwalk-presenter-control")) {
      const box = button.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(button.getAttribute("aria-label")).toMatch(/slide$/);
    }
  });
});

describe("presenter helpers", () => {
  test("elapsed time reads like a stopwatch and never goes negative across clock skew", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });

  test("the presenter window opens the same app with view=presenter and keeps the other settings", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const before = location.href;
    cleanups.push(() => history.replaceState(null, "", before));
    history.replaceState(null, "", "?level=2");
    openPresenterWindow();
    const [href, target] = open.mock.calls[0] ?? [];
    const url = new URL(String(href));
    expect(url.searchParams.get("view")).toBe("presenter");
    expect(url.searchParams.get("level")).toBe("2");
    // One named window: pressing the button twice must not stack windows.
    expect(target).toBe("docwalk-presenter");
  });
});
