// The channels here are BroadcastChannel stand-ins, which take no target origin.
/* oxlint-disable unicorn/require-post-message-target-origin */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MirrorFeed } from "../annotate/mirrorFeed";
import { RESYNC_MIN_GAP_MS, type MarkStroke, type MirrorOp } from "../annotate/mirrorTypes";
import {
  connectPresenter,
  DISCONNECT_AFTER_MS,
  HEARTBEAT_MS,
  startPresenterBridge,
  type ChannelFactory,
  type ChannelLike,
  type PresenterState,
} from "./bridge";
import { PRESENTER_CHANNEL } from "./types";

/**
 * An in-memory stand-in for BroadcastChannel: a message reaches every other
 * channel with the same name, never its sender, as a structured clone.
 */
function createHub() {
  const members = new Set<{ name: string; listeners: ((data: unknown) => void)[] }>();
  const names: string[] = [];
  const factory: ChannelFactory = (name) => {
    names.push(name);
    const self = { name, listeners: [] as ((data: unknown) => void)[] };
    members.add(self);
    const channel: ChannelLike = {
      postMessage(message) {
        if (!members.has(self)) throw new Error("posted on a closed channel");
        for (const other of members) {
          if (other === self || other.name !== name) continue;
          for (const listener of other.listeners) listener(structuredClone(message));
        }
      },
      listen: (listener) => self.listeners.push(listener),
      close: () => members.delete(self),
    };
    return channel;
  };
  /** A raw channel on the hub, to play a hostile or broken peer. */
  const peer = () => {
    const received: unknown[] = [];
    const channel = factory(PRESENTER_CHANNEL);
    channel.listen((data) => received.push(data));
    return { channel, received };
  };
  return { factory, peer, names, size: () => members.size };
}

const STATE: PresenterState = {
  markdown: "# Doc\n\n## One\n\nText\n\n## Two\n\nMore",
  level: "auto",
  current: "one/1",
  addresses: ["doc/1", "one/1", "two/1"],
  startedAt: 1_700_000_000_000,
};

function audience(hub: ReturnType<typeof createHub>, state: { value: PresenterState }) {
  let notify: (() => void) | undefined;
  const goTo = vi.fn<(address: string) => boolean>(() => true);
  const step = vi.fn<(direction: 1 | -1) => void>();
  const unsubscribe = vi.fn<() => void>();
  const stop = startPresenterBridge({
    getState: () => state.value,
    goTo,
    step,
    subscribe: (onChange) => {
      notify = onChange;
      return unsubscribe;
    },
    channel: hub.factory,
  });
  return { stop, goTo, step, unsubscribe, change: () => notify?.() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audience bridge", () => {
  test("announces the state on start, so a presenter that is already open fills in at once", () => {
    const hub = createHub();
    const watcher = hub.peer();
    audience(hub, { value: STATE });
    expect(hub.names).toContain(PRESENTER_CHANNEL);
    expect(watcher.received).toEqual([{ type: "state", ...STATE }]);
  });

  test("announces every change, so the presenter's previews follow the room", () => {
    const hub = createHub();
    const watcher = hub.peer();
    const state = { value: STATE };
    const a = audience(hub, state);
    state.value = { ...STATE, current: "two/1" };
    a.change();
    expect(watcher.received.at(-1)).toEqual({ type: "state", ...STATE, current: "two/1" });
  });

  test("passes no notes field: the presenter reads notes from the Markdown it already gets, whatever a peer adds", () => {
    const hub = createHub();
    const sender = hub.peer();
    const onState = vi.fn<(s: PresenterState) => void>();
    connectPresenter(onState, { channel: hub.factory });
    sender.channel.postMessage({
      type: "state",
      ...STATE,
      notes: ["<img src=x onerror=alert(1)>"],
    });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0]?.[0]).toEqual(STATE);
    expect(Object.keys(onState.mock.calls[0]?.[0] ?? {}).toSorted()).toEqual([
      "addresses",
      "current",
      "level",
      "markdown",
      "startedAt",
    ]);
  });

  test("answers hello with the state, so a presenter opened later does not wait for the next slide change", () => {
    const hub = createHub();
    audience(hub, { value: STATE });
    const onState = vi.fn<(s: PresenterState) => void>();
    connectPresenter(onState, { channel: hub.factory });
    expect(onState).toHaveBeenCalledWith(STATE);
  });

  test("applies goto and step from the presenter, because the audience window owns the deck", () => {
    const hub = createHub();
    const a = audience(hub, { value: STATE });
    const presenter = connectPresenter(() => {}, { channel: hub.factory });
    presenter.goTo("two/1");
    presenter.step(1);
    presenter.step(-1);
    expect(a.goTo).toHaveBeenCalledWith("two/1");
    expect(a.step.mock.calls).toEqual([[1], [-1]]);
  });

  test("drops malformed requests: any same-origin tab can post on a named channel", () => {
    const hub = createHub();
    const a = audience(hub, { value: STATE });
    const hostile = hub.peer();
    const before = hostile.received.length;
    for (const junk of [
      null,
      "step",
      42,
      { type: "goto" },
      { type: "goto", address: 7 },
      { type: "goto", address: "" },
      { type: "goto", address: "x".repeat(10_000) },
      { type: "step", direction: 2 },
      { type: "step", direction: "1" },
      { type: "state", ...STATE },
      { type: "reload" },
    ]) {
      hostile.channel.postMessage(junk);
    }
    expect(a.goTo).not.toHaveBeenCalled();
    expect(a.step).not.toHaveBeenCalled();
    // None of them counts as a hello either: no state was re-sent.
    expect(hostile.received.length).toBe(before);
  });

  test("stopping unsubscribes and leaves the channel, so a torn-down deck cannot be driven", () => {
    const hub = createHub();
    const a = audience(hub, { value: STATE });
    a.stop();
    expect(a.unsubscribe).toHaveBeenCalledOnce();
    const presenter = connectPresenter(() => {}, { channel: hub.factory });
    presenter.step(1);
    expect(a.step).not.toHaveBeenCalled();
    expect(hub.size()).toBe(1);
  });
});

describe("presenter connection", () => {
  test("passes on only valid state, so a broken message cannot crash the previews", () => {
    const hub = createHub();
    const onState = vi.fn<(s: PresenterState) => void>();
    connectPresenter(onState, { channel: hub.factory });
    const hostile = hub.peer();
    for (const junk of [
      { type: "state" },
      { ...STATE, type: "state", level: 9 },
      { ...STATE, type: "state", level: [] },
      { ...STATE, type: "state", markdown: 5 },
      { ...STATE, type: "state", addresses: "one/1" },
      // The slide list keys items by address; these would corrupt it.
      { ...STATE, type: "state", addresses: ["one/1", "one/1"] },
      { ...STATE, type: "state", addresses: ["one/1", ""] },
      { ...STATE, type: "state", startedAt: Number.NaN },
      { type: "step", direction: 1 },
    ]) {
      hostile.channel.postMessage(junk);
    }
    expect(onState).not.toHaveBeenCalled();
    hostile.channel.postMessage({ type: "state", ...STATE, level: [2, 3], extra: "dropped" });
    expect(onState).toHaveBeenCalledWith({ ...STATE, level: [2, 3] });
  });

  test("keeps saying hello, so it finds an audience window that started after it", () => {
    const hub = createHub();
    const onState = vi.fn<(s: PresenterState) => void>();
    connectPresenter(onState, { channel: hub.factory });
    audience(hub, { value: STATE });
    onState.mockClear();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(onState).toHaveBeenCalledWith(STATE);
  });

  test("reports a disconnect once the audience goes quiet, and recovers when it is back", () => {
    const hub = createHub();
    const onConnectionChange = vi.fn<(connected: boolean) => void>();
    const a = audience(hub, { value: STATE });
    connectPresenter(() => {}, { channel: hub.factory, onConnectionChange });
    expect(onConnectionChange.mock.calls).toEqual([[true]]);

    // An idle audience is not a closed one: heartbeats keep it connected.
    vi.advanceTimersByTime(DISCONNECT_AFTER_MS * 3);
    expect(onConnectionChange.mock.calls).toEqual([[true]]);

    a.stop();
    vi.advanceTimersByTime(DISCONNECT_AFTER_MS + HEARTBEAT_MS);
    expect(onConnectionChange.mock.calls).toEqual([[true], [false]]);

    audience(hub, { value: STATE });
    expect(onConnectionChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  test("close stops the heartbeat and leaves the channel", () => {
    const hub = createHub();
    const presenter = connectPresenter(() => {}, { channel: hub.factory });
    const watcher = hub.peer();
    presenter.close();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(watcher.received).toEqual([]);
    expect(hub.size()).toBe(1);
  });
});

describe("mirrored laser and marks (decision 88)", () => {
  const stroke = (id: number): MarkStroke => ({
    id,
    tool: "pen",
    color: "primary",
    points: [100, 200, 300, 400],
  });

  function mirroredAudience(hub: ReturnType<typeof createHub>) {
    const feed = new MirrorFeed();
    const stop = startPresenterBridge({
      getState: () => STATE,
      goTo: () => true,
      step: () => {},
      subscribe: () => () => {},
      mirror: feed,
      channel: hub.factory,
    });
    return { feed, stop };
  }

  test("the audience window's laser and marks reach a presenter window", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    onMirror.mockClear();
    feed.ingest({ kind: "laser", x: 0.25, y: 0.5 });
    expect(onMirror).toHaveBeenCalledWith({ op: "laser", x: 0.25, y: 0.5 });
    feed.ingest({ kind: "stroke", slide: "one/1", end: true, ...stroke(1) });
    expect(onMirror).toHaveBeenLastCalledWith({
      op: "stroke",
      slide: "one/1",
      id: 1,
      tool: "pen",
      color: "primary",
      from: 0,
      points: [100, 200, 300, 400],
      end: true,
    });
  });

  test("a presenter window gets the slide's marks once, on its first hello, and not on the heartbeat", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1), stroke(2)], reset: true });
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    expect(onMirror.mock.calls.map(([op]) => op.op)).toEqual([
      "board-close",
      "keep",
      "stroke",
      "stroke",
    ]);
    onMirror.mockClear();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(onMirror).not.toHaveBeenCalled();
  });

  test("a second presenter window is brought up to date without repeating it for the first", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1)], reset: true });
    const first = vi.fn<(op: MirrorOp) => void>();
    const second = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror: first });
    first.mockClear();
    connectPresenter(() => {}, { channel: hub.factory, onMirror: second });
    // Inside the first window's 2 s gap: the resync waits for its end (decision 103).
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS);
    expect(second.mock.calls.map(([op]) => op.op)).toEqual(["board-close", "keep", "stroke"]);
    // The resync is a broadcast of ops that change nothing for a window that has the marks.
    expect(first.mock.calls.map(([op]) => op.op)).toEqual(["board-close", "keep", "stroke"]);
  });

  test("a flood of hellos that ask for a resync gets one at once and one at the end of the gap (decision 103)", () => {
    // Any same-origin tab can post on the channel; each resync posts every
    // stroke of the slide again.
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1), stroke(2)], reset: true });
    const hostile = hub.peer();
    // Each resync posts stroke 1 once; nothing else here does.
    const resyncs = () =>
      hostile.received.filter((m) => {
        const op = m as { op?: string; id?: number };
        return op.op === "stroke" && op.id === 1;
      }).length;
    for (let i = 0; i < 50; i++) {
      hostile.channel.postMessage({ type: "hello", resync: true });
      vi.advanceTimersByTime(10);
    }
    expect(resyncs()).toBe(1);
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS);
    expect(resyncs()).toBe(2);
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS * 5);
    expect(resyncs()).toBe(2);
  });

  test("stopping the bridge cancels a resync that was waiting for its gap", () => {
    const hub = createHub();
    const { feed, stop } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1)], reset: true });
    const hostile = hub.peer();
    hostile.channel.postMessage({ type: "hello", resync: true });
    hostile.channel.postMessage({ type: "hello", resync: true });
    stop();
    hostile.received.length = 0;
    // The hub throws on a post to a closed channel, so a timer left behind fails here.
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS * 2);
    expect(hostile.received).toEqual([]);
  });

  test("the diagram focus view is not sent: the window shows scaled, inert copies of the slides", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    onMirror.mockClear();
    feed.focus({ kind: "open", slide: "one/1", block: "diagram", n: 1 });
    feed.focus({ kind: "view", scale: 2, x: 0, y: 0 });
    feed.focus({ kind: "close" });
    expect(onMirror).not.toHaveBeenCalled();
  });

  test("nor is a diagram tour, live or in a resync: the window shows no tour (decision 109)", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1)], reset: true });
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    feed.focus({ kind: "open", slide: "one/1", block: "diagram", n: 1 });
    feed.focus({ kind: "tour", path: [1, 2] });
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS);
    hub.peer().channel.postMessage({ type: "hello", resync: true });
    feed.focus({ kind: "tour", path: [] });
    feed.focus({ kind: "close" });
    const ops = onMirror.mock.calls.map(([op]) => op.op);
    expect(ops).toContain("stroke");
    expect(ops).not.toContain("focus-tour");
    expect(ops.filter((op) => op.startsWith("focus"))).toEqual([]);
  });

  test("nor are the code, table and image views or their line marks, live or in a resync (decision 106)", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    feed.ingest({ kind: "marks", slide: "one/1", strokes: [stroke(1)], reset: true });
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    for (const block of ["code", "table", "image"] as const) {
      feed.focus({ kind: "open", slide: "one/1", block, n: 1 });
      feed.focus({ kind: "view", scale: 2, x: 0.5, y: 0.5 });
      feed.focus({ kind: "lines", lines: [1, 2] });
      vi.advanceTimersByTime(RESYNC_MIN_GAP_MS);
      hub.peer().channel.postMessage({ type: "hello", resync: true });
      feed.focus({ kind: "close" });
    }
    const ops = onMirror.mock.calls.map(([op]) => op.op);
    // The window still gets the marks, so the resyncs did reach it.
    expect(ops).toContain("stroke");
    expect(ops.filter((op) => op.startsWith("focus"))).toEqual([]);
  });

  test("the board ops reach a presenter window, live and in a resync, while the focus ops still do not (decision 110)", () => {
    const hub = createHub();
    const { feed } = mirroredAudience(hub);
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror });
    onMirror.mockClear();
    feed.ingest({ kind: "board", slide: "one/1" });
    expect(onMirror).toHaveBeenLastCalledWith({ op: "board-open", slide: "one/1" });
    feed.ingest({ kind: "marks", slide: "one/board", strokes: [stroke(1)], reset: true });
    feed.focus({ kind: "open", slide: "one/1", block: "code", n: 1 });
    feed.ingest({ kind: "board", slide: null });
    expect(onMirror.mock.calls.map(([op]) => op.op)).toEqual([
      "board-open",
      "clear",
      "stroke",
      "board-close",
    ]);
    // A window that opens while the board is up is told, ahead of the strokes.
    feed.ingest({ kind: "board", slide: "one/1" });
    feed.ingest({ kind: "marks", slide: "one/board", strokes: [stroke(1)], reset: true });
    const late = vi.fn<(op: MirrorOp) => void>();
    connectPresenter(() => {}, { channel: hub.factory, onMirror: late });
    vi.advanceTimersByTime(RESYNC_MIN_GAP_MS);
    expect(late.mock.calls.map(([op]) => op.op).slice(0, 2)).toEqual(["board-open", "keep"]);
  });

  test("a malformed mirror message is dropped: any same-origin tab can post on the channel", () => {
    const hub = createHub();
    const onMirror = vi.fn<(op: MirrorOp) => void>();
    const onState = vi.fn<(s: PresenterState) => void>();
    connectPresenter(onState, { channel: hub.factory, onMirror });
    const hostile = hub.peer();
    const valid = {
      type: "mirror",
      op: "stroke",
      slide: "one/1",
      id: 1,
      tool: "pen",
      color: "primary",
      from: 0,
      points: [1, 2],
      end: false,
    };
    for (const junk of [
      { type: "mirror", op: "laser", x: 2, y: 0 },
      { type: "mirror", op: "laser", x: 0.5, y: 0.5, html: "<img onerror=x>" },
      { type: "mirror", op: "nothing" },
      { ...valid, points: [1, 2, 3] },
      { ...valid, points: [5000, 1] },
      { ...valid, color: "red" },
      { ...valid, slide: "" },
      { type: "mirror" },
    ]) {
      hostile.channel.postMessage(junk);
    }
    expect(onMirror).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    hostile.channel.postMessage(valid);
    expect(onMirror).toHaveBeenCalledOnce();
  });
});
