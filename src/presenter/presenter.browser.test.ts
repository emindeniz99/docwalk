import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MirrorFeed } from "../annotate/mirrorFeed";
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

/** Calls `check` on every DOM change until the preview `cls` shows `heading`; returns its result then. */
function whenPreviewShows<T>(el: HTMLElement, cls: string, heading: string, check: () => T) {
  return new Promise<T>((resolve) => {
    const observer = new MutationObserver(() => {
      if (previewHeading(el, cls) !== heading) return;
      observer.disconnect();
      resolve(check());
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
  });
}

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

  describe("a long document", () => {
    // Enough slides that building all of them takes many turns of the event loop.
    const markdown = [
      "# Long talk",
      "",
      "Intro.",
      "",
      ...Array.from({ length: 40 }, (_, i) => [
        `## Part ${i + 1}`,
        "",
        `Body of part ${i + 1}.`,
        "",
        "- one",
        "- two",
        "",
      ]).flat(),
    ].join("\n");
    const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((s) => `${s.id}/1`);
    const stateAt = (current: string) => ({
      type: "state",
      markdown,
      level: "auto",
      current,
      addresses,
      startedAt: Date.now(),
    });

    // In WebKit the presenter window shares the audience tab's main thread.
    // Built in one piece, the previews froze the deck the room is watching
    // for seconds; and the presenter, who needs only two of them to go on,
    // waited for all of them.
    test("shows the slides the presenter is on before the rest are built, and says it is still rendering", async () => {
      const channel = fakeChannel();
      const el = renderView(channel.factory);
      const shown = whenPreviewShows(el, "docwalk-presenter-current", "Part 30", () => ({
        status: status(el),
        next: previewHeading(el, "docwalk-presenter-next"),
      }));
      await channel.deliver(stateAt(addresses[30] as string));
      const atFirstSight = await shown;
      expect(atFirstSight.next).toBe("Part 31");
      expect(atFirstSight.status).toMatch(/rendering/i);
      // The status line clears only once every slide has a preview, so it
      // never claims a finished list that still shows bare addresses.
      await expect.poll(() => status(el), { timeout: 30_000 }).toBe("");
      const titles = [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(titles.filter((t) => t?.includes("/1"))).toEqual([]);
    }, 40_000);

    test("brings forward the slide the presenter moves to while the rest are still building", async () => {
      const channel = fakeChannel();
      const el = renderView(channel.factory);
      await channel.deliver(stateAt(addresses[1] as string));
      await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Part 1");
      const shown = whenPreviewShows(el, "docwalk-presenter-current", "Part 40", () => status(el));
      await channel.deliver(stateAt(addresses[40] as string));
      // Built in document order, the last slide would come last, with the status already clear.
      expect(await shown).toMatch(/rendering/i);
    }, 40_000);

    // The build shares a main thread with the audience deck in WebKit. Work
    // for a document the window no longer shows (the audience sent another,
    // or the window is closing) only takes turns from the deck and from the
    // build that matters. Both cases stop the build the same way.
    test("stops building as soon as the previews are no longer wanted", async () => {
      const channel = fakeChannel();
      const el = renderView(channel.factory);
      await channel.deliver(stateAt(addresses[1] as string));
      await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Part 1");
      expect(status(el)).toMatch(/rendering/i);
      // Every slide the build paginates is measured in a box of its own on <body>.
      let measured = 0;
      const observer = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof HTMLElement && n.classList.contains("docwalk-measure")) measured++;
          }
        }
      });
      observer.observe(document.body, { childList: true });
      root?.unmount();
      root = null;
      // Long enough for several more slides: each one waits for a frame.
      await new Promise((resolve) => setTimeout(resolve, 500));
      observer.disconnect();
      expect(measured).toBe(0);
    }, 40_000);
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

const NOTES_MARKDOWN = [
  "# Notes deck",
  "",
  "Intro.",
  "",
  "## Alpha section",
  "",
  "<!-- Open with the outage. -->",
  "",
  "Text A.",
  "",
  "## Beta section",
  "",
  "Text B, no notes.",
  "",
  "## Gamma section",
  "",
  "<!-- prettier-ignore -->",
  "",
  "<!-- Ask for questions.",
  "Then thank the team. -->",
  "",
  "Text C.",
].join("\n");
const NOTES_ADDRESSES = sectionize(parseMarkdown(NOTES_MARKDOWN), "auto").sections.map(
  (s) => `${s.id}/1`,
);
const [, N_ALPHA, N_BETA, N_GAMMA] = NOTES_ADDRESSES as [string, string, string, string];

const notesPanel = (el: HTMLElement) => el.querySelector<HTMLElement>(".docwalk-presenter-notes");
const noteTexts = (el: HTMLElement) =>
  [...el.querySelectorAll(".docwalk-presenter-note")].map((n) => n.textContent);

function notesState(current: string, markdown = NOTES_MARKDOWN, addresses = NOTES_ADDRESSES) {
  return { type: "state", markdown, level: "auto", current, addresses, startedAt: Date.now() };
}

describe("speaker notes in the presenter view (decision 79)", () => {
  test("shows the current slide's notes and swaps them when the slide changes, so the presenter reads what belongs to the slide the room sees", async () => {
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver(notesState(N_ALPHA));
    await expect.poll(() => noteTexts(el)).toEqual(["Open with the outage."]);

    await channel.deliver(notesState(N_GAMMA));
    // A tool directive is not a note; a multi-line note stays one note.
    await expect.poll(() => noteTexts(el)).toEqual(["Ask for questions.\nThen thank the team."]);
  });

  test("says so when the slide has no notes, and keeps the panel, so the layout does not jump between slides", async () => {
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver(notesState(N_ALPHA));
    await expect.poll(() => noteTexts(el)).toHaveLength(1);
    const panel = notesPanel(el);

    await channel.deliver(notesState(N_BETA));
    await expect.poll(() => noteTexts(el)).toEqual([]);
    expect(notesPanel(el)).toBe(panel);
    expect(panel?.textContent).toContain("No notes for this slide.");
  });

  test("shows a section's notes on each of its pages, because the notes belong to the section", async () => {
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    const id = N_ALPHA.split("/")[0];
    const pages = [`${id}/1`, `${id}/2`];
    const addresses = [...NOTES_ADDRESSES.slice(0, 1), ...pages, ...NOTES_ADDRESSES.slice(2)];
    for (const page of pages) {
      await channel.deliver(notesState(page, NOTES_MARKDOWN, addresses));
      await expect.poll(() => noteTexts(el)).toEqual(["Open with the outage."]);
    }
  });

  test("follows an edit of the Markdown: a note added shows at once", async () => {
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver(notesState(N_BETA));
    await expect.poll(() => notesPanel(el)?.textContent).toContain("No notes for this slide.");
    const edited = NOTES_MARKDOWN.replace("Text B, no notes.", "<!-- Added later. -->\n\nText B.");
    await channel.deliver(notesState(N_BETA, edited));
    await expect.poll(() => noteTexts(el)).toEqual(["Added later."]);
  });

  test("prints hostile note text as text: no element, handler or script comes of it", async () => {
    const hostile =
      '<img src=x onerror="window.noteOwned = 1"> </section></main><script>window.noteOwned = 2</script>';
    const markdown = `# Deck\n\n## Alpha\n\n<!-- ${hostile} -->\n\nText.\n\n## Beta\n\n<!-- never closed\n\nText.\n`;
    const addresses = sectionize(parseMarkdown(markdown), "auto").sections.map((x) => `${x.id}/1`);
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver(notesState(addresses[1] as string, markdown, addresses));
    await expect.poll(() => noteTexts(el)).toEqual([hostile]);
    const panel = notesPanel(el) as HTMLElement;
    expect(panel.querySelector("img, script, main, section")).toBeNull();
    expect((window as { noteOwned?: number }).noteOwned).toBeUndefined();
    // The page around the panel survived the stray end tags.
    expect(el.querySelectorAll("main")).toHaveLength(1);
  });

  test("keeps notes out of the slide previews", async () => {
    const channel = fakeChannel();
    const el = renderView(channel.factory);
    await channel.deliver(notesState(N_ALPHA));
    await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Alpha section");
    const canvases = [...el.querySelectorAll(".docwalk-presenter-canvas")];
    expect(canvases.length).toBeGreaterThan(0);
    for (const canvas of canvases) expect(canvas.textContent).not.toContain("outage");
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

/** The real audience side with a mirror feed, over the real BroadcastChannel. */
function mirroredAudience() {
  const feed = new MirrorFeed();
  cleanups.push(
    startPresenterBridge({
      getState: () => ({
        markdown: MARKDOWN,
        level: "auto",
        current: ALPHA,
        addresses: ADDRESSES,
        startedAt: Date.now(),
      }),
      goTo: () => true,
      step: () => {},
      subscribe: () => () => {},
      mirror: feed,
    }),
  );
  return feed;
}

const paperIn = (el: HTMLElement, cls: string) =>
  el.querySelector<HTMLElement>(`.${cls} .docwalk-mirror-board`);
const shown = (paper: HTMLElement | null) =>
  paper !== null && getComputedStyle(paper).display !== "none";
const boardMarks = (el: HTMLElement) =>
  el.querySelectorAll(".docwalk-presenter-current .docwalk-mirror [data-mark]").length;

describe("the whiteboard in the presenter window (decision 110)", () => {
  test("the current preview shows the paper and the board's strokes after board-open, and the next preview shows nothing", async () => {
    const feed = mirroredAudience();
    const el = renderView();
    await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Alpha section");
    expect(shown(paperIn(el, "docwalk-presenter-current"))).toBe(false);

    const section = ALPHA.slice(0, ALPHA.indexOf("/"));
    feed.ingest({
      kind: "marks",
      slide: `${section}/board`,
      reset: true,
      strokes: [
        { id: 1, tool: "pen", color: "primary", points: [1024, 1024, 2048, 2048, 3072, 3072] },
      ],
    });
    feed.ingest({ kind: "board", slide: ALPHA });
    await expect.poll(() => shown(paperIn(el, "docwalk-presenter-current"))).toBe(true);
    await expect.poll(() => boardMarks(el)).toBe(1);
    // The next-slide preview has no overlay: the board covers the page the room is on.
    expect(el.querySelector(".docwalk-presenter-next .docwalk-mirror")).toBeNull();
    // The previews are inert copies, so nothing in them took the cover.
    expect(el.querySelector(".docwalk-presenter-canvas")?.hasAttribute("inert")).toBe(true);

    feed.ingest({ kind: "board", slide: null });
    await expect.poll(() => shown(paperIn(el, "docwalk-presenter-current"))).toBe(false);
  });

  test("a board over a page the room is not on leaves the current preview alone", async () => {
    const feed = mirroredAudience();
    const el = renderView();
    await expect.poll(() => previewHeading(el, "docwalk-presenter-current")).toBe("Alpha section");
    feed.ingest({ kind: "board", slide: BETA });
    // Give the op its trip over the channel and the overlay its redraw.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shown(paperIn(el, "docwalk-presenter-current"))).toBe(false);
    expect(el.querySelector(".docwalk-presenter-next .docwalk-mirror")).toBeNull();
  });
});
