import { useSyncExternalStore } from "react";
import { useMediaQuery } from "../shell/useMediaQuery";

/**
 * Which source editor the edit view shows (decision 53): CodeMirror by
 * default, Monaco when the viewer picks it in the More menu. A per-browser
 * convenience, not a secret, so it lives in `localStorage`. This module is
 * tiny on purpose: the menu reads it on first load, while both editors stay
 * in their own lazy chunks.
 */
export type EditorKind = "codemirror" | "monaco";

export const EDITOR_KEY = "docwalk.editor";

/** Touch screens keep CodeMirror: Monaco has no mobile support (decision 4). */
export const COARSE_POINTER = "(pointer: coarse)";

/** The stored choice; anything but "monaco" (missing, garbage, blocked storage) is CodeMirror. */
export function readEditorChoice(storage: Pick<Storage, "getItem"> | undefined): EditorKind {
  try {
    return storage?.getItem(EDITOR_KEY) === "monaco" ? "monaco" : "codemirror";
  } catch {
    return "codemirror";
  }
}

const listeners = new Set<() => void>();
let current: EditorKind | null = null;

/** `localStorage` itself, which throws on access where site data is blocked. */
function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function getChoice(): EditorKind {
  current ??= readEditorChoice(localStore());
  return current;
}

export function setEditorChoice(kind: EditorKind): void {
  current = kind;
  try {
    // The default is not stored, so clearing site data and picking CodeMirror look the same.
    if (kind === "monaco") localStorage.setItem(EDITOR_KEY, kind);
    else localStorage.removeItem(EDITOR_KEY);
  } catch {
    // Storage can be unavailable (private mode); the choice still applies for this visit.
  }
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

// The choice lives in storage that every tab of this origin shares, so a pick
// made in another tab (or site data cleared there) reaches this one as a
// `storage` event; two windows must not show different editors.
if (typeof addEventListener === "function") {
  addEventListener("storage", (event) => {
    // A null key is the whole store being cleared.
    if (event.key !== null && event.key !== EDITOR_KEY) return;
    const next = readEditorChoice(localStore());
    if (next === current) return;
    current = next;
    notify();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the viewer picked, regardless of the device; the menu shows this. */
export function useStoredEditorChoice(): EditorKind {
  return useSyncExternalStore(subscribe, getChoice);
}

/** The editor to render: the stored choice, except that a touch device always gets CodeMirror. */
export function useEditorChoice(): EditorKind {
  const stored = useStoredEditorChoice();
  const coarse = useMediaQuery(COARSE_POINTER);
  return coarse ? "codemirror" : stored;
}
