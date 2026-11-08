// The channels here are BroadcastChannel stand-ins, which take no target origin.
/* oxlint-disable unicorn/require-post-message-target-origin */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
