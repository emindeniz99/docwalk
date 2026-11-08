import type { FocusMirror, MirrorStore } from "../annotate/mirrorStore";
import type { DeckController } from "./controller";
import { openMirroredFocus, type MirroredFocus } from "./focus";
import { findBlock } from "./focusTargets";

/**
 * A follower's side of the mirrored focus view (decisions 88 and 106): it
 * opens the view the presenter opened, on this deck's own copy of the block
 * the presenter named by kind and place, follows its zoom, scroll and marked
 * lines, and closes it with the presenter.
 *
 * When this deck has no such block on the page with the presenter's address
 * (another pagination), the image is not loaded here, or the follower shows
 * another page, nothing opens and nothing is said; the next change of slide
 * or focus op tries again. A view the follower closes itself stays closed
 * until the presenter opens another; one that a rebuild or a change of slide
 * closed opens again when the follower is back.
 */
export function followFocus(controller: DeckController, store: MirrorStore): () => void {
  let handle: MirroredFocus | null = null;
  let shown: string | null = null;
  let dismissed: string | null = null;
  // What the open view was last given; the store hands out a new object for each change.
  let view: FocusMirror["view"] | undefined;
  let lines: FocusMirror["lines"] | undefined;

  const shut = () => {
    const was = handle;
    handle = null;
    shown = null;
    was?.close();
  };

  const apply = () => {
    const focus = store.focus;
    if (!focus) {
      dismissed = null;
      shut();
      return;
    }
    const key = `${focus.block} ${focus.n} ${focus.slide}`;
    if (!handle || shown !== key) {
      if (dismissed === key) return;
      shut();
      // Not on that slide yet: the next slide change tries again.
      if (controller.current()?.address !== focus.slide) return;
      const block = findBlock(controller.stage(), focus);
      if (!block) return;
      const next = openMirroredFocus(block, focus.block, (byViewer) => {
        if (handle !== next) return;
        handle = null;
        shown = null;
        if (byViewer) dismissed = key;
      });
      if (!next) return;
      handle = next;
      shown = key;
      view = undefined;
      lines = undefined;
    }
    // The laser and the marks change the store too; only a new view or list moves the copy.
    if (focus.view !== view) {
      view = focus.view;
      handle.setView(focus.view);
    }
    if (focus.lines !== lines) {
      lines = focus.lines;
      handle.setLines(focus.lines);
    }
  };

  apply();
  const off = store.subscribe(apply);
  const stop = controller.onChange(apply);
  return () => {
    off();
    stop();
    shut();
  };
}
