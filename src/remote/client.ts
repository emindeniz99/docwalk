import { API_LIMITS, REMOTE_PATH } from "../api/types";
import { decrypt, encrypt, importKey, randomId } from "./crypto";
import type { RemoteMessage, RoomCredentials } from "./types";

/**
 * One participant's connection to a remote-control room (decision 8). The
 * relay forwards frames to every other socket in the room; this client
 * encrypts what it sends, decrypts and validates what it receives, and
 * reconnects on its own. Navigation events are ephemeral: nothing is queued
 * while the socket is down. Instead, remotes and followers send `hello` on
 * every (re)connect and the presenter answers with its current state.
 */

export type RemoteStatus = "connecting" | "open" | "reconnecting" | "closed";
export type RemoteRole = "presenter" | "remote" | "follower";

/**
 * - `sent`: handed to the socket.
 * - `queued`: a laser point inside the throttle window; the latest one goes out when it ends.
 * - `not-open`: the socket is down; the message is dropped.
 * - `too-large`: the encrypted frame is over the relay's cap; the message is dropped.
 */
export type SendResult = "sent" | "queued" | "not-open" | "too-large";

export interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  /** Called once when the socket closes or fails to connect. */
  close(): void;
}

/** The part of a WebSocket the client uses, so tests can pass a fake relay. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

export interface RoomConnection {
  send(message: RemoteMessage): Promise<SendResult>;
  /** Closes the socket for good: no reconnect, no further callbacks. */
  close(): void;
}

export interface ConnectOptions {
  creds: RoomCredentials;
  role: RemoteRole;
  /** Called with every message that decrypts and validates, in arrival order. */
  onMessage: (message: RemoteMessage) => void;
  /** Called on every status change. The status starts as "connecting". */
  onStatus: (status: RemoteStatus) => void;
  socketFactory?: SocketFactory;
  /** The page the room URL is resolved against; defaults to the current location. */
  base?: string;
}

/** Laser points go out at most this often (about 30 per second). */
export const LASER_INTERVAL_MS = 33;
export const MAX_RECONNECT_DELAY_MS = 10_000;

/** Wait before reconnect attempt `attempt` (0-based): 0.5 s doubling, capped at 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** attempt);
}

/** `wss://<host>/api/remote/<room>`, or `ws:` when the page is served over plain http. */
export function roomUrl(room: string, base: string): string {
  const url = new URL(REMOTE_PATH + encodeURIComponent(room), base);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.search = "";
  url.hash = "";
  return url.href;
}

const browserSocket: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.open());
  socket.addEventListener("message", (event) => handlers.message(event.data));
  // An `error` is always followed by `close`, so `close` alone drives reconnects.
  socket.addEventListener("close", () => handlers.close());
  return { send: (data) => socket.send(data), close: () => socket.close(1000) };
};

export function connectRoom({
  creds,
  role,
  onMessage,
  onStatus,
  socketFactory = browserSocket,
  base = globalThis.location.href,
}: ConnectOptions): RoomConnection {
  const url = roomUrl(creds.room, base);
  const helloId = randomId();
  const keyPromise = importKey(creds.key);

  let status: RemoteStatus = "connecting";
  let socket: SocketLike | null = null;
  let closed = false;
  let attempt = 0;
  // Events from a socket this client already replaced or closed are ignored.
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let laserTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLaserAt = Number.NEGATIVE_INFINITY;
  let pendingLaser: RemoteMessage | null = null;
  // Encryption and decryption are async; chaining keeps both directions in order.
  let inbound: Promise<void> = Promise.resolve();
  let outbound: Promise<unknown> = Promise.resolve();

  const setStatus = (next: RemoteStatus) => {
    if (status === next) return;
    status = next;
    onStatus(next);
  };

  const scheduleReconnect = () => {
    socket = null;
    setStatus("reconnecting");
    retryTimer = setTimeout(open, reconnectDelay(attempt++));
  };

  function open() {
    if (closed) return;
    const gen = ++generation;
    const current = () => gen === generation && !closed;
    try {
      socket = socketFactory(url, {
        open: () => {
          if (!current()) return;
          attempt = 0;
          setStatus("open");
          if (role !== "presenter") void transmit({ type: "hello", role, id: helloId });
        },
        message: (data) => {
          if (current()) receive(data);
        },
        close: () => {
          if (current()) scheduleReconnect();
        },
      });
    } catch {
      scheduleReconnect();
    }
  }

  function receive(data: unknown) {
    if (typeof data !== "string" || data.length > API_LIMITS.maxFrameBytes) return;
    inbound = inbound
      .then(async () => {
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        const message = await decrypt(await keyPromise, frame);
        if (message && !closed) onMessage(message);
      })
      // A handler that throws (a deck torn down mid-rebuild) must not reject
      // the chain: every later frame would be skipped until a reload. The
      // error is still reported, not swallowed.
      .catch((error: unknown) => globalThis.reportError(error));
  }

  function transmit(message: RemoteMessage): Promise<SendResult> {
    const result = outbound.then(async (): Promise<SendResult> => {
      if (status !== "open" || !socket) return "not-open";
      const frame = JSON.stringify(await encrypt(await keyPromise, message));
      // Base64url and JSON are ASCII, so length equals bytes.
      if (frame.length > API_LIMITS.maxFrameBytes) return "too-large";
      if (status !== "open" || !socket) return "not-open";
      socket.send(frame);
      return "sent";
    });
    outbound = result.catch(() => undefined);
    return result;
  }

  function flushLaser() {
    laserTimer = undefined;
    if (!pendingLaser) return;
    const message = pendingLaser;
    pendingLaser = null;
    lastLaserAt = Date.now();
    void transmit(message);
  }

  keyPromise.then(open, () => {
    closed = true;
    setStatus("closed");
  });

  return {
    send(message) {
      if (closed) return Promise.resolve("not-open");
      if (message.type === "laser") {
        const wait = lastLaserAt + LASER_INTERVAL_MS - Date.now();
        if (wait > 0) {
          pendingLaser = message;
          laserTimer ??= setTimeout(flushLaser, wait);
          return Promise.resolve("queued");
        }
        lastLaserAt = Date.now();
      } else if (message.type === "laser-off") {
        // A point still waiting would bring the laser back after it was hidden.
        clearTimeout(laserTimer);
        laserTimer = undefined;
        pendingLaser = null;
      }
      return transmit(message);
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      clearTimeout(retryTimer);
      clearTimeout(laserTimer);
      socket?.close();
      socket = null;
      setStatus("closed");
    },
  };
}
