import { getStroke } from "perfect-freehand";
import { outlinePath } from "../annotate/outline";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * How long a point of the trail stays on screen, as on the slides
 * (`LASER_TRAIL_MS` in annotate/layer.ts). Not imported from there: that
 * module pulls drauu and the annotation layer's CSS into the map's chunk.
 */
export const MAP_LASER_TRAIL_MS = 600;

/** The dot's diameter and the trail's width in CSS pixels, the slides' `LASER_SIZE` (not exported there). */
export const MAP_LASER_SIZE = 12;

export interface MapLaser {
  /** Shows the dot at `x`, `y` in the pane's padding box, in CSS pixels, and adds a trail point. */
  point: (x: number, y: number) => void;
  /** Hides the dot; a trail already drawn fades on its own. */
  hide: () => void;
  /** Removes the overlay; later calls do nothing. */
  dispose: () => void;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The map's laser (decision 149): a dot and the slides' fading trail on an
 * overlay over `pane`, in screen pixels, outside the scaled layer, so it has
 * one size at every zoom. The overlay takes no pointer events and is hidden
 * from assistive technology; MapView decides which pointer points. Reduced
 * motion, read at each point, draws the dot alone.
 */
export function createMapLaser(pane: HTMLElement): MapLaser {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("docwalk-map-laser");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("r", String(MAP_LASER_SIZE / 2));
  pane.append(svg);

  let trail: TrailPoint[] = [];
  let frame = 0;
  let live = true;

  /** The trail under the dot, so the dot stays on top. */
  const showPath = () => {
    if (!path.isConnected) svg.insertBefore(path, svg.firstChild);
  };

  const render = () => {
    frame = 0;
    const now = performance.now();
    trail = trail.filter((p) => now - p.t < MAP_LASER_TRAIL_MS);
    if (trail.length === 0) {
      path.remove();
      return;
    }
    // The slides' stroke (annotate/layer.ts, renderTrail).
    const outline = getStroke(
      trail.map((p) => [p.x, p.y]),
      {
        size: MAP_LASER_SIZE,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.4,
        start: { taper: true },
      },
    );
    path.setAttribute("d", outlinePath(outline));
    const newest = trail.at(-1) as TrailPoint;
    path.setAttribute("opacity", String(1 - (now - newest.t) / MAP_LASER_TRAIL_MS));
    showPath();
    frame = requestAnimationFrame(render);
  };

  return {
    point(x, y) {
      if (!live) return;
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      if (!dot.isConnected) svg.append(dot);
      if (reducedMotion()) {
        trail = [];
        path.remove();
        return;
      }
      trail.push({ x, y, t: performance.now() });
      if (!frame) frame = requestAnimationFrame(render);
    },
    hide() {
      dot.remove();
    },
    dispose() {
      if (!live) return;
      live = false;
      cancelAnimationFrame(frame);
      frame = 0;
      trail = [];
      svg.remove();
    },
  };
}
