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
 */

export interface ViewerUrlState {
  address: string | null;
  level: "auto" | number | number[] | null;
  view: "edit" | "document" | "present" | "presenter" | null;
}
