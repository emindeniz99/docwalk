import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { penInUse, useStylusDraws } from "../annotate/stylus";
import { slideOwner, type PointerKind } from "../annotate/stylusPolicy";
import type { AnnotationLayer, AnnotationMode } from "../annotate/types";
import type { MapHandle } from "../map/MapView";
import { usePresentChrome, usePresentFrame } from "./presentChrome";
import type { View } from "./view";
import { useWakeLock } from "./wakeLock";

const pointerKind = (type: string): PointerKind =>
  type === "pen" || type === "touch" ? type : "mouse";

/**
 * Presenting: the stage's frame and chrome, the screen kept awake, entering
 * present mode in fullscreen, and leaving it when fullscreen ends. The map is
 * presented the same way (decision 154): the map view in fullscreen, with no
 * view of its own, so the link and the room's state keep saying map.
 */
export function usePresenting({
  view,
  follow,
  followOpen,
  mode,
  deckRef,
  layerRef,
  mapRef,
  mapLaser,
  setMapLaser,
  show,
}: {
  view: View;
  follow: boolean;
  /** A follow screen whose slide can be trusted (see useRemoteRoom). */
  followOpen: boolean;
  mode: AnnotationMode;
  deckRef: RefObject<HTMLDivElement | null>;
  layerRef: RefObject<AnnotationLayer | null>;
  mapRef: RefObject<MapHandle | null>;
  /** The map's laser, which an Escape it was waiting for switches off (decision 154). */
  mapLaser: boolean;
  setMapLaser: (on: boolean) => void;
  show: (next: View | ((v: View) => View)) => void;
}) {
  // Presenting, and on a follow screen (decision 113), the slide fills the
  // screen unless the viewer chose the card frame (decision 77).
  const frame = usePresentFrame();
  const presenting = view === "present" && !follow;
  const staged = presenting || follow;
  const fill = staged && frame === "fill";
  // The map is presented only while it shows, and never on a follow screen (decision 154).
  const [mapPresented, setMapPresented] = useState(false);
  if (mapPresented && (view !== "map" || follow)) setMapPresented(false);
  // The screen stays on while presenting (decision 80), the map too.
  useWakeLock(view === "present" || mapPresented);
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
  const goFullscreen = useCallback(async () => {
    fullscreenLeft.current = false;
    try {
      // The whole page goes fullscreen, not just the deck or the map: dialogs such as the
      // command palette render outside them and would be invisible.
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen can be refused (iOS, iframes); present mode still fills the window.
    }
  }, []);
  const present = useCallback(async () => {
    show("present");
    await goFullscreen();
    deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
  }, [show, goFullscreen, deckRef]);

  // The Exit button leaves for good, so the laser has no say in that exit (see onFullscreen).
  const exitedByButton = useRef(false);
  const presentMap = useCallback(async () => {
    exitedByButton.current = false;
    setMapPresented(true);
    await goFullscreen();
    mapRef.current?.focus();
  }, [goFullscreen, mapRef]);
  const leaveMap = useCallback(() => setMapPresented(false), []);
  const exitMap = useCallback(() => {
    // The button unmounts into "Present the map"; keep focus on the map, as Escape does.
    mapRef.current?.focus();
    if (document.fullscreenElement) {
      exitedByButton.current = true;
      void document.exitFullscreen();
    } else leaveMap();
  }, [mapRef, leaveMap]);

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
      // And the map's laser (decision 149): it goes off, and the map stays presented, windowed.
      const byButton = exitedByButton.current;
      exitedByButton.current = false;
      if (mapPresented && mapLaser && !byButton) {
        setMapLaser(false);
        return;
      }
      show((v) => (v === "present" ? "edit" : v));
      leaveMap();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [show, layerRef, mapPresented, mapLaser, setMapLaser, leaveMap]);

  return { frame, staged, fill, chrome, present, mapPresented, presentMap, exitMap, leaveMap };
}
