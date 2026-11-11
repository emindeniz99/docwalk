import { API_LIMITS, REMOTE_PATH } from "../api/types";
import {
  decrypt,
  encrypt,
  fromBase64Url,
  importKey,
  importSigningKey,
  importVerifyKey,
  randomId,
  toBase64Url,
  type RoomKey,
  type StateKey,
} from "./crypto";
import { PartAssembler, splitMessage } from "./parts";
import { ReplayGuard } from "./replay";
import { PRESENTER_ID, SEAT_TAKEN_CLOSE, type RemoteMessage, type RoomCredentials } from "./types";

/**
 * One participant's connection to a remote-control room (decision 8). The
 * relay forwards frames to every other socket in the room; this client
 * encrypts what it sends, decrypts and validates what it receives, and
 * reconnects on its own. Navigation events are ephemeral: nothing is queued
 * while the socket is down. Instead, remotes, followers and agents send
 * `hello` on every (re)connect and the presenter answers with its current
 * state. They also say hello again when they accept a state from a presenter
 * sender id they have not seen (decision 111): a hello sent while the
 * presenter's socket was down reached nobody, and a reloaded presenter tab
 * starts with no count. Only a state the presenter signed counts, so another
 * key holder cannot make them say hello (decision 118).
 *
 * Keys by role (decision 68): the presenter holds both, remotes and agents
 * the control key, followers the view key. Everything is sent under the
 * control key except a follower's hello (view key) and the presenter's
 * state, which goes out under both so followers and remotes each get it.
 * The presenter accepts nothing under the view key but a follower's hello,
 * so a follow link can neither steer the deck nor talk to agents. Every
 * frame is sealed with this connection's id and counter, and a frame whose
 * counter a receiver has seen from that sender is dropped (replay.ts).
 *
 * Followers share the view key, so it cannot tell them apart from the
 * presenter. The presenter signs every state it sends with the room's
 * private state key, and a follower takes nothing but state that verifies
 * under the public key from its link (decision 73). Every remote and agent
 * holds the control key, so the presenter signs its countdown too, and a
 * remote or agent takes a countdown only when it verifies under the public
 * key its own link carries (decision 117).
 *
 * The client runs in Node too (the `docwalk-mcp` agent, decision 59), so it
 * uses no DOM API beyond what Node 22 also has.
 */

export type RemoteStatus = "connecting" | "open" | "reconnecting" | "closed";
export type RemoteRole = "presenter" | "remote" | "follower" | "agent";

/**
 * - `sent`: handed to the socket.
 * - `queued`: a laser point inside the throttle window; the latest one goes out when it ends.
 * - `not-open`: the socket is down; the message is dropped.
 * - `too-large`: the encrypted frame is over the relay's cap and the message
 *   cannot be split into parts (parts.ts); it is dropped.
 */
type SendResult = "sent" | "queued" | "not-open" | "too-large";

export interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  /** Called once when the socket closes or fails to connect, with the close code when there is one. */
  close(code?: number): void;
}

/** The part of a WebSocket the client uses, so tests can pass a fake relay. */
interface SocketLike {
  send(data: string): void;
  close(): void;
}

/**
 * Opens a socket to `url`. `seat` is the control seat token (`seatToken`),
 * or null for a follower; the browser socket sends it as `?seat=`.
 */
export type SocketFactory = (
  url: string,
  handlers: SocketHandlers,
  seat?: string | null,
) => SocketLike;

export interface RoomConnection {
  /** This participant's id: the hello id, or PRESENTER_ID. Messages with another `to` are not delivered. */
  readonly id: string;
  send(message: RemoteMessage): Promise<SendResult>;
  /** Closes the socket for good: no reconnect, no further callbacks. */
  close(): void;
}

interface ConnectOptions {
  /** The presenter needs both keys, a remote or an agent `key`, a follower `view`; without it the status goes to "closed". */
  creds: RoomCredentials;
  role: RemoteRole;
  /** Called with every message that decrypts and validates, in arrival order. */
  onMessage: (message: RemoteMessage) => void;
  /** Called on every status change. The status starts as "connecting". */
  onStatus: (status: RemoteStatus) => void;
  /**
   * The relay refused this socket's seat token: the room's control seats
   * belong to another key (worker/room.ts, decision 74). With this set, the
   * client closes for good and calls it; without it, it keeps retrying.
   */
  onSeatTaken?: () => void;
  socketFactory?: SocketFactory;
  /** The page the room URL is resolved against; defaults to the current location. */
  base?: string;
}

/** Laser points go out at most this often (about 30 per second). */
export const LASER_INTERVAL_MS = 33;

/** A phone's laser point, or the presenter's mirrored one (decision 88): both share the throttle. */
const isLaser = (message: RemoteMessage) =>
  message.type === "laser" || (message.type === "mirror" && message.op === "laser");
const isLaserOff = (message: RemoteMessage) =>
  message.type === "laser-off" || (message.type === "mirror" && message.op === "laser-off");
export const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * A client says hello again when it accepts a presenter state from a sender
 * id it has not seen (decision 111), at most this often.
 */
export const HELLO_AGAIN_GAP_MS = 1000;

/** How many presenter sender ids a client remembers, so a replay of an earlier tab's states costs no hello. */
const STATE_SENDERS_KEPT = 8;

/** Wait before reconnect attempt `attempt` (0-based): 0.5 s doubling, capped at 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** attempt);
}

/** `wss://<host>/api/remote/<room>`, or `ws:` when the page is served over plain http. */
function roomUrl(room: string, base: string): string {
  const url = new URL(REMOTE_PATH + encodeURIComponent(room), base);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Proof that a socket holds the control key, so the relay seats it in one of
 * the places a follower can never fill (worker/room.ts): HMAC-SHA-256 of the
 * room id under the control key. A follow link carries only the view key and
 * cannot make it; the relay learns nothing about either key from it. Null
 * when `creds` has no control key.
 */
export async function seatToken(creds: RoomCredentials): Promise<string | null> {
  const raw = creds.key === null ? null : fromBase64Url(creds.key);
  if (!raw) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const label = new TextEncoder().encode(`docwalk seat ${creds.room}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, label)));
}

const browserSocket: SocketFactory = (url, handlers, seat) => {
  const socket = new WebSocket(seat ? `${url}?seat=${seat}` : url);
  socket.addEventListener("open", () => handlers.open());
  socket.addEventListener("message", (event) => handlers.message(event.data));
  // An `error` is always followed by `close`, so `close` alone drives reconnects.
  socket.addEventListener("close", (event) => handlers.close(event.code));
  return { send: (data) => socket.send(data), close: () => socket.close(1000) };
};

interface RoleKeys {
  control: RoomKey | null;
  view: RoomKey | null;
  /** The presenter's private state key, when it has one: its states are signed with it. */
  sign: StateKey | null;
  /** The public state key: a follower takes only state that verifies under it, a remote or agent only such a countdown. */
  verify: StateKey | null;
}

/** Imports the keys `role` uses; rejects when the link lacks one (a follow link opened as a remote). */
async function importRoleKeys(creds: RoomCredentials, role: RemoteRole): Promise<RoleKeys> {
  const control = role === "follower" ? null : creds.key;
  const view = role === "presenter" || role === "follower" ? creds.view : null;
  const sign = role === "presenter" ? (creds.sign ?? null) : null;
  const verify = role === "presenter" ? null : (creds.verify ?? null);
  if (
    (role !== "follower" && control === null) ||
    (role !== "remote" && role !== "agent" && view === null) ||
    (role === "follower" && verify === null)
  ) {
    throw new Error(`This join link has no key for a ${role}.`);
  }
  const stateKey = async (key: Promise<RoomKey>) => ({ room: creds.room, key: await key });
  const [controlKey, viewKey, signKey, verifyKey] = await Promise.all([
    control === null ? null : importKey(control),
    view === null ? null : importKey(view),
    sign === null ? null : stateKey(importSigningKey(sign)),
    verify === null ? null : stateKey(importVerifyKey(verify)),
  ]);
  return { control: controlKey, view: viewKey, sign: signKey, verify: verifyKey };
}

/** The browser's reportError; Node has none, so the agent logs to stderr instead. */
function reportError(error: unknown) {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (report) report(error);
  else console.error(error);
}

export function connectRoom({
  creds,
  role,
  onMessage,
  onStatus,
  onSeatTaken,
  socketFactory = browserSocket,
  // Node has no location: the agent (mcp/) always passes the join link as `base`.
  base = (globalThis as { location?: { href: string } }).location?.href ?? "",
}: ConnectOptions): RoomConnection {
  const url = roomUrl(creds.room, base);
  const helloId = randomId();
  const self = role === "presenter" ? PRESENTER_ID : helloId;
  const assembler = new PartAssembler(self);
  const keysPromise = importRoleKeys(creds, role);
  const seatPromise = role === "follower" ? Promise.resolve(null) : seatToken(creds);
  let seat: string | null = null;
  // This connection's seal (crypto.ts): a random sender id and a counter.
  const sender = randomId();
  let counter = 0;
  // One guard per key: a view-key holder must not be able to push a
  // control-key sender's counter forward and get its frames dropped.
  const guards = { control: new ReplayGuard(), view: new ReplayGuard() };

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
  // Hello again (decision 111): the sender ids of the last presenter states taken, oldest first.
  const stateSenders: string[] = [];
  let lastAgainAt = Number.NEGATIVE_INFINITY;
  let againTimer: ReturnType<typeof setTimeout> | undefined;
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
      socket = socketFactory(
        url,
        {
          open: () => {
            if (!current()) return;
            attempt = 0;
            setStatus("open");
            if (role !== "presenter") void transmit({ type: "hello", role, id: helloId });
          },
          message: (data) => {
            if (current()) receive(data);
          },
          close: (code) => {
            if (!current()) return;
            if (code === SEAT_TAKEN_CLOSE && onSeatTaken) {
              stop();
              onSeatTaken();
            } else {
              scheduleReconnect();
            }
          },
        },
        seat,
      );
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
        const sealed = await unseal(await keysPromise, frame);
        let message = sealed?.message ?? null;
        if (message?.type === "part") message = await assembler.add(message);
        // An answer for another agent is not this participant's business.
        if (message && "to" in message && message.to !== self) return;
        if (!message || closed) return;
        if (sealed?.signed && role !== "presenter" && message.type === "state") {
          noteStateSender(sealed.sender);
        }
        onMessage(message);
      })
      // A handler that throws (a deck torn down mid-rebuild) must not reject
      // the chain: every later frame would be skipped until a reload. The
      // error is still reported, not swallowed.
      .catch(reportError);
  }

  /**
   * The message in `frame`, its sender id and whether the presenter signed it, if it decrypts
   * under a key this role holds, is new, and that key may carry it.
   */
  async function unseal(
    keys: RoleKeys,
    frame: unknown,
  ): Promise<{ message: RemoteMessage; sender: string; signed: boolean } | null> {
    if (keys.control) {
      const sealed = await decrypt(keys.control, frame, keys.verify ?? undefined);
      if (sealed) {
        // Any remote or agent could have sealed a countdown: only the presenter's signature
        // makes it the presenter window's (decision 117).
        if (sealed.message.type === "countdown" && role !== "presenter" && !sealed.signed) {
          return null;
        }
        return guards.control.accept(sealed.sender, sealed.counter)
          ? { message: sealed.message, sender: sealed.sender, signed: sealed.signed }
          : null;
      }
    }
    if (!keys.view) return null;
    const sealed = await decrypt(keys.view, frame, keys.verify ?? undefined);
    if (!sealed) return null;
    // A follow link only follows: the presenter takes nothing else under the view key.
    const { message } = sealed;
    if (role === "presenter" && !(message.type === "hello" && message.role === "follower")) {
      return null;
    }
    // Any follower could have sealed it: only the presenter's signature makes a state, or the
    // laser, marks and focus view it mirrors (decision 88), true.
    if (
      role === "follower" &&
      !((message.type === "state" || message.type === "mirror") && sealed.signed)
    ) {
      return null;
    }
    // Counters are recorded only for frames this role takes. Recording one
    // first let any view-key holder seal a frame under the presenter's sender
    // id with the largest counter, so followers dropped every real state, or
    // flood the table until the presenter's entry was evicted.
    return guards.view.accept(sealed.sender, sealed.counter)
      ? { message, sender: sealed.sender, signed: sealed.signed }
      : null;
  }

  /** A signed state from a sender id not among the last few: say hello again. */
  function noteStateSender(from: string) {
    if (stateSenders.includes(from)) return;
    stateSenders.push(from);
    if (stateSenders.length > STATE_SENDERS_KEPT) stateSenders.shift();
    const wait = lastAgainAt + HELLO_AGAIN_GAP_MS - Date.now();
    if (wait <= 0) sendHelloAgain();
    else againTimer ??= setTimeout(sendHelloAgain, wait);
  }

  function sendHelloAgain() {
    againTimer = undefined;
    if (closed || status !== "open" || role === "presenter") return;
    lastAgainAt = Date.now();
    void transmit({ type: "hello", role, id: helloId });
  }

  /** `message` encrypted under `key` with the next counter, as wire text; a state, mirror or countdown message is signed when this role can. */
  async function seal(keys: RoleKeys, key: RoomKey, message: RemoteMessage): Promise<string> {
    const signed =
      message.type === "state" || message.type === "mirror" || message.type === "countdown";
    const signer = signed ? (keys.sign ?? undefined) : undefined;
    return JSON.stringify(await encrypt(key, message, { sender, counter: ++counter }, signer));
  }

  function transmit(message: RemoteMessage): Promise<SendResult> {
    const result = outbound.then(async (): Promise<SendResult> => {
      if (status !== "open" || !socket) return "not-open";
      const keys = await keysPromise;
      // State goes to followers (view key) and remotes and agents (control key). What the
      // presenter mirrors goes to followers alone: remotes and agents never receive it.
      const targets = (
        message.type === "state"
          ? [keys.view, keys.control]
          : message.type === "mirror"
            ? [keys.view]
            : [keys.control ?? keys.view]
      ).filter((key): key is RoomKey => key !== null);
      if (targets.length === 0) return "not-open";
      const frames: string[] = [];
      for (const key of targets) frames.push(await seal(keys, key, message));
      // Base64url and JSON are ASCII, so length equals bytes.
      if (frames.every((frame) => frame.length <= API_LIMITS.maxFrameBytes)) {
        if (status !== "open" || !socket) return "not-open";
        for (const frame of frames) socket.send(frame);
        return "sent";
      }
      const [key] = targets;
      const parts = await splitMessage(message, "to" in message ? message.to : PRESENTER_ID);
      if (!parts || !key || targets.length !== 1) return "too-large";
      for (const part of parts) {
        const partFrame = await seal(keys, key, part);
        if (partFrame.length > API_LIMITS.maxFrameBytes) return "too-large";
        if (status !== "open" || !socket) return "not-open";
        socket.send(partFrame);
      }
      return "sent";
    });
    outbound = result.catch(() => undefined);
    return result;
  }

  function stop() {
    if (closed) return;
    closed = true;
    generation++;
    // Guarded: the Workers runtime types (worker/room.test.ts runs this client) take no undefined.
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (laserTimer !== undefined) clearTimeout(laserTimer);
    if (againTimer !== undefined) clearTimeout(againTimer);
    socket?.close();
    socket = null;
    setStatus("closed");
  }

  function flushLaser() {
    laserTimer = undefined;
    if (!pendingLaser) return;
    const message = pendingLaser;
    pendingLaser = null;
    lastLaserAt = Date.now();
    void transmit(message);
  }

  Promise.all([keysPromise, seatPromise]).then(
    ([, token]) => {
      seat = token;
      open();
    },
    () => {
      closed = true;
      setStatus("closed");
    },
  );

  return {
    id: self,
    send(message) {
      if (closed) return Promise.resolve("not-open");
      if (isLaser(message)) {
        const wait = lastLaserAt + LASER_INTERVAL_MS - Date.now();
        if (wait > 0) {
          pendingLaser = message;
          laserTimer ??= setTimeout(flushLaser, wait);
          return Promise.resolve("queued");
        }
        lastLaserAt = Date.now();
      } else if (isLaserOff(message)) {
        // A point still waiting would bring the laser back after it was hidden.
        if (laserTimer !== undefined) clearTimeout(laserTimer);
        laserTimer = undefined;
        pendingLaser = null;
      }
      return transmit(message);
    },
    close: stop,
  };
}
