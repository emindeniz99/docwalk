import { useEffect, useRef, useState } from "react";
import { MirrorStore } from "../annotate/mirrorStore";
import { attachMirror } from "../annotate/mirrorView";
import type { DeckController } from "../deck/controller";
import { followFocus } from "../deck/focusMirror";
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

/**
 * Draws the presenter's laser and marks over the follower's slide, and opens
 * and closes the focus view when the presenter does (decisions 88 and 106).
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

  useEffect(() => (controller ? followFocus(controller, store) : undefined), [controller, store]);
}

/**
 * A follower screen's connection (`?view=follow#room=..&v=..&p=..`), loaded only
 * on follower pages. It renders nothing: it follows the presenter's slide
 * once the deck exists, reports the room's state to App, and hands App each
 * new document the presenter announces. It also shows what the presenter
 * mirrors: the laser, pen marks and the focus view (decisions 88 and 106).
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
