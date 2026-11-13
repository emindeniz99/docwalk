import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { HealthResponse } from "../api/types";
import { m } from "../paraglide/messages.js";
import type { LevelOption } from "../sectioning/sectionize";
import type { FollowUpdate } from "../shell/RemoteFollower";
import type { Notice } from "../shell/useDocument";
import { useLazyDialog } from "../shell/useLazyDialog";

/**
 * Remote control (decision 8), only when the Worker offers it: the presenter's
 * room behind the Remote command, and on a follower page (`?view=follow`) the
 * presenter's updates and documents.
 */
export function useRemoteRoom({
  follow,
  health,
  loadFromLink,
  setNotice,
  setLevel,
}: {
  follow: boolean;
  health: HealthResponse | null;
  loadFromLink: (link: string) => Promise<unknown>;
  setNotice: (notice: Notice | null) => void;
  setLevel: Dispatch<SetStateAction<LevelOption>>;
}) {
  const join = useLazyDialog();
  const [remoteOn, setRemoteOn] = useState(false);
  // Feature-detected through /api/health and hidden in static mode (AGENTS.md rule 6).
  const remoteAvailable = !follow && health?.features.includes("remote") === true;

  const [followUpdate, setFollowUpdate] = useState<FollowUpdate>({
    status: "connecting",
    state: null,
    incomplete: false,
  });
  // Called once for each document the presenter announces, so a follower
  // picks up an edit or a newly opened document; null when there is no link.
  const onFollowDocument = useCallback(
    (link: string | null) => {
      if (link) void loadFromLink(link);
      else setNotice({ message: m.follow_doc_too_long(), tone: "error" });
    },
    [loadFromLink, setNotice],
  );
  const onFollowUpdate = useCallback(
    (update: FollowUpdate) => {
      setFollowUpdate(update);
      // Section ids, and so the presenter's slide addresses, depend on the slide level.
      const next = update.state?.level;
      if (next !== undefined)
        setLevel((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    },
    [setLevel],
  );
  useEffect(() => {
    if (followUpdate.incomplete) setNotice({ message: m.follow_link_incomplete(), tone: "error" });
  }, [followUpdate.incomplete, setNotice]);

  // A follow screen hides its bar like a presenting one, but only while the
  // slide can be trusted: anything but an open connection, or an incomplete
  // link, keeps the bar (and the status in it) up.
  const followOpen = follow && followUpdate.status === "open" && !followUpdate.incomplete;

  const openRemote = useCallback(() => {
    setRemoteOn(true);
    join.onOpenChange(true);
  }, [join]);

  return {
    join,
    remoteOn,
    remoteAvailable,
    openRemote,
    followUpdate,
    followOpen,
    onFollowUpdate,
    onFollowDocument,
  };
}
