import * as v from "valibot";
import type { MirrorFeed } from "../annotate/mirrorFeed";
import { MirrorMessageSchema } from "../annotate/mirrorSchema";
import { RESYNC_MIN_GAP_MS, type MirrorOp } from "../annotate/mirrorTypes";
import { PRESENTER_CHANNEL, type PresenterMessage } from "./types";

/**
 * Same-machine presenter bridge (decision 8). The audience window owns the
 * deck and announces its state; presenter windows render previews from that
 * state and ask for navigation. Everything that arrives over the channel is
 * validated first (decision 46): another tab of the same origin, an older
 * build or a buggy extension can post anything on a named channel.
 */

/** The audience's full state, as carried by a `state` message. */
export type PresenterState = Omit<Extract<PresenterMessage, { type: "state" }>, "type">;

/** The part of `BroadcastChannel` the bridge uses, so tests can pass a fake. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  /** Receives the `data` of every message from other channels of the same name. */
  listen(listener: (data: unknown) => void): void;
  /** Stops delivery and sending; listeners are dropped with the channel. */
  close(): void;
}

export type ChannelFactory = (name: string) => ChannelLike;

const browserChannel: ChannelFactory = (name) => {
  const channel = new BroadcastChannel(name);
  return {
    // BroadcastChannel is same-origin by construction and takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    postMessage: (message) => channel.postMessage(message),
    listen: (listener) =>
      channel.addEventListener("message", (event) => listener((event as MessageEvent).data)),
    close: () => channel.close(),
  };
};

/** A presenter window asks for the state this often; the audience answers each time. */
export const HEARTBEAT_MS = 2000;
/** With no state for this long, the presenter reports the audience as gone. */
export const DISCONNECT_AFTER_MS = 5000;

// Generous ceilings: they only stop a hostile sender from making the
// presenter parse and render an unbounded payload.
const MAX_MARKDOWN_CHARS = 5_000_000;
const MAX_SLIDES = 10_000;
const MAX_ADDRESS_CHARS = 512;

const address = v.pipe(v.string(), v.maxLength(MAX_ADDRESS_CHARS));
const headingDepth = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6));

const StateMessage = v.object({
  type: v.literal("state"),
  markdown: v.pipe(v.string(), v.maxLength(MAX_MARKDOWN_CHARS)),
  level: v.union([
    v.literal("auto"),
    headingDepth,
    v.pipe(v.array(headingDepth), v.minLength(1), v.maxLength(6)),
  ]),
  current: address,
  // The slide list keys its items by address: an empty or repeated one
  // would break the list, and the audience never produces either.
  addresses: v.pipe(
    v.array(v.pipe(address, v.minLength(1))),
    v.maxLength(MAX_SLIDES),
    v.check((list) => new Set(list).size === list.length, "addresses must be unique"),
  ),
  startedAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** What the audience accepts: requests from presenter windows only. */
const PresenterRequest = v.variant("type", [
  v.object({ type: v.literal("hello"), resync: v.optional(v.boolean()) }),
  v.object({ type: v.literal("goto"), address: v.pipe(address, v.minLength(1)) }),
  v.object({ type: v.literal("step"), direction: v.picklist([1, -1]) }),
]);

export interface PresenterBridgeOptions {
  getState: () => PresenterState;
  goTo: (address: string) => boolean;
  step: (direction: 1 | -1) => void;
  /** Calls `onChange` after every deck change; returns an unsubscribe function. */
  subscribe: (onChange: () => void) => () => void;
  /**
   * The laser and marks the audience window shows (decision 88). The window
   * sends them to presenter windows as `mirror` messages, and sends the
   * current slide's marks again to one that says hello for the first time,
   * at most once per 2 s (decision 103).
   * The focus views (diagram, code, table and image) stay out: the presenter
   * window shows scaled, inert copies of the slides.
   */
  mirror?: MirrorFeed;
  channel?: ChannelFactory;
}

/**
 * Audience side. Posts the state on start, on every change and whenever a
 * presenter says hello; applies valid `goto`/`step` requests and drops
 * everything else. Returns a function that stops the bridge.
 */
export function startPresenterBridge(options: PresenterBridgeOptions): () => void {
  const channel = (options.channel ?? browserChannel)(PRESENTER_CHANNEL);
  const post = () => {
    const message: PresenterMessage = { type: "state", ...options.getState() };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(message);
  };
  const postOp = (op: MirrorOp) => {
    if (op.op.startsWith("focus")) return;
    const message: PresenterMessage = { type: "mirror", ...op };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(message);
  };
  // At most one resync per gap, whoever asks (decision 103); one asked for
  // inside the gap runs at its end, so a second window still gets the marks.
  let lastResync = Number.NEGATIVE_INFINITY;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  const resync = (mirror: MirrorFeed) => {
    resyncTimer = undefined;
    lastResync = Date.now();
    mirror.resync(postOp);
  };
  const askResync = (mirror: MirrorFeed) => {
    if (resyncTimer !== undefined) return;
    const wait = lastResync + RESYNC_MIN_GAP_MS - Date.now();
    if (wait > 0) resyncTimer = setTimeout(() => resync(mirror), wait);
    else resync(mirror);
  };
  channel.listen((data) => {
    const parsed = v.safeParse(PresenterRequest, data);
    if (!parsed.success) return;
    const request = parsed.output;
    if (request.type === "hello") {
      post();
      if (request.resync && options.mirror) askResync(options.mirror);
    } else if (request.type === "goto") options.goTo(request.address);
    else options.step(request.direction);
  });
  const unsubscribe = options.subscribe(post);
  const stopMirror = options.mirror?.addSink(postOp);
  post();
  return () => {
    clearTimeout(resyncTimer);
    unsubscribe();
    stopMirror?.();
    channel.close();
  };
}

export interface PresenterConnection {
  goTo(address: string): void;
  step(direction: 1 | -1): void;
  close(): void;
}

export interface ConnectPresenterOptions {
  /** `false` when no state arrived for `DISCONNECT_AFTER_MS`, `true` when one arrives again. */
  onConnectionChange?: (connected: boolean) => void;
  /** Called with each laser or mark op from the audience window that validates (decision 88). */
  onMirror?: (op: MirrorOp) => void;
  channel?: ChannelFactory;
}

/**
 * Presenter side. Says hello on connect and every `HEARTBEAT_MS`, so it
 * finds an audience window that started later and notices one that closed;
 * passes on only `state` and `mirror` messages that validate. The first
 * hello also asks for the current slide's marks, which the heartbeat does not.
 */
export function connectPresenter(
  onState: (state: PresenterState) => void,
  options: ConnectPresenterOptions = {},
): PresenterConnection {
  const channel = (options.channel ?? browserChannel)(PRESENTER_CHANNEL);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  const send = (message: PresenterMessage) => channel.postMessage(message);
  let connected = false;
  let silence: ReturnType<typeof setTimeout> | undefined;

  const setConnected = (next: boolean) => {
    if (next === connected) return;
    connected = next;
    options.onConnectionChange?.(next);
  };

  channel.listen((data) => {
    const mirrored = v.safeParse(MirrorMessageSchema, data);
    if (mirrored.success) {
      const { type: _kind, ...op } = mirrored.output;
      options.onMirror?.(op);
      return;
    }
    const parsed = v.safeParse(StateMessage, data);
    if (!parsed.success) return;
    const { type: _type, ...state } = parsed.output;
    clearTimeout(silence);
    silence = setTimeout(() => setConnected(false), DISCONNECT_AFTER_MS);
    setConnected(true);
    onState(state);
  });

  send({ type: "hello", resync: true });
  const heartbeat = setInterval(() => send({ type: "hello" }), HEARTBEAT_MS);

  return {
    goTo: (target) => send({ type: "goto", address: target }),
    step: (direction) => send({ type: "step", direction }),
    close() {
      clearInterval(heartbeat);
      clearTimeout(silence);
      channel.close();
    },
  };
}
