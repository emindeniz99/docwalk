import { useSyncExternalStore } from "react";
import { BLOCKED_IMAGE_CLASS, BLOCKED_IMAGE_SRC } from "./toHtml";

/**
 * The viewer's side of the remote-image gate (decision 33): a blocked image
 * loads on click or Enter, or every remote image loads when the "always
 * load" setting is on. The setting is a per-browser viewer preference, not a
 * secret, so it lives in `localStorage`.
 */
export const LOAD_REMOTE_IMAGES_KEY = "docwalk.loadRemoteImages";

/**
 * Loads one blocked image. The URL is checked again here, so only an https
 * URL is ever loaded, whatever ended up in `data-docwalk-src`. Returns whether it loaded.
 */
export function loadBlockedImage(img: HTMLImageElement): boolean {
  const src = img.getAttribute(BLOCKED_IMAGE_SRC);
  if (!src || !URL.canParse(src, document.baseURI)) return false;
  const url = new URL(src, document.baseURI);
  if (url.protocol !== "https:") return false;
  for (const attr of [BLOCKED_IMAGE_SRC, "role", "tabindex", "aria-label", "title"]) {
    img.removeAttribute(attr);
  }
  img.classList.remove(BLOCKED_IMAGE_CLASS);
  img.src = url.href;
  return true;
}

/** Loads the blocked image an event landed on, if any. */
function loadFromEvent(event: Event): void {
  const img =
    event.target instanceof Element
      ? event.target.closest<HTMLImageElement>(`img.${BLOCKED_IMAGE_CLASS}`)
      : null;
  if (!img || !loadBlockedImage(img)) return;
  // The first activation only loads: it must not follow a surrounding link
  // or reach reveal.js, which reads Space as "next slide".
  event.preventDefault();
  event.stopPropagation();
}

function loadFromKey(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") loadFromEvent(event);
}

/** Click, Enter or Space on a blocked image under `root` loads it. Returns the cleanup. */
export function enableClickToLoad(root: HTMLElement): () => void {
  root.addEventListener("click", loadFromEvent);
  root.addEventListener("keydown", loadFromKey);
  return () => {
    root.removeEventListener("click", loadFromEvent);
    root.removeEventListener("keydown", loadFromKey);
  };
}

const listeners = new Set<() => void>();
let current: boolean | null = null;

function readStored(): boolean {
  try {
    return localStorage.getItem(LOAD_REMOTE_IMAGES_KEY) === "true";
  } catch {
    return false;
  }
}

function getLoadRemoteImages(): boolean {
  current ??= readStored();
  return current;
}

export function setLoadRemoteImages(on: boolean): void {
  current = on;
  try {
    if (on) localStorage.setItem(LOAD_REMOTE_IMAGES_KEY, "true");
    else localStorage.removeItem(LOAD_REMOTE_IMAGES_KEY);
  } catch {
    // Storage can be unavailable (private mode); the setting still applies for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The "always load remote images" setting; views that render Markdown re-render when it changes. */
export function useLoadRemoteImages(): boolean {
  return useSyncExternalStore(subscribe, getLoadRemoteImages);
}
