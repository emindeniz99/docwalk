import { ChevronLeft, ChevronRight, Crosshair } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "react-aria-components";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { connectRoom, type RemoteStatus, type RoomConnection, type SocketFactory } from "./client";
import type { FollowState } from "./follower";
import type { RemoteMessage, RoomCredentials } from "./types";
import "./remote.css";

/** While a finger rests on the pad, its point is repeated this often so the presenter's idle timeout does not hide it. */
export const LASER_REPEAT_MS = 1000;
/**
 * The presenter answers every hello, step and goto with its state. Without
 * an answer in this long, the presenter's tab is closed, reloading or
 * offline, and the remote stops offering controls that would go nowhere.
 */
export const PRESENTER_REPLY_MS = 4000;

export const STATUS_TEXT: Record<RemoteStatus, () => string> = {
  connecting: m.phone_connecting,
  open: m.phone_connected,
  reconnecting: m.phone_reconnecting,
  closed: m.phone_disconnected,
};

/** The relay is connected but the presenter does not answer. */
export const PRESENTER_AWAY = m.phone_presenter_away;

export interface RemoteViewProps {
  /** From `parseJoinFragment(location.hash)`; null shows what is wrong with the link. */
  creds: RoomCredentials | null;
  socketFactory?: SocketFactory;
  /** The page URL; defaults to the current location. */
  base?: string;
}

function useRemoteControl(
  creds: RoomCredentials | null,
  socketFactory: SocketFactory | undefined,
  base: string | undefined,
) {
  const [status, setStatus] = useState<RemoteStatus>("connecting");
  const [state, setState] = useState<FollowState | null>(null);
  const [presenterAway, setPresenterAway] = useState(false);
  const connection = useRef<RoomConnection | null>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const room = creds?.room;
  const key = creds?.key;

  const expectReply = useCallback(() => {
    clearTimeout(replyTimer.current);
    replyTimer.current = setTimeout(() => setPresenterAway(true), PRESENTER_REPLY_MS);
  }, []);

  useEffect(() => {
    if (!room || !key) return;
    let active = true;
    // connectRoom sends `hello` on every (re)connect; the presenter answers with state.
    const conn = connectRoom({
      creds: { room, key },
      role: "remote",
      onMessage: (message) => {
        if (!active || message.type !== "state") return;
        const { type: _type, ...rest } = message;
        clearTimeout(replyTimer.current);
        setPresenterAway(false);
        setState(rest);
      },
      onStatus: (next) => {
        if (!active) return;
        setStatus(next);
        if (next === "open") expectReply();
      },
      ...(socketFactory ? { socketFactory } : {}),
      ...(base ? { base } : {}),
    });
    connection.current = conn;
    return () => {
      active = false;
      clearTimeout(replyTimer.current);
      conn.close();
      connection.current = null;
      setStatus("connecting");
    };
  }, [room, key, socketFactory, base, expectReply]);

  const send = (message: RemoteMessage) => {
    if (message.type === "step" || message.type === "goto") expectReply();
    void connection.current?.send(message);
  };
  return { status, state, presenterAway, send };
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** The pointer's position on the pad as 0..1 coordinates, clamped to the pad. */
function toPoint(event: ReactPointerEvent<HTMLDivElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - box.left) / box.width),
    y: clamp((event.clientY - box.top) / box.height),
  };
}

/**
 * A touch area shaped like the slide: a finger at (x, y) on the pad points
 * the presenter's laser at the same relative spot on the slide. A tap places
 * a point too, so no drag is required (WCAG 2.5.7).
 */
function LaserPad({ send, disabled }: { send: (m: RemoteMessage) => void; disabled: boolean }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const repeat = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const next = toPoint(event);
    pressed.current = next;
    setPoint(next);
    send({ type: "laser", ...next });
  };

  const release = () => {
    clearInterval(repeat.current);
    if (!pressed.current) return;
    pressed.current = null;
    setPoint(null);
    send({ type: "laser-off" });
  };

  // On unmount the connection closes too; the presenter's idle timeout hides the laser.
  useEffect(() => () => clearInterval(repeat.current), []);

  return (
    <section className="docwalk-remote-pad-wrap" aria-labelledby="docwalk-remote-pad-label">
      <div
        className="docwalk-remote-pad"
        data-disabled={disabled || undefined}
        data-active={point ? true : undefined}
        onPointerDown={(event) => {
          if (disabled) return;
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // No active pointer with that id (synthetic events); moves still arrive over the pad.
          }
          move(event);
          clearInterval(repeat.current);
          repeat.current = setInterval(() => {
            if (pressed.current) send({ type: "laser", ...pressed.current });
          }, LASER_REPEAT_MS);
        }}
        onPointerMove={(event) => {
          if (pressed.current) move(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <span id="docwalk-remote-pad-label" className="docwalk-remote-pad-label">
          <Crosshair aria-hidden size={20} />
          {m.phone_laser()}
        </span>
        {point && (
          <span
            className="docwalk-remote-pad-dot"
            aria-hidden
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          />
        )}
      </div>
    </section>
  );
}

/** The phone remote (`?view=remote#room=..&k=..`). No document is loaded here: only the presenter's state. */
export function RemoteView({ creds, socketFactory, base }: RemoteViewProps) {
  const { status, state, presenterAway, send } = useRemoteControl(creds, socketFactory, base);
  // A page root: its text follows a language switch made in another docwalk tab.
  useLocale();

  if (!creds) {
    return (
      <main className="docwalk-remote" aria-labelledby="docwalk-remote-title">
        <h1 id="docwalk-remote-title" className="docwalk-remote-title">
          {m.phone_incomplete_title()}
        </h1>
        <p className="docwalk-remote-muted">{m.phone_incomplete_body()}</p>
      </main>
    );
  }

  // Connected to the relay is not enough: the presenter must be answering too.
  const away = status === "open" && presenterAway;
  const disabled = status !== "open" || presenterAway;
  return (
    <main className="docwalk-remote" aria-labelledby="docwalk-remote-title">
      <header className="docwalk-remote-header">
        <div className="docwalk-remote-heading">
          <span className="docwalk-remote-overline">{m.join_remote_title()}</span>
          <h1 id="docwalk-remote-title" className="docwalk-remote-title">
            {state && !away ? state.title || state.current : m.follow_waiting()}
          </h1>
        </div>
        <span
          className="docwalk-remote-status"
          data-status={away ? "reconnecting" : status}
          role="status"
        >
          {away ? PRESENTER_AWAY() : STATUS_TEXT[status]()}
        </span>
      </header>
      {/* A live region, so a screen reader confirms where a Next or Previous press landed (WCAG 4.1.3). */}
      <p className="docwalk-remote-count" aria-live="polite" aria-atomic="true">
        <span aria-hidden="true">
          {state && !away ? `${state.index + 1} / ${state.total}` : "– / –"}
        </span>
        <span className="docwalk-remote-sr">
          {state && !away
            ? m.phone_slide_of({ current: state.index + 1, total: state.total })
            : m.phone_slide_unknown()}
        </span>
      </p>
      <LaserPad send={send} disabled={disabled} />
      <footer className="docwalk-remote-controls">
        <Button
          className="docwalk-remote-button"
          isDisabled={disabled}
          onPress={() => send({ type: "step", direction: -1 })}
        >
          <ChevronLeft aria-hidden size={22} />
          {m.previous()}
        </Button>
        <Button
          className="docwalk-remote-button docwalk-remote-next"
          isDisabled={disabled}
          onPress={() => send({ type: "step", direction: 1 })}
        >
          {m.next()}
          <ChevronRight aria-hidden size={22} />
        </Button>
      </footer>
    </main>
  );
}
