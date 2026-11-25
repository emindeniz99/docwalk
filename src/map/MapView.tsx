import type { Root } from "mdast";
import {
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";
import { FOCUS_ATTR } from "../deck/focusTargets";
import { wireFocusTargets } from "../deck/focusWiring";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { useLoadRemoteImages } from "../render/remoteImages";
import type { Section, SectionPlan } from "../sectioning/sectionize";
import {
  type Camera,
  cameraTransform,
  anchorFrame,
  clamp,
  FIT_MARGIN,
  fitAll,
  fitFrame,
  framesNear,
  holdTop,
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
import { createMapLaser, type MapLaser } from "./laser";
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

/** A section chosen in the shell; a new `seq` is a new choice, even of the same section. */
export interface MapRequest {
  sectionId: string;
  seq: number;
}

/** What the app can ask of a mounted map (decision 152). */
export interface MapHandle {
  /**
   * The phone remote's Next (1) or Previous (-1): the next or previous frame
   * of the route from the current frame, as Right and Left do on the pane but
   * wherever keyboard focus is, with the laser on or off. True when the map
   * took the step, also at an end where it refits in place; false while it
   * has no camera yet (not opened, or no frames), so the caller can do
   * something else with the press.
   */
  step: (direction: 1 | -1) => boolean;
}

export interface MapViewProps {
  /** The map's handle, for the phone remote's steps. */
  ref?: Ref<MapHandle>;
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
  /** The deck plan's slide levels, for headings the deck shows only as breadcrumbs (decision 148). */
  deckLevels?: readonly number[];
  /**
   * A section the reader chose in the shell (an outline entry, a palette
   * result): each new `seq` moves the map to that section's frame, even when
   * `current` already names it (decision 148).
   */
  request?: MapRequest | null;
  /**
   * The deck section a frame the reader made current maps to (decisions 145
   * and 147), called only when it differs from the last section known.
   */
  onCurrent?: (sectionId: string) => void;
  /**
   * The frame the map makes current, as often as it changes (decision 153): its
   * id, and `head` when it is the frame the deck section's address alone opens
   * (`frameForSection`), so a link names a frame only when it differs. Called
   * before `onCurrent` when one move changes both, so the app has the frame
   * when the section moves the deck. Nothing is reported while the deck has no
   * current section: the address is unknown. A follower's map reports nothing.
   * `onCurrent` stays the section's: a `###` frame reports no section.
   */
  onFrame?: (report: { frame: string; head: boolean }) => void;
  /**
   * The frame a link opened the page on (`?frame=`, decision 153). The opening
   * view goes to it when this map has it and it lies in the deck section the
   * address names (`sectionForFrame`); otherwise the section's own frame opens,
   * as without a link. Used for the opening view only.
   */
  openFrame?: string | null;
  /**
   * A follow screen's map only (decision 153): the frame the presenter's state
   * names, within `current`. The map follows it as it follows `current` when it
   * has that frame, and shows `current`'s frame when it has not (the follower's
   * document may not have caught up). "Back to presenter" ends a roam on it.
   */
  frame?: string | null;
  /**
   * Whether the map's laser is on (decision 149). The app holds it, so the
   * command palette can switch it too, and switches it off when the map goes.
   */
  laser?: boolean;
  /** `L` or Escape on the pane asks for the laser on or off. */
  onLaserChange?: (on: boolean) => void;
  /**
   * A follow screen's map (decision 150): `current` is the presenter's
   * section, the map reports nothing and has no laser, and the reader's own
   * pan, zoom, route key or frame click starts a roam that "Back to
   * presenter" or Escape ends. Read when the map mounts.
   */
  follow?: boolean;
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

/** A non-empty selection's ends, or null for none: compared to tell whether a press changed it. */
type SelectionKey = [Node | null, number, Node | null, number] | null;

function selectionKey(): SelectionKey {
  const sel = getSelection();
  return sel && !sel.isCollapsed
    ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset]
    : null;
}

function sameSelection(a: SelectionKey, b: SelectionKey): boolean {
  return a === b || (a !== null && b !== null && a.every((part, i) => part === b[i]));
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
  /** The deck's sections and slide levels, for the mapping between frames and slides; moves nothing. */
  setDeck: (sections: readonly DeckSection[], levels: readonly number[]) => void;
  /** The laser on or off (decision 149): the pane marks it and the status says it when it changes. */
  setLaser: (on: boolean) => void;
  /** A section the reader chose in the shell: its frame, with the move, whatever is current. */
  request: (sectionId: string) => void;
  /** The phone remote's Next or Previous (decision 152): the key's move, from wherever focus is. False when the map is not ready. */
  step: (direction: 1 | -1) => boolean;
  /** A follower's roam ends: the map goes to the presenter's section and follows it again (decision 150). */
  back: () => void;
  /**
   * The deck's current section, from outside (an outline entry, a link, a
   * palette result), and on a follower's map the frame the presenter's state
   * names (decision 153).
   */
  setCurrent: (sectionId: string | null, presenterFrame?: string | null) => void;
  /** The frame the link opened the page on, or null (decision 153). */
  setOpenFrame: (frame: string | null) => void;
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
 * - A height change re-places the frames and keeps the anchor frame's top
 *   where it is on screen (decision 155): the current frame while any of it
 *   is in the pane, else the first frame in the pane. The frames above the
 *   changed one move with it, the frames after it follow the anchor, and the
 *   camera is only clamped to the new bounds. A move under way is not
 *   shifted: it reads its frame's new place on every step.
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
 *
 * Rules this view chose for the laser (step 4, decision 149):
 * - `L` follows the slides' shortcut: Shift + L is left alone, and a held
 *   key switches nothing again.
 * - The dot shows from the next pointer move after the laser goes on, and
 *   stays while a mouse or pen rests on the pane.
 * - A mouse or pen press takes keyboard focus to the pane when it is
 *   elsewhere, so the route's keys keep working while pointing.
 * - Only a click from a pointer is swallowed; a click from a key or from
 *   assistive technology (`detail` 0) keeps its meaning.
 * - After two fingers, the finger left down neither points nor pans until it
 *   lifts.
 * - A press that began pointing keeps its click swallowed when the laser
 *   goes off before the release; the laser going on ends a mouse drag.
 * - While a finger points, a mouse or pen moves no dot.
 * - Switched on while focus is outside the pane, the pane takes focus.
 *
 * Rules this view chose for the phone remote's steps (decision 152):
 * - A step is the arrow key's move (`goToFrame`), taken from outside the
 *   pane, so it needs no focus and no exclusion of a text field or a box that
 *   scrolls; a focus view of a block closes only when the step goes to
 *   another frame.
 * - A step at the first or last frame refits the frame in place, as the key
 *   does, and leaves an open view.
 *
 * Rules this view chose for a follower's map (step 5, decision 150):
 * - A roam starts with whatever moves the camera by the reader's hand: the
 *   wheel, a drag, a pinch, the zoom keys, a route key, `0`, a click that
 *   chooses a frame, a link to a heading, Tab to something off screen, and
 *   a press that stops a move on its way. Opening a block in the focus view
 *   moves nothing and starts none.
 * - The frames the follower walks to set no deck section: `deckCurrent`
 *   stays the presenter's, which "Back to presenter" goes to.
 * - Escape ends a roam only from the pane; the focus view's own Escape
 *   never reaches it (the view lies outside the pane). A roam takes focus
 *   to the pane when it is elsewhere, so the Escape the status names works.
 * - A drag roams only once it has moved past `TAP_SLOP`; a finger's jitter
 *   still pans those few pixels but leaves the map following.
 * - Focus a closing focus view hands back to a frame other than the
 *   current one goes to the pane instead, when the follower is following:
 *   the follower opened the block, but the presenter has moved since. It is
 *   told apart from Tab by its missing `relatedTarget` after focus was in
 *   the view.
 */
function mountMap(
  pane: HTMLElement,
  layer: HTMLElement,
  status: HTMLElement,
  onCurrent: (sectionId: string) => void,
  onFrame: (report: { frame: string; head: boolean }) => void,
  onLaser: (on: boolean) => void,
  follow: { onRoam: (roaming: boolean) => void } | null,
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
  let deckLevels: readonly number[] = [];
  /** The deck section last known to be current: from outside, or reported. */
  let deckCurrent: string | null = null;
  let currentFrame: string | null = null;
  /** The frame the link opened the page on, for the opening view (decision 153). */
  let openFrame: string | null = null;
  /** A follower's map: the frame the presenter's state names, within `deckCurrent` (decision 153). */
  let presenterFrame: string | null = null;
  /** What `onFrame` last said, so it speaks only when the frame or its head-ness changes. */
  let reported: string | null = null;
  /** The whole map is shown (`0`), so a click in a frame chooses it. */
  let whole = false;
  /** The map opened before the deck had a current slide, and the reader has done nothing yet. */
  let waiting = false;
  /** The camera travelling to a frame or to the whole map. */
  let move: { from: Camera; to: () => Camera | null; start: number; frame: number } | null = null;
  /** The heading a link has just focused: its frame is reached by a move, not by the focus rule. */
  let navigated: HTMLElement | null = null;
  /** The laser's overlay while it is on (decision 149). */
  let laser: MapLaser | null = null;
  /** The finger that points: one that came down alone while the laser is on. */
  let laserTouch: number | null = null;
  /** The last press pointed: its click is swallowed even if the laser went off before the release. */
  let laserPress = false;
  /** A follower moved the map by hand: the presenter's sections no longer move it (decision 150). */
  let roaming = false;

  /** A follower's own move starts a roam, said politely once (decision 150). */
  const roam = () => {
    if (!follow || roaming) return;
    roaming = true;
    status.textContent = m.map_roaming();
    follow.onRoam(true);
    // The status asks for Escape, which only the pane hears: a roam by the wheel or a
    // finger leaves focus on <body> or the bar, so the pane takes it.
    if (!pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
  };

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
   * Tells the app the current frame, and whether it is the one the deck
   * section's address alone opens (decision 153). Not while the deck has no
   * current section, and never from a follower's map.
   */
  const publish = () => {
    if (follow || currentFrame === null || deckCurrent === null) return;
    const head = currentFrame === frameForSection(mapSections, deckSections, deckCurrent);
    const key = `${currentFrame}\n${head}`;
    if (key === reported) return;
    reported = key;
    onFrame({ frame: currentFrame, head });
  };

  /**
   * The link's frame for the deck section `sectionId`: the frame the link named
   * when this map has it and it lies in that section, else null (decision 153).
   */
  const linkedFrame = (sectionId: string): string | null =>
    openFrame !== null &&
    mapSections.some((s) => s.id === openFrame) &&
    sectionForFrame(deckSections, mapSections, openFrame, deckLevels) === sectionId
      ? openFrame
      : null;

  /** A follower's presenter frame, when this map has it (decision 153); else null, and the section's frame stands in. */
  const followedFrame = (): string | null =>
    follow && presenterFrame !== null && order.includes(presenterFrame) ? presenterFrame : null;

  /**
   * Makes `id` the current frame: marked, said when it changed and `say` is
   * set, and its deck section reported when `report` is set and that
   * section is not the last one known. The frame is reported first, so the
   * app has it when the section moves the deck (decision 153).
   */
  const mark = (id: string, { say, report }: { say: boolean; report: boolean }) => {
    const changed = id !== currentFrame;
    if (currentFrame !== null) handle?.frames.get(currentFrame)?.removeAttribute("aria-current");
    currentFrame = id;
    handle?.frames.get(id)?.setAttribute("aria-current", "true");
    if (changed && say) announce(id);
    // A follower's map moves no deck: the presenter's section stays `deckCurrent` (decision 150).
    const section =
      report && !follow ? sectionForFrame(deckSections, mapSections, id, deckLevels) : null;
    const moves = section !== null && section !== deckCurrent;
    if (moves) deckCurrent = section;
    publish();
    if (moves) onCurrent(section);
  };

  /** Goes to a frame the reader chose: current, said, reported, and the camera moved to it. */
  const goToFrame = (
    id: string,
    {
      report = true,
      animate = true,
      within,
      leaveFocus = false,
    }: {
      report?: boolean;
      animate?: boolean;
      within?: Within | undefined;
      leaveFocus?: boolean;
    } = {},
  ) => {
    whole = false;
    waiting = false;
    // A key or a click that leaves the frame holding keyboard focus takes focus
    // to the pane, so it is never on something off screen (decision 148).
    const focused = document.activeElement;
    if (leaveFocus && focused && layer.contains(focused) && frameOf(focused) !== id)
      pane.focus({ preventScroll: true });
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
      (deckCurrent !== null &&
        (followedFrame() ??
          linkedFrame(deckCurrent) ??
          frameForSection(mapSections, deckSections, deckCurrent))) ||
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
    const before = placement.frames;
    placement = placeFrames(columns, heights);
    const was = new Map(before.map((rect) => [rect.id, rect]));
    rects = new Map(placement.frames.map((rect) => [rect.id, rect]));
    if (camera) {
      // The frame being read keeps its place (decision 155); a move under way
      // reads its target's new place on its next step.
      const anchor = move ? null : anchorFrame(before, camera, paneSize, currentFrame);
      const from = anchor === null ? undefined : was.get(anchor);
      const to = anchor === null ? undefined : rects.get(anchor);
      if (from && to) camera = holdTop(camera, from.y, to.y);
      camera = clamp(camera, placement.bounds, paneSize);
    } else open();
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
  const byHand = (roams = true) => {
    stopMove();
    whole = false;
    waiting = false;
    if (roams) roam();
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

  /** The selection as it stood when the last press began, to tell a drag-select from a leftover one. */
  let selectedAtPress: SelectionKey = null;

  // Touch pointers down on the pane, in pane coordinates.
  const touches = new Map<number, Point>();
  /** One pointer panning: a finger, or a mouse or pen drag that began on empty map. */
  let drag: { id: number; last: Point; moved: number } | null = null;
  /** The last press panned or pinched: the click that may follow it is no tap. */
  let panned = false;
  /** Two fingers: the camera and their places when the second came down. */
  let pinching: { ids: [number, number]; camera: Camera; points: [Point, Point] } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    selectedAtPress = selectionKey();
    laserPress = laser !== null;
    if (!camera) return;
    // "Back to presenter" is the button's: a finger or a mouse on it pans nothing.
    if ((event.target as Element).closest(".docwalk-map-back")) return;
    const at = local(event);
    if (laser && event.pointerType !== "touch") {
      // A mouse or pen press points and does nothing else (decision 149); onMouseDown
      // keeps it from selecting text, dragging a link or focusing what it is on.
      if (!pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
      laser.point(at.x, at.y);
      return;
    }
    // A touch or a press ends a move where it is (decision 145); a tap still chooses.
    // A finger that points moves nothing, so it stops nothing either.
    if (!laser) {
      // A press that stops the move to the presenter's frame leaves the map elsewhere: a roam.
      if (move) roam();
      stopMove();
    }
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, at);
      const down = [...touches];
      if (down.length === 1) {
        panned = false;
        if (laser) {
          laserTouch = event.pointerId;
          laser.point(at.x, at.y);
        } else drag = { id: event.pointerId, last: at, moved: 0 };
      } else if (down.length === 2) {
        const [[a, pa], [b, pb]] = down as [[number, Point], [number, Point]];
        drag = null;
        panned = true;
        pinching = { ids: [a, b], camera, points: [pa, pb] };
        // Two fingers pinch and pan, and the dot goes while they do (decision 149).
        laserTouch = null;
        laser?.hide();
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
    // A follower's drag starts a roam only past the tap slop, so a finger's jitter does not.
    byHand(drag.moved > TAP_SLOP);
    setCamera(pan(camera, dx, dy, placement.bounds, paneSize));
  };
  /**
   * Clears `panned` once the press is over: a pan released outside the pane,
   * or a touch pan, gets no click, and the next click must not be swallowed
   * (decision 148). A click that does follow comes before this timer.
   */
  let pannedTimer = 0;
  // On the window: a finger or the mouse can be released outside the pane.
  const onPointerUp = (event: PointerEvent) => {
    // The dot goes when its finger lifts and when the browser takes the pointer (decision 149).
    if (event.pointerId === laserTouch || event.type === "pointercancel") {
      laserTouch = null;
      laser?.hide();
    }
    if (panned && touches.size <= 1) {
      clearTimeout(pannedTimer);
      pannedTimer = window.setTimeout(() => {
        panned = false;
      }, 0);
    }
    if (drag?.id === event.pointerId) drag = null;
    if (!touches.delete(event.pointerId)) return;
    if (pinching && pinching.ids.includes(event.pointerId)) {
      pinching = null;
      // The finger left down pans on from where it is; with the laser on it does nothing.
      const [rest] = touches;
      if (rest && !laser) drag = { id: rest[0], last: rest[1], moved: TAP_SLOP + 1 };
    }
  };

  /**
   * Capture, before a link or the focus wiring sees it. The end of a pan is
   * no click. On the whole map a click in a frame chooses it and nothing
   * else; at reading zoom a click on a frame's heading or empty area does,
   * and a link, a block or text keep their own meaning (decision 145).
   */
  const onClick = (event: MouseEvent) => {
    // A pointer's click with the laser on opens nothing, follows nothing and chooses nothing (decision 149).
    if ((laser || laserPress) && event.detail !== 0) {
      laserPress = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
    // A click that ends a text selection is no choice of a frame: only a
    // selection that changed during this press counts (decision 148).
    const selection = getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      frame.contains(selection.anchorNode) &&
      !sameSelection(selectionKey(), selectedAtPress)
    )
      return;
    if (whole) {
      event.preventDefault();
      event.stopPropagation();
      goToFrame(id, { leaveFocus: true });
      roam();
      return;
    }
    if (target.closest("a")) return;
    const empty =
      target === frame ||
      (target.parentElement === frame && target.classList.contains("docwalk-slide-body"));
    const headingId = frame.getAttribute("aria-labelledby");
    const onHeading = headingId !== null && target.closest(`#${CSS.escape(headingId)}`) !== null;
    if ((empty || onHeading) && id !== currentFrame) {
      goToFrame(id, { leaveFocus: true });
      roam();
    }
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
    // A focus view hands focus back to its block with no element losing it (its close
    // button left the page). On a follower's map that block may sit in a frame the
    // presenter has since left: the pane takes focus and the map stays (decision 150).
    const fromView = focusViewOpened && event.relatedTarget === null;
    focusViewOpened = false;
    if (fromView && follow && !roaming && frameOf(el) !== currentFrame) {
      pane.focus({ preventScroll: true });
      return;
    }
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
      roam();
    });
  };

  /** Focus went into a focus view (decision 129) and has not come back to the map yet. */
  let focusViewOpened = false;
  const onDocumentFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".docwalk-focus")) focusViewOpened = true;
  };

  // The laser's pointer (decision 149): a mouse or pen over the pane, or the finger that points.
  const onLaserMove = (event: PointerEvent) => {
    if (!laser || (event.pointerType === "touch" && event.pointerId !== laserTouch)) return;
    // One dot: while a finger points, a mouse or pen elsewhere does not move it.
    if (event.pointerType !== "touch" && laserTouch !== null) return;
    const at = local(event);
    laser.point(at.x, at.y);
  };
  const onPointerLeave = () => laser?.hide();
  // No text selection, link drag or focus change from a press while the laser is on.
  const onMouseDown = (event: MouseEvent) => {
    if (laser) event.preventDefault();
  };
  // No long-press menu and no middle click on a link while pointing.
  const onLaserHold = (event: MouseEvent) => {
    if (laser) event.preventDefault();
  };

  /**
   * `L` switches the laser and Escape switches it off (decision 149), with
   * the route keys' exclusions. Returns whether the key was the laser's.
   */
  const laserKey = (event: KeyboardEvent): boolean => {
    // A follower's map has no laser (decision 150).
    if (follow) return false;
    const toggle = event.key.toLowerCase() === "l" && !event.shiftKey;
    const off = event.key === "Escape" && laser !== null;
    if ((!toggle && !off) || event.isComposing) return false;
    const target = event.target instanceof Element ? event.target : pane;
    if (usesKey(target, event, pane)) return false;
    event.preventDefault();
    // An Escape that switched the laser off does nothing else in the app.
    if (off) event.stopPropagation();
    if (!event.repeat) onLaser(toggle ? laser === null : false);
    return true;
  };

  // The keys of the route (decision 145): on the pane, so only while focus is on the map.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (laserKey(event)) return;
    if (event.isComposing || !camera || order.length === 0) return;
    const { key } = event;
    if (key === "Escape" && roaming) {
      const target = event.target instanceof Element ? event.target : pane;
      if (usesKey(target, event, pane)) return;
      event.preventDefault();
      back();
      return;
    }
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
      goToFrame(to, { leaveFocus: true });
      roam();
      return;
    }
    if (key === "0" || (key === "Enter" && whole)) {
      event.preventDefault();
      roam();
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

  /** Ends a follower's roam on the presenter's section's frame (decision 150). */
  function back() {
    if (!roaming || !follow) return;
    roaming = false;
    follow.onRoam(false);
    const id =
      followedFrame() ??
      (deckCurrent === null ? null : frameForSection(mapSections, deckSections, deckCurrent));
    if (id !== null) goToFrame(id, { report: false, leaveFocus: true });
    // After the frame's own announcement, so this is what is said.
    status.textContent = m.map_following();
  }

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
  document.addEventListener("focusin", onDocumentFocusIn, true);
  pane.addEventListener("click", onClick, { capture: true });
  pane.addEventListener("keydown", onKeyDown);
  pane.addEventListener("pointermove", onLaserMove);
  pane.addEventListener("pointerleave", onPointerLeave);
  pane.addEventListener("mousedown", onMouseDown);
  pane.addEventListener("contextmenu", onLaserHold);
  pane.addEventListener("auxclick", onLaserHold, { capture: true });
  // Back online: a diagram whose code did not load may load now (decision 148).
  const onOnline = () => {
    handle?.retryFailed();
    schedule();
  };
  window.addEventListener("online", onOnline);

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
          roam();
        },
      });
      handle = current;
      // The current frame stays current across an edit while it is on the map.
      let jump: string | null = null;
      if (camera) {
        let kept =
          currentFrame !== null && current.frames.has(currentFrame)
            ? currentFrame
            : (deckCurrent !== null && frameForSection(mapSections, deckSections, deckCurrent)) ||
              firstFrame(order);
        // A follower's document has caught up: the presenter's frame is here now (decision 153).
        const followed = roaming ? null : followedFrame();
        if (followed !== null && followed !== kept) {
          kept = followed;
          jump = followed;
        }
        currentFrame = null;
        if (kept !== null) mark(kept, { say: false, report: false });
      }
      // Placed and shown at once from the heights the frames have now (decision 144):
      // never the previous render's, and never waiting on a slow image or chunk.
      heights = new Map([...current.frames.keys()].map((id) => [id, current.measure(id) ?? 0]));
      for (const el of current.frames.values()) markScrollable(el);
      place();
      writeNow();
      if (jump !== null) moveTo(() => frameCamera(jump), false);
    },
    setDeck(sections, levels) {
      deckSections = sections;
      deckLevels = levels;
    },
    setLaser(on) {
      if (on === (laser !== null)) return;
      if (on) {
        laser = createMapLaser(pane);
        pane.dataset["laser"] = "";
        // A mouse drag panning when the laser goes on ends here; two fingers still pinch.
        drag = null;
        // Switched on from outside (the palette): the pane takes focus, so Escape reaches it.
        if (!pane.contains(document.activeElement)) pane.focus({ preventScroll: true });
      } else {
        laser?.dispose();
        laser = null;
        laserTouch = null;
        delete pane.dataset["laser"];
      }
      status.textContent = on ? m.map_laser_on() : m.map_laser_off();
    },
    request(sectionId) {
      deckCurrent = sectionId;
      // Not opened yet: the opening view goes to `deckCurrent`.
      const id = camera ? frameForSection(mapSections, deckSections, sectionId) : null;
      if (id !== null) goToFrame(id, { report: false });
    },
    step(direction) {
      if (!camera || order.length === 0) return false;
      const to =
        direction === 1 ? nextFrame(order, currentFrame) : previousFrame(order, currentFrame);
      if (to === null) return false;
      // As a slide change closes them on the slides, which Next on the last slide is not;
      // a diagram view stays (decision 152).
      if (to !== currentFrame) {
        const focused = document.activeElement;
        focusWiring.closeContent();
        // A closing view hands focus back to its block, and the focus rule would make that
        // block's frame current again once the step has moved on: the step's frame wins.
        const returned = document.activeElement;
        if (returned !== focused && returned instanceof HTMLElement && layer.contains(returned)) {
          navigated = returned;
          queueMicrotask(() => {
            navigated = null;
          });
        }
      }
      goToFrame(to, { leaveFocus: true });
      return true;
    },
    back,
    setCurrent(sectionId, frame = null) {
      // The deck is being built: nothing to follow until it is back.
      if (sectionId === null) return;
      const here =
        currentFrame === null
          ? null
          : sectionForFrame(deckSections, mapSections, currentFrame, deckLevels);
      deckCurrent = sectionId;
      presenterFrame = follow ? frame : null;
      if (!camera) return;
      // Only the first section to arrive after opening can still be the opening view.
      const opening = waiting;
      waiting = false;
      // A roaming follower's map stays where they put it; `back` goes to `deckCurrent` (decision 150).
      if (roaming) return;
      // The frame to show: the presenter's, when this map has it, and the link's on the
      // opening view; else the section's own frame (decisions 145 and 153). A follower
      // always has one in mind, so a state with no frame leaves a ### frame for the column's head.
      const wanted =
        followedFrame() ??
        (opening ? linkedFrame(sectionId) : null) ??
        (follow ? frameForSection(mapSections, deckSections, sectionId) : null);
      if (wanted === null ? here === sectionId : wanted === currentFrame) {
        // Nothing moves, but the section may be what makes this frame the head one.
        publish();
        return;
      }
      const id = wanted ?? frameForSection(mapSections, deckSections, sectionId);
      if (id === null) return;
      if (opening) {
        // The deck's first slide arrives after the map opened: still the opening view.
        mark(id, { say: false, report: false });
        moveTo(() => frameCamera(id), false);
        return;
      }
      goToFrame(id, { report: false });
    },
    setOpenFrame(frame) {
      openFrame = frame;
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
      document.removeEventListener("focusin", onDocumentFocusIn, true);
      pane.removeEventListener("click", onClick, { capture: true });
      pane.removeEventListener("keydown", onKeyDown);
      pane.removeEventListener("pointermove", onLaserMove);
      pane.removeEventListener("pointerleave", onPointerLeave);
      pane.removeEventListener("mousedown", onMouseDown);
      pane.removeEventListener("contextmenu", onLaserHold);
      pane.removeEventListener("auxclick", onLaserHold, { capture: true });
      window.removeEventListener("online", onOnline);
      laser?.dispose();
      laser = null;
      clearTimeout(pannedTimer);
    },
  };
}

/** No deck sections yet: one array, so the effect that hands them over runs only on a change. */
const NO_SECTIONS: readonly DeckSection[] = [];
const NO_LEVELS: readonly number[] = [];

/**
 * The map view (decisions 142 and 145): the frames of the map's plan on one
 * layer in a named, focusable pane, in document order whatever their place,
 * so a screen reader and Tab read the document in order; one of them is the
 * current frame, which follows the deck's current slide and reports its own.
 */
export default function MapView({
  ref,
  root,
  current = null,
  deckSections = NO_SECTIONS,
  deckLevels = NO_LEVELS,
  request = null,
  onCurrent,
  onFrame,
  openFrame = null,
  frame = null,
  laser = false,
  onLaserChange,
  follow = false,
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
  const reportFrame = useEffectEvent((at: { frame: string; head: boolean }) => onFrame?.(at));
  const askLaser = useEffectEvent((on: boolean) => onLaserChange?.(on));
  useImperativeHandle(
    ref,
    () => ({ step: (direction) => controller.current?.step(direction) ?? false }),
    [],
  );
  // A follower's roam (decision 150): the controller decides it, this shows the button.
  const [roaming, setRoaming] = useState(false);
  useEffect(() => {
    const map = mountMap(
      paneRef.current!,
      layerRef.current!,
      statusRef.current!,
      (id) => report(id),
      (at) => reportFrame(at),
      (on) => askLaser(on),
      follow ? { onRoam: setRoaming } : null,
    );
    controller.current = map;
    return () => {
      map.dispose();
      controller.current = null;
      setRoaming(false);
    };
  }, [follow]);
  // Before the render below, so the opening view knows the deck's current slide.
  useEffect(() => {
    controller.current?.setDeck(deckSections, deckLevels);
  }, [deckSections, deckLevels]);
  useEffect(() => {
    controller.current?.setOpenFrame(openFrame);
  }, [openFrame]);
  useEffect(() => {
    controller.current?.setCurrent(current, frame);
  }, [current, frame]);
  useEffect(() => {
    controller.current?.setLaser(laser);
  }, [laser]);
  // A request made before this map mounted (on an earlier visit to the map) is not a new choice.
  const handledSeq = useRef(request?.seq ?? 0);
  useEffect(() => {
    if (!request || request.seq <= handledSeq.current) return;
    handledSeq.current = request.seq;
    controller.current?.request(request.sectionId);
  }, [request]);
  useEffect(() => {
    controller.current?.render(plan, loadRemoteImages);
    // `locale` is read through Paraglide while rendering; it is here to re-render on a switch.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [plan, loadRemoteImages, locale]);
  return (
    <section ref={paneRef} className="docwalk-map-pane" aria-label={m.map_region()} tabIndex={0}>
      {/* Before the layer, so it is the first Tab stop after the pane; outside the scaled layer. */}
      {roaming && (
        <Button
          className="docwalk-button docwalk-map-back"
          data-variant="primary"
          onPress={() => {
            // The button goes with the roam: focus stays on the map, not on <body>.
            paneRef.current?.focus({ preventScroll: true });
            controller.current?.back();
          }}
        >
          {m.map_back_to_presenter()}
        </Button>
      )}
      <div ref={layerRef} className="docwalk-map-layer" />
      {/* The current frame's title and place (decision 145); outside the scaled layer. */}
      <p ref={statusRef} role="status" className="docwalk-map-status" />
    </section>
  );
}
