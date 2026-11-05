import { useEffect, useState } from "react";
import type { DeckController } from "../deck/controller";
import type { RemoteStatus } from "../remote/client";
import { parseJoinFragment } from "../remote/crypto";
import { useRemoteFollower, type FollowState } from "../remote/follower";

export interface FollowUpdate {
  status: RemoteStatus;
  state: FollowState | null;
  /** The page's `#room=..&k=..` fragment is missing or malformed. */
  incomplete: boolean;
}

/**
 * A follower screen's connection (`?view=follow#room=..&k=..`), loaded only
 * on follower pages. It renders nothing: it follows the presenter's slide
 * once the deck exists and reports the room's state to App, which loads the
 * presenter's document from it.
 */
export function RemoteFollower({
  controller,
  onUpdate,
}: {
  controller: DeckController | null;
  onUpdate: (update: FollowUpdate) => void;
}) {
  // Read once: URL sync may rewrite the address bar, and the room must not change with it.
  const [creds] = useState(() => parseJoinFragment(location.hash));
  const { status, state } = useRemoteFollower({ creds, controller });
  useEffect(() => {
    onUpdate({ status, state, incomplete: creds === null });
  }, [status, state, creds, onUpdate]);
  return null;
}
