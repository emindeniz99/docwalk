import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DeckController, SlideInfo } from "../deck/controller";
import type { Locale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import type { SectionPlan } from "../sectioning/sectionize";
import type { View } from "../shell/view";
import type { EditorDiagnostic } from "./types";

/**
 * Between the editor and the deck: slide notes as editor diagnostics, and the
 * preview following the editor's cursor.
 */
export function useEditorSync({
  controller,
  plan,
  slides,
  sectionLines,
  view,
  locale,
}: {
  controller: DeckController | null;
  plan: SectionPlan;
  slides: SlideInfo[];
  sectionLines: Map<string, number>;
  view: View;
  locale: Locale;
}) {
  // Notes on slides become editor diagnostics at their section's source line.
  // Until the deck rebuilds, its slides are those of the text before the last
  // edit: a slide whose section the edit removed has no line, and its note
  // waits for the rebuild instead of landing on line 1.
  const diagnostics = useMemo<EditorDiagnostic[]>(
    () =>
      slides.flatMap((sl) => {
        const line = sectionLines.get(sl.sectionId);
        if (!sl.flagged || line === undefined) return [];
        const note = sl.note ?? m.app_slide_has_note();
        return [
          {
            line,
            message: m.app_slide_diagnostic(
              { number: sl.index + 1, address: sl.address, note },
              { locale },
            ),
            severity: "warning" as const,
          },
        ];
      }),
    [slides, sectionLines, locale],
  );

  // The preview follows the cursor while editing. The editor reports a line
  // only when it changes, and a heading just typed is not a section until the
  // edit has been paginated and the deck rebuilt: the last line is matched
  // again then, and followed if its section is not the one followed last
  // (so a level switch or a write elsewhere leaves a browsed preview alone).
  const cursor = useRef<{ line: number; section: string | null } | null>(null);
  const followCursor = useCallback(
    (moved: boolean) => {
      const at = cursor.current;
      if (!controller || !at) return;
      let target: string | null = null;
      for (const sec of plan.sections) if (sec.line <= at.line) target = sec.id;
      if (!target || (!moved && target === at.section)) return;
      if (controller.current()?.sectionId === target || controller.goTo(target)) {
        at.section = target;
      }
    },
    [controller, plan],
  );
  const onCursorLine = useCallback(
    (line: number) => {
      cursor.current = { line, section: cursor.current?.section ?? null };
      followCursor(true);
    },
    [followCursor],
  );
  useEffect(() => {
    if (view === "edit") followCursor(false);
    // The editor remounts on return to Edit and reports its line again.
    else cursor.current = null;
  }, [view, followCursor]);

  return { diagnostics, onCursorLine };
}
