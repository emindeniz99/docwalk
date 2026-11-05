import { Bot, Check, Copy, KeyRound, TriangleAlert, X } from "lucide-react";
import qrcodeGenerator from "qrcode-generator";
import { useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  Switch,
  TextField,
} from "react-aria-components";
import type { RemoteStatus } from "./client";
import type { RemoteHost } from "./host";
import "./remote.css";

export const KEY_NOTE =
  "Both links contain the room key. Anyone who has either link can follow along and change slides, so share them only with your audience.";
export const DOC_LINK_TOO_LONG =
  "This document is too long to send with the follow link. Followers need to open it themselves.";
export const AGENT_NOTE =
  "An agent you run with docwalk-mcp and the phone remote link can read the document and change slides. Switch this on to let it change the document too. Anyone with the link could then do the same.";

const STATUS_TEXT: Record<RemoteStatus, string> = {
  connecting: "Opening the room…",
  open: "Room open",
  reconnecting: "Reconnecting to the room…",
  closed: "Room closed",
};

const COPIED = "Link copied.";
const COPY_MANUALLY = "Copying is blocked here. The link is selected: press Ctrl+C (⌘C on a Mac).";
/** Empty modules around the code, as the QR specification asks, so phone cameras find its edges. */
const QUIET_ZONE = 4;

export interface JoinDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  host: Pick<
    RemoteHost,
    | "joinUrls"
    | "participants"
    | "status"
    | "docLinkTooLong"
    | "allowAgentEdits"
    | "setAllowAgentEdits"
    | "lastAgentEdit"
  >;
}

/** "Changed by <agent> at 14:03", in the viewer's locale. */
export function describeAgentEdit(edit: { name: string; at: number }): string {
  const time = new Date(edit.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Last changed by ${edit.name} at ${time}.`;
}

/**
 * The QR code for `value` as SVG elements. Each dark module becomes a unit
 * square in one path; nothing goes through innerHTML.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcodeGenerator(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const count = qr.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return { size: count + 2 * QUIET_ZONE, path: parts.join("") };
  }, [value]);
  return (
    <svg
      className="docwalk-join-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect className="docwalk-join-qr-bg" width={size} height={size} />
      <path className="docwalk-join-qr-fg" d={path} />
    </svg>
  );
}

function JoinLink({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
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
    <section className="docwalk-join-card" aria-label={title}>
      <h3 className="docwalk-join-card-title">{title}</h3>
      <p className="docwalk-join-muted">{description}</p>
      <QrCode value={url} label={`QR code for the ${title.toLowerCase()} link`} />
      <TextField isReadOnly value={url} className="docwalk-join-field">
        <Label className="docwalk-overline">{title} link</Label>
        <Input
          ref={inputRef}
          className="docwalk-join-input"
          onFocus={(e) => e.currentTarget.select()}
        />
      </TextField>
      <Button className="docwalk-join-copy" onPress={() => void copy()}>
        {copyStatus === COPIED ? <Check aria-hidden size={18} /> : <Copy aria-hidden size={18} />}
        Copy {title.toLowerCase()} link
      </Button>
      <p role="status" className="docwalk-join-status">
        {copyStatus}
      </p>
    </section>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lets the presenter hand out the phone-remote and follow links (decision 8). */
export function JoinDialog({ isOpen, onOpenChange, host }: JoinDialogProps) {
  const { joinUrls, participants, status, docLinkTooLong } = host;
  const { allowAgentEdits, setAllowAgentEdits, lastAgentEdit } = host;
  const agentsId = useId();
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="docwalk-join-overlay"
    >
      <Modal className="docwalk-join">
        <Dialog className="docwalk-join-dialog">
          {({ close }) => (
            <>
              <div className="docwalk-join-header">
                <Heading slot="title" level={2} className="docwalk-join-title">
                  Remote control
                </Heading>
                <Button aria-label="Close" className="docwalk-join-close" onPress={close}>
                  <X aria-hidden size={20} />
                </Button>
              </div>
              <p className="docwalk-join-muted" aria-live="polite">
                <span data-status={status} className="docwalk-join-room">
                  {STATUS_TEXT[status]}
                </span>
                {" · "}
                {plural(participants.remotes, "remote", "remotes")} and{" "}
                {plural(participants.followers, "follower", "followers")} joined
                {participants.agents > 0 &&
                  ` · ${plural(participants.agents, "agent", "agents")} connected`}
              </p>
              <div className="docwalk-join-cards">
                <JoinLink
                  title="Phone remote"
                  description="Next, previous and a laser pointer from a phone."
                  url={joinUrls.remote}
                />
                <JoinLink
                  title="Follow along"
                  description="Other screens show the slide you are on."
                  url={joinUrls.follow}
                />
              </div>
              <section className="docwalk-join-agents" aria-labelledby={`${agentsId}-title`}>
                <div className="docwalk-join-agents-head">
                  <Bot aria-hidden size={18} />
                  <h3 id={`${agentsId}-title`} className="docwalk-join-card-title">
                    Agents
                  </h3>
                  <Switch
                    className="docwalk-switch"
                    isSelected={allowAgentEdits}
                    onChange={setAllowAgentEdits}
                    aria-describedby={`${agentsId}-note`}
                  >
                    <span className="docwalk-switch-track" aria-hidden="true">
                      <span className="docwalk-switch-thumb" />
                    </span>
                    Allow agent edits
                  </Switch>
                </div>
                <p id={`${agentsId}-note`} className="docwalk-join-muted">
                  {AGENT_NOTE}
                </p>
                {lastAgentEdit && (
                  <p className="docwalk-join-muted" data-testid="agent-last-edit">
                    {describeAgentEdit(lastAgentEdit)}
                  </p>
                )}
              </section>
              <p className="docwalk-join-note">
                <KeyRound aria-hidden size={18} />
                <span>{KEY_NOTE}</span>
              </p>
              {docLinkTooLong && (
                <p className="docwalk-join-note">
                  <TriangleAlert aria-hidden size={18} />
                  <span>{DOC_LINK_TOO_LONG}</span>
                </p>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
