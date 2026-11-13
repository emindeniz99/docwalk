import { useCallback, useMemo } from "react";
import { BOARD_TEXT, boardAddress } from "../annotate/board";
import { slideFingerprint } from "../annotate/markKeys";
import type { DocumentMarks } from "../annotate/savedMarks";
import { clonePages, type DeckController } from "../deck/controller";
import { SLIDE_SIZE } from "../deck/Deck";
import { speakerNotes } from "../sectioning/notes";
import type { SectionPlan } from "../sectioning/sectionize";
import { withBoardPages } from "./boardPages";
import type { ExportOptions } from "./types";

/**
 * What the export menu works from. The exporters work from the paginated pages the audience
 * sees, as copies they may change. Each slide takes the saved marks drawn on its present text
 * (decision 105), unless left out. A section's speaker notes go on its last slide (decision
 * 114), for the print that asks. They come from the whole plan: a choice of sections (decision
 * 100) cuts the pages, and the comment above the first heading stays with the cover whatever
 * is chosen (decision 107).
 */
export function useExportOptions({
  controller,
  plan,
  chosen,
  docTitle,
  savedMarks,
}: {
  controller: DeckController | null;
  plan: SectionPlan;
  /** The sections chosen to present (decision 100). */
  chosen: ReadonlySet<string>;
  docTitle: string;
  savedMarks: DocumentMarks | null;
}) {
  const notes = useMemo(() => speakerNotes(plan), [plan]);
  const chosenNotes = [...notes.keys()].some((id) => chosen.has(id));
  const getExportOptions = useCallback(
    (withMarks: boolean, withNotes: boolean): ExportOptions | null => {
      if (!controller) return null;
      const pages = clonePages(controller);
      const exported = pages.map(({ info, element }, index) => {
        const marks = withMarks
          ? (savedMarks?.strokes(info.address, slideFingerprint(element)) ?? [])
          : [];
        const isLast = pages[index + 1]?.info.sectionId !== info.sectionId;
        const sectionNotes = withNotes && isLast ? notes.get(info.sectionId) : undefined;
        return {
          address: info.address,
          title: info.title,
          element,
          ...(marks.length > 0 ? { marks } : {}),
          ...(sectionNotes ? { notes: [...sectionNotes] } : {}),
        };
      });
      return {
        title: docTitle,
        size: SLIDE_SIZE,
        // A section's whiteboard follows its last page when it has marks and marks are wanted (decision 110).
        slides: withMarks
          ? withBoardPages(
              exported,
              (id) => savedMarks?.strokes(boardAddress(id), BOARD_TEXT) ?? [],
            )
          : exported,
      };
    },
    [controller, docTitle, savedMarks, notes],
  );
  return { chosenNotes, getExportOptions };
}
