import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { DeckController, SlideInfo } from "../deck/controller";
import { m } from "../paraglide/messages.js";
import type { ThemeChoice } from "../shell/theme";
import type { Notice } from "../shell/useDocument";
import type { View } from "../shell/view";
import { PEN_COLORS, resolvePenColor, type PenColor } from "./AnnotationToolbar";
import { boardAddress, boardKey, sectionOf } from "./board";
import { markColorOf } from "./mirrorTypes";
import { notePenOn, stylusDraws, subscribePenInUse } from "./stylus";
import type { AnnotationLayer, AnnotationMode } from "./types";
import { useAnnotationShortcuts } from "./useAnnotationShortcuts";

/** Set once the first pen has been told that fingers now change slides. */
const STYLUS_NOTICE_KEY = "docwalk.stylusNoticeSeen";

/**
 * The pen, laser and whiteboard over the slides: the chosen tool and colour,
 * the board's state, the first-pen notice and the annotation keys. The layer
 * itself is made by `useSavedMarksLayer` once the document's saved marks are
 * known; it lives in `layerRef`, and `layerReady` counts each time it is set up.
 */
export function useAnnotationLayer({
  follow,
  controller,
  view,
  theme,
  slides,
  sketchOpen,
  deckRef,
  setNotice,
}: {
  follow: boolean;
  controller: DeckController | null;
  view: View;
  theme: ThemeChoice;
  slides: SlideInfo[];
  /** A sketch owns its keys (P, A, E are Excalidraw tools too). */
  sketchOpen: boolean;
  deckRef: RefObject<HTMLDivElement | null>;
  setNotice: (notice: Notice | null) => void;
}) {
  const layerRef = useRef<AnnotationLayer | null>(null);
  const [mode, setMode] = useState<AnnotationMode>("off");
  // The page the open whiteboard covers (decision 110), from the layer's events; `told` keeps
  // the status silent until the first open and then says "closed" once it is.
  const [boardState, setBoardState] = useState<{ page: string | null; told: boolean }>({
    page: null,
    told: false,
  });
  const boardPage = boardState.page;
  const [penColor, setPenColor] = useState<PenColor>(PEN_COLORS[0].variable);
  // Said in a polite status in the deck pane when the whiteboard opens or closes (decision 110).
  const boardTitle = boardPage
    ? (slides.find((sl) => sl.sectionId === sectionOf(boardPage))?.title ?? sectionOf(boardPage))
    : "";
  const boardStatus = boardPage
    ? m.board_opened({ title: boardTitle })
    : boardState.told
      ? m.board_closed()
      : "";

  // The first pen on the stage (decision 110): fingers now change slides, and the viewer is told
  // once per browser, and where to change it.
  useEffect(() => {
    if (follow || !controller) return;
    return notePenOn(controller.stage());
  }, [follow, controller]);
  useEffect(() => {
    if (follow) return;
    let stop: (() => void) | undefined;
    const unsubscribe = subscribePenInUse(() => {
      if (!stylusDraws()) return;
      try {
        if (localStorage.getItem(STYLUS_NOTICE_KEY) === "true") return;
        localStorage.setItem(STYLUS_NOTICE_KEY, "true");
      } catch {
        // Without storage the notice shows once per visit, since the latch sets once.
      }
      // Not while the pen is down: the notice moves the page, and a tap that began on a link
      // would end on something else. The click of this touch comes before the timeout.
      const lifted = () => {
        stop?.();
        window.setTimeout(() => setNotice({ message: m.stylus_notice(), tone: "info" }), 0);
      };
      window.addEventListener("pointerup", lifted, true);
      window.addEventListener("pointercancel", lifted, true);
      stop = () => {
        window.removeEventListener("pointerup", lifted, true);
        window.removeEventListener("pointercancel", lifted, true);
      };
    });
    return () => {
      unsubscribe();
      stop?.();
    };
  }, [follow, setNotice]);

  // Set when the annotation layer is up (in useSavedMarksLayer, once the saved marks it draws are known).
  const [layerReady, setLayerReady] = useState(0);
  useEffect(
    () => () => {
      layerRef.current?.destroy();
      layerRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (layerReady) layerRef.current?.setMode(mode);
  }, [mode, layerReady]);
  // The pen colour is a CSS variable whose value changes with the theme, so
  // `theme` re-resolves it even though the body does not read it.
  useEffect(() => {
    if (layerReady) {
      layerRef.current?.setColor(resolvePenColor(penColor), markColorOf(penColor) ?? undefined);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [penColor, theme, layerReady]);
  // The whiteboard of the section on screen (decision 110). The layer is the source of truth:
  // it opens and closes, and the `board` events it sends set `boardState`.
  const toggleBoard = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (layer.board()) {
      layer.setBoard(null);
      return;
    }
    const section = controller?.current()?.sectionId;
    if (!section) return;
    layer.setBoard({ key: boardKey(section), address: boardAddress(section) });
    // The first touch should draw: with no drawing tool chosen, the pen is.
    if (layer.board()) setMode((chosen) => (chosen === "off" ? "pen" : chosen));
  }, [controller]);
  // The deck pane is hidden in the document view; a board there would be open on nothing.
  useEffect(() => {
    if (view === "document") layerRef.current?.setBoard(null);
  }, [view]);
  useAnnotationShortcuts(
    {
      mode,
      setMode,
      undo: () => layerRef.current?.undo(),
      redo: () => layerRef.current?.redo(),
      board: { open: boardPage !== null, toggle: toggleBoard },
    },
    // Presenting, the keys work anywhere. In the edit view the toolbar is on screen
    // too, so they work while focus is in the deck pane (the slide or the toolbar).
    // A sketch owns its keys (P, A, E are Excalidraw tools too).
    !follow && !sketchOpen,
    view === "present" ? undefined : deckRef,
  );

  return {
    layerRef,
    mode,
    setMode,
    penColor,
    setPenColor,
    boardPage,
    boardStatus,
    setBoardState,
    layerReady,
    setLayerReady,
    toggleBoard,
  };
}
