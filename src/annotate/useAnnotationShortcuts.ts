import { useEffect, useEffectEvent, type RefObject } from "react";
import { inFocusView } from "../deck/focusView";
import type { AnnotationMode } from "./types";

export type AnnotationShortcut = { mode: AnnotationMode } | { action: "undo" | "redo" };

const MODE_KEYS: Record<string, AnnotationMode> = {
  p: "pen",
  l: "laser",
  a: "arrow",
  r: "rect",
  c: "ellipse",
  e: "eraser",
};

/** Inputs that take no typed text: a focused colour swatch (a radio) must not swallow the shortcuts. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** True when the key press belongs to text entry: a text input, a textarea, a select or the source editor. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return (
    target.closest(
      'textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ) !== null
  );
}

/** The shortcut a key press asks for, or null when it is not one of ours. */
export function annotationShortcut(event: KeyboardEvent): AnnotationShortcut | null {
  if (event.defaultPrevented || event.isComposing || isTextEntry(event.target)) return null;
  // An open focus view (decision 87) is its own layer: P, L, A, R, C, E and Escape are not for the pen.
  if (inFocusView(event.target)) return null;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (command && !event.altKey && key === "z") {
    return { action: event.shiftKey ? "redo" : "undo" };
  }
  if (command || event.altKey) return null;
  if (key === "escape") return { mode: "off" };
  if (event.shiftKey) return null;
  const mode = MODE_KEYS[key];
  return mode ? { mode } : null;
}

export interface AnnotationShortcutHandlers {
  /** The current mode: Escape is only claimed while a tool is active. */
  mode: AnnotationMode;
  setMode: (mode: AnnotationMode) => void;
  undo: () => void;
  redo: () => void;
}

/**
 * P pen, L laser, A arrow, R rectangle, C ellipse, E eraser, Escape off, Ctrl/Cmd+Z undo,
 * Shift+Ctrl/Cmd+Z redo. Ignored while focus is in a text field, and, when
 * `scope` is given, for keys pressed outside it (so P stays type-ahead in a list).
 */
export function useAnnotationShortcuts(
  handlers: AnnotationShortcutHandlers,
  enabled = true,
  scope?: RefObject<HTMLElement | null>,
): void {
  // An effect event always sees the latest handlers without re-subscribing.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (scope && !(event.target instanceof Node && scope.current?.contains(event.target))) return;
    const shortcut = annotationShortcut(event);
    if (!shortcut) return;
    if ("action" in shortcut) {
      handlers[shortcut.action]();
    } else if (shortcut.mode === "off") {
      // With no tool active, Escape still belongs to reveal.js and fullscreen.
      if (handlers.mode === "off") return;
      handlers.setMode("off");
    } else {
      handlers.setMode(shortcut.mode);
    }
    event.preventDefault();
    // reveal.js binds P (previous) and L (next) on document and ignores
    // defaultPrevented, so a claimed key must not travel on to it.
    event.stopPropagation();
  });

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    // Capture on window runs before reveal.js's document listener.
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [enabled]);
}
