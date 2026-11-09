import { getStroke } from "perfect-freehand";
import { COORD_MAX, MIRROR_HEIGHT, MIRROR_WIDTH } from "./mirrorTypes";
import { outlinePath } from "./outline";
import type { SavedStroke } from "./savedMarks";

/**
 * Saved marks as SVG (decision 105): the annotation layer draws restored
 * strokes with it, and the exports draw a slide's marks over the page. Every
 * element is made here with `createElementNS` and `setAttribute` from the
 * stroke's numbers; the tool and colour come from fixed lists, so nothing
 * stored is ever parsed as markup. The shapes match mirrorView.ts, which
 * matches drauu's pen and arrow.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const PEN_SIZE = 4;
/** drauu's arrowhead: a marker 4 stroke widths wide, 16 px at a stroke width of 4. */
const HEAD_LENGTH = 16;
const HEAD_HALF_WIDTH = 8;

/**
 * One stroke in a box `width` by `height` user units wide. With `paint` the
 * colour is written on the element, as drauu does on the presenter's
 * surface; without it, CSS colours the element by its `data-color` key.
 */
export function strokeElement(
  stroke: SavedStroke,
  width: number,
  height: number,
  paint?: string,
  doc: Document = document,
): SVGElement | null {
  const { points } = stroke;
  const x = (i: number) => ((points[i] ?? 0) * width) / COORD_MAX;
  const y = (i: number) => ((points[i] ?? 0) * height) / COORD_MAX;
  let element: SVGElement;
  if (stroke.tool === "arrow") {
    if (points.length < 4) return null;
    element = arrow(doc, x(0), y(1), x(2), y(3), paint);
  } else {
    if (points.length < 2) return null;
    const pairs: number[][] = [];
    for (let i = 0; i + 1 < points.length; i += 2) pairs.push([x(i), y(i + 1), 0.5]);
    // The options of drauu's stylus, so a restored stroke looks like the one drawn.
    const outline = getStroke(pairs, {
      size: PEN_SIZE,
      thinning: 0.9,
      simulatePressure: false,
      start: { taper: 5 },
      end: { taper: 5 },
    });
    element = doc.createElementNS(SVG_NS, "path");
    element.setAttribute("d", outlinePath(outline));
    if (paint) element.setAttribute("fill", paint);
  }
  element.dataset["tool"] = stroke.tool;
  element.dataset["color"] = stroke.color;
  return element;
}

function arrow(doc: Document, x1: number, y1: number, x2: number, y2: number, paint?: string) {
  const group = doc.createElementNS(SVG_NS, "g");
  const line = doc.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / length;
  const dy = (y2 - y1) / length;
  // The head's tip is half its length past the line's end, as drauu's marker puts it.
  const half = HEAD_LENGTH / 2;
  const baseX = x2 - dx * half;
  const baseY = y2 - dy * half;
  const head = doc.createElementNS(SVG_NS, "path");
  head.setAttribute(
    "d",
    `M ${x2 + dx * half} ${y2 + dy * half} L ${baseX - dy * HEAD_HALF_WIDTH} ${baseY + dx * HEAD_HALF_WIDTH} L ${baseX + dy * HEAD_HALF_WIDTH} ${baseY - dx * HEAD_HALF_WIDTH} Z`,
  );
  if (paint) {
    line.setAttribute("stroke", paint);
    line.setAttribute("stroke-width", String(PEN_SIZE));
    line.setAttribute("stroke-linecap", "round");
    head.setAttribute("fill", paint);
  }
  group.append(line, head);
  return group;
}

/**
 * A slide's marks for an export page: an SVG with the slide's 1280 by 720
 * view box that stretches over the page (export.css colours it).
 */
export function marksOverlay(doc: Document, strokes: readonly SavedStroke[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "docwalk-export-marks");
  svg.setAttribute("viewBox", `0 0 ${MIRROR_WIDTH} ${MIRROR_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const stroke of strokes) {
    const element = strokeElement(stroke, MIRROR_WIDTH, MIRROR_HEIGHT, undefined, doc);
    if (element) svg.append(element);
  }
  return svg;
}
