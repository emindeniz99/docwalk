import type { Root } from "mdast";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { FOCUS_ATTR } from "../deck/focusTargets";
import { wireFocusTargets } from "../deck/focusWiring";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { useLoadRemoteImages } from "../render/remoteImages";
import type { Section, SectionPlan } from "../sectioning/sectionize";
import {
  type Camera,
  cameraTransform,
  clamp,
  FIT_MARGIN,
  fitAll,
  fitFrame,
  framesNear,
  pan,
  pinch,
  type Size,
  wheel,
  zoomAt,
} from "./camera";
import { renderFrames, type MapFrames } from "./frames";
import {
  type FrameRect,
  mapColumns,
  mapPlan,
  type MapFrame,
  type MapPlacement,
  MIN_FRAME_HEIGHT,
  placeFrames,
} from "./layout";
import "./map.css";
import {
  ease,
  firstFrame,
  frameForSection,
  lastFrame,
  MOVE_MS,
  nextFrame,
  placeOf,
  previousFrame,
  routeOrder,
  sectionForFrame,
  tween,
  zoomStep,
} from "./route";

/** A deck section as the map reads it: its id and where it starts in the source. */
type DeckSection = Pick<Section, "id" | "line">;

export interface MapViewProps {
  /**
   * The parsed document. The map sections it itself with `mapPlan`, so the
   * level override and the choice of sections do not change it (decision 142).
   */
  root: Root;
  /**
   * The deck's current section id, the slide the reader is on; null while the
   * deck builds. The map opens on its frame and moves there when it names
   * another section than the current frame's (decision 145, Address).
   */
  current?: string | null;
  /** The deck's sections at the viewer's level, which `current` and `onCurrent` name. */
  deckSections?: readonly DeckSection[];
  /**
   * The deck section a frame the reader made current maps to (decisions 145
   * and 147), called only when it differs from the last section known.
   */
  onCurrent?: (sectionId: string) => void;
}

interface Point {
  x: number;
  y: number;
}

/** Safari's `GestureEvent`, which the DOM types do not have. */
type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

/**
 * A box in a frame that scrolls gets a tab stop, so a keyboard user can
 * scroll it (WCAG 2.1.1), as the document view does: wide tables, code and
 * equations, and the frame's body when a wide table makes it scroll
 * sideways. A focus target is a tab stop already. Frames near the view
 * gain focus targets once drawn (frames.ts); far frames rely on this.
 */
function markScrollable(frame: HTMLElement): void {
  for (const box of frame.querySelectorAll<HTMLElement>(
    ".docwalk-slide-body, table, pre, .docwalk-math-display",
  )) {
    if (box.hasAttribute(FOCUS_ATTR)) continue;
    if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) box.tabIndex = 0;
    else box.removeAttribute("tabindex");
  }
}

/** CSS pixels a pointer may move between press and release and still tap. */
const TAP_SLOP = 10;

/** The current frame's ring, in CSS pixels on screen at every zoom (map.css). */
const RING_PX = 3;

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);

/** Which way a key scrolls a focused box: -1 or 1 on one axis, or null for a key that scrolls nothing. */
function scrollDirection(event: KeyboardEvent): { x: number; y: number } | null {
  switch (event.key) {
    case "ArrowRight":
      return { x: 1, y: 0 };
    case "ArrowLeft":
      return { x: -1, y: 0 };
    case "ArrowDown":
    case "PageDown":
    case "End":
      return { x: 0, y: 1 };
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return { x: 0, y: -1 };
    case " ":
      return { x: 0, y: event.shiftKey ? -1 : 1 };
    default:
      return null;
  }
}

/** Whether an `overflow` value lets a reader scroll the box. */
const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";

/** Whether a reader can still scroll `el` that way with the keyboard. */
function canScroll(el: Element, { x, y }: { x: number; y: number }): boolean {
  const style = getComputedStyle(el);
  if (x !== 0 && scrolls(style.overflowX)) {
    const max = el.scrollWidth - el.clientWidth;
    if (x > 0 ? el.scrollLeft < max - 1 : el.scrollLeft > 0) return true;
  }
  if (y !== 0 && scrolls(style.overflowY)) {
    const max = el.scrollHeight - el.clientHeight;
    if (y > 0 ? el.scrollTop < max - 1 : el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Whether the element the key was pressed on uses that key itself
 * (decision 145, Keys): a text field; a link, a button or a block that opens
 * the focus view for Enter and Space; a box that can still scroll that way.
 */
function usesKey(target: Element, event: KeyboardEvent, pane: HTMLElement): boolean {
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
    return true;
  if (
    (event.key === "Enter" || event.key === " ") &&
    target.closest(`a[href], button, summary, [role="button"], [${FOCUS_ATTR}], .docwalk-diagram`)
  )
    return true;
  const direction = scrollDirection(event);
  if (!direction) return false;
  for (let el: Element | null = target; el && el !== pane; el = el.parentElement) {
    if (canScroll(el, direction)) return true;
  }
  return false;
}

/** The id of the frame that holds `el`. */
const frameOf = (el: Element): string | undefined =>
  el.closest<HTMLElement>("[data-map-frame]")?.dataset["mapFrame"];

/** Where a focused element sits in its frame, in map units from the frame's top. */
interface Within {
  top: number;
  height: number;
}

interface MapController {
  /** Draws `plan`'s frames in place of the current ones; the camera stays where it is. */
  render: (plan: SectionPlan, loadRemoteImages: boolean) => void;
  /** The deck's sections, for the mapping between frames and slides; moves nothing. */
  setDeckSections: (sections: readonly DeckSection[]) => void;
  /** The deck's current section, from outside (an outline entry, a link, a palette result). */
  setCurrent: (sectionId: string | null) => void;
  /** Stops everything and empties the layer. */
  dispose: () => void;
}

/**
 * The map's frames on `layer`, placed by `placeFrames` and moved by one
 * camera transform (decision 142). The camera lives here, outside React:
 * input changes it at once and the layer is written at most once per
 * animation frame.
 *
 * Rules this view chose (step 2, decision 144):
 * - The frames are placed from heights read as soon as they are in the
 *   page, and shown once the pane has a size, the camera on the opening
 *   frame; they are placed again as their heights settle.
 * - A height change re-places the frames and leaves the camera alone,
 *   only clamped to the new bounds: the frames after the changed one in
 *   its column move, the rest of the screen does not.
 * - "Empty map" for a mouse or pen drag is the pane, the layer and a
 *   frame's own box outside its `.docwalk-slide-body`; inside the body the
 *   mouse and the pen select text and follow links. One finger pans from
 *   anywhere, text included.
 * - A pointer that moved more than `TAP_SLOP` pans, and the click that may
 *   follow it opens and follows nothing; a tap clicks as usual.
 *
 * Rules this view chose for the route (step 3, decisions 145 and 147):
 * - Shift + Space goes to the previous frame, as on the slides (reveal.js);
 *   Shift with any other named key is left to the browser.
 * - The whole map (`0`) ends with any zoom or pan by the reader and with a
 *   move to a frame; until then `0` and Enter return to the current frame
 *   and a click anywhere in a frame goes to it.
 * - A move draws diagrams once, where it ends, so Mermaid's long tasks never
 *   stall the camera on its way.
 * - A move started in a hidden tab, which gets no animation frames, jumps.
 * - Tab to something a frame away makes that frame current with no move, so
 *   focus is never off screen; a link to a heading moves there.
 * - The current section from outside moves the map only when it names
 *   another deck section than the current frame's, and is never reported
 *   back. The first one to arrive after a map that opened before the deck
 *   had a current slide places the map there at once, as the opening would.
 */
function mountMap(
  pane: HTMLElement,
  layer: HTMLElement,
  status: HTMLElement,
  onCurrent: (sectionId: string) => void,
): MapController {
  layer.style.setProperty("--map-min-frame-height", `${MIN_FRAME_HEIGHT}px`);
  /** Null until the opening view. */
  let camera: Camera | null = null;
  let paneSize: Size = { width: pane.clientWidth, height: pane.clientHeight };
  let columns: MapFrame[][] = [];
  let heights = new Map<string, number>();
  let placement: MapPlacement = placeFrames([], heights);
  let rects = new Map<string, FrameRect>();
  let handle: MapFrames | null = null;
  // Click or Enter on a block opens the focus view (decisions 129 and 144).
  const focusWiring = wireFocusTargets(layer);
  /** Each frame element's written place, so a placement writes only what moved. */
  const written = new WeakMap<HTMLElement, string>();
  let raf = 0;

  // The route (decision 145).
  let mapSections: readonly Section[] = [];
  let order: string[] = [];
  let deckSections: readonly DeckSection[] = [];
  /** The deck section last known to be current: from outside, or reported. */
  let deckCurrent: string | null = null;
  let currentFrame: string | null = null;
  /** The whole map is shown (`0`), so a click in a frame chooses it. */
  let whole = false;
  /** The map opened before the deck had a current slide, and the reader has done nothing yet. */
  let waiting = false;
  /** The camera travelling to a frame or to the whole map. */
  let move: { from: Camera; to: () => Camera | null; start: number; frame: number } | null = null;
  /** The heading a link has just focused: its frame is reached by a move, not by the focus rule. */
  let navigated: HTMLElement | null = null;

  const write = () => {
    raf = 0;
    if (!handle) return;
    for (const rect of placement.frames) {
      const el = handle.frames.get(rect.id);
      const at = `${rect.x},${rect.y}`;
      if (!el || written.get(el) === at) continue;
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      written.set(el, at);
    }
    layer.style.width = `${placement.bounds.width}px`;
    layer.style.height = `${placement.bounds.height}px`;
    if (!camera) return;
    layer.style.transform = cameraTransform(camera);
    layer.style.setProperty("--map-ring", `${RING_PX / camera.scale}px`);
    layer.dataset["placed"] = "";
    // Frames drawn later are measured again by frames.ts and re-placed below.
    // Not on the way of a move: only where it ends (decision 145).
    if (!move) void handle.drawDiagrams(framesNear(placement, camera, paneSize));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(write);
  };
  /** Writes a pending change now, so the layer's boxes show the camera held here. */
  const writeNow = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    write();
  };
  /** Stops a move where it has got to; the camera stays there. */
  const stopMove = () => {
    if (!move) return;
    cancelAnimationFrame(move.frame);
    move = null;
    // The place it stopped at may be near diagrams the move did not draw.
    schedule();
  };
  const setCamera = (next: Camera) => {
    camera = next;
    schedule();
  };

  /** One animation frame of a move: the target is read again, so a frame that moved meanwhile is where it ends. */
  const step = () => {
    const current = move;
    if (!current) return;
    const target = current.to();
    const t = (performance.now() - current.start) / MOVE_MS;
    if (!target || t >= 1) {
      move = null;
      if (target) camera = target;
    } else {
      camera = tween(current.from, target, ease(t), paneSize);
      current.frame = requestAnimationFrame(step);
    }
    if (raf) cancelAnimationFrame(raf);
    write();
  };

  /**
   * The camera to `to()`: a move of `MOVE_MS` on animation frames, or a jump
   * with `animate` false, with reduced motion (read now, for each move), or
   * in a hidden tab, which gets no animation frames.
   */
  const moveTo = (to: () => Camera | null, animate: boolean) => {
    stopMove();
    const target = to();
    if (!camera || !target) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!animate || reduced || document.hidden) {
      camera = target;
      if (raf) cancelAnimationFrame(raf);
      if (document.hidden) write();
      else {
        raf = 0;
        schedule();
      }
      return;
    }
    move = { from: camera, to, start: performance.now(), frame: requestAnimationFrame(step) };
  };

  /**
   * A frame fitted as at opening (decision 142); with `within`, moved up if
   * that part of the frame would still be below the pane.
   */
  const frameCamera = (id: string, within?: Within): Camera | null => {
    const rect = rects.get(id);
    if (!rect) return null;
    let next = fitFrame(rect, placement.bounds, paneSize);
    if (within) {
      const mapTop = rect.y + within.top;
      const screenTop = mapTop * next.scale + next.y;
      if (screenTop < 0 || screenTop + within.height * next.scale > paneSize.height) {
        const margin = Math.min(FIT_MARGIN, paneSize.height / 4);
        next = clamp({ ...next, y: margin - mapTop * next.scale }, placement.bounds, paneSize);
      }
    }
    return next;
  };

  /** Says the current frame's title and place, politely (decision 145). */
  const announce = (id: string) => {
    const place = placeOf(order, id);
    if (!place) return;
    const title = mapSections.find((s) => s.id === id)?.title ?? "";
    status.textContent = title
      ? m.map_status({ title, index: place.index, count: place.count })
      : m.map_status_untitled({ index: place.index, count: place.count });
  };

  /**
   * Makes `id` the current frame: marked, said when it changed and `say` is
   * set, and its deck section reported when `report` is set and that
   * section is not the last one known.
   */
  const mark = (id: string, { say, report }: { say: boolean; report: boolean }) => {
    const changed = id !== currentFrame;
    if (currentFrame !== null) handle?.frames.get(currentFrame)?.removeAttribute("aria-current");
    currentFrame = id;
    handle?.frames.get(id)?.setAttribute("aria-current", "true");
    if (changed && say) announce(id);
    if (!report) return;
    const section = sectionForFrame(deckSections, mapSections, id);
    if (section !== null && section !== deckCurrent) {
      deckCurrent = section;
      onCurrent(section);
    }
  };

  /** Goes to a frame the reader chose: current, said, reported, and the camera moved to it. */
  const goToFrame = (
    id: string,
    {
      report = true,
      animate = true,
      within,
    }: { report?: boolean; animate?: boolean; within?: Within | undefined } = {},
  ) => {
    whole = false;
    waiting = false;
    mark(id, { say: true, report });
    moveTo(() => frameCamera(id, within), animate);
  };

  /** Where `el` sits in its frame, read from the layer as the camera has drawn it. */
  const withinFrame = (el: HTMLElement, id: string): Within | undefined => {
    const rect = rects.get(id);
    if (!camera || !rect) return undefined;
    writeNow();
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const top = (b.top - p.top - pane.clientTop - camera.y) / camera.scale;
    return { top: top - rect.y, height: b.height / camera.scale };
  };

  /** The opening view: the deck's current slide's frame, else the first, fitted (decisions 142 and 145). */
  const open = () => {
    if (camera || paneSize.width <= 0 || paneSize.height <= 0) return;
    const opening =
      (deckCurrent !== null && frameForSection(mapSections, deckSections, deckCurrent)) ||
      firstFrame(order);
    waiting = deckCurrent === null;
    if (opening !== null) mark(opening, { say: false, report: false });
    const rect = opening === null ? undefined : rects.get(opening);
    setCamera(
      rect
        ? fitFrame(rect, placement.bounds, paneSize)
        : clamp({ x: 0, y: 0, scale: 1 }, placement.bounds, paneSize),
    );
  };

  const place = () => {
    placement = placeFrames(columns, heights);
    rects = new Map(placement.frames.map((rect) => [rect.id, rect]));
    if (camera) camera = clamp(camera, placement.bounds, paneSize);
    else open();
    schedule();
  };

  /**
   * Brings `el`, inside a frame, into view: the frame fitted as at opening,
   * then moved up if `el` would still be below the pane. Nothing moves while
   * `el` is whole in the pane, or partly in it after a pointer moved focus
   * there, so a click never makes the map jump. Returns whether it moved.
   */
  const reveal = (el: HTMLElement): boolean => {
    const id = frameOf(el);
    if (!camera || id === undefined || !rects.has(id)) return false;
    writeNow();
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const left = b.left - p.left - pane.clientLeft;
    const top = b.top - p.top - pane.clientTop;
    const inside =
      left >= 0 &&
      top >= 0 &&
      left + b.width <= paneSize.width &&
      top + b.height <= paneSize.height;
    const seen =
      left + b.width > 0 && top + b.height > 0 && left < paneSize.width && top < paneSize.height;
    if (inside || (seen && !el.matches(":focus-visible"))) return false;
    const next = frameCamera(id, withinFrame(el, id));
    if (!next) return false;
    stopMove();
    setCamera(next);
    return true;
  };

  const local = (event: { clientX?: number; clientY?: number }): Point => {
    const p = pane.getBoundingClientRect();
    return {
      x: (event.clientX ?? Number.NaN) - p.left - pane.clientLeft,
      y: (event.clientY ?? Number.NaN) - p.top - pane.clientTop,
    };
  };

  /** The reader moved the camera by hand: a move stops where it is and the whole map ends. */
  const byHand = () => {
    stopMove();
    whole = false;
    waiting = false;
  };

  // The pane takes every wheel event: a plain wheel pans, Ctrl/Cmd + wheel zooms (decision 127).
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!camera) return;
    byHand();
    const at = local(event);
    setCamera(
      wheel(
        camera,
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          x: at.x,
          y: at.y,
        },
        placement.bounds,
        paneSize,
      ),
    );
  };

  // Touch pointers down on the pane, in pane coordinates.
  const touches = new Map<number, Point>();
  /** One pointer panning: a finger, or a mouse or pen drag that began on empty map. */
  let drag: { id: number; last: Point; moved: number } | null = null;
  /** The last press panned or pinched: the click that may follow it is no tap. */
  let panned = false;
  /** Two fingers: the camera and their places when the second came down. */
  let pinching: { ids: [number, number]; camera: Camera; points: [Point, Point] } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    if (!camera) return;
    // A touch or a press ends a move where it is (decision 145); a tap still chooses.
    stopMove();
    const at = local(event);
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, at);
      const down = [...touches];
      if (down.length === 1) {
        panned = false;
        drag = { id: event.pointerId, last: at, moved: 0 };
      } else if (down.length === 2) {
        const [[a, pa], [b, pb]] = down as [[number, Point], [number, Point]];
        drag = null;
        panned = true;
        pinching = { ids: [a, b], camera, points: [pa, pb] };
      }
      return;
    }
    panned = false;
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".docwalk-slide-body")) return;
    // No text selection starts from the frame's chrome; focus goes to the pane as a click would send it.
    event.preventDefault();
    pane.focus({ preventScroll: true });
    drag = { id: event.pointerId, last: at, moved: 0 };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!camera) return;
    const at = local(event);
    if (touches.has(event.pointerId)) touches.set(event.pointerId, at);
    if (pinching) {
      const a = touches.get(pinching.ids[0]);
      const b = touches.get(pinching.ids[1]);
      if (a && b) {
        byHand();
        setCamera(pinch(pinching.camera, pinching.points, [a, b], placement.bounds, paneSize));
      }
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const dx = at.x - drag.last.x;
    const dy = at.y - drag.last.y;
    drag.last = at;
    drag.moved += Math.hypot(dx, dy);
    if (drag.moved > TAP_SLOP) panned = true;
    if (dx === 0 && dy === 0) return;
    byHand();
    setCamera(pan(camera, dx, dy, placement.bounds, paneSize));
  };
  // On the window: a finger or the mouse can be released outside the pane.
  const onPointerUp = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) drag = null;
    if (!touches.delete(event.pointerId)) return;
    if (pinching && pinching.ids.includes(event.pointerId)) {
      pinching = null;
      // The finger left down pans on from where it is.
      const [rest] = touches;
      if (rest) drag = { id: rest[0], last: rest[1], moved: TAP_SLOP + 1 };
    }
  };

  /**
   * Capture, before a link or the focus wiring sees it. The end of a pan is
   * no click. On the whole map a click in a frame chooses it and nothing
   * else; at reading zoom a click on a frame's heading or empty area does,
   * and a link, a block or text keep their own meaning (decision 145).
   */
  const onClick = (event: MouseEvent) => {
    if (panned) {
      panned = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!camera || event.button !== 0) return;
    const target = event.target as Element;
    const frame = target.closest<HTMLElement>("[data-map-frame]");
    const id = frame?.dataset["mapFrame"];
    if (!frame || id === undefined || frame.parentElement !== layer) return;
    // A click that ends a text selection is no choice of a frame.
    const selection = getSelection();
    if (selection && !selection.isCollapsed && frame.contains(selection.anchorNode)) return;
    if (whole) {
      event.preventDefault();
      event.stopPropagation();
      goToFrame(id);
      return;
    }
    if (target.closest("a")) return;
    const empty =
      target === frame ||
      (target.parentElement === frame && target.classList.contains("docwalk-slide-body"));
    const headingId = frame.getAttribute("aria-labelledby");
    const onHeading = headingId !== null && target.closest(`#${CSS.escape(headingId)}`) !== null;
    if ((empty || onHeading) && id !== currentFrame) goToFrame(id);
  };

  // Safari's pinch (decisions 127 and 128): judged at its start, ignored while two fingers are down.
  let gesture: { from: number; ignored: boolean } | null = null;
  const onGesture = (event: GestureLike) => {
    event.preventDefault();
    if (event.type === "gesturestart") {
      gesture = camera ? { from: camera.scale, ignored: touches.size > 1 } : null;
      return;
    }
    if (!camera || !gesture || gesture.ignored) return;
    byHand();
    const target = gesture.from * (event.scale ?? 1);
    setCamera(zoomAt(camera, target / camera.scale, local(event), placement.bounds, paneSize));
  };

  // A keyboard user never tabs into something off screen (WCAG 2.4.11), and a
  // frame brought into view that way becomes current. Read after the task, so
  // a link that focused a heading moves there instead (onNavigate).
  const onFocusIn = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    queueMicrotask(() => {
      if (navigated === el) {
        navigated = null;
        return;
      }
      if (!reveal(el)) return;
      const id = frameOf(el);
      if (id === undefined) return;
      whole = false;
      waiting = false;
      mark(id, { say: true, report: true });
    });
  };

  // The keys of the route (decision 145): on the pane, so only while focus is on the map.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || !camera || order.length === 0) return;
    const { key } = event;
    // Shift + Space is the previous frame, as on the slides; Shift with a named key is the browser's.
    if (event.shiftKey && key.length > 1) return;
    const target = event.target instanceof Element ? event.target : pane;
    if (usesKey(target, event, pane)) return;
    let to: string | null = null;
    if (NEXT_KEYS.has(key) || (key === " " && !event.shiftKey)) to = nextFrame(order, currentFrame);
    else if (PREVIOUS_KEYS.has(key) || key === " ") to = previousFrame(order, currentFrame);
    else if (key === "Home") to = firstFrame(order);
    else if (key === "End") to = lastFrame(order);
    if (to !== null) {
      event.preventDefault();
      goToFrame(to);
      return;
    }
    if (key === "0" || (key === "Enter" && whole)) {
      event.preventDefault();
      if (whole) {
        whole = false;
        const id = currentFrame;
        if (id !== null) moveTo(() => frameCamera(id), true);
      } else {
        whole = true;
        waiting = false;
        moveTo(() => fitAll(placement.bounds, paneSize), true);
      }
      return;
    }
    if (key === "+" || key === "=" || key === "-") {
      event.preventDefault();
      byHand();
      setCamera(zoomStep(camera, key === "-" ? "out" : "in", placement.bounds, paneSize));
    }
  };

  const resize = new ResizeObserver(() => {
    paneSize = { width: pane.clientWidth, height: pane.clientHeight };
    if (camera) setCamera(clamp(camera, placement.bounds, paneSize));
    else open();
  });
  resize.observe(pane);

  pane.addEventListener("wheel", onWheel, { passive: false });
  pane.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  pane.addEventListener("gesturestart", onGesture);
  pane.addEventListener("gesturechange", onGesture);
  layer.addEventListener("focusin", onFocusIn);
  pane.addEventListener("click", onClick, { capture: true });
  pane.addEventListener("keydown", onKeyDown);

  return {
    render(plan, loadRemoteImages) {
      // The copy in an open view is of frames that are about to go.
      focusWiring.close();
      handle?.dispose();
      columns = mapColumns(plan);
      mapSections = plan.sections;
      order = routeOrder(columns);
      const current = renderFrames(layer, plan, {
        loadRemoteImages,
        onHeights: (changed) => {
          for (const [id, height] of changed) heights.set(id, height);
          // A height changes when the content does, which may make a box scroll or stop.
          for (const id of changed.keys()) {
            const el = current.frames.get(id);
            if (el) markScrollable(el);
          }
          place();
        },
        // A link to a heading in another frame: that frame, by a move (decision 145).
        onNavigate: (frameId, target) => {
          navigated = target;
          // After the focus rule's own check, which runs in a microtask queued before this one.
          queueMicrotask(() => {
            navigated = null;
          });
          goToFrame(frameId, { within: withinFrame(target, frameId) });
        },
      });
      handle = current;
      // The current frame stays current across an edit while it is on the map.
      if (camera) {
        const kept =
          currentFrame !== null && current.frames.has(currentFrame)
            ? currentFrame
            : (deckCurrent !== null && frameForSection(mapSections, deckSections, deckCurrent)) ||
              firstFrame(order);
        currentFrame = null;
        if (kept !== null) mark(kept, { say: false, report: false });
      }
      // Placed and shown at once from the heights the frames have now (decision 144):
      // never the previous render's, and never waiting on a slow image or chunk.
      heights = new Map([...current.frames.keys()].map((id) => [id, current.measure(id) ?? 0]));
      for (const el of current.frames.values()) markScrollable(el);
      place();
      writeNow();
    },
    setDeckSections(sections) {
      deckSections = sections;
    },
    setCurrent(sectionId) {
      // The deck is being built: nothing to follow until it is back.
      if (sectionId === null) return;
      const here =
        currentFrame === null ? null : sectionForFrame(deckSections, mapSections, currentFrame);
      deckCurrent = sectionId;
      if (!camera) return;
      // Only the first section to arrive after opening can still be the opening view.
      const opening = waiting;
      waiting = false;
      if (here === sectionId) return;
      const id = frameForSection(mapSections, deckSections, sectionId);
      if (id === null) return;
      if (opening) {
        // The deck's first slide arrives after the map opened: still the opening view.
        mark(id, { say: false, report: false });
        moveTo(() => frameCamera(id), false);
        return;
      }
      goToFrame(id, { report: false });
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (move) cancelAnimationFrame(move.frame);
      move = null;
      focusWiring.close();
      focusWiring.stop();
      handle?.dispose();
      handle = null;
      layer.replaceChildren();
      resize.disconnect();
      pane.removeEventListener("wheel", onWheel);
      pane.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      pane.removeEventListener("gesturestart", onGesture);
      pane.removeEventListener("gesturechange", onGesture);
      layer.removeEventListener("focusin", onFocusIn);
      pane.removeEventListener("click", onClick, { capture: true });
      pane.removeEventListener("keydown", onKeyDown);
    },
  };
}

/** No deck sections yet: one array, so the effect that hands them over runs only on a change. */
const NO_SECTIONS: readonly DeckSection[] = [];

/**
 * The map view (decisions 142 and 145): the frames of the map's plan on one
 * layer in a named, focusable pane, in document order whatever their place,
 * so a screen reader and Tab read the document in order; one of them is the
 * current frame, which follows the deck's current slide and reports its own.
 */
export default function MapView({
  root,
  current = null,
  deckSections = NO_SECTIONS,
  onCurrent,
}: MapViewProps) {
  const plan = useMemo(() => mapPlan(root), [root]);
  const loadRemoteImages = useLoadRemoteImages();
  // Footnote labels and image buttons are rendered in the UI language.
  const locale = useLocale();
  const paneRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const controller = useRef<MapController | null>(null);
  const report = useEffectEvent((sectionId: string) => onCurrent?.(sectionId));
  useEffect(() => {
    const map = mountMap(paneRef.current!, layerRef.current!, statusRef.current!, (id) =>
      report(id),
    );
    controller.current = map;
    return () => {
      map.dispose();
      controller.current = null;
    };
  }, []);
  // Before the render below, so the opening view knows the deck's current slide.
  useEffect(() => {
    controller.current?.setDeckSections(deckSections);
  }, [deckSections]);
  useEffect(() => {
    controller.current?.setCurrent(current);
  }, [current]);
  useEffect(() => {
    controller.current?.render(plan, loadRemoteImages);
    // `locale` is read through Paraglide while rendering; it is here to re-render on a switch.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [plan, loadRemoteImages, locale]);
  return (
    <section ref={paneRef} className="docwalk-map-pane" aria-label={m.map_region()} tabIndex={0}>
      <div ref={layerRef} className="docwalk-map-layer" />
      {/* The current frame's title and place (decision 145); outside the scaled layer. */}
      <p ref={statusRef} role="status" className="docwalk-map-status" />
    </section>
  );
}
