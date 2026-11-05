import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as v from "valibot";
import type { DeckController } from "../deck/controller";
import type { LevelOption } from "../sectioning/sectionize";
import { connectRoom, type RemoteStatus, type RoomConnection, type SocketFactory } from "./client";
import {
  createRoomCredentials,
  formatJoinUrl,
  MAX_TITLE_CHARS,
  RoomCredentialsSchema,
} from "./crypto";
import type { RemoteMessage, RoomCredentials } from "./types";

/**
 * The presenter's side of remote control (decision 8). The presenter's deck
 * stays the source of truth: it announces its state on join, on every slide
 * change and in answer to every step or goto (so a remote can tell that a
 * presenter is there), and applies navigation that remotes ask for.
 */

/** sessionStorage key: the room survives a reload of the presenter tab, so phones stay joined. */
export const ROOM_STORAGE_KEY = "docwalk.remote-room";
/** A remote laser point disappears after this long without an update (a phone that dropped out). */
export const LASER_IDLE_MS = 3000;
/** Distinct participant ids remembered per role; a hostile key holder cannot grow this without bound. */
const MAX_TRACKED = 1000;

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
}

export interface RemoteHost {
  joinUrls: { remote: string; follow: string };
  /** Devices that joined this session, counted once each. Departures are not reported by the relay. */
  participants: { remotes: number; followers: number };
  /** "closed" while disabled. */
  status: RemoteStatus;
  /** The latest laser point from a remote in slide coordinates (0..1), or null when hidden. */
  laser: { x: number; y: number } | null;
  /** True when followers get no document link: too long for a link, or for the relay's frame. */
  docLinkTooLong: boolean;
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

function readStoredCredentials(): RoomCredentials | null {
  try {
    const raw = storage()?.getItem(ROOM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = v.safeParse(RoomCredentialsSchema, JSON.parse(raw));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function storeCredentials(creds: RoomCredentials) {
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
}: RemoteHostOptions): RemoteHost {
  const [creds, setCreds] = useState(() => readStoredCredentials() ?? createRoomCredentials());
  /** The room this tab holds (see claimRoom); nothing connects before that. */
  const [claimed, setClaimed] = useState<string | null>(null);
  const [status, setStatus] = useState<RemoteStatus>("connecting");
  const [participants, setParticipants] = useState({ remotes: 0, followers: 0 });
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [docLinkTooLong, setDocLinkTooLong] = useState(false);

  const connection = useRef<RoomConnection | null>(null);
  const controllerRef = useRef(controller);
  const docLinkRef = useRef(docLink);
  const levelRef = useRef(level);
  useLayoutEffect(() => {
    controllerRef.current = controller;
    levelRef.current = level;
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

  useEffect(() => {
    if (!enabled) return;
    storeCredentials(creds);
    if (claimed === creds.room) return;
    let active = true;
    void claimRoom(creds.room).then((ok) => {
      if (!active) return;
      if (ok) setClaimed(creds.room);
      else setCreds(createRoomCredentials());
    });
    return () => {
      active = false;
    };
  }, [enabled, claimed, creds]);
  const ready = enabled && claimed === creds.room;

  useEffect(() => {
    if (!ready) return;
    const seen = { remote: new Set<string>(), follower: new Set<string>() };
    let laserTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const handle = (message: RemoteMessage) => {
      const deck = controllerRef.current;
      switch (message.type) {
        case "hello": {
          const ids = seen[message.role];
          if (!ids.has(message.id) && ids.size < MAX_TRACKED) {
            ids.add(message.id);
            setParticipants({ remotes: seen.remote.size, followers: seen.follower.size });
          }
          void sendState();
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
          clearTimeout(laserTimer);
          laserTimer = setTimeout(() => setLaser(null), LASER_IDLE_MS);
          break;
        case "laser-off":
          clearTimeout(laserTimer);
          setLaser(null);
          break;
        case "state":
          // Only the presenter announces state; another tab claiming to is ignored.
          break;
      }
    };

    const conn = connectRoom({
      creds,
      role: "presenter",
      onMessage: (message) => {
        if (active) handle(message);
      },
      onStatus: (next) => {
        if (!active) return;
        setStatus(next);
        if (next === "open") void sendState();
      },
      ...(socketFactory ? { socketFactory } : {}),
      ...(base ? { base } : {}),
    });
    connection.current = conn;
    return () => {
      active = false;
      clearTimeout(laserTimer);
      conn.close();
      connection.current = null;
      setStatus("connecting");
      setLaser(null);
    };
  }, [ready, creds, socketFactory, base, sendState]);

  // Subscribing announces the current slide at once, and again on every change,
  // including after the deck is rebuilt or the doc link changes.
  useEffect(() => {
    if (!ready || !controller) return;
    docLinkRef.current = docLink;
    return controller.onChange(() => void sendState());
  }, [ready, controller, docLink, sendState]);

  const joinBase = base ?? globalThis.location.href;
  return {
    joinUrls: {
      remote: formatJoinUrl(joinBase, "remote", creds),
      follow: formatJoinUrl(joinBase, "follow", creds),
    },
    participants,
    status: enabled ? status : "closed",
    laser: enabled ? laser : null,
    docLinkTooLong,
  };
}
