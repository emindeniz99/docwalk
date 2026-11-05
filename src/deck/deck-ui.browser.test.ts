import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import mermaid from "mermaid";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { OPEN_SKETCH_EVENT } from "../canvas/request";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck, REBUILD_DELAY_MS } from "./Deck";
import { renderDiagrams } from "./mermaid";

const DIAGRAM = "```mermaid\nflowchart LR\n  a --> b\n```";
const WITH_DIAGRAM = `## Diagram\n\n${DIAGRAM}\n\n## Next\n\nMore text.\n`;

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Mount the real Deck (reveal.js, Mermaid, pagination) in a sized pane, as App does. */
function mountDeck(markdown: string, size = { width: 1280, height: 800 }) {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "grid",
    width: `${size.width}px`,
    height: `${size.height}px`,
  });
  document.body.append(container);
  root = createRoot(container);
  const readies: (DeckController | null)[] = [];
  const onReady = (c: DeckController | null) => readies.push(c);
  const show = (md: string) =>
    root!.render(h(Deck, { plan: sectionize(parseMarkdown(md), "auto"), onReady }));
  show(markdown);
  const builds = () => readies.filter(Boolean).length;
  const ready = async (n = 1) => {
    await expect.poll(builds, { timeout: 20_000, interval: 10 }).toBeGreaterThanOrEqual(n);
  };
  return { container, show, builds, ready, readies };
}

const meets = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const overlay = () => document.querySelector<HTMLElement>(".docwalk-focus");
const presentDiagram = () =>
  document.querySelector<HTMLElement>(".reveal .slides section.present .docwalk-diagram")!;

describe("diagram focus view (the full-screen diagram, decision 3)", () => {
  test("Enter on a focused diagram opens the view and it stays open", async () => {
    // The diagram's own label promises "Press Enter to open it full screen"; the
    // keystroke used to open the view and then click the Close button it had just focused.
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const host = presentDiagram();
    host.focus();
    await userEvent.keyboard("{Enter}");
    await sleep(50);
    const dialog = overlay();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-label")).toBe("Diagram, full screen");
    expect(dialog!.querySelector("svg")).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  });

  test("Escape closes the view and returns focus to the diagram on the slide", async () => {
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const host = presentDiagram();
    host.focus();
    await userEvent.keyboard("{Enter}");
    expect(overlay()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(overlay()).toBeNull();
    // Otherwise a keyboard user is dropped at the top of the page.
    expect(document.activeElement).toBe(host);
  });

  test("a click opens the view; the Close button closes it and focus returns", async () => {
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const host = presentDiagram();
    await userEvent.click(host);
    expect(overlay()).not.toBeNull();
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Close"]')!);
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(host);
  });

  test("Tab and Shift+Tab stay inside the view, and the page behind it is inert", async () => {
    // The overlay covers the whole window and says aria-modal; a Tab that reaches
    // the hidden header puts focus on buttons nobody can see.
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const host = presentDiagram();
    host.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = overlay()!;
    expect(host.closest("[inert]")).not.toBeNull();
    for (let i = 0; i < 7; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 7; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(host.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(host);
  });

  test("Open as sketch hands the diagram's source and position to the app (decision 54)", async () => {
    // The focus view is plain DOM; the app opens canvas mode only through this event.
    // Its own second diagram: the render cache is shared, and other tests count renders of `a --> c`.
    const second = DIAGRAM.replace("a --> b", "s --> t");
    const deck = mountDeck(`## One\n\n${DIAGRAM}\n\n## Two\n\n${second}\n`);
    await deck.ready();
    const requests: unknown[] = [];
    const listen = (event: Event) => requests.push((event as CustomEvent).detail);
    document.addEventListener(OPEN_SKETCH_EVENT, listen);
    deck.readies.at(-1)?.goTo("two");
    const host = presentDiagram();
    await userEvent.click(host);
    await userEvent.click(overlay()!.querySelector<HTMLElement>('[aria-label="Open as sketch"]')!);
    document.removeEventListener(OPEN_SKETCH_EVENT, listen);
    // The second diagram of the deck, by its source as written: that is the sketch's key.
    expect(requests).toEqual([{ source: "flowchart LR\n  s --> t\n", index: 2 }]);
    // The focus view gives way, and the diagram gets focus back for when the sketch closes.
    expect(overlay()).toBeNull();
    expect(document.activeElement).toBe(host);
  });

  test("Escape still closes the view after a click on the diagram stage", async () => {
    // A click on a non-focusable spot used to move focus to <body>, where the
    // overlay's own Escape handler never heard the key.
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    await userEvent.click(presentDiagram());
    const stage = overlay()!.querySelector<HTMLElement>(".docwalk-focus-stage")!;
    await userEvent.click(stage, { position: { x: 4, y: 4 } });
    await userEvent.keyboard("{Escape}");
    expect(overlay()).toBeNull();
  });
});

describe("reveal.js chrome on the stage", () => {
  test("the next-slide button shows a focus outline when reached with Tab (WCAG 2.4.7)", async () => {
    const deck = mountDeck("## One\n\nA.\n\n## Two\n\nB.\n");
    await deck.ready();
    deck.container.querySelector<HTMLElement>(".reveal")!.focus();
    let next: HTMLElement | null = null;
    for (let i = 0; i < 8 && !next; i++) {
      await userEvent.tab();
      if (document.activeElement?.matches(".navigate-right"))
        next = document.activeElement as HTMLElement;
    }
    expect(next, "Tab reaches the next-slide button").not.toBeNull();
    const style = getComputedStyle(next!);
    expect(style.outlineStyle).not.toBe("none");
    expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
  });

  for (const size of [
    { width: 1440, height: 820 },
    // The phone edit view: a short, wide pane where the slide nearly fills the height.
    { width: 360, height: 200 },
  ]) {
    test(`no position chip covers the slide or the arrows at ${size.width}x${size.height}`, async () => {
      // The header already shows "n / total" and the slide address; a second chip
      // in the corner sat on the next arrow and hid the slide's bottom-right corner.
      const deck = mountDeck("## One\n\nA.\n\n## Two\n\nB.\n", size);
      await deck.ready();
      const rect = (s: string) => {
        const el = deck.container.querySelector<HTMLElement>(s);
        if (!el || getComputedStyle(el).display === "none") return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? r : null;
      };
      const slide = rect(".reveal .slides section.present .docwalk-slide")!;
      const arrow = rect(".reveal .controls .navigate-right")!;
      expect(slide).not.toBeNull();
      expect(arrow).not.toBeNull();
      const chip = rect(".reveal .slide-number");
      const covers = chip ? [meets(chip, slide), meets(chip, arrow)] : [false, false];
      expect(covers, "chip over [slide, next arrow]").toEqual([false, false]);
    });
  }
});

describe("rebuilding while the author types (decision 43: 300 ms to repaginate)", () => {
  test("the first build starts at once; it does not wait for the edit delay", async () => {
    const deck = mountDeck("## One\n\nA.\n");
    await expect
      .poll(() => deck.container.querySelector(".reveal"), { timeout: 100 })
      .not.toBeNull();
  });

  test("a burst of keystrokes rebuilds once, after typing stops, without re-rendering the unchanged diagram", async () => {
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const render = vi.spyOn(mermaid, "render");
    for (let i = 1; i <= 6; i++) {
      deck.show(`${WITH_DIAGRAM}\nTyped ${"x".repeat(i)}.\n`);
      await sleep(60);
    }
    // While typing, the last finished deck stays up: no teardown per keystroke.
    expect(deck.readies.filter((c) => c === null)).toHaveLength(0);
    await deck.ready(2);
    await sleep(REBUILD_DELAY_MS + 200);
    expect(deck.builds()).toBe(2);
    expect(deck.container.textContent).toContain(`Typed ${"x".repeat(6)}.`);
    // The diagram's source did not change, so its cached SVG is reused.
    expect(render).not.toHaveBeenCalled();
    expect(presentDiagram().querySelector("svg")).not.toBeNull();
  });

  test("an edited diagram is rendered again", async () => {
    const deck = mountDeck(WITH_DIAGRAM);
    await deck.ready();
    const render = vi.spyOn(mermaid, "render");
    deck.show(WITH_DIAGRAM.replace("a --> b", "a --> c"));
    await deck.ready(2);
    expect(render).toHaveBeenCalledTimes(1);
    expect(presentDiagram().textContent).toContain("c");
  });

  test("a superseded build stops rendering diagrams", async () => {
    // Mermaid queues renders, so a stale build that kept going delayed the current one.
    const host = document.createElement("div");
    host.innerHTML = [1, 2, 3]
      .map(
        (n) => `<pre><code class="language-mermaid">flowchart LR\n  s${n} --> t${n}</code></pre>`,
      )
      .join("");
    document.body.append(host);
    const render = vi.spyOn(mermaid, "render");
    let calls = 0;
    const results = await renderDiagrams(host, () => ++calls > 1);
    expect(results).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("the same diagram twice in one deck gets two separate renders", async () => {
    // A shared SVG would carry the same element ids twice, and arrowhead
    // markers resolve to the first copy, which may sit on a hidden slide.
    const host = document.createElement("div");
    const block = `<pre><code class="language-mermaid">flowchart LR\n  twin --> pair</code></pre>`;
    host.innerHTML = block + block;
    document.body.append(host);
    await renderDiagrams(host);
    const ids = [...host.querySelectorAll("svg")].map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
