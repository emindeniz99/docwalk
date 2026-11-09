import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as v from "valibot";
import type { MirrorFeed } from "../annotate/mirrorFeed";
import { mirrorFrameBytes, resyncGapMs, type MirrorOp } from "../annotate/mirrorTypes";
import type { DeckController } from "../deck/controller";
import { sameCountdown, toRemoteCountdown, type Countdown } from "../presenter/pacing";
import type { LevelOption } from "../sectioning/sectionize";
import { answerAgent, isAgentRequest, type AgentHostContext } from "./agent";
import { connectRoom, type RemoteStatus, type RoomConnection, type SocketFactory } from "./client";
import {
  createPresenterCredentials,
  formatJoinUrl,
  MAX_TITLE_CHARS,
  RoomCredentialsSchema,
  type PresenterCredentials,
} from "./crypto";
import type { RemoteMessage } from "./types";

/**
 * The presenter's side of remote control (decision 8). The presenter's deck
 * stays the source of truth: it announces its state on join, on every slide
 * change and in answer to every step or goto (so a remote can tell that a
 * presenter is there), and applies navigation that remotes ask for.
 *
 * Agents (decision 59) may read the document and the slide list; they may
 * change the document only while the presenter has "Allow agent edits" on.
 * Both, and every step or goto, need the control key of the phone remote
 * link; the follow link carries only the view key (decision 68).
 * The switch belongs to the room and starts off, also after a reload.
 *
 * The countdown of the presenter window (decision 112) goes to remotes as a
 * message of its own under the control key: on every change, after the state
 * that answers a hello or opens the socket, and as null once it is gone.
 * Followers never get it. The client signs it, so a remote takes it only from
 * this tab (decision 117).
 *
 * The join links stay hidden until the presenter's socket has opened, so
 * the presenter's seat token is the first the relay sees (decision 71).
 * When the relay refuses the token anyway, the room's control seats belong
 * to someone else's key, and the presenter moves to a new room with new
 * keys instead of staying on as a follower (decision 74).
 */

/** sessionStorage key: the room survives a reload of the presenter tab, so phones stay joined. */
export const ROOM_STORAGE_KEY = "docwalk.remote-room";
/** A remote laser point disappears after this long without an update (a phone that dropped out). */
export const LASER_IDLE_MS = 3000;
/** Distinct participant ids remembered per role; a hostile key holder cannot grow this without bound. */
const MAX_TRACKED = 1000;
/** An agent asking for the slide list waits at most this long for the deck to catch up with the document. */
export const DECK_WAIT_MS = 10_000;
/**
 * A follower's hello (and the room reopening) makes the presenter resend the
 * mirrored marks of the current slide, this long after the state has gone
 * out (decision 88), and never before the gap the last resync earned: at
 * least 2 s, longer the more its frames cost (`resyncGapMs`, decision 103).
 */
export const RESYNC_DELAY_MS = 150;
/**
 * A hello gets the state at once; the hellos that follow within this long
 * share one more state at its end, read from the deck as it is then
 * (decision 103). A change of slide still sends its state at once.
 */
export const HELLO_STATE_GAP_MS = 250;

export interface RemoteHostOptions {
  controller: DeckController | null;
  /**
   * Share link for followers (`?src=`, `?repo=` or `#doc=`); null when the
   * document has none (too long for a link), undefined while it is being built.
   */
  docLink: string | null | undefined;
  /** The deck's slide level; followers need it to have the same section ids. Defaults to "auto". */
  level?: LevelOption;
  /** True when the Worker offers "remote" and the presenter turned remote control on. */
  enabled: boolean;
  socketFactory?: SocketFactory;
  /** The app URL join links start from; defaults to the current location. */
  base?: string;
  /** The document agents read and write; null while it loads. */
  markdown?: string | null;
  /** An agent's write was applied: replace the document and say who changed it. */
  onAgentEdit?: (markdown: string, name: string) => void;
  /** An agent tried to write while agent edits are off. */
  onAgentEditRefused?: (name: string) => void;
  /**
   * What the presenter mirrors to followers (decisions 88 and 106): the
   * laser, marks and the diagram, code, table and image focus views. The
   * host sends its ops to the room signed, relays a phone's laser through
   * it, and resyncs a follower that joins late.
   */
  mirror?: MirrorFeed | null;
  /**
   * The presenter window's countdown, which phone remotes show (decision
   * 112); null or undefined when there is none. The host sends durations on
   * every change and never to followers.
   */
  countdown?: Countdown | null;
}

export interface RemoteHost {
  /** Null until the presenter's socket has opened in this room: nobody may join before it. */
  joinUrls: { remote: string; follow: string } | null;
  /** Devices that joined this session, counted once each. Departures are not reported by the relay. */
  participants: { remotes: number; followers: number; agents: number };
  /** "closed" while disabled. */
  status: RemoteStatus;
  /** The latest laser point from a remote in slide coordinates (0..1), or null when hidden. */
  laser: { x: number; y: number } | null;
  /** True when followers get no document link: too long for a link, or for the relay's frame. */
  docLinkTooLong: boolean;
  /** "Allow agent edits" for this room; off until the presenter turns it on. */
  allowAgentEdits: boolean;
  setAllowAgentEdits: (allow: boolean) => void;
  /** The last write an agent made in this room, for "changed by". */
  lastAgentEdit: { name: string; at: number } | null;
}

/**
 * Takes the room for this tab with a Web Lock held until the page closes.
 * A duplicated tab copies sessionStorage, room included; without the lock it
 * would join the same room as a second presenter, and every remote press
 * would move both decks. False when another tab already holds the room.
 * Memoized per room, so React's rehearsal remount in development, which asks
 * twice, gets the same answer. Without the Locks API (an insecure context)
 * the room is taken unchecked.
 */
const claims = new Map<string, Promise<boolean>>();
function claimRoom(room: string): Promise<boolean> {
  let claim = claims.get(room);
  if (!claim) {
    const locks = globalThis.navigator?.locks;
    claim = locks
      ? new Promise<boolean>((resolve) => {
          void locks
            .request(`docwalk.remote-room:${room}`, { ifAvailable: true }, (lock) => {
              resolve(lock !== null);
              // Held for the page's lifetime; a closed or reloaded tab releases it.
              return lock ? new Promise<never>(() => {}) : undefined;
            })
            .catch(() => resolve(true));
        })
      : Promise.resolve(true);
    claims.set(room, claim);
  }
  return claim;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredCredentials(): PresenterCredentials | null {
  try {
    const raw = storage()?.getItem(ROOM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = v.safeParse(RoomCredentialsSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function storeCredentials(creds: PresenterCredentials) {
  try {
    storage()?.setItem(ROOM_STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Storage blocked: the room lasts until this tab reloads.
  }
}

export function useRemoteHost({
  controller,
  docLink,
  level = "auto",
  enabled,
  socketFactory,
  base,
  markdown = null,
  onAgentEdit,
  onAgentEditRefused,
  mirror = null,
  countdown = null,
}: RemoteHostOptions): RemoteHost {
  /** Null while a new room's keys are generated (none stored, a duplicated tab, a taken seat). */
  const [creds, setCreds] = useState(readStoredCredentials);
  /** The room this tab holds (see claimRoom); nothing connects before that. */
  const [claimed, setClaimed] = useState<string | null>(null);
  /** The room whose socket has opened at least once; its join links show from then on. */
  const [opened, setOpened] = useState<string | null>(null);
  const [status, setStatus] = useState<RemoteStatus>("connecting");
  const [participants, setParticipants] = useState({ remotes: 0, followers: 0, agents: 0 });
  // Keyed by room, so a new room (a duplicated tab) starts with edits off.
  const [agentEdits, setAgentEdits] = useState<{ room: string; allow: boolean } | null>(null);
  const allowAgentEdits = creds !== null && agentEdits?.room === creds.room && agentEdits.allow;
  const [lastAgentEdit, setLastAgentEdit] = useState<RemoteHost["lastAgentEdit"]>(null);
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [docLinkTooLong, setDocLinkTooLong] = useState(false);

  const connection = useRef<RoomConnection | null>(null);
  const controllerRef = useRef(controller);
  const docLinkRef = useRef(docLink);
  const levelRef = useRef(level);
  const markdownRef = useRef(markdown);
  /** The document the current deck was built from; the slide list is stale while it differs. */
  const builtForRef = useRef<string | null>(null);
  const deckWaiters = useRef(new Set<() => void>());
  const allowRef = useRef(allowAgentEdits);
  const countdownRef = useRef(countdown);
  /** What the phones were last sent: null for nothing or a cleared clock, undefined when a send did not go out. */
  const sentCountdownRef = useRef<Countdown | null | undefined>(null);
  const callbacks = useRef({ onAgentEdit, onAgentEditRefused });
  useLayoutEffect(() => {
    if (controller !== controllerRef.current) builtForRef.current = controller ? markdown : null;
    controllerRef.current = controller;
    levelRef.current = level;
    // An applied write sets the ref at once; the prop catches up a render later.
    markdownRef.current = markdown;
    allowRef.current = allowAgentEdits;
    countdownRef.current = countdown;
    callbacks.current = { onAgentEdit, onAgentEditRefused };
  });
  useEffect(() => {
    if (!controller || builtForRef.current !== markdownRef.current) return;
    for (const wake of deckWaiters.current) wake();
  });

  // Reads everything through refs, so it is stable and the connection is never restarted for it.
  const sendState = useCallback(async () => {
    const conn = connection.current;
    const deck = controllerRef.current;
    const slide = deck?.current();
    if (!conn || !deck || !slide) return;
    const link = docLinkRef.current;
    const lvl = levelRef.current;
    const state: Extract<RemoteMessage, { type: "state" }> = {
      type: "state",
      current: slide.address,
      index: slide.index,
      total: deck.slides().length,
      title: slide.title.slice(0, MAX_TITLE_CHARS),
      docLink: link ?? null,
      docLinkTooLong: link === null,
      level: typeof lvl === "object" ? [...lvl] : lvl,
    };
    const result = await conn.send(state);
    if (result === "too-large" && state.docLink) {
      // Navigation still works without the link; the join dialog says followers need the document.
      const fallback = { ...state, docLink: null, docLinkTooLong: true };
      if ((await conn.send(fallback)) === "sent") setDocLinkTooLong(true);
    } else if (result === "sent") {
      setDocLinkTooLong(state.docLinkTooLong);
    }
  }, []);

  /**
   * Sends the countdown to the phones. A change goes out when it differs from
   * what they were sent; `again` (a hello, a reopened socket) sends it whatever
   * was sent, null included, because a phone that missed the end of a countdown
   * would keep showing it.
   */
  const sendCountdown = useCallback(async (now: Countdown | null, again: boolean) => {
    const conn = connection.current;
    if (!conn) return;
    const sent = sentCountdownRef.current;
    if (!again && sent !== undefined && sameCountdown(now, sent)) return;
    sentCountdownRef.current = now;
    const result = await conn.send({
      type: "countdown",
      countdown: now ? toRemoteCountdown(now, Date.now()) : null,
    });
    // The socket was not open: the next change or hello sends it again.
    if (result !== "sent" && sentCountdownRef.current === now) sentCountdownRef.current = undefined;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    if (!creds) {
      void createPresenterCredentials().then((fresh) => {
        if (active) setCreds(fresh);
      });
    } else if (claimed !== creds.room) {
      storeCredentials(creds);
      void claimRoom(creds.room).then((ok) => {
        if (!active) return;
        if (ok) setClaimed(creds.room);
        else setCreds(null);
      });
    }
    return () => {
      active = false;
    };
  }, [enabled, claimed, creds]);
  const room = enabled && creds !== null && claimed === creds.room ? creds : null;

  useEffect(() => {
    if (!room) return;
    const seen = {
      remote: new Set<string>(),
      follower: new Set<string>(),
      agent: new Set<string>(),
    };
    let laserTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    // The mirror's ops reach the room as signed `mirror` messages, under the view key only.
    const sendOp = (op: MirrorOp) => void conn.send({ type: "mirror", ...op });
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    /** When the next resync may start: the last one's start plus the gap its frames earned. */
    let nextResyncAt = Number.NEGATIVE_INFINITY;
    const scheduleResync = () => {
      if (!mirror || resyncTimer !== undefined) return;
      const wait = Math.max(RESYNC_DELAY_MS, nextResyncAt - Date.now());
      resyncTimer = setTimeout(() => {
        resyncTimer = undefined;
        if (!active) return;
        const startedAt = Date.now();
        let cost = 0;
        mirror.resync((op) => {
          cost += mirrorFrameBytes(op);
          sendOp(op);
        });
        nextResyncAt = startedAt + resyncGapMs(cost);
      }, wait);
    };

    /** The state, then the countdown the phones may have missed (decision 112). */
    const announce = async () => {
      await sendState();
      if (active) await sendCountdown(countdownRef.current, true);
    };
    let helloStateTimer: ReturnType<typeof setTimeout> | undefined;
    let lastHelloState = Number.NEGATIVE_INFINITY;
    const answerHello = () => {
      if (helloStateTimer !== undefined) return;
      const send = () => {
        helloStateTimer = undefined;
        lastHelloState = Date.now();
        if (active) void announce();
      };
      const wait = lastHelloState + HELLO_STATE_GAP_MS - Date.now();
      if (wait > 0) helloStateTimer = setTimeout(send, wait);
      else send();
    };

    const agentContext: AgentHostContext = {
      markdown: () => markdownRef.current,
      slides: () =>
        new Promise((resolve) => {
          const answer = () => {
            clearTimeout(timer);
            deckWaiters.current.delete(answer);
            const deck = controllerRef.current;
            resolve({
              current: deck?.current()?.address ?? null,
              slides: deck?.slides() ?? [],
            });
          };
          // Past the wait, the agent gets the deck as it is rather than nothing.
          const timer = setTimeout(answer, DECK_WAIT_MS);
          deckWaiters.current.add(answer);
          if (controllerRef.current && builtForRef.current === markdownRef.current) answer();
        }),
      allowEdits: () => allowRef.current,
      apply: (next, name) => {
        markdownRef.current = next;
        setLastAgentEdit({ name, at: Date.now() });
        callbacks.current.onAgentEdit?.(next, name);
      },
      refused: (name) => callbacks.current.onAgentEditRefused?.(name),
    };
    // One request at a time: a write checks its base revision against the
    // document the previous write left, not one that is about to change.
    let agentQueue: Promise<unknown> = Promise.resolve();

    const handle = (message: RemoteMessage) => {
      if (isAgentRequest(message)) {
        agentQueue = agentQueue
          .then(async () => {
            const reply = await answerAgent(message, agentContext);
            if (!active) return;
            if ((await conn.send(reply)) === "too-large") {
              await conn.send({
                type: "result",
                request: message.request,
                to: message.from,
                ok: false,
                error: "too-large",
              });
            }
          })
          .catch((error: unknown) => globalThis.reportError(error));
        return;
      }
      const deck = controllerRef.current;
      switch (message.type) {
        case "hello": {
          const ids = seen[message.role];
          if (!ids.has(message.id) && ids.size < MAX_TRACKED) {
            ids.add(message.id);
            setParticipants({
              remotes: seen.remote.size,
              followers: seen.follower.size,
              agents: seen.agent.size,
            });
          }
          answerHello();
          if (message.role === "follower") scheduleResync();
          break;
        }
        case "step":
        case "goto": {
          const before = deck?.current()?.address;
          if (message.type === "goto") deck?.goTo(message.address);
          else if (message.direction === 1) deck?.next();
          else deck?.prev();
          // A move announces itself; a press that moved nothing (the last
          // slide, an unknown address) still gets an answer.
          if (deck?.current()?.address === before) void sendState();
          break;
        }
        case "laser":
          setLaser({ x: message.x, y: message.y });
          // A phone's laser is the presenter's laser: followers and the presenter window see it too.
          mirror?.laser(message.x, message.y);
          clearTimeout(laserTimer);
          laserTimer = setTimeout(() => {
            setLaser(null);
            mirror?.laserOff();
          }, LASER_IDLE_MS);
          break;
        case "laser-off":
          clearTimeout(laserTimer);
          setLaser(null);
          mirror?.laserOff();
          break;
        case "state":
        case "countdown":
        case "doc":
        case "slides":
        case "result":
        case "part":
        case "mirror":
          // Only the presenter announces state and answers agents; another tab claiming to is ignored.
          break;
      }
    };

    const conn = connectRoom({
      creds: room,
      role: "presenter",
      onMessage: (message) => {
        if (active) handle(message);
      },
      onStatus: (next) => {
        if (!active) return;
        setStatus(next);
        if (next === "open") {
          setOpened(room.room);
          void announce();
          // Followers that stayed may have missed marks while the socket was down.
          scheduleResync();
        }
      },
      // Someone reached the relay with a seat token first. Their room is not
      // worth keeping: a new one, with new keys and links, is.
      onSeatTaken: () => {
        if (active) setCreds(null);
      },
      ...(socketFactory ? { socketFactory } : {}),
      ...(base ? { base } : {}),
    });
    connection.current = conn;
    const stopMirror = mirror?.addSink(sendOp);
    return () => {
      active = false;
      clearTimeout(laserTimer);
      clearTimeout(resyncTimer);
      clearTimeout(helloStateTimer);
      sentCountdownRef.current = null;
      stopMirror?.();
      conn.close();
      connection.current = null;
      setStatus("connecting");
      setLaser(null);
    };
  }, [room, socketFactory, base, sendState, sendCountdown, mirror]);

  // Subscribing announces the current slide at once, and again on every change,
  // including after the deck is rebuilt or the doc link changes.
  const ready = room !== null;
  useEffect(() => {
    if (!ready || !controller) return;
    docLinkRef.current = docLink;
    return controller.onChange(() => void sendState());
  }, [ready, controller, docLink, sendState]);

  // A change of the countdown reaches the phones at once, also the one that ends it.
  useEffect(() => {
    if (ready) void sendCountdown(countdown, false);
  }, [ready, countdown, sendCountdown]);

  const roomId = creds?.room ?? null;
  const setAllowAgentEdits = useCallback(
    (allow: boolean) => {
      if (roomId !== null) setAgentEdits({ room: roomId, allow });
    },
    [roomId],
  );

  const joinBase = base ?? globalThis.location.href;
  return {
    joinUrls:
      enabled && creds !== null && opened === creds.room
        ? {
            remote: formatJoinUrl(joinBase, "remote", creds),
            follow: formatJoinUrl(joinBase, "follow", creds),
          }
        : null,
    participants,
    status: enabled ? status : "closed",
    laser: enabled ? laser : null,
    docLinkTooLong,
    allowAgentEdits,
    setAllowAgentEdits,
    lastAgentEdit,
  };
}
