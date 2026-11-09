import { useSyncExternalStore } from "react";

/**
 * Stylus detection and pen drags (decision 110). The policy that says what a
 * pen, a finger and a mouse may do lives in `stylusPolicy.ts`; this module
 * holds the browser side: the setting, the "a pen is in use" latch, and the
 * watcher that turns a pen drag on the bare slide into a stroke.
 */

// ---- The setting ----------------------------------------------------------

/** Set ("true") when the viewer turned "Stylus draws, fingers change slides" off. */
export const STYLUS_AS_MOUSE_KEY = "docwalk.stylusAsMouse";

function readAsMouse(): boolean {
  try {
    return localStorage.getItem(STYLUS_AS_MOUSE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeAsMouse(asMouse: boolean): void {
  try {
    if (asMouse) localStorage.setItem(STYLUS_AS_MOUSE_KEY, "true");
    else localStorage.removeItem(STYLUS_AS_MOUSE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the setting still applies for this visit.
  }
}

const settingListeners = new Set<() => void>();
let draws: boolean | null = null;

/** The setting, on by default: a pen draws and a finger changes slides. */
export function stylusDraws(): boolean {
  draws ??= !readAsMouse();
  return draws;
}

export function setStylusDraws(on: boolean): void {
  if (on === stylusDraws()) return;
  draws = on;
  writeAsMouse(!on);
  for (const listener of settingListeners) listener();
}

export function subscribeStylusDraws(listener: () => void): () => void {
  settingListeners.add(listener);
  return () => settingListeners.delete(listener);
}

export function useStylusDraws(): boolean {
  return useSyncExternalStore(subscribeStylusDraws, stylusDraws, () => true);
}

// ---- The latch ------------------------------------------------------------

const penListeners = new Set<() => void>();
let penSeen = false;

/** True once a pen has touched the stage; it lasts until the page reloads. */
export function penInUse(): boolean {
  return penSeen;
}

export function subscribePenInUse(listener: () => void): () => void {
  penListeners.add(listener);
  return () => penListeners.delete(listener);
}

function onPenDown(event: PointerEvent): void {
  if (event.pointerType !== "pen" || penSeen) return;
  penSeen = true;
  for (const listener of penListeners) listener();
}

/**
 * Mark a pen as in use at its first `pointerdown` inside `stage`. A hover is
 * no touch of the glass, so only a contact counts. Returns the disposer; the
 * latch itself stays set.
 */
export function notePenOn(stage: HTMLElement): () => void {
  stage.addEventListener("pointerdown", onPenDown, true);
  return () => stage.removeEventListener("pointerdown", onPenDown, true);
}

// ---- Pen drags ------------------------------------------------------------

/** A pen that moves further than this many CSS px while down is drawing, not tapping. */
export const PEN_DRAG_PX = 4;

/** How long after the pen lifts a click may still arrive. */
const CLICK_WINDOW_MS = 500;

interface DragWatch {
  /** Called when watching may start a drag, and again for each move: the tool is off and the setting on. */
  enabled: () => boolean;
  /** Called once per drag with the `pointerdown` that began it. */
  onDrag: (down: PointerEvent) => void;
}

/**
 * Watch the primary pen on the stage. A tap does nothing here, so its click
 * follows a link or opens a diagram. Once the pen has moved more than
 * {@link PEN_DRAG_PX} while down, `onDrag` gets the `pointerdown` once, and
 * the click that ends the drag is cancelled, so a stroke that finishes over a
 * link does not follow it. The next `pointerdown`, or the end of the click
 * window, disarms that cancel. Returns the disposer.
 */
export function watchPenDrags(stage: HTMLElement, { enabled, onDrag }: DragWatch): () => void {
  let down: PointerEvent | null = null;
  let fired = false;
  let swallow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    swallow = false;
    clearTimeout(timer);
  };
  const onWindowDown = () => disarm();
  const onStageDown = (event: PointerEvent) => {
    down = null;
    if (event.pointerType !== "pen" || !event.isPrimary || event.button !== 0 || !enabled()) return;
    down = event;
    fired = false;
  };
  const onMove = (event: PointerEvent) => {
    if (!down || fired || event.pointerId !== down.pointerId) return;
    if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) <= PEN_DRAG_PX)
      return;
    if (!enabled()) return;
    fired = true;
    onDrag(down);
  };
  const onEnd = (event: PointerEvent) => {
    if (!down || event.pointerId !== down.pointerId) return;
    if (fired && event.type === "pointerup") {
      swallow = true;
      clearTimeout(timer);
      timer = setTimeout(disarm, CLICK_WINDOW_MS);
    }
    down = null;
  };
  const onClick = (event: MouseEvent) => {
    if (!swallow) return;
    disarm();
    event.preventDefault();
    event.stopPropagation();
  };

  window.addEventListener("pointerdown", onWindowDown, true);
  stage.addEventListener("pointerdown", onStageDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onEnd, true);
  window.addEventListener("pointercancel", onEnd, true);
  window.addEventListener("click", onClick, true);
  return () => {
    disarm();
    window.removeEventListener("pointerdown", onWindowDown, true);
    stage.removeEventListener("pointerdown", onStageDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onEnd, true);
    window.removeEventListener("pointercancel", onEnd, true);
    window.removeEventListener("click", onClick, true);
  };
}
