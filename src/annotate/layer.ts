import { createDrauu, type Drauu, type DrawingMode } from "@drauu/core";
import { getStroke } from "perfect-freehand";
import "./layer.css";
import {
  MAX_STROKE_POINTS,
  MIN_STEP_PX,
  MIRROR_HEIGHT,
  MIRROR_WIDTH,
  quantize,
  type MarkColor,
  type MarkEvent,
  type MarkStroke,
  type MarkTool,
} from "./mirrorTypes";
import { coverPage } from "./boardCover";
import { strokeElement } from "./markSvg";
import { outlinePath } from "./outline";
import { watchPenDrags } from "./stylus";
import { acceptedInput } from "./stylusPolicy";
import type { AnnotationLayer, AnnotationLayerOptions, AnnotationMode } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** How long a laser point stays on screen; the trail is gone this long after the pointer stops. */
export const LASER_TRAIL_MS = 600;

const PEN_SIZE = 4;
const LASER_SIZE = 12;

/** The modes drauu draws or erases in; the laser and "off" are the layer's own. */
type DrawMode = MarkTool | "eraser";
const DRAUU_MODE: Record<DrawMode, DrawingMode> = {
  pen: "stylus",
  arrow: "line",
  rect: "rectangle",
  ellipse: "ellipse",
  eraser: "eraseLine",
};

const attrNum = (el: Element | null, name: string) => Number(el?.getAttribute(name));

const isMarkTool = (mode: AnnotationMode): mode is MarkTool =>
  mode === "pen" || mode === "arrow" || mode === "rect" || mode === "ellipse";

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

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Pen, arrow and eraser marks (drauu) plus a fading laser trail over `host`.
 * Marks live in memory per slide key; the layer writes nothing anywhere.
 * Observers (`observe`) hear the laser, strokes and the marks that are
 * visible, in slide units, so the mirror can send them on (decision 88) and
 * App can save them (decision 105); `options.saved` brings saved marks back.
 *
 * Each slide key gets its own drauu instance on its own SVG surface, made on
 * the first visit. Dumping and reloading one instance's markup on every slide
 * switch wiped drauu's undo stack, so marks made before leaving a slide could
 * no longer be undone after coming back to it.
 */
export function createAnnotationLayer(
  host: HTMLElement,
  options: AnnotationLayerOptions = {},
): AnnotationLayer {
  const { input } = options;
  const root = document.createElement("div");
  root.className = "docwalk-annotate";
  // The whiteboard's paper (decision 110): hidden unless a board is open, under every draw surface.
  const paper = document.createElement("div");
  paper.className = "docwalk-annotate-board";
  paper.setAttribute("aria-hidden", "true");
  const laser = surface("laser");
  root.append(paper, laser);

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

  // What observers hear (decision 88). Strokes are recorded whether or not anyone listens:
  // an observer that arrives later (a presenter window) is brought up to date from them.
  const observers = new Set<(event: MarkEvent) => void>();
  const notify = (event: MarkEvent) => {
    for (const observer of observers) observer(event);
  };
  /** The recorded stroke behind each committed element of a drawing. */
  const strokeOf = new WeakMap<Element, MarkStroke>();
  /** The slide address each drawing belongs to; null until the first key. */
  const slideOf = new Map<Drauu, string | null>();
  let colorKey: MarkColor = "primary";
  let nextStrokeId = 1;
  interface Capture {
    id: number;
    tool: MarkTool;
    color: MarkColor;
    points: number[];
    last: { x: number; y: number } | null;
  }
  let capture: Capture | null = null;

  // Until setColor, draw in the accent (DESIGN.md: it marks the pen). currentColor would
  // follow the host's text colour, which is light on the dark stage and vanishes on a white slide.
  const accent = getComputedStyle(host).getPropertyValue("--dw-color-primary").trim();
  let color = accent || "currentColor";

  let mode: AnnotationMode = "off";
  let key: string | null = null;
  /** The open whiteboard: its drawing and address, the page it covers and the undo of that cover. */
  let board: { address: string; page: string; drawing: Drauu; uncover: () => void } | null = null;
  /** One drawing per slide key; `null` holds marks made before the first key. */
  const drawings = new Map<string | null, Drauu>();

  /**
   * The pointer types a drawing accepts (decision 110). Once a pen is in use,
   * drauu leaves a finger's touch alone: it bubbles to reveal.js, which swipes.
   */
  function applyInput(drawing: Drauu) {
    const types =
      input &&
      acceptedInput({
        drawingTool: isMarkTool(mode) || mode === "eraser",
        laser: mode === "laser",
        stylusDraws: input.stylusDraws(),
        penInUse: input.penInUse(),
      });
    if (types) drawing.options.acceptsInputTypes = [...types] as ("mouse" | "touch" | "pen")[];
    else delete drawing.options.acceptsInputTypes;
  }

  /** Bring a drawing up to the current tool, colour and accepted input. */
  function applyTool(drawing: Drauu) {
    drawing.brush.color = color;
    if (isMarkTool(mode) || mode === "eraser") {
      drawing.brush.arrowEnd = mode === "arrow";
      // Also re-indexes the strokes for drauu's eraser.
      drawing.mode = DRAUU_MODE[mode];
    }
    applyInput(drawing);
  }

  /** True while a pen drag is handed to drauu: its own `pointerdown` is not a new drag. */
  let handingOver = false;

  function createDrawing(): Drauu {
    const svg = surface("draw");
    root.insertBefore(svg, laser);
    const drawing = createDrauu({ el: svg, brush: { mode: "stylus", color, size: PEN_SIZE } });
    applyTool(drawing);
    drawing.on("start", () => {
      if (drawing !== active) return;
      // A pen drag with no tool chosen is a pen stroke (decision 110).
      const tool = isMarkTool(mode) ? mode : handingOver ? "pen" : null;
      capture = tool ? { id: nextStrokeId++, tool, color: colorKey, points: [], last: null } : null;
    });
    drawing.on("changed", () => {
      if (drawing !== active) return;
      if (drawing.drawing) growStroke(drawing);
      else reportMarks(false);
    });
    drawing.on("committed", (node?: Element) => {
      if (drawing === active) commitStroke(drawing, node);
    });
    drawing.on("canceled", () => {
      if (drawing !== active || !capture) return;
      notify({ kind: "cancel", id: capture.id });
      capture = null;
    });
    return drawing;
  }

  /** The point in slide units, or null while the overlay has no size. */
  function unitPoint(x: number, y: number): { x: number; y: number } | null {
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    if (!width || !height || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: x / width, y: y / height };
  }

  /** The last point drauu's pen model holds, in slide units. */
  function penPoint(drawing: Drauu): { x: number; y: number } | null {
    const points = (drawing.model as unknown as { points?: { x: number; y: number }[] }).points;
    const at = points?.at(-1);
    return at ? unitPoint(at.x, at.y) : null;
  }

  /** The pen's newest point joins the stroke when it is far enough from the last one. */
  function growStroke(drawing: Drauu) {
    if (!capture || capture.tool !== "pen") return;
    const unit = penPoint(drawing);
    if (!unit || capture.points.length >= 2 * MAX_STROKE_POINTS) return;
    const { last } = capture;
    if (
      last &&
      Math.hypot((unit.x - last.x) * MIRROR_WIDTH, (unit.y - last.y) * MIRROR_HEIGHT) < MIN_STEP_PX
    ) {
      return;
    }
    capture.last = unit;
    capture.points.push(quantize(unit.x), quantize(unit.y));
    announceStroke(capture, false);
  }

  function announceStroke(stroke: Capture, end: boolean) {
    const slide = slideOf.get(active);
    if (slide == null) return;
    notify({
      kind: "stroke",
      slide,
      end,
      id: stroke.id,
      tool: stroke.tool,
      color: stroke.color,
      points: stroke.points,
    });
  }

  /**
   * The two corners of a drawn shape (decision 110): an arrow's two ends in
   * the order it was drawn, or the box of a `<rect>` or `<ellipse>`, top-left
   * first. Null when the element is none of those or has no size yet.
   */
  function cornersOf(node: Element): number[] | null {
    let box: [number, number, number, number];
    const line = node.querySelector("line");
    if (line) {
      box = [attrNum(line, "x1"), attrNum(line, "y1"), attrNum(line, "x2"), attrNum(line, "y2")];
    } else if (node.localName === "rect") {
      const [x, y] = [attrNum(node, "x"), attrNum(node, "y")];
      box = [x, y, x + attrNum(node, "width"), y + attrNum(node, "height")];
    } else if (node.localName === "ellipse") {
      const [cx, cy, rx, ry] = [
        attrNum(node, "cx"),
        attrNum(node, "cy"),
        attrNum(node, "rx"),
        attrNum(node, "ry"),
      ];
      box = [cx - rx, cy - ry, cx + rx, cy + ry];
    } else {
      return null;
    }
    const from = unitPoint(box[0], box[1]);
    const to = unitPoint(box[2], box[3]);
    return from && to ? [quantize(from.x), quantize(from.y), quantize(to.x), quantize(to.y)] : null;
  }

  function commitStroke(drawing: Drauu, node?: Element) {
    const done = capture;
    capture = null;
    if (!done || !node) return;
    if (done.tool === "pen") {
      // The release point always counts, whatever the spacing rule said.
      const unit = penPoint(drawing);
      const n = done.points.length;
      if (unit && n < 2 * MAX_STROKE_POINTS) {
        const x = quantize(unit.x);
        const y = quantize(unit.y);
        if (done.points[n - 2] !== x || done.points[n - 1] !== y) done.points.push(x, y);
      }
    } else {
      // Every other tool is two corners. Read the drawn element, since Shift and Alt move them.
      const corners = cornersOf(node);
      if (corners) done.points = corners;
    }
    if (done.points.length === 0) return;
    strokeOf.set(node, { id: done.id, tool: done.tool, color: done.color, points: done.points });
    announceStroke(done, true);
  }

  /** The strokes a drawing shows now, in drawing order. */
  function visibleStrokes(drawing: Drauu): MarkStroke[] {
    const strokes: MarkStroke[] = [];
    for (const child of drawing.el?.children ?? []) {
      const stroke = strokeOf.get(child);
      if (stroke) strokes.push(stroke);
    }
    return strokes;
  }

  /**
   * Draws a slide's saved strokes (decision 105) into its drawing, on the
   * first visit. They join drauu's element list, so the eraser reaches them,
   * but no undo step, so undo never removes what was there on arrival.
   */
  function restore(drawing: Drauu, slideKey: string, address: string) {
    const saved = options.saved?.(slideKey, address) ?? [];
    if (saved.length === 0) return;
    // A hidden stage measures 0; the deck's stage is always the slide box.
    const width = root.offsetWidth || MIRROR_WIDTH;
    const height = root.offsetHeight || MIRROR_HEIGHT;
    const tokens = getComputedStyle(stage);
    for (const stroke of saved) {
      const paint = tokens.getPropertyValue(`--dw-color-${stroke.color}`).trim() || color;
      const node = strokeElement(stroke, width, height, paint);
      if (!node) continue;
      // How drauu lists a committed stroke for its eraser; no public call does it.
      // oxlint-disable-next-line no-underscore-dangle
      drawing._appendNode(node);
      strokeOf.set(node, { id: nextStrokeId++, ...stroke, points: [...stroke.points] });
    }
  }

  /** Tells observers what the current slide shows; `reset` marks that the slide just changed. */
  function reportMarks(reset: boolean) {
    const slide = slideOf.get(active);
    if (slide == null || observers.size === 0) return;
    notify({ kind: "marks", slide, strokes: visibleStrokes(active), reset });
  }

  /** Only the current slide's surface is shown and takes pointer events (layer.css). */
  function show(drawing: Drauu) {
    for (const d of drawings.values()) {
      if (d.el) d.el.dataset["active"] = String(d === drawing);
    }
  }

  // The handlers createDrawing wires read `active`, but only after this line has run.
  let active = createDrawing();
  /** The current slide's drawing: `active`, unless a whiteboard is open over it. */
  let slideDrawing = active;
  slideOf.set(active, null);
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
    notify({ kind: "laser-off" });
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

  /** A finger is for swiping once a pen is in use, so it moves no laser either. */
  const fingerSwipes = (event: PointerEvent) =>
    event.pointerType === "touch" && !!input?.penInUse() && input.stylusDraws();

  function onLaserMove(event: PointerEvent) {
    if (mode !== "laser" || fingerSwipes(event)) return;
    const { x, y } = toLocal(event);
    const unit = unitPoint(x, y);
    if (unit) {
      notify({
        kind: "laser",
        x: Math.min(1, Math.max(0, unit.x)),
        y: Math.min(1, Math.max(0, unit.y)),
      });
    }
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
    if (mode !== "laser" || fingerSwipes(event)) return;
    // Keep receiving moves while a finger or stylus drags past the overlay edge.
    laser.setPointerCapture?.(event.pointerId);
    onLaserMove(event);
  }

  function onLaserEnd() {
    // Normal motion lets the trail fade on its own; reduced motion removes it now.
    if (prefersReducedMotion()) clearLaser();
    else notify({ kind: "laser-off" });
  }

  function openBoard(next: { key: string; address: string }) {
    const page = slideOf.get(slideDrawing);
    if (key === null || page == null) return;
    if (board) {
      if (board.address === next.address) return;
      closeBoard(false);
    }
    // A stroke still being drawn on the slide belongs to neither page.
    slideDrawing.cancel();
    slideDrawing.drawing = false;
    let drawing = drawings.get(next.key);
    if (!drawing) {
      drawing = createDrawing();
      slideOf.set(drawing, next.address);
      drawings.set(next.key, drawing);
      restore(drawing, next.key, next.address);
    }
    board = { address: next.address, page, drawing, uncover: coverPage(stage) };
    active = drawing;
    root.toggleAttribute("data-board", true);
    applyTool(active);
    show(active);
    notify({ kind: "board", slide: page });
    reportMarks(true);
  }

  /** Undoes `openBoard` in reverse. `report` is false when a change of slide reports its own marks next. */
  function closeBoard(report: boolean) {
    const open = board;
    if (!open) return;
    // A stroke still being drawn on the board is cancelled while the board is still the active drawing.
    open.drawing.cancel();
    open.drawing.drawing = false;
    board = null;
    open.uncover();
    root.removeAttribute("data-board");
    active = slideDrawing;
    applyTool(active);
    show(active);
    notify({ kind: "board", slide: null });
    if (report) reportMarks(true);
  }

  /**
   * A pen that has moved past the drag threshold with no tool chosen starts a
   * pen stroke where it went down: drauu gets the `pointerdown` the page took,
   * and its own window listeners carry the rest of the stroke. A tap never
   * gets here, so its click still follows a link or opens a diagram.
   */
  function startPenDrag(down: PointerEvent) {
    const drawing = active;
    const svg = drawing.el;
    if (!svg) return;
    drawing.brush.arrowEnd = false;
    drawing.brush.color = color;
    drawing.mode = "stylus";
    handingOver = true;
    try {
      svg.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: down.pointerId,
          pointerType: "pen",
          isPrimary: down.isPrimary,
          button: 0,
          buttons: 1,
          pressure: down.pressure,
          clientX: down.clientX,
          clientY: down.clientY,
        }),
      );
    } finally {
      handingOver = false;
    }
  }
  const watchStage = (target: HTMLElement) =>
    input
      ? watchPenDrags(target, {
          enabled: () => !handingOver && mode === "off" && input.stylusDraws(),
          onDrag: startPenDrag,
        })
      : () => {};
  let stopWatching = watchStage(host);
  // A setting or latch change reaches the drawing on screen at once.
  const stopInput = input?.subscribe?.(() => applyInput(active));

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
    setColor(next, swatch) {
      color = next;
      if (swatch) colorKey = swatch;
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
    setKey(next, address = next) {
      if (next === key) return;
      // Another page closes the board; the same page under a new key (a rebuild) leaves it open.
      if (board && board.page !== address) closeBoard(false);
      if (key === null) {
        // Marks made before the first key belong to the first slide.
        drawings.delete(null);
        drawings.set(next, slideDrawing);
        slideOf.set(slideDrawing, address);
        restore(slideDrawing, next, address);
        refreshEraser();
      } else {
        // A stroke still being drawn when the slide changes belongs to no slide.
        slideDrawing.cancel();
        slideDrawing.drawing = false;
        let drawing = drawings.get(next);
        if (!drawing) {
          drawing = createDrawing();
          slideOf.set(drawing, address);
          drawings.set(next, drawing);
          restore(drawing, next, address);
        }
        slideDrawing = drawing;
        if (!board) {
          active = drawing;
          applyTool(active);
          show(active);
        }
      }
      key = next;
      clearLaser();
      // Under an open board the receivers keep the board's marks.
      if (!board) reportMarks(true);
    },
    setBoard(next) {
      if (next) openBoard(next);
      else closeBoard(true);
    },
    board: () => board?.address ?? null,
    moveTo(next) {
      if (next === stage) return;
      clearLaser();
      detach();
      attach(next);
      stopWatching();
      stopWatching = watchStage(next);
      // The rebuilt deck has a new current page; the board covers that one.
      if (board) {
        board.uncover();
        board.uncover = coverPage(next);
      }
    },
    retain(keys) {
      const keep = new Set<string | null>(keys);
      const dropped = new Set<string>();
      for (const [k, drawing] of drawings) {
        if (drawing === active || drawing === slideDrawing || keep.has(k)) continue;
        const slide = slideOf.get(drawing);
        if (slide != null) dropped.add(slide);
        // drauu forgets its element on unmount, so take it first.
        const svg = drawing.el;
        drawing.unmount();
        svg?.remove();
        drawings.delete(k);
        slideOf.delete(drawing);
      }
      // Receivers still hold what those slides showed. The current slide has its own report.
      const here = slideOf.get(active);
      for (const slide of dropped) {
        if (slide !== here) notify({ kind: "marks", slide, strokes: [], reset: false });
      }
    },
    observe(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
    destroy() {
      stopWatching();
      stopInput?.();
      board?.uncover();
      board = null;
      clearLaser();
      observers.clear();
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
