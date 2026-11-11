import { openBlockFocus, openDiagramFocus } from "./focus";
import { FOCUS_ATTR, markFocusTarget } from "./focusTargets";

const nothing = (): void => undefined;

/**
 * An image that finishes loading later (a click on its placeholder, a slow host) becomes a
 * target then; `load` does not bubble, so the listener runs while it travels down.
 */
function onImageLoad(event: Event): void {
  if (event.target instanceof HTMLImageElement) markFocusTarget(event.target);
}

/**
 * The gestures that open the focus views from the blocks under `root`: a
 * click or Enter on a diagram, a code block, a table or a loaded image
 * (decision 87). The deck and the document view both use it (decision 129).
 * A link on the page (`#…`) is the caller's to follow, and opens nothing
 * here. The caller marks the blocks once they are drawn; an image that loads
 * later is marked as it loads.
 *
 * `close` closes a view opened from `root`, if it is still open; `stop`
 * removes the listeners.
 */
export function wireFocusTargets(root: HTMLElement): { close(): void; stop(): void } {
  let closeOpened = nothing;
  const onClick = (event: Event) => {
    const target = event.target as Element;
    if (target.closest('a[href^="#"]')) return;
    const diagram = target.closest<HTMLElement>(".docwalk-diagram");
    if (diagram) {
      closeOpened = openDiagramFocus(diagram);
      return;
    }
    // A code block, table or loaded image (decision 87). A link inside it is followed, and
    // a click that ends a text selection is not a request to open anything.
    const block = target.closest<HTMLElement>(`[${FOCUS_ATTR}]`);
    if (!block || target.closest("a")) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(block, true)) return;
    closeOpened = openBlockFocus(block);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
    // Only the block itself: Enter on a link inside a table follows the link.
    const block = event.target instanceof HTMLElement && event.target.hasAttribute(FOCUS_ATTR);
    if (!diagram && !block) return;
    // Otherwise the key's default action clicks the Close button the view has just focused.
    event.preventDefault();
    closeOpened = diagram ? openDiagramFocus(diagram) : openBlockFocus(event.target as HTMLElement);
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  root.addEventListener("load", onImageLoad, true);
  return {
    close: () => closeOpened(),
    stop() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("load", onImageLoad, true);
    },
  };
}
