import { useEffect, useEffectEvent, type RefObject } from "react";
import { isTextEntry } from "../annotate/useAnnotationShortcuts";

/** True when a key press asks for the slide overview: a plain O outside text entry. */
export function isOverviewKey(event: KeyboardEvent): boolean {
  return (
    event.key.toLowerCase() === "o" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    !isTextEntry(event.target)
  );
}

/**
 * O opens the slide overview. Presenting, it works anywhere; in the edit view
 * only while focus is in `scope` (the deck pane), so O stays a letter in the
 * outline's type-ahead and in the editor. reveal.js's own O overview is
 * switched off in Deck.tsx; this one is keyboard navigable and named.
 */
export function useOverviewShortcut(
  open: () => void,
  enabled: boolean,
  scope?: RefObject<HTMLElement | null>,
): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (scope && !(event.target instanceof Node && scope.current?.contains(event.target))) return;
    if (!isOverviewKey(event)) return;
    event.preventDefault();
    open();
  });

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled]);
}
