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
 *
 * reveal.js also clears `inert` on the current page whenever it is asked for
 * a slide, the one on screen too, and then fires no `slidechanged` that
 * would close the board (reveal.js 6.0.2 has no event after that update).
 * So while the cover holds, a page that is still current and loses `inert`
 * gets it back.
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
  const keep = new MutationObserver(() => {
    if (!page.inert && page.classList.contains("present")) page.inert = true;
  });
  keep.observe(page, { attributes: true, attributeFilter: ["inert"] });
  return () => {
    keep.disconnect();
    if (page.classList.contains("present")) page.inert = false;
  };
}
