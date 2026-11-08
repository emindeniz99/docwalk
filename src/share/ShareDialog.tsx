import { Check, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import type { ShareComments } from "../comments/useCommentsUi";
import type { DocumentSource } from "../inputs/types";
import { m } from "../paraglide/messages.js";
import { buildShareLink, type ShareLinkResult } from "./link";
import "./share.css";

// Message functions, so each render reads the current UI language.
export const PRIVACY_NOTE = m.share_privacy;

export const COMMENTS_PRIVACY_NOTE = m.share_comments_privacy;

export const COMMENTS_NAMES_NOTE = m.share_comments_names;

export const COMMENTS_DROPPED = m.share_comments_dropped;

type CopyStatus = "" | "copied" | "manual";

export interface ShareDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  source: DocumentSource;
  markdown: string;
  /** The page URL the link starts from; defaults to the current location. */
  base?: string;
  /** The document's comments (decision 55); offered as "Include comments" when there are any. */
  comments?: ShareComments;
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
                  {m.share_title()}
                </Heading>
                <Button aria-label={m.close()} className="docwalk-share-close" onPress={close}>
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
function ShareBody({
  source,
  markdown,
  base,
  comments,
}: Omit<ShareDialogProps, "isOpen" | "onOpenChange">) {
  const [state, setState] = useState<State>({ status: "building" });
  const [withComments, setWithComments] = useState(true);
  const hasComments = (comments?.count ?? 0) > 0;
  const includeComments = hasComments && withComments;
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (includeComments && comments ? comments.encode() : Promise.resolve(null))
      .then((encoded) =>
        buildShareLink({
          source,
          markdown,
          base: base ?? globalThis.location.href,
          comments: encoded,
        }),
      )
      .catch((): ShareLinkResult => ({
        ok: false,
        message: m.share_build_failed(),
      }))
      .then((result) => {
        if (!cancelled) setState(result);
      });
    return () => {
      cancelled = true;
    };
  }, [source, markdown, base, includeComments, comments]);

  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      setCopyStatus("copied");
    } catch {
      // Clipboard access is denied in some browsers and frames: leave the
      // link selected so the keyboard shortcut copies it.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyStatus("manual");
    }
  };

  return (
    <>
      {hasComments && (
        <Checkbox
          className="docwalk-share-checkbox"
          isSelected={withComments}
          onChange={setWithComments}
        >
          <span className="docwalk-share-checkbox-box" aria-hidden="true">
            {withComments && <Check size={14} />}
          </span>
          {m.share_include_comments({ count: comments?.count ?? 0 })}
        </Checkbox>
      )}
      {"status" in state ? (
        <p className="docwalk-share-muted">{m.share_preparing()}</p>
      ) : state.ok ? (
        <>
          <TextField isReadOnly value={state.link.url} className="docwalk-share-field">
            <Label className="docwalk-overline">{m.share_link()}</Label>
            <div className="docwalk-share-row">
              <Input
                ref={inputRef}
                className="docwalk-share-input"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button className="docwalk-share-copy" onPress={() => void copy(state.link.url)}>
                {copyStatus === "copied" ? (
                  <Check aria-hidden size={18} />
                ) : (
                  <Copy aria-hidden size={18} />
                )}
                {m.share_copy()}
              </Button>
            </div>
          </TextField>
          {state.link.commentsDropped && (
            <p className="docwalk-share-warning">
              <TriangleAlert aria-hidden size={18} />
              <span>{COMMENTS_DROPPED()}</span>
            </p>
          )}
          {state.link.warning && (
            <p className="docwalk-share-warning">
              <TriangleAlert aria-hidden size={18} />
              <span>{state.link.warning}</span>
            </p>
          )}
          {state.link.kind === "fragment" && (
            <p className="docwalk-share-muted docwalk-share-privacy">
              <Info aria-hidden size={16} />
              <span>{PRIVACY_NOTE()}</span>
            </p>
          )}
          {includeComments && !state.link.commentsDropped && (
            <p className="docwalk-share-muted docwalk-share-privacy">
              <Info aria-hidden size={16} />
              <span>{COMMENTS_PRIVACY_NOTE()}</span>
            </p>
          )}
          {includeComments && !state.link.commentsDropped && comments?.named && (
            <p className="docwalk-share-muted docwalk-share-privacy">
              <Info aria-hidden size={16} />
              <span>{COMMENTS_NAMES_NOTE()}</span>
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
        {copyStatus === "copied"
          ? m.share_copied()
          : copyStatus === "manual"
            ? m.share_copy_manually()
            : ""}
      </p>
    </>
  );
}
