import { useEffect, useRef, useState } from "react";
import type { DeckController } from "../deck/controller";
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
  /** The page's `#room=..&k=..` fragment is missing or malformed. */
  incomplete: boolean;
}

/**
 * A follower screen's connection (`?view=follow#room=..&k=..`), loaded only
 * on follower pages. It renders nothing: it follows the presenter's slide
 * once the deck exists, reports the room's state to App, and hands App each
 * new document the presenter announces.
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
  const { status, state } = useRemoteFollower({ creds, controller });
  useEffect(() => {
    onUpdate({ status, state, incomplete: creds === null });
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
