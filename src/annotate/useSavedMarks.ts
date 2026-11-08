import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { m } from "../paraglide/messages.js";
import type { Notice } from "../shell/useDocument";
import { openMarksStore } from "./marksStore";
import { DocumentMarks, loadMarks, memoryMarksStore, type MarksProblem } from "./savedMarks";

const PROBLEM: Record<MarksProblem, () => string> = {
  full: m.marks_save_full,
  failed: m.marks_save_failed,
};

const noSubscription = () => () => {};

export interface SavedMarksApi {
  /**
   * The open document's saved marks; null while its identity or its marks
   * load, so nothing drawn then is saved under another document's key.
   */
  marks: DocumentMarks | null;
  /** Slides with saved marks: the export option and the delete command show while it is above 0. */
  count: number;
}

/**
 * The saved marks of the open document (decision 105), keyed by the
 * identity comments compute (decision 65). A follower screen saves nothing:
 * with `enabled` false the marks live in memory only.
 */
export function useSavedMarks({
  documentKey,
  enabled,
  setNotice,
}: {
  documentKey: string | null;
  enabled: boolean;
  setNotice: (notice: Notice | null) => void;
}): SavedMarksApi {
  const [store] = useState(() => (enabled ? openMarksStore() : null));
  const [unsaved] = useState(() => new DocumentMarks("", [], memoryMarksStore(), () => {}));
  const [loaded, setLoaded] = useState<DocumentMarks | null>(null);
  const notify = useRef(setNotice);
  useEffect(() => {
    notify.current = setNotice;
  });

  const onProblem = useCallback((problem: MarksProblem) => {
    notify.current({ message: PROBLEM[problem](), tone: "error" });
  }, []);

  useEffect(() => {
    // A key that goes away and comes back the same (a file reloaded from disk) keeps its marks.
    if (!store || documentKey === null || loaded?.doc === documentKey) return;
    let live = true;
    void store
      .then((s) => loadMarks(s, documentKey, onProblem))
      .then((next) => {
        if (live) setLoaded(next);
      });
    return () => {
      live = false;
    };
  }, [store, documentKey, loaded, onProblem]);

  const marks = !enabled ? unsaved : loaded?.doc === documentKey ? loaded : null;
  const subscribe = useCallback(
    (onChange: () => void) => (marks ? marks.subscribe(onChange) : noSubscription()),
    [marks],
  );
  const count = useSyncExternalStore(subscribe, () => marks?.size ?? 0);
  return { marks, count };
}
