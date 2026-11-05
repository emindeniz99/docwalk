import { useEffect, useState } from "react";
import type { DeckController } from "../deck/controller";
import type { LoadedDocument } from "../inputs/types";
import { JoinDialog } from "../remote/JoinDialog";
import { useRemoteHost } from "../remote/host";
import { buildShareLink } from "../share/link";
import { useStageLaser } from "./useStageLaser";

export interface RemotePresenterProps {
  controller: DeckController | null;
  doc: LoadedDocument | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The presenter's side of remote control (decision 8), loaded and mounted
 * only after the presenter turns it on, and only when the Worker offers
 * "remote": the room, the join dialog and the laser on the stage. Mounted
 * once, in the main view, so a room never gets a second presenter.
 */
export function RemotePresenter({ controller, doc, isOpen, onOpenChange }: RemotePresenterProps) {
  const [docLink, setDocLink] = useState<string | null>(null);
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

  const remote = useRemoteHost({ controller, docLink, enabled: true });
  useStageLaser(controller, remote.laser);
  return <JoinDialog isOpen={isOpen} onOpenChange={onOpenChange} host={remote} />;
}
