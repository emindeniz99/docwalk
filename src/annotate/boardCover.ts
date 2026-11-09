/**
 * Keep the keyboard off the page a whiteboard covers (decision 110). The
 * board is a paper element over the slide box; the page underneath stays in
 * the DOM and its links stay tabbable, so Tab would land on something nobody
 * can see (WCAG 2.4.11).
 *
 * reveal.js marks every slide but the current one `inert`, so the cover
 * touches the current page only, and the undo puts back only what the cover
 * set: a page that was inert already stays inert, and a page that stopped
 * being current meanwhile belongs to reveal.js again.
 */

/**
 * Make the current page of `stage` (reveal.js's `.slides`) inert. Focus that
 * sits inside the page moves to the closest `.reveal`, so keys keep working.
 * Returns the undo.
 */
export function coverPage(stage: HTMLElement): () => void {
  const page = stage.querySelector<HTMLElement>(":scope > section.present");
  if (!page) return () => {};
  const active = document.activeElement;
  if (active instanceof HTMLElement && page.contains(active)) {
    stage.closest<HTMLElement>(".reveal")?.focus({ preventScroll: true });
  }
  if (page.inert) return () => {};
  page.inert = true;
  return () => {
    if (page.classList.contains("present")) page.inert = false;
  };
}
