import { getStroke } from "perfect-freehand";
import "./mirror.css";
import type { MirrorStore, StoredStroke } from "./mirrorStore";
import { COORD_MAX, MIRROR_HEIGHT, MIRROR_LASER_IDLE_MS, MIRROR_WIDTH } from "./mirrorTypes";
import { outlinePath } from "./outline";
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
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const PEN_SIZE = 4;
/** drauu's arrowhead: a marker 4 stroke widths wide, 16 px at a stroke width of 4. */
const HEAD_LENGTH = 16;
const HEAD_HALF_WIDTH = 8;
/** Changes that arrive together are drawn together. A timer, not an animation frame: a hidden tab gets none. */
const REDRAW_MS = 16;

export interface MirrorView {
  /** Draws the store's state for the current address now. */
  refresh(): void;
  /** Moves the overlay to a new host: a deck rebuild replaces the stage mid-talk. */
  moveTo(host: HTMLElement): void;
  destroy(): void;
}

const gridX = (n: number) => (n * MIRROR_WIDTH) / COORD_MAX;
const gridY = (n: number) => (n * MIRROR_HEIGHT) / COORD_MAX;

function drawPen(points: number[]): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  const pairs: number[][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    pairs.push([gridX(points[i]!), gridY(points[i + 1]!), 0.5]);
  }
  // The options of drauu's stylus, so the presenter's stroke and its copy match.
  const outline = getStroke(pairs, {
    size: PEN_SIZE,
    thinning: 0.9,
    simulatePressure: false,
    start: { taper: 5 },
    end: { taper: 5 },
  });
  path.setAttribute("d", outlinePath(outline));
  return path;
}

function drawArrow(points: number[]): SVGGElement {
  const group = document.createElementNS(SVG_NS, "g");
  const x1 = gridX(points[0]!);
  const y1 = gridY(points[1]!);
  const x2 = gridX(points[2]!);
  const y2 = gridY(points[3]!);
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  // The head's tip is half its length past the line's end, as drauu's marker puts it.
  const half = HEAD_LENGTH / 2;
  const tip = `${x2 + dx * half} ${y2 + dy * half}`;
  const baseX = x2 - dx * half;
  const baseY = y2 - dy * half;
  const left = `${baseX - dy * HEAD_HALF_WIDTH} ${baseY + dx * HEAD_HALF_WIDTH}`;
  const right = `${baseX + dy * HEAD_HALF_WIDTH} ${baseY - dx * HEAD_HALF_WIDTH}`;
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("d", `M ${tip} L ${left} L ${right} Z`);
  group.append(line, head);
  return group;
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

function draw(stroke: StoredStroke): SVGElement | null {
  if (stroke.tool === "arrow") {
    // An arrow needs both ends; a shorter list is a stroke that is still arriving.
    return stroke.points.length >= 4 ? drawArrow(stroke.points) : null;
  }
  if (stroke.tool === "rect" || stroke.tool === "ellipse") {
    // The saved marks and exports draw shapes the same way (decision 110).
    return strokeElement(stroke, MIRROR_WIDTH, MIRROR_HEIGHT);
  }
  return stroke.points.length >= 2 ? drawPen(stroke.points) : null;
}

/**
 * Attaches the overlay to `host` (the slide box, or a slide-sized preview).
 * `address` says which slide the receiver shows now; only that slide's marks
 * are drawn, so a page the receiver does not have never shows a stranger's.
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
  root.append(svg, dot);

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

  function render() {
    pending = undefined;
    const slide = address();
    const strokes = slide === null ? [] : store.strokes(slide);
    const elements: SVGElement[] = [];
    const live = new Set<number>();
    for (const stroke of strokes) {
      live.add(stroke.id);
      let entry = drawn.get(stroke.id);
      if (!entry || !sameStroke(entry.from, stroke)) {
        const element = draw(stroke);
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
    },
    destroy() {
      unsubscribe();
      clearTimeout(pending);
      clearTimeout(laserTimer);
      detach();
    },
  };
}
