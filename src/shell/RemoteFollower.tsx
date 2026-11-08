import { useEffect, useRef, useState } from "react";
import { MirrorStore } from "../annotate/mirrorStore";
import { attachMirror } from "../annotate/mirrorView";
import type { DeckController } from "../deck/controller";
import { openMirroredDiagram, type MirroredFocus } from "../deck/focus";
import { slideAddress } from "../deck/pages";
import type { RemoteStatus } from "../remote/client";
import { parseJoinFragment } from "../remote/crypto";
import {
  followedDocument,
  NO_DOC_LINK,
  useRemoteFollower,
  type FollowState,
} from "../remote/follower";

export interface FollowUpdate {
  status: RemoteStatus;
  state: FollowState | null;
  /** The page's `#room=..&v=..&p=..` fragment is missing, malformed or lacks the view or state key. */
  incomplete: boolean;
}

/** The `n`-th diagram (from 1) of the page with address `slide` in the deck's stage, if there is one. */
function findDiagram(stage: HTMLElement, slide: string, n: number): HTMLElement | null {
  for (const page of stage.querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")) {
    if (slideAddress(page) === slide) {
      return page.querySelectorAll<HTMLElement>(".docwalk-diagram")[n - 1] ?? null;
    }
  }
  return null;
}

/**
 * Draws the presenter's laser and marks over the follower's slide, and opens
 * and closes the diagram focus view when the presenter does (decision 88).
 * Marks show only on a page with the presenter's address, so a section that
 * this screen paginated differently never shows them on the wrong page.
 */
function useMirrorOverlay(controller: DeckController | null, store: MirrorStore) {
  useEffect(() => {
    if (!controller) return;
    const view = attachMirror(
      controller.stage(),
      store,
      () => controller.current()?.address ?? null,
    );
    const stop = controller.onChange(() => view.refresh());
    return () => {
      stop();
      view.destroy();
    };
  }, [controller, store]);

  useEffect(() => {
    if (!controller) return;
    let handle: MirroredFocus | null = null;
    let shown: string | null = null;
    // A view the follower closed itself stays closed until the presenter opens another.
    let dismissed: string | null = null;

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
      const key = `${focus.slide}#${focus.diagram}`;
      if (handle && shown === key) {
        handle.setView(focus.view);
        return;
      }
      if (dismissed === key) return;
      shut();
      // Not on that slide yet: the next slide change tries again.
      if (controller.current()?.address !== focus.slide) return;
      const diagram = findDiagram(controller.stage(), focus.slide, focus.diagram);
      if (!diagram) return;
      const next: MirroredFocus | null = openMirroredDiagram(diagram, () => {
        if (handle !== next) return;
        handle = null;
        shown = null;
        dismissed = key;
      });
      if (!next) return;
      handle = next;
      shown = key;
      next.setView(focus.view);
    };

    apply();
    const off = store.subscribe(apply);
    const stop = controller.onChange(apply);
    return () => {
      off();
      stop();
      shut();
    };
  }, [controller, store]);
}

/**
 * A follower screen's connection (`?view=follow#room=..&v=..&p=..`), loaded only
 * on follower pages. It renders nothing: it follows the presenter's slide
 * once the deck exists, reports the room's state to App, and hands App each
 * new document the presenter announces. It also shows what the presenter
 * mirrors: the laser, pen marks and the diagram focus view (decision 88).
 */
export function RemoteFollower({
  controller,
  onUpdate,
  onDocument,
}: {
  controller: DeckController | null;
  onUpdate: (update: FollowUpdate) => void;
  /**
   * Called once per document the presenter announces (its first, an edit, a
   * newly opened one) with the link to load, or null when the presenter has
   * none to send. Not called while the presenter is still building its link.
   */
  onDocument: (link: string | null) => void;
}) {
  // Read once: URL sync may rewrite the address bar, and the room must not change with it.
  const [creds] = useState(() => parseJoinFragment(location.hash));
  const [store] = useState(() => new MirrorStore());
  const { status, state } = useRemoteFollower({
    creds,
    controller,
    onMirror: (op) => store.apply(op),
  });
  useMirrorOverlay(controller, store);
  useEffect(() => {
    onUpdate({ status, state, incomplete: creds?.view == null || creds.verify == null });
  }, [status, state, creds, onUpdate]);

  const followed = state ? followedDocument(state) : null;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (followed === null || followed === handled.current) return;
    handled.current = followed;
    onDocument(followed === NO_DOC_LINK ? null : followed);
  }, [followed, onDocument]);
  return null;
}
