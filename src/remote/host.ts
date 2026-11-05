import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as v from "valibot";
import type { DeckController } from "../deck/controller";
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
 * stays the source of truth: it announces its state on join and on every
 * slide change, and applies navigation that remotes ask for.
 */

/** sessionStorage key: the room survives a reload of the presenter tab, so phones stay joined. */
export const ROOM_STORAGE_KEY = "docwalk.remote-room";
/** A remote laser point disappears after this long without an update (a phone that dropped out). */
export const LASER_IDLE_MS = 3000;
/** Distinct participant ids remembered per role; a hostile key holder cannot grow this without bound. */
const MAX_TRACKED = 1000;

export interface RemoteHostOptions {
  controller: DeckController | null;
  /** Share link for followers (`?src=`, `?repo=` or `#doc=`); null when the document has none. */
  docLink: string | null;
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
  /** True when the doc link made the state frame too large for the relay and followers got none. */
  docLinkTooLong: boolean;
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
  enabled,
  socketFactory,
  base,
}: RemoteHostOptions): RemoteHost {
  const [creds] = useState(() => readStoredCredentials() ?? createRoomCredentials());
  const [status, setStatus] = useState<RemoteStatus>("connecting");
  const [participants, setParticipants] = useState({ remotes: 0, followers: 0 });
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [docLinkTooLong, setDocLinkTooLong] = useState(false);

  const connection = useRef<RoomConnection | null>(null);
  const controllerRef = useRef(controller);
  const docLinkRef = useRef(docLink);
  useLayoutEffect(() => {
    controllerRef.current = controller;
  });

  // Reads everything through refs, so it is stable and the connection is never restarted for it.
  const sendState = useCallback(async () => {
    const conn = connection.current;
    const deck = controllerRef.current;
    const slide = deck?.current();
    if (!conn || !deck || !slide) return;
    const state: RemoteMessage = {
      type: "state",
      current: slide.address,
      index: slide.index,
      total: deck.slides().length,
      title: slide.title.slice(0, MAX_TITLE_CHARS),
      docLink: docLinkRef.current,
    };
    const result = await conn.send(state);
    if (result === "too-large" && state.docLink) {
      // Navigation still works without the link; the join dialog says followers need the document.
      if ((await conn.send({ ...state, docLink: null })) === "sent") setDocLinkTooLong(true);
    } else if (result === "sent") {
      setDocLinkTooLong(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    storeCredentials(creds);
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
          if (message.direction === 1) deck?.next();
          else deck?.prev();
          break;
        case "goto":
          deck?.goTo(message.address);
          break;
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
  }, [enabled, creds, socketFactory, base, sendState]);

  // Subscribing announces the current slide at once, and again on every change,
  // including after the deck is rebuilt or the doc link changes.
  useEffect(() => {
    if (!enabled || !controller) return;
    docLinkRef.current = docLink;
    return controller.onChange(() => void sendState());
  }, [enabled, controller, docLink, sendState]);

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
