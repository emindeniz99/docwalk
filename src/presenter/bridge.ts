import * as v from "valibot";
import type { MirrorFeed } from "../annotate/mirrorFeed";
import { MirrorMessageSchema } from "../annotate/mirrorSchema";
import { RESYNC_MIN_GAP_MS, type MirrorOp } from "../annotate/mirrorTypes";
import { CountdownSchema, type Countdown } from "./pacing";
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
  // The stored schema holds 80's limits; the room's message checks them again (decision 112).
  v.object({ type: v.literal("countdown"), countdown: v.nullable(CountdownSchema) }),
]);

interface PresenterBridgeOptions {
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
  /**
   * The presenter window's countdown, as it last sent it (decision 112); null
   * once it is reset, and null again when no request came for
   * `DISCONNECT_AFTER_MS`, which is how a closed window clears the phone's clock.
   */
  onCountdown?: (countdown: Countdown | null) => void;
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
  // A presenter window repeats its countdown with each heartbeat: one that
  // stops is gone, and so is its clock. The timer runs from the start too, so
  // a bridge that restarts (a rebuilt deck) clears a clock whose window closed
  // meanwhile; a window that is still there speaks again within a heartbeat.
  let countdownExpiry: ReturnType<typeof setTimeout> | undefined;
  const armCountdownExpiry = () => {
    clearTimeout(countdownExpiry);
    countdownExpiry = setTimeout(() => options.onCountdown?.(null), DISCONNECT_AFTER_MS);
  };
  if (options.onCountdown) armCountdownExpiry();
  channel.listen((data) => {
    const parsed = v.safeParse(PresenterRequest, data);
    if (!parsed.success) return;
    const request = parsed.output;
    if (request.type === "hello") {
      post();
      if (request.resync && options.mirror) askResync(options.mirror);
    } else if (request.type === "goto") options.goTo(request.address);
    else if (request.type === "step") options.step(request.direction);
    else {
      armCountdownExpiry();
      options.onCountdown?.(request.countdown);
    }
  });
  const unsubscribe = options.subscribe(post);
  const stopMirror = options.mirror?.addSink(postOp);
  post();
  return () => {
    clearTimeout(resyncTimer);
    clearTimeout(countdownExpiry);
    unsubscribe();
    stopMirror?.();
    channel.close();
  };
}

export interface PresenterConnection {
  goTo(address: string): void;
  step(direction: 1 | -1): void;
  /**
   * Tells the audience tab the window's countdown at once, and again after each
   * heartbeat hello while there is one, so closing the window ends it (decision
   * 112). Null (a Reset) is posted once, and not at all for a window that had none.
   */
  setCountdown(countdown: Countdown | null): void;
  close(): void;
}

interface ConnectPresenterOptions {
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
  let closed = false;
  /** The window's countdown, which the heartbeat repeats; null or undefined: nothing to repeat. */
  let countdown: Countdown | null | undefined;

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
  const heartbeat = setInterval(() => {
    send({ type: "hello" });
    if (countdown) send({ type: "countdown", countdown });
  }, HEARTBEAT_MS);

  return {
    goTo: (target) => send({ type: "goto", address: target }),
    step: (direction) => send({ type: "step", direction }),
    setCountdown(next) {
      // A window opened with none has nothing to take back: posting null would wipe the
      // clock of another presenter window. A Reset posts null once; the audience tab's 5 s
      // expiry covers a null that went missing.
      const hadNone = countdown === undefined || countdown === null;
      countdown = next;
      if (closed || (next === null && hadNone)) return;
      send({ type: "countdown", countdown: next });
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(silence);
      channel.close();
    },
  };
}
