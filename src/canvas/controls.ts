/**
 * Names for two Excalidraw 0.18.1 controls that fail axe (decision 98):
 * the main menu button has no name (button-name), and the zoom button's
 * title ("Reset zoom") does not contain the percentage it shows
 * (label-content-name-mismatch). Excalidraw offers no prop for either, so
 * the labels are set on its elements and kept current as it re-renders.
 */

const MENU = ".main-menu-trigger";
const ZOOM = ".reset-zoom-button";

function setLabel(element: Element, label: string): void {
  if (label && element.getAttribute("aria-label") !== label) {
    element.setAttribute("aria-label", label);
  }
}

/** Applies the names to what is in `root` now. */
export function nameExcalidrawControls(root: ParentNode, menuLabel: string): void {
  for (const menu of root.querySelectorAll(MENU)) setLabel(menu, menuLabel);
  for (const zoom of root.querySelectorAll(ZOOM)) {
    // Excalidraw's own title, translated, then what the button reads.
    const title = zoom.getAttribute("title") ?? "";
    const shown = zoom.textContent?.trim() ?? "";
    setLabel(zoom, title.includes(shown) ? title : `${title} ${shown}`.trim());
  }
}

/**
 * Names the controls now and again whenever Excalidraw changes them. The
 * observer writes only `aria-label`, which it does not watch, so it cannot
 * trigger itself. Returns the stop function.
 */
export function keepExcalidrawControlsNamed(root: HTMLElement, menuLabel: string): () => void {
  nameExcalidrawControls(root, menuLabel);
  const observer = new MutationObserver(() => nameExcalidrawControls(root, menuLabel));
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title"],
  });
  return () => observer.disconnect();
}
