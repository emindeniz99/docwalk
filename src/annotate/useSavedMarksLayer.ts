import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { useCommentsUi } from "../comments/useCommentsUi";
import type { DeckController } from "../deck/controller";
import { m } from "../paraglide/messages.js";
import type { Notice } from "../shell/useDocument";
import { useLazyDialog } from "../shell/useLazyDialog";
import { BOARD_TEXT, boardKey, isBoardAddress, sectionOf } from "./board";
import { markKeys, slideFingerprints } from "./markKeys";
import type { MirrorFeed } from "./mirrorFeed";
import { marksSaver } from "./savedMarks";
import { penInUse, stylusDraws, subscribePenInUse, subscribeStylusDraws } from "./stylus";
import type { AnnotationLayer } from "./types";
import { useSavedMarks } from "./useSavedMarks";

/** What the layer asks of the stylus setting and latch (decision 110). */
const STYLUS_INPUT = {
  stylusDraws,
  penInUse,
  subscribe: (listener: () => void) => {
    const stopSetting = subscribeStylusDraws(listener);
    const stopLatch = subscribePenInUse(listener);
    return () => {
      stopSetting();
      stopLatch();
    };
  },
};

/**
 * Pen and arrow marks saved per document and slide (decision 105), under the
 * comments' identity, and the annotation layer that draws them over the deck;
 * also the "Delete saved marks" dialog and action.
 */
export function useSavedMarksLayer({
  comments,
  follow,
  controller,
  mirrorFeed,
  layerRef,
  setBoardState,
  setLayerReady,
  setNotice,
}: {
  comments: Pick<
    ReturnType<typeof useCommentsUi>,
    "documentKey" | "documentLegacyKey" | "documentUnidentified"
  >;
  follow: boolean;
  controller: DeckController | null;
  mirrorFeed: MirrorFeed;
  layerRef: RefObject<AnnotationLayer | null>;
  setBoardState: Dispatch<SetStateAction<{ page: string | null; told: boolean }>>;
  setLayerReady: Dispatch<SetStateAction<number>>;
  setNotice: (notice: Notice | null) => void;
}) {
  const saved = useSavedMarks({
    documentKey: comments.documentKey,
    legacyKey: comments.documentLegacyKey,
    unidentified: comments.documentUnidentified,
    enabled: !follow,
    setNotice,
  });
  const { marks: savedMarks } = saved;

  // Pen and laser over the slides; each slide keeps its own marks while the deck is open, and
  // its saved marks come back on its first visit. The layer (drauu, perfect-freehand) loads
  // after the deck and the document's saved marks are up, outside the first-load bundle.
  // A rebuild (an edit, an agent write, a disk reload, a language switch) brings a new stage:
  // the layer moves onto it, and only slides whose text changed lose their marks. Another
  // document brings other saved marks: the layer starts again from those.
  /** The saved marks the current layer was made for. */
  const layerMarks = useRef<typeof savedMarks>(null);
  const fingerprints = useRef(new Map<string, string>());
  useEffect(() => {
    if (!controller || !savedMarks) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("./layer").then(({ createAnnotationLayer }) => {
      if (cancelled) return;
      if (layerRef.current && layerMarks.current !== savedMarks) {
        // Receivers hear the board close before the layer goes.
        layerRef.current.setBoard(null);
        layerRef.current.destroy();
        layerRef.current = null;
      }
      let layer = layerRef.current;
      if (!layer) {
        layer = createAnnotationLayer(controller.stage(), {
          saved: (key, address) => savedMarks.forKey(key, address),
          input: STYLUS_INPUT,
        });
        // What it draws goes to the mirror (decision 88) and into the saved marks (decision
        // 105). It keeps its observers across rebuilds, so this runs once per document.
        layer.observe((event) => mirrorFeed.ingest(event));
        layer.observe((event) => {
          if (event.kind === "board") setBoardState({ page: event.slide, told: true });
        });
        layer.observe(
          marksSaver(
            () => savedMarks,
            // A board's text is "no text", so it outlives edits to its section (decision 110).
            (address) => (isBoardAddress(address) ? BOARD_TEXT : fingerprints.current.get(address)),
          ),
        );
        layerMarks.current = savedMarks;
      }
      const shown = layer;
      shown.moveTo(controller.stage());
      layerRef.current = shown;
      fingerprints.current = slideFingerprints(controller.stage());
      const keys = markKeys(controller.stage());
      stop = controller.onChange((sl) =>
        shown.setKey(keys.get(sl.address) ?? sl.address, sl.address),
      );
      // Every present section's whiteboard stays too, though no slide key names it.
      const boardSections = new Set([...keys.keys()].map(sectionOf));
      shown.retain([...keys.values(), ...[...boardSections].map(boardKey)]);
      setLayerReady((n) => n + 1);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [controller, mirrorFeed, savedMarks, layerRef, setBoardState, setLayerReady]);

  // "Delete saved marks": the records, then every slide's marks and their undo history.
  const clearMarks = useLazyDialog();
  const deleteSavedMarks = useCallback(() => {
    if (!savedMarks) return;
    layerRef.current?.retain([]);
    layerRef.current?.clear();
    void savedMarks.clear().then((done) => {
      if (done) setNotice({ message: m.marks_cleared(), tone: "info" });
    });
  }, [savedMarks, setNotice, layerRef]);

  return { saved, savedMarks, clearMarks, deleteSavedMarks };
}
