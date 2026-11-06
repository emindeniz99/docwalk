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
import { ariaLocale, getAppLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import type { RemoteStatus } from "./client";
import type { RemoteHost } from "./host";
import "./remote.css";

// Message functions, so each render reads the current UI language.
export const KEY_NOTE = m.join_key_note;
export const DOC_LINK_TOO_LONG = m.join_doc_too_long;
export const AGENT_NOTE = m.join_agent_note;

const STATUS_TEXT: Record<RemoteStatus, () => string> = {
  connecting: m.join_status_connecting,
  open: m.join_status_open,
  reconnecting: m.join_status_reconnecting,
  closed: m.join_status_closed,
};

/** Each link's texts as whole messages: a translation cannot be built from a lower-cased title. */
const LINK_TEXT = {
  remote: {
    title: m.join_remote_title,
    description: m.join_remote_description,
    field: m.join_remote_link,
    copy: m.join_remote_copy,
    qr: m.join_remote_qr,
  },
  follow: {
    title: m.join_follow_title,
    description: m.join_follow_description,
    field: m.join_follow_link,
    copy: m.join_follow_copy,
    qr: m.join_follow_qr,
  },
};

type CopyStatus = "" | "copied" | "manual";
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

/** "Changed by <agent> at 14:03", in the UI language and its time format. */
export function describeAgentEdit(edit: { name: string; at: number }): string {
  const time = new Date(edit.at).toLocaleTimeString(ariaLocale(getAppLocale()), {
    hour: "2-digit",
    minute: "2-digit",
  });
  return m.join_last_agent_edit({ name: edit.name, time });
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

function JoinLink({ kind, url }: { kind: keyof typeof LINK_TEXT; url: string }) {
  const text = LINK_TEXT[kind];
  const title = text.title();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const copy = async () => {
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
    <section className="docwalk-join-card" aria-label={title}>
      <h3 className="docwalk-join-card-title">{title}</h3>
      <p className="docwalk-join-muted">{text.description()}</p>
      <QrCode value={url} label={text.qr()} />
      <TextField isReadOnly value={url} className="docwalk-join-field">
        <Label className="docwalk-overline">{text.field()}</Label>
        <Input
          ref={inputRef}
          className="docwalk-join-input"
          onFocus={(e) => e.currentTarget.select()}
        />
      </TextField>
      <Button className="docwalk-join-copy" onPress={() => void copy()}>
        {copyStatus === "copied" ? <Check aria-hidden size={18} /> : <Copy aria-hidden size={18} />}
        {text.copy()}
      </Button>
      <p role="status" className="docwalk-join-status">
        {copyStatus === "copied"
          ? m.share_copied()
          : copyStatus === "manual"
            ? m.share_copy_manually()
            : ""}
      </p>
    </section>
  );
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
                  {m.remote_control()}
                </Heading>
                <Button aria-label={m.close()} className="docwalk-join-close" onPress={close}>
                  <X aria-hidden size={20} />
                </Button>
              </div>
              <p className="docwalk-join-muted" aria-live="polite">
                <span data-status={status} className="docwalk-join-room">
                  {STATUS_TEXT[status]()}
                </span>
                {" · "}
                {m.join_participants({
                  remotes: participants.remotes,
                  followers: participants.followers,
                })}
                {participants.agents > 0 &&
                  ` · ${m.join_agents_connected({ agents: participants.agents })}`}
              </p>
              <div className="docwalk-join-cards">
                <JoinLink kind="remote" url={joinUrls.remote} />
                <JoinLink kind="follow" url={joinUrls.follow} />
              </div>
              <section className="docwalk-join-agents" aria-labelledby={`${agentsId}-title`}>
                <div className="docwalk-join-agents-head">
                  <Bot aria-hidden size={18} />
                  <h3 id={`${agentsId}-title`} className="docwalk-join-card-title">
                    {m.join_agents()}
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
                    {m.join_allow_agent_edits()}
                  </Switch>
                </div>
                <p id={`${agentsId}-note`} className="docwalk-join-muted">
                  {AGENT_NOTE()}
                </p>
                {lastAgentEdit && (
                  <p className="docwalk-join-muted" data-testid="agent-last-edit">
                    {describeAgentEdit(lastAgentEdit)}
                  </p>
                )}
              </section>
              <p className="docwalk-join-note">
                <KeyRound aria-hidden size={18} />
                <span>{KEY_NOTE()}</span>
              </p>
              {docLinkTooLong && (
                <p className="docwalk-join-note">
                  <TriangleAlert aria-hidden size={18} />
                  <span>{DOC_LINK_TOO_LONG()}</span>
                </p>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
