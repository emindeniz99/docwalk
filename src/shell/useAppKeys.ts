import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DeckController } from "../deck/controller";
import { useOverviewShortcut } from "../deck/useOverviewShortcut";
import type { View } from "./view";

/**
 * The app's own keys: O for the slide overview, Mod+K for the command
 * palette, and Escape out of present mode. The annotation keys live in
 * useAnnotationShortcuts.
 */
export function useAppKeys({
  follow,
  controller,
  view,
  deckRef,
  openOverview,
  setPaletteOpen,
  show,
}: {
  follow: boolean;
  controller: DeckController | null;
  view: View;
  deckRef: RefObject<HTMLDivElement | null>;
  openOverview: () => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  show: (next: View | ((v: View) => View)) => void;
}) {
  // O opens the slide overview: anywhere while presenting, from the deck pane while editing.
  useOverviewShortcut(
    openOverview,
    !follow && controller !== null && view !== "document",
    view === "present" ? undefined : deckRef,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!follow && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Without fullscreen (refused on iOS, in iframes, or headless) Escape is
      // the only way out of present mode, so handle it here too. The pen and
      // laser claim Escape first while a tool is active.
      // reveal marks Escape as handled (its binding is a no-op), so do not test defaultPrevented here.
      if (e.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else show((v) => (v === "present" ? "edit" : v));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, follow, setPaletteOpen]);
}
