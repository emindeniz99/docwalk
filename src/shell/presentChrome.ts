import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

/**
 * Presenting chrome that steps aside (decision 75). On a phone the bar
 * above the slide (counter, address, overview, Exit) and the annotation
 * tools took a third of the screen, and iPhone Safari offers pages no
 * Fullscreen API to win the room back. So while presenting, the chrome
 * hides after a few idle seconds and the slide grows into the whole stage.
 *
 * The rules, in the order a presenter meets them:
 * - Hiding waits {@link CHROME_IDLE_MS} after the last activity, and never
 *   happens while a control has keyboard focus, a dialog or menu is open,
 *   the mouse rests on the bar, or a pen, laser or arrow stroke is under way.
 * - Moving a mouse or pen, a key that is not a navigation key, and a touch
 *   tap on the stage around the slide bring the chrome back. A tap toggles,
 *   so the same tap that showed it hides it again.
 * - Navigation keys and swipes never show it: a clicker or a swipe moves the
 *   slide and the room keeps the bigger slide.
 * - With a drawing tool selected, the slide belongs to the tool: a tap
 *   or a pointer moving over the slide draws (or points) and changes
 *   nothing; the stage around the slide still toggles the chrome. Without a
 *   tool, a tap on the slide toggles it too, unless it lands on a link, a
 *   diagram or an image, which do their own thing.
 * - Tab shows the chrome and focuses its first control (Shift+Tab: its last),
 *   so a keyboard user never tabs into nothing. Hidden controls stay in the
 *   accessibility tree, and focus reaching one by any route shows them.
 */
export const CHROME_IDLE_MS = 3000;

/** How long the first-time hint stays up once the chrome has hidden. */
export const CHROME_HINT_MS = 5000;

export const KEEP_CHROME_KEY = "docwalk.keepPresentControls";
export const CHROME_HINT_KEY = "docwalk.presentControlsHintSeen";

/** The chrome that hides: the bar above the slide (with the tools) and reveal.js's arrows. */
const CHROME = ".docwalk-preview-head, .reveal .controls";
/** Open layers that keep the chrome up: the overview, the palette, a menu, diagram focus. */
const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
/** Things on a slide a tap is meant for. */
const SLIDE_TARGET = "a, button, input, summary, img, .docwalk-diagram";
const TABBABLE =
  'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

/**
 * Keys that only move through the deck: a clicker's keys (Page Up/Down,
 * arrows, B and period for a blank screen), Space, Home and End. Modifier
 * keys on their own are no request for anything either.
 */
const QUIET_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "b",
  "B",
  ".",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
]);

/** True for a key press that should leave hidden chrome hidden. */
export function isQuietKey(event: Pick<KeyboardEvent, "key">): boolean {
  return QUIET_KEYS.has(event.key);
}

// ---- Stored preferences ---------------------------------------------------

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function write(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "true");
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode); the setting still applies for this visit.
  }
}

const listeners = new Set<() => void>();
let keepVisible: boolean | null = null;

function getKeepVisible(): boolean {
  keepVisible ??= read(KEEP_CHROME_KEY);
  return keepVisible;
}

/**
 * "Always show presenting controls" in the More menu: a per-browser
 * preference for people who would rather keep the bar, not a secret, so it
 * lives in `localStorage`.
 */
export function setKeepChromeVisible(on: boolean): void {
  keepVisible = on;
  write(KEEP_CHROME_KEY, on);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeepChromeVisible(): boolean {
  return useSyncExternalStore(subscribe, getKeepVisible, () => false);
}

// ---- The hook -------------------------------------------------------------

export interface PresentChrome {
  /** The chrome is hidden and the slide has the stage to itself. */
  hidden: boolean;
  /** Show the first-time hint ("Tap or move to show controls"). */
  hint: boolean;
}

interface Options {
  /** Presenting, and the viewer has not asked to keep the controls. */
  active: boolean;
  /** The deck pane: the bar above the slide plus the deck. */
  pane: RefObject<HTMLElement | null>;
  /** A pen, laser, arrow or eraser is selected, so the slide belongs to the tool. */
  toolActive: boolean;
}

const within = (target: EventTarget | null, selector: string): Element | null =>
  target instanceof Element ? target.closest(selector) : null;

export function usePresentChrome({ active, pane, toolActive }: Options): PresentChrome {
  const keep = useKeepChromeVisible();
  const enabled = active && !keep;
  const [hidden, setHidden] = useState(false);
  const [hint, setHint] = useState(false);
  // Leaving present mode (or keeping the controls) shows them; the next start is fresh.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setHidden(false);
    setHint(false);
  }
  const tool = useRef(toolActive);
  useLayoutEffect(() => {
    tool.current = toolActive;
  });

  useEffect(() => {
    const root = pane.current;
    if (!enabled || !root) return;
    let isHidden = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let drawing = false;
    let overBar = false;
    let last: { x: number; y: number } | null = null;
    let tap: { id: number; x: number; y: number; t: number } | null = null;

    const inChrome = (target: EventTarget | null) => {
      const el = within(target, CHROME);
      return el !== null && root.contains(el);
    };
    const overSlide = (x: number, y: number) => {
      const box = root.querySelector(".reveal .slides")?.getBoundingClientRect();
      return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    const keyboardFocusInChrome = () => {
      const el = document.activeElement;
      return inChrome(el) && el instanceof Element && el.matches(":focus-visible");
    };
    const held = () =>
      drawing || overBar || keyboardFocusInChrome() || document.querySelector(OPEN_LAYER) !== null;

    const set = (next: boolean) => {
      if (next === isHidden) return;
      isHidden = next;
      setHidden(next);
      clearTimeout(hintTimer);
      if (next && !read(CHROME_HINT_KEY)) {
        write(CHROME_HINT_KEY, true);
        setHint(true);
        hintTimer = setTimeout(() => setHint(false), CHROME_HINT_MS);
      } else {
        setHint(false);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (held()) schedule();
        else set(true);
      }, CHROME_IDLE_MS);
    };
    const show = () => {
      set(false);
      schedule();
    };
    const hide = () => {
      clearTimeout(timer);
      set(true);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        if (!isHidden || inChrome(event.target) || document.querySelector(OPEN_LAYER)) {
          schedule();
          return;
        }
        // The bar comes before the deck in the DOM, so a plain Tab from the
        // slide would leave the page. Land on the controls instead.
        const items = [
          ...root.querySelectorAll<HTMLElement>(`.docwalk-preview-head :is(${TABBABLE})`),
        ].filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
        const target = event.shiftKey ? items.at(-1) : items[0];
        if (!target) return;
        event.preventDefault();
        show();
        target.focus();
        return;
      }
      if (!isQuietKey(event)) show();
    };
    const onMove = (event: PointerEvent) => {
      // Touch moves are swipes and strokes; only a tap counts (onUp).
      if (event.pointerType === "touch") return;
      // The first event only sets a baseline, and a relayout under a still
      // mouse (the slide growing) is not a movement; a real move sends many.
      const moved =
        last !== null && Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y) > 1;
      last = { x: event.clientX, y: event.clientY };
      overBar = inChrome(event.target);
      if (!moved || drawing) return;
      if (tool.current && overSlide(event.clientX, event.clientY)) return;
      show();
    };
    const onDown = (event: PointerEvent) => {
      if (within(event.target, ".docwalk-annotate")) drawing = true;
      if (event.pointerType === "touch" && event.isPrimary)
        tap = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp };
      else if (inChrome(event.target)) show();
    };
    const onUp = (event: PointerEvent) => {
      if (drawing) {
        drawing = false;
        if (!isHidden) schedule();
      }
      const start = tap;
      tap = null;
      if (event.type !== "pointerup" || !start || start.id !== event.pointerId) return;
      const distance = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y);
      if (distance > 12 || event.timeStamp - start.t > 500) return;
      const target = event.target;
      if (inChrome(target)) {
        show();
        return;
      }
      if (!(target instanceof Node) || !root.contains(target)) return;
      if (document.querySelector(OPEN_LAYER)) return;
      if (overSlide(event.clientX, event.clientY)) {
        if (tool.current || within(target, SLIDE_TARGET)) return;
      }
      if (isHidden) show();
      else hide();
    };
    const onFocus = (event: FocusEvent) => {
      if (inChrome(event.target)) show();
    };
    // A mouse that leaves the window over the bar no longer rests on it.
    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) overBar = false;
    };

    schedule();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("pointerout", onOut, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      clearTimeout(timer);
      clearTimeout(hintTimer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, [enabled, pane]);

  // reveal.js lays out only on window resize; the stage just changed size.
  const isHidden = enabled && hidden;
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(frame);
    // Read by nobody inside: a change of `isHidden` is the stage changing size.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [isHidden]);

  return { hidden: isHidden, hint: enabled && hint };
}
