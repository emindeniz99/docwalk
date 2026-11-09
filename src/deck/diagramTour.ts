import { m } from "../paraglide/messages.js";
import { diagramGraph, type DiagramGraph } from "./diagramGraph";
import {
  normalizeTour,
  TOUR_MAX_NEIGHBOURS_READ,
  tourHighlight,
  type TourHighlight,
  type TourPath,
} from "./tourModel";
import "./diagramTour.css";

/**
 * Draws one step of the diagram tour on the focus view's copy of a diagram
 * (decision 109). docwalk adds a single `g.docwalk-tour-layer` as the last
 * child of the root svg, and a `data-docwalk-tour-dim` attribute on the edge
 * paths off the path. Nothing else in Mermaid's SVG changes, and `clear`
 * puts the svg back as it was (rule 3: nothing hidden, clipped or scaled).
 *
 * Rule 5: no HTML is parsed here and no node id is written to the page.
 * Rings take their size from `getBBox`, lines copy the `d` of a path in the
 * sanitized copy, and labels reach the caller as strings for `textContent`.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
/** Units between a node and its ring. */
const RING_PADDING = 6;
const DIM_ATTRIBUTE = "data-docwalk-tour-dim";

export interface DiagramTour {
  /** Nodes the tour can step through. */
  readonly count: number;
  /**
   * Announce and draw a path (node numbers from 1, the last current). The
   * status is announced at once; the marks are drawn once the first Fit has
   * run (rule 4). The promise settles when this path is drawn, or when a later
   * `show` or `clear` replaced it. An empty path, or one with no node of this
   * diagram, clears the marks.
   */
  show(path: TourPath): Promise<void>;
  /** Remove every mark docwalk added. */
  clear(): void;
  /** The number of the node that holds `target`, or `null` on the ground. */
  nodeAt(target: EventTarget | null): number | null;
}

/**
 * @param svg The view's copy of the diagram, with its Mermaid ids.
 * @param source The diagram's Markdown text, as `data-source` holds it.
 * @param announce Gets the status text for a polite live region; set it with `textContent`.
 * @param options.fitted Settles after the stage's first Fit; marks are measured after it.
 */
export function createDiagramTour(
  svg: SVGSVGElement,
  source: string,
  announce: (text: string) => void,
  options: { fitted?: Promise<unknown> } = {},
): DiagramTour {
  const graph = diagramGraph(svg, source);
  const count = graph.nodes.length;
  let layer: SVGGElement | null = null;
  // Bumped by every show and clear: a draw that waited draws only if it is still the latest.
  let latest = 0;

  // Measuring waits for fonts, the first Fit and one frame (rule 4). Text in a
  // cloned diagram is already laid out, but a hidden stage measures as zero.
  let measurable = false;
  let waiting: Promise<void> | null = null;
  const whenMeasurable = (): Promise<void> => {
    waiting ??= (async () => {
      await options.fitted;
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      measurable = true;
    })();
    return waiting;
  };

  function removeMarks() {
    layer?.remove();
    layer = null;
    for (const el of svg.querySelectorAll(`[${DIM_ATTRIBUTE}]`)) el.removeAttribute(DIM_ATTRIBUTE);
  }

  function draw(steps: TourPath) {
    removeMarks();
    const highlight = tourHighlight(steps, graph.edges);
    layer = document.createElementNS(SVG_NS, "g");
    layer.setAttribute("class", "docwalk-tour-layer");
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("pointer-events", "none");
    svg.append(layer);
    drawMarks(svg, layer, graph, highlight);
    graph.edges.forEach((edge, index) => {
      if (!highlight.pathEdges.has(index) && !highlight.touching.has(index)) {
        edge.path.setAttribute(DIM_ATTRIBUTE, "");
      }
    });
  }

  return {
    count,
    show(path) {
      const mine = ++latest;
      const steps = normalizeTour(path, count);
      if (steps.length === 0) {
        removeMarks();
        return Promise.resolve();
      }
      announce(statusText(graph, steps));
      if (measurable) {
        draw(steps);
        return Promise.resolve();
      }
      return whenMeasurable().then(() => {
        if (mine === latest) draw(steps);
      });
    },
    clear() {
      latest += 1;
      removeMarks();
    },
    nodeAt(target) {
      if (!(target instanceof Node)) return null;
      const index = graph.nodes.findIndex((node) =>
        node.elements.some((el) => el.contains(target)),
      );
      return index < 0 ? null : index + 1;
    },
  };
}

/** "Label. Node 2 of 7. Linked to: A, B and 3 more." as plain text. */
function statusText(graph: DiagramGraph, steps: TourPath): string {
  const highlight = tourHighlight(steps, graph.edges);
  const number = highlight.current ?? 1;
  const label = graph.nodes[number - 1]?.label ?? "";
  const step = m.tour_step({ label, number, count: graph.nodes.length });
  const linked = highlight.neighbours.flatMap((n) => graph.nodes[n - 1]?.label ?? []);
  if (linked.length === 0) return step;
  const read = linked.slice(0, TOUR_MAX_NEIGHBOURS_READ).join(", ");
  const more = linked.length - TOUR_MAX_NEIGHBOURS_READ;
  const names = more > 0 ? `${read} ${m.tour_links_more({ count: more })}` : read;
  return `${step} ${m.tour_links({ names })}`;
}

/** Edge lines first, then earlier rings, the current ring on top; each on a halo. */
function drawMarks(
  svg: SVGSVGElement,
  layer: SVGGElement,
  graph: DiagramGraph,
  highlight: TourHighlight,
) {
  // From an element's own space into the layer's, whatever zoom or Fit the svg has.
  const toLayer = layer.getCTM()?.inverse();
  if (!toLayer) return;
  const place = (mark: SVGElement, from: SVGGraphicsElement): boolean => {
    const ctm = from.getCTM();
    if (!ctm) return false;
    (mark as SVGGraphicsElement).transform.baseVal.initialize(
      svg.createSVGTransformFromMatrix(toLayer.multiply(ctm)),
    );
    return true;
  };

  for (const index of highlight.pathEdges) {
    const edge = graph.edges[index];
    const d = edge?.path.getAttribute("d");
    if (!edge || !d) continue;
    for (const cls of ["docwalk-tour-halo", "docwalk-tour-edge"]) {
      const line = document.createElementNS(SVG_NS, "path");
      line.setAttribute("class", cls);
      line.setAttribute("d", d);
      if (place(line, edge.path)) layer.append(line);
    }
  }

  const ring = (n: number, cls: string) => {
    for (const el of graph.nodes[n - 1]?.elements ?? []) {
      const box = boxOf(el);
      if (!box) continue;
      for (const kind of ["docwalk-tour-halo", cls]) {
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("class", kind);
        rect.setAttribute("x", String(box.x - RING_PADDING));
        rect.setAttribute("y", String(box.y - RING_PADDING));
        rect.setAttribute("width", String(box.width + 2 * RING_PADDING));
        rect.setAttribute("height", String(box.height + 2 * RING_PADDING));
        if (place(rect, el)) layer.append(rect);
      }
    }
  };
  for (const n of [...highlight.trail].toSorted((a, b) => a - b)) ring(n, "docwalk-tour-trail");
  if (highlight.current !== null) ring(highlight.current, "docwalk-tour-ring");
}

/**
 * The node's box in its own space, or `null` when it has none on screen (a
 * hidden or collapsed group). Chromium still answers `getBBox` and `getCTM`
 * for a group under `display: none`, so the screen box decides.
 */
function boxOf(el: SVGGraphicsElement): DOMRect | null {
  const onScreen = el.getBoundingClientRect();
  if (onScreen.width === 0 && onScreen.height === 0) return null;
  try {
    const box = el.getBBox();
    return box.width > 0 && box.height > 0 ? box : null;
  } catch {
    return null;
  }
}
