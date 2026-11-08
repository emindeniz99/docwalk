import type { HeadingDepth } from "../sectioning/sectionize";

/**
 * Contract for URL state (decision 21). The hash carries the slide address
 * so a link can open a deck on a given slide; a GitHub heading anchor
 * (`#failure-handling`) opens that section's first slide.
 *
 *   #failure-handling/2   -> section "failure-handling", page 2
 *   #failure-handling     -> its first page
 *   (no hash)             -> first slide
 *
 * The query string carries viewer settings that are not in the document:
 *   ?level=auto|1|2|3|1,3   slide level override (decision 20)
 *   ?view=edit|document|present|presenter
 *   ?sections=<id>,<id>     the sections to present (decision 100)
 */

export interface ViewerUrlState {
  /** Canonical `<section-id>/<page>`; a bare anchor parses as page 1. */
  address: string | null;
  /** A list has two or more levels, sorted and without duplicates. */
  level: "auto" | HeadingDepth | HeadingDepth[] | null;
  view: "edit" | "document" | "present" | "presenter" | null;
  /** Section ids to present, without repeats; `null` presents every section. */
  sections: string[] | null;
}
