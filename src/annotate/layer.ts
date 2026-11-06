import { createDrauu, type Drauu, type DrawingMode } from "@drauu/core";
import { getStroke } from "perfect-freehand";
import "./layer.css";
import type { AnnotationLayer, AnnotationMode } from "./types";

// App loads this module lazily, with the layer, after the deck is up.
export { markKeys } from "./markKeys";

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
 *
 * Each slide key gets its own drauu instance on its own SVG surface, made on
 * the first visit. Dumping and reloading one instance's markup on every slide
 * switch wiped drauu's undo stack, so marks made before leaving a slide could
 * no longer be undone after coming back to it.
 */
export function createAnnotationLayer(host: HTMLElement): AnnotationLayer {
  const root = document.createElement("div");
  root.className = "docwalk-annotate";
  const laser = surface("laser");
  root.append(laser);

  // The overlay is absolutely positioned, so it needs a containing block.
  let stage = host;
  let restorePosition = "";
  function attach(next: HTMLElement) {
    stage = next;
    restorePosition = next.style.position;
    if (getComputedStyle(next).position === "static") next.style.position = "relative";
    next.append(root);
  }
  function detach() {
    root.remove();
    stage.style.position = restorePosition;
  }
  attach(host);

  // Until setColor, draw in the accent (DESIGN.md: it marks the pen). currentColor would
  // follow the host's text colour, which is light on the dark stage and vanishes on a white slide.
  const accent = getComputedStyle(host).getPropertyValue("--dw-color-primary").trim();
  let color = accent || "currentColor";

  let mode: AnnotationMode = "off";
  let key: string | null = null;
  /** One drawing per slide key; `null` holds marks made before the first key. */
  const drawings = new Map<string | null, Drauu>();

  /** Bring a drawing up to the current tool and colour. */
  function applyTool(drawing: Drauu) {
    drawing.brush.color = color;
    if (mode === "pen" || mode === "arrow" || mode === "eraser") {
      drawing.brush.arrowEnd = mode === "arrow";
      // Also re-indexes the strokes for drauu's eraser.
      drawing.mode = DRAUU_MODE[mode];
    }
  }

  function createDrawing(): Drauu {
    const svg = surface("draw");
    root.insertBefore(svg, laser);
    const drawing = createDrauu({ el: svg, brush: { mode: "stylus", color, size: PEN_SIZE } });
    applyTool(drawing);
    return drawing;
  }

  /** Only the current slide's surface is shown and takes pointer events (layer.css). */
  function show(drawing: Drauu) {
    for (const d of drawings.values()) {
      if (d.el) d.el.dataset["active"] = String(d === drawing);
    }
  }

  let active = createDrawing();
  drawings.set(null, active);
  show(active);

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
    if (mode === "eraser") active.mode = "eraseLine";
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
      applyTool(active);
    },
    mode: () => mode,
    setColor(next) {
      color = next;
      active.brush.color = next;
    },
    undo() {
      active.undo();
      refreshEraser();
    },
    redo() {
      active.redo();
      refreshEraser();
    },
    clear() {
      active.clear();
      refreshEraser();
    },
    setKey(next) {
      if (next === key) return;
      if (key === null) {
        // Marks made before the first key belong to the first slide.
        drawings.delete(null);
        drawings.set(next, active);
      } else {
        // A stroke still being drawn when the slide changes belongs to no slide.
        active.cancel();
        active.drawing = false;
        let drawing = drawings.get(next);
        if (!drawing) {
          drawing = createDrawing();
          drawings.set(next, drawing);
        }
        active = drawing;
        applyTool(active);
        show(active);
      }
      key = next;
      clearLaser();
    },
    moveTo(next) {
      if (next === stage) return;
      clearLaser();
      detach();
      attach(next);
    },
    retain(keys) {
      const keep = new Set<string | null>(keys);
      for (const [k, drawing] of drawings) {
        if (drawing === active || keep.has(k)) continue;
        // drauu forgets its element on unmount, so take it first.
        const svg = drawing.el;
        drawing.unmount();
        svg?.remove();
        drawings.delete(k);
      }
    },
    destroy() {
      clearLaser();
      laser.removeEventListener("pointerdown", onLaserDown);
      laser.removeEventListener("pointermove", onLaserMove);
      laser.removeEventListener("pointerup", onLaserEnd);
      laser.removeEventListener("pointercancel", onLaserEnd);
      laser.removeEventListener("pointerleave", onLaserEnd);
      for (const d of drawings.values()) d.unmount();
      drawings.clear();
      detach();
    },
  };
}
