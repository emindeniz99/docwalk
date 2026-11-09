import type { FocusEvent } from "../annotate/mirrorTypes";

/**
 * Who hears when a focus view (diagram, code, table or image) opens, zooms,
 * marks lines or closes (decisions 88 and 106).
 * A plain subscriber list in its own file, so the app shell can listen
 * without importing the focus view and its Panzoom into the first load.
 */

const observers = new Set<(event: FocusEvent) => void>();

/** Calls `listener` for every focus view event. Returns the function that stops it. */
export function observeFocus(listener: (event: FocusEvent) => void): () => void {
  observers.add(listener);
  return () => observers.delete(listener);
}

export function emitFocus(event: FocusEvent): void {
  for (const observer of observers) observer(event);
}
