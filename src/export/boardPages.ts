import { boardAddress, sectionOf } from "../annotate/board";
import type { SavedStroke } from "../annotate/savedMarks";
import { m } from "../paraglide/messages.js";
import type { ExportSlide } from "./types";

/**
 * A section's whiteboard as one more export page (decision 110): blank paper
 * in the slide's colour, titled "Whiteboard: <section title>", with the
 * board's saved marks over it. It is a slide to the exporters, so the print
 * view, the HTML file and the PNGs name and number it as they do any page.
 *
 * Kept apart from pages.ts, which brings in the sanitizer: App builds these
 * slides and loads the exporters only when one is asked for (decision 43).
 */
export function boardSlide(
  sectionId: string,
  sectionTitle: string,
  marks: readonly SavedStroke[],
): ExportSlide {
  const title = m.board_page_title({ title: sectionTitle });
  const paper = document.createElement("section");
  paper.className = "docwalk-slide docwalk-export-board";
  paper.setAttribute("aria-label", title);
  return { address: boardAddress(sectionId), title, element: paper, marks };
}

/**
 * `slides` with each section's whiteboard after the section's last page, for
 * the sections whose board has saved marks (`boardMarks` gives them). A
 * section's title is the one its pages carry.
 */
export function withBoardPages(
  slides: readonly ExportSlide[],
  boardMarks: (sectionId: string) => readonly SavedStroke[],
): ExportSlide[] {
  const result: ExportSlide[] = [];
  slides.forEach((slide, i) => {
    result.push(slide);
    const id = sectionOf(slide.address);
    if (i + 1 < slides.length && sectionOf(slides[i + 1]!.address) === id) return;
    const marks = boardMarks(id);
    if (marks.length > 0) result.push(boardSlide(id, slide.title, marks));
  });
  return result;
}
