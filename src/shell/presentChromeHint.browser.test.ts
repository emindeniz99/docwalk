import { act, createElement as h, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CHROME_IDLE_MS, overlapsAny, slideContentBoxes, usePresentChrome } from "./presentChrome";

/**
 * The first-use hint never covers slide content (decision 134). In phone
 * landscape the hint sat over the last lines of a slide filled to the
 * bottom. It now shows only where its box overlaps none of the slide's
 * content, read from the rendered page (rule 2), and a hint that did not
 * show is not counted as seen. These run in a real browser: the boxes are
 * the point, and jsdom has none.
 */

const HINT_KEY = "docwalk.presentControlsHintSeen";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.removeItem(HINT_KEY);
  vi.useRealTimers();
});

const rect = (x: number, y: number, width: number, height: number) =>
  new DOMRect(x, y, width, height);

describe("overlapsAny", () => {
  test("a box that shares area with any other overlaps", () => {
    expect(overlapsAny(rect(0, 0, 100, 20), [rect(500, 500, 10, 10), rect(90, 15, 50, 50)])).toBe(
      true,
    );
  });

  test("boxes that only touch at an edge leave the hint clear of the text", () => {
    expect(overlapsAny(rect(0, 0, 100, 20), [rect(0, 20, 100, 20), rect(100, 0, 10, 20)])).toBe(
      false,
    );
  });

  test("nothing to cover, nothing overlapped", () => {
    expect(overlapsAny(rect(0, 0, 100, 20), [])).toBe(false);
  });
});

/** A slide in a fixed box, so its boxes do not depend on the test page's width. */
function slide(html: string): HTMLElement {
  const el = document.createElement("section");
  el.style.cssText =
    "position: absolute; inset: 0 auto auto 0; width: 400px; font: 16px/20px serif";
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

describe("slideContentBoxes", () => {
  test("each text line is its own box, so a short last line leaves the space beside it free", () => {
    const s = slide(`<p style="margin: 0; width: 120px">one two three four five six seven</p>`);
    const boxes = slideContentBoxes(s);
    expect(boxes.length).toBeGreaterThan(1);
    // Line boxes stack: the paragraph is several rows of text, not one block.
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(boxes.length);
    for (const b of boxes) expect(b.right).toBeLessThanOrEqual(120 + 0.5);
  });

  test("images, diagrams, code and tables count whole; hidden text and blank space do not", () => {
    const s = slide(`
      <img alt="" width="50" height="40" style="display: block">
      <svg width="60" height="30" style="display: block"></svg>
      <pre style="margin: 0; height: 30px"></pre>
      <table style="height: 25px; width: 80px"><tbody><tr><td></td></tr></tbody></table>
      <aside class="notes" style="display: none">Speaker notes the room never sees.</aside>
    `);
    const boxes = slideContentBoxes(s);
    expect(boxes.map((b) => [Math.round(b.width), Math.round(b.height)])).toEqual([
      [50, 40],
      [60, 30],
      [400, 30],
      [80, 25],
    ]);
  });
});

function Harness({ pane, html }: { pane: RefObject<HTMLDivElement | null>; html: string }) {
  const chrome = usePresentChrome({ active: true, pane, slideOwner: () => false });
  return h("div", {
    ref: pane,
    "data-hint": String(chrome.hint),
    style: { position: "relative", width: "640px", height: "360px" },
    dangerouslySetInnerHTML: {
      __html: `<div class="docwalk-preview-head"><button>Overview</button></div>
        <div class="reveal"><div class="slides">
          <section class="present" style="position: absolute; inset: 0; font: 16px/20px serif">${html}</section>
        </div></div>
        <p role="status" class="docwalk-chrome-hint"
          style="position: absolute; bottom: 32px; left: 0; right: 0; width: fit-content; margin: 0 auto; padding: 8px 16px"></p>`,
    },
  });
}

/** Mounts the harness, lets the idle timer hide the chrome, and waits two frames for the measure. */
async function hideOnce(html: string): Promise<string | null> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const pane = createRef<HTMLDivElement>();
  act(() => root!.render(h(Harness, { pane, html })));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_MS + 100);
  });
  vi.useRealTimers();
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((done) => requestAnimationFrame(done));
  });
  return pane.current?.getAttribute("data-hint") ?? null;
}

describe("the first hide", () => {
  test("over a line at the bottom of the slide, the hint stays away and is not counted as seen", async () => {
    const line = `<p style="position: absolute; bottom: 30px; left: 0; right: 0; margin: 0; text-align: center">The last line the room is reading</p>`;
    expect(await hideOnce(line)).toBe("false");
    expect(localStorage.getItem(HINT_KEY)).toBeNull();
  });

  test("with the slide's content at the top, the hint shows and is counted as seen", async () => {
    expect(await hideOnce(`<h2 style="margin: 0">A short slide</h2>`)).toBe("true");
    expect(localStorage.getItem(HINT_KEY)).toBe("true");
  });
});
