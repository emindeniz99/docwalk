/**
 * Exports (decision 9). All three work from the rendered, paginated slides
 * (the same pages the audience sees), entirely in the browser.
 *
 * - PDF: the browser's print dialog with print CSS, one 16:9 slide per page.
 * - HTML: one self-contained file (styles inlined, diagrams as inline SVG,
 *   no scripts, no remote requests) that opens offline and prints well.
 * - PNG: one image per slide, zipped only if the browser lacks multi-file
 *   download; otherwise sequential downloads.
 *
 * All three draw a slide's saved marks over it when the slide carries them.
 * Speaker notes reach one view only: the print view that asks for them.
 */

import type { SavedStroke } from "../annotate/savedMarks";

export interface ExportSlide {
  address: string;
  title: string;
  /** The rendered slide element (a clone the exporter may mutate). */
  element: HTMLElement;
  /** The slide's saved marks (decision 105), drawn over the page. */
  marks?: readonly SavedStroke[];
  /**
   * The section's speaker notes (decision 79) as plain strings, set on the
   * section's last page only. Only the print view with notes prints them
   * (decision 114); the HTML file and the PNGs never carry them.
   */
  notes?: readonly string[];
}

export interface ExportOptions {
  title: string;
  slides: ExportSlide[];
  /** Slide size in CSS px (the deck's 1280x720). */
  size: { width: number; height: number };
}
