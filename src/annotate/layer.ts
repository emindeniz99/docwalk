import { createDrauu, type DrawingMode } from "@drauu/core";
import { getStroke } from "perfect-freehand";
import "./layer.css";
import type { AnnotationLayer, AnnotationMode } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** How long a laser point stays on screen; the trail is gone this long after the pointer stops. */
export const LASER_TRAIL_MS = 600;

const PEN_SIZE = 4;
const LASER_SIZE = 12;

const DRAUU_MODE: Record<"pen" | "arrow" | "eraser", DrawingMode> = {
  pen: "stylus",
  arrow: "line",
  eraser: "eraseLine",
};

interface LaserPoint {
  x: number;
  y: number;
  t: number;
}

function surface(kind: "draw" | "laser"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("docwalk-annotate-surface", `docwalk-annotate-${kind}`);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

/** perfect-freehand outline points to an SVG path, closed with quadratic curves. */
function outlinePath(points: number[][]): string {
  if (points.length < 2) return "";
  const [first] = points as [number[]];
  let d = `M ${first[0]} ${first[1]} Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i] as [number, number];
    const [x1, y1] = points[(i + 1) % points.length] as [number, number];
    d += ` ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
  }
  return `${d} Z`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Pen, arrow and eraser marks (drauu) plus a fading laser trail over `host`.
 * Marks live in memory per slide key; nothing is written anywhere else.
 */
export function createAnnotationLayer(host: HTMLElement): AnnotationLayer {
  const root = document.createElement("div");
  root.className = "docwalk-annotate";
  const draw = surface("draw");
  const laser = surface("laser");
  root.append(draw, laser);

  // The overlay is absolutely positioned, so it needs a containing block.
  const restorePosition = host.style.position;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.append(root);

  // Until setColor, draw in the accent (DESIGN.md: it marks the pen). currentColor would
  // follow the host's text colour, which is light on the dark stage and vanishes on a white slide.
  const accent = getComputedStyle(host).getPropertyValue("--dw-color-primary").trim();
  const drauu = createDrauu({
    el: draw,
    brush: { mode: "stylus", color: accent || "currentColor", size: PEN_SIZE },
  });

  let mode: AnnotationMode = "off";
  let key: string | null = null;
  const saved = new Map<string, string>();

  // Laser state.
  let trail: LaserPoint[] = [];
  let frame = 0;
  let idleTimer = 0;
  const laserPath = document.createElementNS(SVG_NS, "path");
  const laserDot = document.createElementNS(SVG_NS, "circle");
  laserDot.setAttribute("r", String(LASER_SIZE / 2));

  function setRootMode(next: AnnotationMode) {
    root.dataset.mode = next;
  }
  setRootMode(mode);

  /** drauu's eraser indexes the strokes when it is selected; re-index after the strokes change. */
  function refreshEraser() {
    if (mode === "eraser") drauu.mode = "eraseLine";
  }

  function clearLaser() {
    trail = [];
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(idleTimer);
    laser.replaceChildren();
  }

  function toLocal(event: PointerEvent): { x: number; y: number } {
    const point = laser.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(laser.getScreenCTM()?.inverse());
    return { x: local.x, y: local.y };
  }

  function renderTrail() {
    frame = 0;
    const now = performance.now();
    trail = trail.filter((p) => now - p.t < LASER_TRAIL_MS);
    if (trail.length === 0) {
      laser.replaceChildren();
      return;
    }
    const outline = getStroke(
      trail.map((p) => [p.x, p.y]),
      { size: LASER_SIZE, thinning: 0.6, smoothing: 0.5, streamline: 0.4, start: { taper: true } },
    );
    laserPath.setAttribute("d", outlinePath(outline));
    const newest = trail[trail.length - 1] as LaserPoint;
    laserPath.setAttribute("opacity", String(1 - (now - newest.t) / LASER_TRAIL_MS));
    if (!laserPath.isConnected) laser.replaceChildren(laserPath);
    frame = requestAnimationFrame(renderTrail);
  }

  function onLaserMove(event: PointerEvent) {
    if (mode !== "laser") return;
    const { x, y } = toLocal(event);
    if (prefersReducedMotion()) {
      // No moving trail and no fade: a still dot that goes away in one step.
      laserDot.setAttribute("cx", String(x));
      laserDot.setAttribute("cy", String(y));
      if (!laserDot.isConnected) laser.replaceChildren(laserDot);
      clearTimeout(idleTimer);
      idleTimer = window.setTimeout(clearLaser, LASER_TRAIL_MS);
      return;
    }
    trail.push({ x, y, t: performance.now() });
    if (!frame) frame = requestAnimationFrame(renderTrail);
  }

  function onLaserDown(event: PointerEvent) {
    if (mode !== "laser") return;
    // Keep receiving moves while a finger or stylus drags past the overlay edge.
    laser.setPointerCapture?.(event.pointerId);
    onLaserMove(event);
  }

  function onLaserEnd() {
    // Normal motion lets the trail fade on its own; reduced motion removes it now.
    if (prefersReducedMotion()) clearLaser();
  }

  laser.addEventListener("pointerdown", onLaserDown);
  laser.addEventListener("pointermove", onLaserMove);
  laser.addEventListener("pointerup", onLaserEnd);
  laser.addEventListener("pointercancel", onLaserEnd);
  laser.addEventListener("pointerleave", onLaserEnd);

  return {
    setMode(next) {
      if (next === mode) return;
      mode = next;
      setRootMode(next);
      if (next !== "laser") clearLaser();
      if (next === "pen" || next === "arrow" || next === "eraser") {
        drauu.brush.arrowEnd = next === "arrow";
        drauu.mode = DRAUU_MODE[next];
      }
    },
    mode: () => mode,
    setColor(color) {
      drauu.brush.color = color;
    },
    undo() {
      drauu.undo();
      refreshEraser();
    },
    redo() {
      drauu.redo();
      refreshEraser();
    },
    clear() {
      drauu.clear();
      refreshEraser();
    },
    setKey(next) {
      if (next === key) return;
      // Marks made before the first key belong to the first slide.
      if (key !== null) {
        const dump = drauu.dump();
        if (dump) saved.set(key, dump);
        else saved.delete(key);
        const restored = saved.get(next);
        if (restored) drauu.load(restored);
        else drauu.clear();
      }
      key = next;
      clearLaser();
      refreshEraser();
    },
    destroy() {
      clearLaser();
      laser.removeEventListener("pointerdown", onLaserDown);
      laser.removeEventListener("pointermove", onLaserMove);
      laser.removeEventListener("pointerup", onLaserEnd);
      laser.removeEventListener("pointercancel", onLaserEnd);
      laser.removeEventListener("pointerleave", onLaserEnd);
      drauu.unmount();
      root.remove();
      host.style.position = restorePosition;
      saved.clear();
    },
  };
}
