/**
 * Comment markers on the scaled slide (decision 94). A count button sits
 * beside each heading of the current slide that has open comments, in a layer
 * of its own on the stage: never inside a page, so the pagination probes, the
 * overview and the exporters, which copy or measure pages, never meet it.
 *
 * reveal.js scales the 1280 by 720 stage with a CSS transform. A button
 * placed in stage pixels would shrink with it (at 0.4 it would be 10 px), so
 * each button is placed from the end of its heading's text on screen and drawn
 * `max(1, 1/scale)` times its size: never under 24 CSS px on screen, and
 * growing with the slide above scale 1. Slide content is not touched (rule 3).
 * Markers carry only counts and heading titles, set as text.
 */
import type { SlideInfo } from "../deck/controller";
import { m } from "../paraglide/messages.js";
import { anchorTarget } from "../render/fragments";
import { anchorKey, openCounts, type AnchorIndex } from "./anchors";
import { markerIcon } from "./markers";
import type { DocComment } from "./types";

export const SLIDE_MARKERS_CLASS = "docwalk-slide-markers";
export const SLIDE_MARKER_CLASS = "docwalk-slide-marker";

/** Stage pixels between the end of the heading's text and the button. */
const GAP = 8;
/** The stage's design width (src/deck/Deck.tsx, SLIDE_SIZE), to keep a button on the slide. */
const STAGE_WIDTH = 1280;
/** Layout requests that arrive together are done together. A timer, not an animation frame: a hidden tab gets none. */
const LAYOUT_MS = 16;

export interface SlideMarkers {
  /** Sets what to mark and lays the layer out now. */
  update(index: AnchorIndex, comments: readonly DocComment[]): void;
  /** Lays the layer out for the current slide, now and again a moment later. */
  layout(): void;
  destroy(): void;
}

/** The page element that shows `slide`, among the stage's own children. */
function pageOf(stage: HTMLElement, slide: SlideInfo): HTMLElement | null {
  for (const el of stage.querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")) {
    if (
      el.dataset["docwalkId"] === slide.sectionId &&
      (el.dataset["page"] ?? "1") === `${slide.page}`
    ) {
      return el;
    }
  }
  return null;
}

/** The last line box of a heading's text, where the button goes. */
function lastLine(heading: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(heading);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  return lines.at(-1) ?? heading.getBoundingClientRect();
}

export function attachSlideMarkers(
  stage: HTMLElement,
  current: () => SlideInfo | null,
  onOpen: (slug: string) => void,
): SlideMarkers {
  const layer = document.createElement("div");
  layer.className = SLIDE_MARKERS_CLASS;
  stage.append(layer);

  let index: AnchorIndex | null = null;
  let comments: readonly DocComment[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function run() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    layer.replaceChildren();
    const slide = current();
    const page = slide ? pageOf(stage, slide) : null;
    if (!index || !page) return;
    const counts = openCounts(comments, index);
    if (counts.size === 0) return;

    const box = stage.getBoundingClientRect();
    // The stage is laid out at its design size and scaled by a transform.
    const scale = box.width / (stage.offsetWidth || STAGE_WIDTH) || 1;
    const grow = Math.max(1, 1 / scale);
    const body = page.querySelector<HTMLElement>(".docwalk-slide-body")?.getBoundingClientRect();
    for (const target of index.headings) {
      const n = counts.get(anchorKey({ kind: "heading", slug: target.slug })) ?? 0;
      const heading = n > 0 ? anchorTarget(page, target.slug) : null;
      if (!heading || !/^H[1-6]$/.test(heading.tagName)) continue;
      const line = lastLine(heading);
      const middle = line.top + line.height / 2;
      // A heading scrolled out of its slide, or not shown, gets no button.
      if (line.height === 0 || (body && (middle < body.top || middle > body.bottom))) continue;

      const rtl = getComputedStyle(heading).direction === "rtl";
      const button = document.createElement("button");
      button.type = "button";
      button.className = SLIDE_MARKER_CLASS;
      button.setAttribute("aria-label", m.comments_marker({ count: n, title: target.title }));
      button.append(markerIcon(), document.createTextNode(String(n)));
      button.addEventListener("click", () => onOpen(target.slug));
      layer.append(button);

      const y = (middle - box.top) / scale;
      let x = rtl ? (line.left - box.left) / scale - GAP : (line.right - box.left) / scale + GAP;
      const width = button.offsetWidth * grow;
      // Keep the button on the slide when a heading runs to its edge.
      x = rtl ? Math.min(Math.max(x, width), STAGE_WIDTH) : Math.min(x, STAGE_WIDTH - width);
      button.style.left = `${Math.max(0, x)}px`;
      button.style.top = `${y}px`;
      button.style.transformOrigin = rtl ? "100% 50%" : "0 50%";
      button.style.transform = `translate(${rtl ? "-100%" : "0"}, -50%) scale(${grow})`;
    }
  }

  function schedule() {
    if (timer === undefined) timer = setTimeout(run, LAYOUT_MS);
  }

  /** Now, and once more shortly: on a slide change reveal.js shows the slide a moment after it says so. */
  function layout() {
    run();
    schedule();
  }

  // reveal.js writes its scale into the stage's style on every resize and slide change.
  const observer = new MutationObserver(schedule);
  observer.observe(stage, { attributes: true, attributeFilter: ["style"] });

  return {
    update(nextIndex, nextComments) {
      index = nextIndex;
      comments = nextComments;
      layout();
    },
    layout,
    destroy() {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      layer.remove();
    },
  };
}
