import { boardAddress, sectionOf } from "./board";
import { coverPage } from "./boardCover";
import "./mirror.css";
import type { MirrorStore, StoredStroke } from "./mirrorStore";
import { MIRROR_HEIGHT, MIRROR_LASER_IDLE_MS, MIRROR_WIDTH } from "./mirrorTypes";
import { strokeElement } from "./markSvg";

/**
 * Draws a `MirrorStore` over a slide (decision 88): the presenter's pen and
 * arrow marks and laser, on a follower's stage and over the presenter
 * window's preview. The overlay is an SVG with the slide's own 1280 by 720
 * view box, so a mark lands on the same spot at any window size and in any
 * frame, and it never takes a pointer event.
 *
 * Everything drawn is built here from the store's numbers with
 * `setAttribute` and `createElementNS`; the only things from the wire that
 * pick a look are a tool and a colour key, both from fixed lists, and the
 * colour is a design token (mirror.css). No message string is parsed as markup.
 *
 * While the presenter's whiteboard is open over the page the receiver shows
 * (decision 110), the overlay adds the board's paper and draws the strokes of
 * the section's board address in place of the page's, and keeps the page
 * underneath out of the keyboard's reach. The receiver's own slide change
 * ends it with no op: the address stops matching.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
/** Changes that arrive together are drawn together. A timer, not an animation frame: a hidden tab gets none. */
const REDRAW_MS = 16;

export interface MirrorView {
  /** Draws the store's state for the current address now. */
  refresh(): void;
  /** Moves the overlay to a new host: a deck rebuild replaces the stage mid-talk. */
  moveTo(host: HTMLElement): void;
  destroy(): void;
}

/**
 * Whether `next` draws as `before` did. The points count too: a stroke can be
 * replaced by one of the same id and length (ids restart after a presenter
 * reload). The store hands out a new array for every change, so the
 * reference usually answers before any number is compared.
 */
function sameStroke(before: StoredStroke, next: StoredStroke): boolean {
  if (before.tool !== next.tool || before.color !== next.color) return false;
  if (before.points === next.points) return true;
  return (
    before.points.length === next.points.length &&
    before.points.every((n, i) => n === next.points[i])
  );
}

/**
 * Attaches the overlay to `host` (the slide box, or a slide-sized preview).
 * `address` says which slide the receiver shows now; only that slide's marks
 * (or its board's, while the board is open over it) are drawn, so a page the
 * receiver does not have never shows a stranger's.
 */
export function attachMirror(
  host: HTMLElement,
  store: MirrorStore,
  address: () => string | null,
): MirrorView {
  const root = document.createElement("div");
  root.className = "docwalk-mirror";
  root.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MIRROR_WIDTH} ${MIRROR_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const dot = document.createElement("div");
  dot.className = "docwalk-remote-laser";
  dot.hidden = true;
  // The whiteboard's paper (decision 110): shown through `data-board`, under the strokes.
  const paper = document.createElement("div");
  paper.className = "docwalk-mirror-board";
  root.append(paper, svg, dot);

  // The overlay is absolutely positioned, so the host needs to be a containing block.
  let stage = host;
  let restorePosition = "";
  const attach = (next: HTMLElement) => {
    stage = next;
    restorePosition = next.style.position;
    if (getComputedStyle(next).position === "static") next.style.position = "relative";
    next.append(root);
  };
  const detach = () => {
    root.remove();
    stage.style.position = restorePosition;
  };
  attach(host);

  /** The element drawn for a stroke, with what it was drawn from. */
  const drawn = new Map<number, { from: StoredStroke; element: SVGElement }>();
  let laserTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLaser: { x: number; y: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  /** The undo of the keyboard cover, while the board shows. */
  let uncover: (() => void) | null = null;

  function render() {
    pending = undefined;
    const slide = address();
    const board = slide !== null && store.board === slide;
    root.toggleAttribute("data-board", board);
    if (board && !uncover) uncover = coverPage(stage);
    else if (!board && uncover) {
      uncover();
      uncover = null;
    }
    const shown = slide === null ? null : board ? boardAddress(sectionOf(slide)) : slide;
    const strokes = shown === null ? [] : store.strokes(shown);
    const elements: SVGElement[] = [];
    const live = new Set<number>();
    for (const stroke of strokes) {
      live.add(stroke.id);
      let entry = drawn.get(stroke.id);
      if (!entry || !sameStroke(entry.from, stroke)) {
        // Drawn as the saved marks and exports draw them (decisions 105, 110), with drauu's
        // stylus options and arrowhead, so the presenter's stroke and its copy match. A shorter
        // list than a stroke needs is one still arriving, and draws nothing.
        const element = strokeElement(stroke, MIRROR_WIDTH, MIRROR_HEIGHT);
        if (!element) {
          drawn.delete(stroke.id);
          continue;
        }
        element.dataset["mark"] = String(stroke.id);
        element.dataset["color"] = stroke.color;
        element.dataset["tool"] = stroke.tool;
        entry = { from: stroke, element };
        drawn.set(stroke.id, entry);
      }
      elements.push(entry.element);
    }
    for (const id of drawn.keys()) if (!live.has(id)) drawn.delete(id);
    const children = [...svg.children];
    if (elements.length !== children.length || elements.some((el, i) => el !== children[i])) {
      svg.replaceChildren(...elements);
    }

    const { laser } = store;
    dot.hidden = laser === null;
    if (laser) {
      dot.style.left = `${laser.x * 100}%`;
      dot.style.top = `${laser.y * 100}%`;
    }
    // A laser nobody turned off (a phone that dropped out) goes by itself.
    if (laser !== lastLaser) {
      lastLaser = laser;
      clearTimeout(laserTimer);
      laserTimer = laser
        ? setTimeout(() => store.apply({ op: "laser-off" }), MIRROR_LASER_IDLE_MS)
        : undefined;
    }
  }

  const schedule = () => {
    pending ??= setTimeout(render, REDRAW_MS);
  };
  const unsubscribe = store.subscribe(schedule);
  render();

  return {
    refresh() {
      clearTimeout(pending);
      render();
    },
    moveTo(next) {
      if (next === stage) return;
      detach();
      attach(next);
      // The rebuilt deck has a new current page; the board covers that one.
      if (uncover) {
        uncover();
        uncover = coverPage(next);
      }
    },
    destroy() {
      unsubscribe();
      clearTimeout(pending);
      clearTimeout(laserTimer);
      uncover?.();
      uncover = null;
      detach();
    },
  };
}
