import { useCallback, useEffect, useRef, type RefObject } from "react";
import { penInUse, useStylusDraws } from "../annotate/stylus";
import { slideOwner, type PointerKind } from "../annotate/stylusPolicy";
import type { AnnotationLayer, AnnotationMode } from "../annotate/types";
import { usePresentChrome, usePresentFrame } from "./presentChrome";
import type { View } from "./view";
import { useWakeLock } from "./wakeLock";

const pointerKind = (type: string): PointerKind =>
  type === "pen" || type === "touch" ? type : "mouse";

/**
 * Presenting: the stage's frame and chrome, the screen kept awake, entering
 * present mode in fullscreen, and leaving it when fullscreen ends.
 */
export function usePresenting({
  view,
  follow,
  followOpen,
  mode,
  deckRef,
  layerRef,
  show,
}: {
  view: View;
  follow: boolean;
  /** A follow screen whose slide can be trusted (see useRemoteRoom). */
  followOpen: boolean;
  mode: AnnotationMode;
  deckRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<AnnotationLayer | null>;
  show: (next: View | ((v: View) => View)) => void;
}) {
  // Presenting, and on a follow screen (decision 113), the slide fills the
  // screen unless the viewer chose the card frame (decision 77).
  const frame = usePresentFrame();
  const presenting = view === "present" && !follow;
  const staged = presenting || follow;
  const fill = staged && frame === "fill";
  // The screen stays on while presenting (decision 80).
  useWakeLock(view === "present");
  // Presenting, the bar and tools step aside after a few idle seconds so the
  // slide can take the whole stage (decision 75); usePresentChrome has the rules.
  const stylusOn = useStylusDraws();
  const chrome = usePresentChrome({
    active: presenting || followOpen,
    pane: deckRef,
    slideOwner: (type) =>
      slideOwner({
        pointerType: pointerKind(type),
        drawingTool: mode !== "off" && mode !== "laser",
        laser: mode === "laser",
        stylusDraws: stylusOn,
        penInUse: penInUse(),
      }),
    barIsStage: fill,
  });

  // Whether this fullscreen session's exit has been acted on; see onFullscreen.
  const fullscreenLeft = useRef(false);
  const present = useCallback(async () => {
    show("present");
    fullscreenLeft.current = false;
    try {
      // The whole page goes fullscreen, not just the deck: dialogs such as the
      // command palette render outside the deck and would be invisible.
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen can be refused (iOS, iframes); present mode still fills the window.
    }
    deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
  }, [show, deckRef]);

  useEffect(() => {
    const onFullscreen = () => {
      if (document.fullscreenElement) {
        fullscreenLeft.current = false;
        return;
      }
      // One exit, one action. An Escape during WebKit's enter animation
      // delays the enter's change event until the exit has begun, so two
      // events in a row find no fullscreen element; acting on both would
      // close a dialog and then leave present mode on the same key.
      if (fullscreenLeft.current) return;
      fullscreenLeft.current = true;
      // Browsers keep Escape for leaving fullscreen and the page never sees
      // the key. With a dialog open (slide overview, sketch, palette) that
      // Escape was meant for the dialog: hand it over and keep presenting,
      // windowed, as a page without fullscreen would.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[role="dialog"]')) {
        focused.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        return;
      }
      // Likewise an open whiteboard (decision 110): that Escape was meant for it, so presenting
      // goes on windowed with the board up; Escape again closes it, and once more leaves.
      if (layerRef.current?.board()) return;
      show((v) => (v === "present" ? "edit" : v));
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [show, layerRef]);

  return { frame, staged, fill, chrome, present };
}
