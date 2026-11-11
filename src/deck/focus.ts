import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import type { FocusViewKind } from "../annotate/mirrorTypes";
import { requestSketch } from "../canvas/request";
import { nodesInDiagram } from "../comments/diagramNodes";
import { m } from "../paraglide/messages.js";
import type { DiagramTour } from "./diagramTour";
import { emitFocus } from "./focusEvents";
import { FOCUS_VIEW_CLASS } from "./focusView";
import { type DiagramEdge, diagramEdges } from "./mermaid";
import { focusKind, isLoadedImage, locateBlock, unmarkFocusTargets } from "./focusTargets";
import { panDelta, wheelPixels, zoomFactor } from "./wheelGesture";
import {
  firstStep,
  jumpTo,
  nextStep,
  normalizeTour,
  previousStep,
  startTour,
  TOUR_MIN_NODES,
  type TourPath,
} from "./tourModel";
import "./focusTour.css";

/**
 * Focus view: a full-window view of one diagram, code block, table or image.
 * Escape closes it and returns focus to the block on the slide. While it is
 * open the rest of the page is inert, Tab cycles through the view, and no
 * key reaches the app behind it.
 *
 * Diagrams and images are drawn on a canvas with fit, zoom, pan, reset and
 * fullscreen. Code and tables are text: they scroll natively and zoom by type
 * size, so selection, touch scroll and line marks keep working (decision 87).
 * Pan and zoom follow the gesture (decision 127): a plain wheel pans a canvas
 * and scrolls text, and Ctrl/Cmd + wheel, which is also how a trackpad pinch
 * arrives, Safari's gesture events and a two-finger pinch zoom by the size of
 * the gesture around its point.
 *
 * Each view tells `focusEvents.ts` which block it shows, how it is zoomed
 * and scrolled, which code lines are marked and how far a diagram tour has
 * gone, so the presenter's view can be mirrored to followers (decisions 88,
 * 106 and 109).
 */

type ViewKind = FocusViewKind;

/** What a stage hands the shell: how it zooms, and what else its toolbar holds. */
interface Stage {
  zoomOut(): void;
  zoomIn(): void;
  fit(): void;
  /** Takes every wheel event on the stage and prevents its default only when it uses it. */
  wheel(event: WheelEvent): void;
  /** The zoom now, in the stage's own unit: Panzoom's scale or the type scale. */
  getScale(): number;
  /** Zooms to `scale`, inside the stage's limits, keeping the point at `clientX`, `clientY` in place. */
  zoomTo(scale: number, clientX: number, clientY: number): void;
  /** Called once the view is in the page and its toolbar is built. */
  start(): void;
  /** Extra toolbar buttons, between Fullscreen and Close; `toolbar` takes what is not a button. */
  extras?(add: AddButton, toolbar: HTMLElement): void;
  /**
   * Offers a key to the stage before the shell reads it. True when the stage
   * used the key: the shell then does nothing more with it (decision 109).
   */
  key?(event: KeyboardEvent): boolean;
  /** Sets the diagram tour to a path a presenter sent, as node numbers (decision 109). */
  setTour?(path: readonly number[]): void;
  /** Settles after the first Fit of a canvas, or when the stage goes (rule 4). */
  fitted?: Promise<void>;
  /**
   * Sets zoom and position to a view a presenter sent (decisions 88 and 106): for a
   * canvas the pan as a fraction of the stage, for text the scroll as a fraction of its reach.
   */
  setTransform?(view: FocusTransform): void;
  /** Marks exactly these lines of a code view, from 1 (decision 106). */
  setLines?(lines: readonly number[]): void;
  dispose(): void;
}
/**
 * Zoom and position of a view, as the mirror carries it: the scale relative
 * to Fit, and for a canvas the pan as fractions of the stage, for text how
 * far it is scrolled as fractions of how far it can scroll.
 */
interface FocusTransform {
  scale: number;
  x: number;
  y: number;
}
type AddButton = (label: string, title: string, action: () => void) => HTMLButtonElement;
/** Safari's `GestureEvent`, which the DOM types do not name. */
type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

let current: { kind: ViewKind; close: () => void } | null = null;

/**
 * Closes an open code, table or image view. A rebuild or a change of slide
 * calls it: the copy comes from a slide that is gone. The diagram view is
 * left as it was (decision 87).
 */
export function closeContentFocus(): void {
  if (current && current.kind !== "diagram") current.close();
}

/** Called when a view closes; `byViewer` is true for Escape, Close or Sketch, false for a rebuild or a slide change. */
type OnClosed = (byViewer: boolean) => void;

function mountView(
  origin: HTMLElement,
  kind: ViewKind,
  label: string,
  makeStage: (stage: HTMLElement, close: () => void) => Stage,
  onClosed?: OnClosed,
): { close: () => void; view: Stage } {
  // One view at a time: a view opened under another (the presenter's, over one the viewer
  // opened) would leave the first one open, and inert, after the second closed.
  current?.close();
  // React keeps this element across deck rebuilds; the `.reveal` inside it is replaced.
  const deckHost = origin.closest(".docwalk-deck-host");

  const overlay = document.createElement("div");
  overlay.className = FOCUS_VIEW_CLASS;
  overlay.dataset["kind"] = kind;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label);
  // A click on the stage focuses the overlay rather than <body>, so its keys still work.
  overlay.tabIndex = -1;

  const stage = document.createElement("div");
  stage.className = "docwalk-focus-stage";
  const toolbar = document.createElement("div");
  toolbar.className = "docwalk-focus-toolbar";
  overlay.append(stage, toolbar);
  // aria-modal only informs screen readers; inert keeps Tab and clicks off the page behind.
  const madeInert = [...document.body.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.inert,
  );
  for (const el of madeInert) el.inert = true;
  document.body.append(overlay);

  const view = makeStage(stage, () => close(true));

  const button: AddButton = (text, title, action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", action);
    toolbar.append(b);
    return b;
  };
  button("−", m.focus_zoom_out(), () => view.zoomOut());
  button("+", m.focus_zoom_in(), () => view.zoomIn());
  button(m.focus_fit(), m.focus_fit_title(), () => view.fit());
  button("⛶", m.focus_fullscreen(), () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.();
  });
  view.extras?.(button, toolbar);
  const closeButton = button("✕", m.close(), () => close(true));

  const onWheel = (event: WheelEvent) => view.wheel(event);
  // Safari's pinch (decision 127): each change is relative to the scale at the start. Its
  // default is prevented so the page does not zoom. A pinch with two fingers on the screen is
  // read from the pointers (Panzoom, or the text stage), so its gesture events only stop the page.
  const touches = new Set<number>();
  const onTouchDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") touches.add(event.pointerId);
  };
  const onTouchUp = (event: PointerEvent) => touches.delete(event.pointerId);
  let gestureFrom = 1;
  const onGesture = (event: GestureLike) => {
    event.preventDefault();
    if (touches.size > 1) return;
    if (event.type === "gesturestart") gestureFrom = view.getScale();
    else view.zoomTo(gestureFrom * (event.scale ?? 1), event.clientX ?? 0, event.clientY ?? 0);
  };
  const onKey = (event: KeyboardEvent) => {
    // Escape reaches the stage first: a running tour ends and the view stays open.
    if (view.key?.(event)) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab") {
      // Keep focus in the view: past the last stop comes the first, and back.
      const stops = [
        ...overlay.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      ];
      const first = stops[0];
      const last = stops.at(-1);
      const active = document.activeElement as HTMLElement | null;
      let target: HTMLElement | undefined;
      if (!active || !stops.includes(active)) target = event.shiftKey ? last : first;
      else if (event.shiftKey && active === first) target = last;
      else if (!event.shiftKey && active === last) target = first;
      if (target) {
        event.preventDefault();
        target.focus();
      }
    } else if (event.key === "Escape") close(true);
    else if (event.key === "+" || event.key === "=") view.zoomIn();
    else if (event.key === "-") view.zoomOut();
    else if (event.key === "0") view.fit();
    // The page behind is inert, but its shortcuts listen on the window: O, the pen
    // letters, Ctrl+K and the clicker keys must not reach it from here.
    event.stopPropagation();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  // Capture: Panzoom stops pointerdown at the canvas.
  stage.addEventListener("pointerdown", onTouchDown, { capture: true });
  stage.addEventListener("pointerup", onTouchUp, { capture: true });
  stage.addEventListener("pointercancel", onTouchUp, { capture: true });
  stage.addEventListener("gesturestart", onGesture);
  stage.addEventListener("gesturechange", onGesture);
  overlay.addEventListener("keydown", onKey);

  let closed = false;
  let announced = false;
  function close(byViewer = false) {
    if (closed) return;
    closed = true;
    if (announced) emitFocus({ kind: "close" });
    onClosed?.(byViewer);
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onTouchDown, { capture: true });
    stage.removeEventListener("pointerup", onTouchUp, { capture: true });
    stage.removeEventListener("pointercancel", onTouchUp, { capture: true });
    stage.removeEventListener("gesturestart", onGesture);
    stage.removeEventListener("gesturechange", onGesture);
    overlay.removeEventListener("keydown", onKey);
    view.dispose();
    if (document.fullscreenElement === overlay) void document.exitFullscreen();
    overlay.remove();
    for (const el of madeInert) el.inert = false;
    if (current?.close === close) current = null;
    // A rebuild while the view was open detached the origin, and focusing it would
    // leave focus on <body>, where reveal.js ignores the arrow keys and the clicker.
    // The same goes for a slide that is no longer shown (reveal.js marks it hidden and inert):
    // the deck takes focus instead.
    if (
      origin.isConnected &&
      origin.checkVisibility?.() !== false &&
      !origin.closest("[inert], [hidden]")
    )
      origin.focus();
    else deckHost?.querySelector<HTMLElement>(".reveal")?.focus({ preventScroll: true });
  }

  current = { kind, close };
  // Every kind is mirrored to followers (decisions 88 and 106). The open goes
  // first, so the view a stage reports as it starts belongs to this block.
  const where = locateBlock(origin, kind);
  if (where) {
    announced = true;
    emitFocus({ kind: "open", ...where });
  }
  view.start();
  closeButton.focus();
  return { close, view };
}

/** Fit, zoom and pan of a picture on a canvas: Panzoom, as for the diagram since decision 28. */
function canvasStage(
  stage: HTMLElement,
  copy: SVGSVGElement | HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
  onView?: (view: FocusTransform) => void,
): Stage {
  const canvas = document.createElement("div");
  canvas.className = "docwalk-focus-canvas";
  canvas.append(copy);
  stage.append(canvas);

  const minScale = 0.1;
  const maxScale = 12;
  const panzoom: PanzoomObject = Panzoom(canvas, { maxScale, minScale, step: 0.25 });
  // The pan travels as a fraction of the stage: what it shifts on screen is x * scale pixels.
  // A stage with no size (a view already closed) has no fraction to give.
  canvas.addEventListener("panzoomchange", (event) => {
    const { x, y, scale } = (event as CustomEvent<FocusTransform>).detail;
    if (stage.clientWidth === 0 || stage.clientHeight === 0) return;
    onView?.({ scale, x: (x * scale) / stage.clientWidth, y: (y * scale) / stage.clientHeight });
  });
  let frame = 0;
  let started = false;
  let wanted: FocusTransform | null = null;
  const { promise: fitted, resolve: markFitted } = Promise.withResolvers<void>();
  const place = (view: FocusTransform) => {
    panzoom.zoom(view.scale, { animate: false, force: true });
    panzoom.pan(
      (view.x * stage.clientWidth) / view.scale,
      (view.y * stage.clientHeight) / view.scale,
      { animate: false, force: true },
    );
  };

  // Fit by sizing the picture itself (it stays sharp) and let CSS centre it in the
  // stage; Panzoom then starts from scale 1 at the centre.
  const fit = () => {
    const scale =
      Math.min(stage.clientWidth / naturalWidth, stage.clientHeight / naturalHeight) * 0.95;
    copy.setAttribute("width", String(Math.floor(naturalWidth * scale)));
    copy.setAttribute("height", String(Math.floor(naturalHeight * scale)));
    panzoom.reset({ animate: false });
  };

  // Panzoom draws on the next frame, and a pinch sends several events per frame, so the
  // focal point comes from the canvas's layout box (which the transform does not move)
  // and Panzoom's own values, never from the drawn box. The canvas is centred in the stage;
  // Panzoom's zoomToPoint assumes its top left corner.
  const zoomTo = (to: number, clientX: number, clientY: number) => {
    const next = Math.min(maxScale, Math.max(minScale, to));
    if (next === panzoom.getScale()) return;
    const box = stage.getBoundingClientRect();
    const centreX = box.left + canvas.offsetLeft - stage.offsetLeft + canvas.offsetWidth / 2;
    const centreY = box.top + canvas.offsetTop - stage.offsetTop + canvas.offsetHeight / 2;
    // Panzoom's focal is the point's offset from the centre, at the new scale.
    const focal = { x: (clientX - centreX) * next, y: (clientY - centreY) * next };
    panzoom.zoom(next, { animate: false, focal });
  };

  return {
    zoomOut: () => panzoom.zoomOut(),
    zoomIn: () => panzoom.zoomIn(),
    fit,
    fitted,
    // A plain wheel pans, so a mouse wheel never zooms by accident (decision 127).
    wheel(event) {
      event.preventDefault();
      const pixels = wheelPixels(event, { width: stage.clientWidth, height: stage.clientHeight });
      const scale = panzoom.getScale();
      if (event.ctrlKey || event.metaKey) {
        zoomTo(scale * zoomFactor(pixels.y), event.clientX, event.clientY);
        return;
      }
      // Panzoom's pan is before the scale: a shift of d screen pixels is d / scale.
      const { x, y } = panDelta(pixels, event.shiftKey);
      panzoom.pan(-x / scale, -y / scale, { relative: true, animate: false });
    },
    getScale: () => panzoom.getScale(),
    zoomTo,
    start: () => {
      frame = requestAnimationFrame(() => {
        fit();
        started = true;
        markFitted();
        // A view that arrived before the first fit is placed once Fit has run.
        if (wanted) place(wanted);
      });
    },
    setTransform(view) {
      wanted = view;
      if (started) place(view);
    },
    dispose: () => {
      // A view closed before its first frame never fits a stage that is gone.
      cancelAnimationFrame(frame);
      markFitted();
      panzoom.destroy();
    },
  };
}

function diagramStage(stage: HTMLElement, diagram: HTMLElement, close: () => void): Stage {
  const svg = diagram.querySelector("svg") as SVGSVGElement;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // The slide copy carries its fitted size; the focus view sizes the diagram itself.
  copy.removeAttribute("style");
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  const naturalWidth = Number(diagram.dataset["naturalWidth"]) || svg.viewBox.baseVal.width || 800;
  const naturalHeight =
    Number(diagram.dataset["naturalHeight"]) || svg.viewBox.baseVal.height || 600;
  const base = canvasStage(stage, copy, naturalWidth, naturalHeight, (view) =>
    emitFocus({ kind: "view", ...view }),
  );
  // Canvas mode (decision 54): the app opens the sketch dialog, lazily, in place of this view.
  const source = diagram.dataset["source"];
  const count = nodesInDiagram(copy).length;
  const tour =
    count >= TOUR_MIN_NODES
      ? tourControls(stage, copy, diagramEdges(diagram), count, base.fitted ?? Promise.resolve())
      : null;
  if (source === undefined && !tour) return base;
  return {
    ...base,
    extras(add, toolbar) {
      if (source !== undefined) {
        // A short label, an icon for Tour and a tighter gap (focusTour.css) keep the toolbar
        // on one row at 390 px; the name says what the button does.
        add(m.focus_sketch(), m.focus_sketch_title(), () => {
          const hosts = [
            ...(diagram.closest(".slides") ?? document).querySelectorAll(".docwalk-diagram"),
          ];
          const at = hosts.indexOf(diagram);
          close();
          requestSketch({ source, index: at >= 0 ? at + 1 : null });
        });
      }
      tour?.mount(add, toolbar);
    },
    ...(tour && { key: tour.key, setTour: tour.setTour }),
    dispose() {
      tour?.dispose();
      base.dispose();
    },
  };
}

/** A pointer that moved less than this between press and release tapped; more is a pan. */
const TAP_SLOP = 6;

/**
 * The diagram tour in the view (decision 109): a Tour toggle, Back and Next
 * with the count, the keys, a tap on a node, and a polite status. The state is
 * a path of node numbers (`tourModel.ts`). `diagramTour.ts` loads on the first
 * start, so the deck's first download does not grow. Every change the viewer
 * makes is reported to the mirror; one that came from the mirror is not.
 */
function tourControls(
  stage: HTMLElement,
  copy: SVGSVGElement,
  edges: readonly DiagramEdge[],
  count: number,
  fitted: Promise<void>,
) {
  let path: TourPath = [];
  let disposed = false;
  let status: HTMLElement | null = null;
  // The status of a start leads with "Tour started." (said once, with the first step).
  let prefix = "";
  let tourButton: HTMLButtonElement;
  let back: HTMLButtonElement;
  let next: HTMLButtonElement;
  let counter: HTMLElement;
  let loaded: Promise<DiagramTour | null> | null = null;
  let drawn = 0;

  const running = () => path.length > 0;
  const load = () =>
    (loaded ??= import("./diagramTour")
      .then(({ createDiagramTour }) =>
        createDiagramTour(
          copy,
          edges,
          (text) => {
            if (status) status.textContent = prefix ? `${prefix} ${text}` : text;
            prefix = "";
          },
          { fitted },
        ),
      )
      // Offline with the chunk missing: the view stays as it was, with no marks.
      .catch(() => null));
  // Draws what `path` is now. Only the latest request draws: a key held down
  // asks for many paths while the module loads.
  const sync = () => {
    const mine = ++drawn;
    if (!running() && !loaded) return;
    void load().then((tour) => {
      if (!tour || mine !== drawn || disposed) return;
      if (running()) void tour.show(path);
      else tour.clear();
    });
  };
  const render = () => {
    tourButton.setAttribute("aria-pressed", String(running()));
    for (const el of [back, next, counter]) el.hidden = !running();
    for (const el of [back, next]) el.disabled = !running();
    // An end that goes nowhere stays focusable, so focus is not lost with it.
    back.setAttribute("aria-disabled", String(path.length <= 1));
    next.setAttribute("aria-disabled", String(nextStep(path, count) === path));
    counter.textContent = running() ? m.tour_count({ number: path.at(-1) ?? 1, count }) : "";
  };
  const sameAsNow = (to: TourPath) =>
    to.length === path.length && to.every((n, i) => n === path[i]);
  const set = (to: TourPath, byViewer: boolean) => {
    if (sameAsNow(to)) return;
    path = to;
    render();
    sync();
    if (byViewer) emitFocus({ kind: "tour", path });
  };
  const start = () => {
    if (running()) return;
    prefix = m.tour_started();
    set(startTour(count), true);
    next.focus();
  };
  const end = (byViewer: boolean) => {
    if (!running()) return;
    // Back and Next hide with the tour; focus goes to Tour rather than to <body>.
    const strands = document.activeElement === back || document.activeElement === next;
    prefix = "";
    set([], byViewer);
    if (status) status.textContent = m.tour_ended();
    if (byViewer || strands) tourButton.focus();
  };
  const step = (to: (from: TourPath) => TourPath) => set(to(path), true);

  // The tap is read from pointerdown and pointerup. Panzoom cancels the
  // pointerdown, and an engine may then send no click for a touch tap (CI's WebKit sent none).
  let down: { id: number; x: number; y: number } | null = null;
  // Capture: Panzoom stops pointerdown at the canvas, so it never bubbles to the stage.
  stage.addEventListener(
    "pointerdown",
    (event) => {
      // A second finger makes it a pinch; a button other than the main one is no tap.
      down =
        event.isPrimary && event.button === 0
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
    },
    { capture: true },
  );
  const goTo = (target: EventTarget | null) => {
    void load().then((tour) => {
      const n = tour?.nodeAt(target) ?? null;
      if (n !== null && !disposed) set(jumpTo(path, n, count), true);
    });
  };
  // A drag that pans goes nowhere.
  stage.addEventListener("pointerup", (event) => {
    const from = down;
    down = null;
    if (!running() || from?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) >= TAP_SLOP) return;
    goTo(event.target);
  });
  // A screen reader's activate and element.click() send a click with detail 0 and no
  // pointer events. A real pointer's click counts 1 or more and was a pointerup above.
  stage.addEventListener("click", (event) => {
    if (running() && event.detail === 0) goTo(event.target);
  });

  return {
    mount(add: AddButton, toolbar: HTMLElement) {
      // An icon keeps the toolbar on one row at 390 px, as Zoom and Fullscreen
      // do: the name is "Tour" and the title carries the hint and the key.
      tourButton = add("◎", m.tour_button_title(), () => (running() ? end(true) : start()));
      tourButton.setAttribute("aria-label", m.tour_button());
      back = add("←", m.tour_back(), () => step(previousStep));
      next = add("→", m.tour_next(), () => step((from) => nextStep(from, count)));
      counter = document.createElement("span");
      counter.className = "docwalk-tour-count";
      toolbar.append(counter);
      // Between the tour's buttons: Tour, Back, count, Next.
      back.after(counter);
      counter.after(next);
      status = document.createElement("div");
      status.className = "docwalk-tour-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      toolbar.append(status);
      render();
    },
    key(event: KeyboardEvent): boolean {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      if (event.key === "Escape") {
        if (!running()) return false;
        end(true);
        return true;
      }
      if (event.key === "t" || event.key === "T") {
        // A held key repeats: only the press toggles.
        if (event.repeat) return true;
        if (running()) end(true);
        else start();
        return true;
      }
      if (!running()) return false;
      // On a toolbar button Space is the button's own.
      const spaceIsNext = event.key === " " && !(event.target instanceof HTMLButtonElement);
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || spaceIsNext) {
        step((from) => nextStep(from, count));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        step(previousStep);
      } else if (event.key === "Home") {
        step(() => firstStep(count));
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    },
    setTour(to: readonly number[]) {
      const normal = normalizeTour(to, count);
      if (normal.length === 0) end(false);
      else set(normal, false);
    },
    dispose() {
      disposed = true;
      drawn += 1;
      void loaded?.then((tour) => tour?.clear());
    },
  };
}

/** Type scale of the text kinds: the range of the buttons, and where Fit may land (decision 87). */
const SCALE_MIN = 0.5;
const SCALE_MAX = 4;
const SCALE_STEP = 0.25;
const FIT_MIN = 0.75;
const FIT_MAX = 3;

/**
 * The copy of a slide element that goes into the view, taken from the
 * sanitized DOM with `cloneNode`: no HTML is parsed (rule 5). Everything that
 * would repeat or dangle beside the slide is removed: ids, tab stops and
 * marks, references to ids, and links to ids the copy does not have.
 */
function cleanCopy<T extends HTMLElement>(origin: T): T {
  const copy = origin.cloneNode(true) as T;
  unmarkFocusTargets(copy);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("aria-labelledby");
    el.removeAttribute("aria-describedby");
    if (el.localName === "a" && el.getAttribute("href")?.startsWith("#")) {
      el.removeAttribute("href");
    }
  }
  return copy;
}

const LINE_CLASS = "docwalk-code-line";
/** A fraction from the wire, kept to 0..1 (decision 106). */
const unit = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Splits the children of a `<code>` into one block per line. A line holds
 * its own newline, so the text of the lines joined is the text of the code.
 * Colour spans keep their place: an element that spans a line break is
 * opened again on the next line. Only text nodes and shells of the copy are
 * used, so nothing in a listing can become markup.
 */
function intoLines(code: Element): HTMLElement[] {
  const lines: HTMLElement[] = [];
  let line: HTMLElement | null = null;
  const place = (text: string, shells: Element[]) => {
    if (!line) {
      line = document.createElement("span");
      line.className = LINE_CLASS;
      lines.push(line);
    }
    let parent: Element = line;
    for (const shell of shells) {
      const again = shell.cloneNode(false) as Element;
      parent.append(again);
      parent = again;
    }
    parent.append(text);
  };
  const walk = (node: Node, shells: Element[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        const text = last ? part : `${part}\n`;
        if (text !== "") place(text, shells);
        if (!last) line = null;
      });
    } else if (node instanceof Element) {
      for (const child of node.childNodes) walk(child, [...shells, node]);
    }
  };
  for (const child of code.childNodes) walk(child, []);
  return lines;
}

const lineOf = (event: Event) =>
  event.target instanceof Element
    ? (event.target.closest<HTMLElement>(`.${LINE_CLASS}`) ?? null)
    : null;

function textStage(stage: HTMLElement, origin: HTMLElement, kind: "code" | "table"): Stage {
  stage.dataset["mode"] = "sheet";
  // The class brings the slide's own table, code and colour rules; the sheet only sets size.
  const sheet = document.createElement("div");
  sheet.className = "docwalk-focus-sheet docwalk-slide-body";
  const copy = cleanCopy(origin);
  sheet.append(copy);
  stage.append(sheet);

  let scale = 1;
  // What Fit chose. The mirror carries the scale as a share of it, so each
  // screen zooms from its own Fit (decision 106).
  let fitted = 1;
  const apply = (next: number) => {
    scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    sheet.style.setProperty("--focus-scale", String(scale));
  };
  const reach = () => ({
    across: Math.max(0, stage.scrollWidth - stage.clientWidth),
    down: Math.max(0, stage.scrollHeight - stage.clientHeight),
  });
  // How far the view is scrolled, as a share of how far it can scroll: the
  // start and the end of a listing meet on screens of any size.
  const report = () => {
    const { across, down } = reach();
    emitFocus({
      kind: "view",
      scale: scale / fitted,
      x: across > 0 ? stage.scrollLeft / across : 0,
      y: down > 0 ? stage.scrollTop / down : 0,
    });
  };
  const zoom = (next: number) => {
    apply(next);
    report();
  };
  // Zooms and scrolls so the text under the point stays under it (decision 127).
  const zoomTo = (next: number, clientX: number, clientY: number) => {
    const from = scale;
    const before = getComputedStyle(sheet);
    const padLeft = Number.parseFloat(before.paddingLeft) || 0;
    const padTop = Number.parseFloat(before.paddingTop) || 0;
    apply(next);
    if (scale === from) return;
    const ratio = scale / from;
    const after = getComputedStyle(sheet);
    const box = stage.getBoundingClientRect();
    const offsetX = clientX - box.left - stage.clientLeft;
    const offsetY = clientY - box.top - stage.clientTop;
    const x = stage.scrollLeft + offsetX;
    const y = stage.scrollTop + offsetY;
    stage.scrollLeft =
      (Number.parseFloat(after.paddingLeft) || 0) + (x - padLeft) * ratio - offsetX;
    stage.scrollTop = (Number.parseFloat(after.paddingTop) || 0) + (y - padTop) * ratio - offsetY;
    report();
  };
  // A two-finger pinch on a touch screen sets the type scale from the change of the fingers'
  // distance. The stage's touch-action lets the browser pan, so one or two fingers still scroll.
  const fingers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; scale: number } | null = null;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    if (!a || !b) return null;
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  };
  const onFingerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = fingers.size === 2 ? spread() : null;
    pinch = now && now.distance > 0 ? { distance: now.distance, scale } : null;
  };
  const onFingerMove = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = pinch && fingers.size === 2 ? spread() : null;
    if (pinch && now) zoomTo((pinch.scale * now.distance) / pinch.distance, now.x, now.y);
  };
  const onFingerUp = (event: PointerEvent) => {
    fingers.delete(event.pointerId);
    pinch = null;
  };
  stage.addEventListener("pointerdown", onFingerDown);
  stage.addEventListener("pointermove", onFingerMove);
  stage.addEventListener("pointerup", onFingerUp);
  stage.addEventListener("pointercancel", onFingerUp);
  // The largest size that needs no sideways scroll and, above 1, no vertical scroll. A
  // line or column that is wider than the screen at FIT_MIN scrolls; smaller is not readable.
  const fit = () => {
    let next = FIT_MAX;
    for (; next >= FIT_MIN; next -= SCALE_STEP) {
      apply(next);
      const sideways = stage.scrollWidth > stage.clientWidth + 1;
      const tall = stage.scrollHeight > stage.clientHeight + 1;
      if (!sideways && (next <= 1 || !tall)) break;
    }
    if (next < FIT_MIN) apply(FIT_MIN);
    fitted = scale;
    report();
  };
  stage.addEventListener("scroll", report, { passive: true });

  const base: Stage = {
    zoomOut: () => zoom(scale - SCALE_STEP),
    zoomIn: () => zoom(scale + SCALE_STEP),
    fit,
    // A plain wheel scrolls the text natively; Ctrl/Cmd + wheel, or a trackpad pinch, zooms.
    wheel(event) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const pixels = wheelPixels(event, { width: stage.clientWidth, height: stage.clientHeight });
      zoomTo(scale * zoomFactor(pixels.y), event.clientX, event.clientY);
    },
    getScale: () => scale,
    zoomTo,
    start: fit,
    setTransform(view) {
      apply(fitted * view.scale);
      const { across, down } = reach();
      stage.scrollLeft = unit(view.x) * across;
      stage.scrollTop = unit(view.y) * down;
    },
    dispose() {
      stage.removeEventListener("scroll", report);
      stage.removeEventListener("pointerdown", onFingerDown);
      stage.removeEventListener("pointermove", onFingerMove);
      stage.removeEventListener("pointerup", onFingerUp);
      stage.removeEventListener("pointercancel", onFingerUp);
    },
  };
  if (kind === "table") {
    // Nothing inside a table takes focus, and axe wants a scrolling region to be reachable.
    stage.tabIndex = 0;
    stage.setAttribute("role", "region");
    stage.setAttribute("aria-label", m.focus_label_table());
    return base;
  }

  copy.setAttribute("role", "group");
  copy.setAttribute("aria-label", m.focus_code_lines());
  const code = copy.querySelector("code") ?? copy;
  const rows = intoLines(code);
  code.replaceChildren(...rows);
  rows.forEach((row, i) => {
    const text = (row.textContent ?? "").replace(/\n$/, "");
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", "false");
    row.setAttribute(
      "aria-label",
      text.trim() === ""
        ? m.focus_line_empty({ number: i + 1 })
        : m.focus_line({ number: i + 1, text }),
    );
    row.tabIndex = i === 0 ? 0 : -1;
  });
  let clear: HTMLButtonElement | null = null;
  const anyMarked = () => rows.some((row) => row.getAttribute("aria-pressed") === "true");
  // Clear is unavailable while nothing is marked. A disabled button cannot keep focus: the
  // keys would go to <body>, where Escape no longer closes the view. So focus moves first, to
  // the line that is the tab stop, which is where marking goes on (decision 87).
  const syncClear = () => {
    if (!clear) return;
    const disabled = !anyMarked();
    if (disabled && document.activeElement === clear)
      (rows.find((row) => row.tabIndex === 0) ?? rows[0])?.focus({ preventScroll: true });
    clear.disabled = disabled;
  };
  // Every change of marks goes to the mirror as the whole list (decision 106).
  const reportLines = () =>
    emitFocus({
      kind: "lines",
      lines: rows.flatMap((row, i) => (row.getAttribute("aria-pressed") === "true" ? [i + 1] : [])),
    });
  const rove = (to: number) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, to))];
    if (!next) return;
    for (const row of rows) row.tabIndex = row === next ? 0 : -1;
    next.focus();
  };
  const toggle = (row: HTMLElement) => {
    row.setAttribute("aria-pressed", String(row.getAttribute("aria-pressed") !== "true"));
    syncClear();
    reportLines();
  };
  copy.addEventListener("click", (event) => {
    const row = lineOf(event);
    if (!row) return;
    // A drag that selects text ends in a click; it is not a mark.
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(row, true)) return;
    for (const other of rows) other.tabIndex = other === row ? 0 : -1;
    toggle(row);
  });
  copy.addEventListener("keydown", (event) => {
    const row = lineOf(event);
    if (!row) return;
    const at = rows.indexOf(row);
    if (event.key === "ArrowDown") rove(at + 1);
    else if (event.key === "ArrowUp") rove(at - 1);
    else if (event.key === "Home") rove(0);
    else if (event.key === "End") rove(rows.length - 1);
    else if (event.key === "Enter" || event.key === " ") toggle(row);
    else return;
    event.preventDefault();
  });
  return {
    ...base,
    extras(add) {
      clear = add(m.focus_clear(), m.focus_clear_title(), () => {
        for (const row of rows) row.setAttribute("aria-pressed", "false");
        syncClear();
        reportLines();
      });
      clear.disabled = true;
    },
    setLines(lines) {
      const marked = new Set(lines);
      rows.forEach((row, i) => row.setAttribute("aria-pressed", String(marked.has(i + 1))));
      syncClear();
    },
  };
}

function imageStage(stage: HTMLElement, origin: HTMLImageElement): Stage {
  // A new <img> for the address the slide already loaded: `currentSrc` is a cache hit,
  // and a blocked image never gets here because it has no `src` (decision 33).
  const copy = document.createElement("img");
  copy.alt = origin.alt;
  copy.src = origin.currentSrc;
  return canvasStage(stage, copy, origin.naturalWidth, origin.naturalHeight, (view) =>
    emitFocus({ kind: "view", ...view }),
  );
}

/**
 * Opens the view of `kind` on `block`, or nothing when the block has
 * nothing to show: a diagram with no drawing, a block that was never marked
 * as `kind`, an image that has not loaded (decision 87).
 */
function mountFocus(block: HTMLElement, kind: ViewKind, onClosed?: OnClosed) {
  if (kind === "diagram") {
    if (!block.querySelector("svg")) return null;
    return mountView(
      block,
      kind,
      m.focus_label(),
      (stage, close) => diagramStage(stage, block, close),
      onClosed,
    );
  }
  if (focusKind(block) !== kind) return null;
  if (kind === "image") {
    if (!(block instanceof HTMLImageElement) || !isLoadedImage(block)) return null;
    return mountView(
      block,
      kind,
      m.focus_label_image(),
      (stage) => imageStage(stage, block),
      onClosed,
    );
  }
  const label = kind === "code" ? m.focus_label_code() : m.focus_label_table();
  return mountView(block, kind, label, (stage) => textStage(stage, block, kind), onClosed);
}

export function openDiagramFocus(diagram: HTMLElement): () => void {
  const opened = mountFocus(diagram, "diagram");
  return opened ? () => opened.close() : () => undefined;
}

/** A view a presenter opened, as a follower holds it (decisions 88 and 106). */
export interface MirroredFocus {
  /** Zoom and position as the presenter has them; `null` leaves the view at Fit. */
  setView(view: FocusTransform | null): void;
  /** The presenter's marked lines of a code view; other kinds ignore it. */
  setLines(lines: readonly number[]): void;
  /** The presenter's diagram tour, as node numbers; other kinds ignore it (decision 109). */
  setTour(path: readonly number[]): void;
  close(): void;
}

/**
 * Opens the focus view of `kind` on `block` for a follower, because the
 * presenter opened it. It is the view a click opens, with the same keys and
 * toolbar. The follower may close it with Escape or Close, and `onClosed`
 * hears whether the viewer did; the presenter's next zoom, scroll or marks
 * move it again. Null when the block has nothing to show, an image this
 * follower has not loaded included: mirroring never loads one (rule 5).
 */
export function openMirroredFocus(
  block: HTMLElement,
  kind: ViewKind,
  onClosed: OnClosed,
): MirroredFocus | null {
  const opened = mountFocus(block, kind, onClosed);
  if (!opened) return null;
  const { close, view } = opened;
  return {
    setView(next) {
      if (next) view.setTransform?.(next);
    },
    setLines(lines) {
      view.setLines?.(lines);
    },
    setTour(path) {
      view.setTour?.(path);
    },
    close: () => close(),
  };
}

/**
 * Opens the focus view for a marked code block, table or image. An image
 * opens only once it has loaded; anything else, including a click on a
 * block that was never marked, does nothing.
 */
export function openBlockFocus(block: HTMLElement): () => void {
  const kind = focusKind(block);
  const opened = kind ? mountFocus(block, kind) : null;
  return opened ? () => opened.close() : () => undefined;
}
