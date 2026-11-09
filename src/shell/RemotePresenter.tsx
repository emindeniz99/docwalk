import { useCallback, useEffect, useState } from "react";
import type { MirrorFeed } from "../annotate/mirrorFeed";
import type { DeckController } from "../deck/controller";
import type { LoadedDocument } from "../inputs/types";
import type { Countdown } from "../presenter/pacing";
import type { LevelOption } from "../sectioning/sectionize";
import { JoinDialog } from "../remote/JoinDialog";
import { useRemoteHost } from "../remote/host";
import { m } from "../paraglide/messages.js";
import { buildShareLink } from "../share/link";
import type { Notice } from "./useDocument";
import { useStageLaser } from "./useStageLaser";

export interface RemotePresenterProps {
  controller: DeckController | null;
  doc: LoadedDocument | null;
  /** The deck's slide level, which followers must use to get the same slide addresses. */
  level: LevelOption;
  /** The laser, marks and diagram focus view to mirror to followers (decision 88). */
  mirror: MirrorFeed;
  /** The presenter window's countdown, which phone remotes show (decision 112); null or absent when there is none. */
  countdown?: Countdown | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Applies an agent's write the way an edit in the editor would (decision 59). */
  edit: (markdown: string) => void;
  setNotice: (notice: Notice | null) => void;
}

/**
 * The presenter's side of remote control (decision 8), loaded and mounted
 * only after the presenter turns it on, and only when the Worker offers
 * "remote": the room, the join dialog and the laser on the stage. Mounted
 * once, in the main view; a duplicated tab gets a room of its own (host.ts),
 * so a room never gets a second presenter.
 *
 * An agent's write (decision 59) becomes an ordinary edit, and a notice says
 * which agent made it; a write refused because agent edits are off says how
 * to allow them.
 */
export function RemotePresenter({
  controller,
  doc,
  level,
  mirror,
  countdown = null,
  isOpen,
  onOpenChange,
  edit,
  setNotice,
}: RemotePresenterProps) {
  // Undefined until the first link is built, so followers wait instead of
  // being told the document is too long to send.
  const [docLink, setDocLink] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    // Debounced: typing while presenting must not re-encode the document on every key.
    const timer = setTimeout(() => {
      void buildShareLink({ source: doc.source, markdown: doc.markdown, base: location.href })
        .then((r) => (r.ok ? r.link.url : null))
        .catch(() => null)
        .then((url) => {
          if (!cancelled) setDocLink(url);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc]);

  const onAgentEdit = useCallback(
    (markdown: string, name: string) => {
      // First, so the draft warning an edit can raise replaces it: that one asks for a decision.
      setNotice({ message: m.agent_changed({ name }), tone: "info" });
      edit(markdown);
    },
    [edit, setNotice],
  );
  const onAgentEditRefused = useCallback(
    (name: string) =>
      setNotice({
        message: m.agent_refused({ name }),
        tone: "info",
        action: { label: m.remote_control(), run: () => onOpenChange(true) },
      }),
    [setNotice, onOpenChange],
  );

  const remote = useRemoteHost({
    controller,
    docLink,
    level,
    enabled: true,
    markdown: doc?.markdown ?? null,
    onAgentEdit,
    onAgentEditRefused,
    mirror,
    countdown,
  });
  useStageLaser(controller, remote.laser);
  return <JoinDialog isOpen={isOpen} onOpenChange={onOpenChange} host={remote} />;
}
