import { Check, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import type { DocumentSource } from "../inputs/types";
import { buildShareLink, type ShareLinkResult } from "./link";
import "./share.css";

export const PRIVACY_NOTE =
  "The document is inside the link. It is never sent to a server, but stays in browser history.";

const COPIED = "Link copied.";
const COPY_MANUALLY = "Copying is blocked here. The link is selected: press Ctrl+C (⌘C on a Mac).";

export interface ShareDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  source: DocumentSource;
  markdown: string;
  /** The page URL the link starts from; defaults to the current location. */
  base?: string;
}

type State = { status: "building" } | ShareLinkResult;

/** Share the current document as a link (decision 7). */
export function ShareDialog({ isOpen, onOpenChange, ...body }: ShareDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-share-overlay"
    >
      <Modal className="docwalk-share">
        <Dialog className="docwalk-share-dialog">
          {({ close }) => (
            <>
              <div className="docwalk-share-header">
                <Heading slot="title" className="docwalk-share-title">
                  Share this document
                </Heading>
                <Button aria-label="Close" className="docwalk-share-close" onPress={close}>
                  <X aria-hidden size={20} />
                </Button>
              </div>
              <ShareBody {...body} />
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Mounted each time the dialog opens, so it starts from "building" with no stale copy status. */
function ShareBody({ source, markdown, base }: Omit<ShareDialogProps, "isOpen" | "onOpenChange">) {
  const [state, setState] = useState<State>({ status: "building" });
  const [copyStatus, setCopyStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    buildShareLink({ source, markdown, base: base ?? globalThis.location.href })
      .catch((): ShareLinkResult => ({
        ok: false,
        message: "docwalk could not build a link here.",
      }))
      .then((result) => {
        if (!cancelled) setState(result);
      });
    return () => {
      cancelled = true;
    };
  }, [source, markdown, base]);

  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      setCopyStatus(COPIED);
    } catch {
      // Clipboard access is denied in some browsers and frames: leave the
      // link selected so the keyboard shortcut copies it.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyStatus(COPY_MANUALLY);
    }
  };

  return (
    <>
      {"status" in state ? (
        <p className="docwalk-share-muted">Preparing the link…</p>
      ) : state.ok ? (
        <>
          <TextField isReadOnly value={state.link.url} className="docwalk-share-field">
            <Label className="docwalk-overline">Link</Label>
            <div className="docwalk-share-row">
              <Input
                ref={inputRef}
                className="docwalk-share-input"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button className="docwalk-share-copy" onPress={() => void copy(state.link.url)}>
                {copyStatus === COPIED ? (
                  <Check aria-hidden size={18} />
                ) : (
                  <Copy aria-hidden size={18} />
                )}
                Copy link
              </Button>
            </div>
          </TextField>
          {state.link.warning && (
            <p className="docwalk-share-warning">
              <TriangleAlert aria-hidden size={18} />
              <span>{state.link.warning}</span>
            </p>
          )}
          {state.link.kind === "fragment" && (
            <p className="docwalk-share-muted docwalk-share-privacy">
              <Info aria-hidden size={16} />
              <span>{PRIVACY_NOTE}</span>
            </p>
          )}
        </>
      ) : (
        <p className="docwalk-share-warning" role="alert">
          <TriangleAlert aria-hidden size={18} />
          <span>{state.message}</span>
        </p>
      )}
      <p role="status" className="docwalk-share-status">
        {copyStatus}
      </p>
    </>
  );
}
