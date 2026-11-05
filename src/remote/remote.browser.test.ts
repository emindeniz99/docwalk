import qrcodeGenerator from "qrcode-generator";
import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi, type Mock } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController, SlideInfo } from "../deck/controller";
import {
  connectRoom,
  LASER_INTERVAL_MS,
  MAX_RECONNECT_DELAY_MS,
  reconnectDelay,
  type RemoteRole,
  type RemoteStatus,
  type RoomConnection,
  type SocketFactory,
  type SocketHandlers,
} from "./client";
import { createRoomCredentials, parseJoinFragment } from "./crypto";
import { useRemoteFollower, type RemoteFollower } from "./follower";
import { useRemoteHost, type RemoteHost } from "./host";
import { DOC_LINK_TOO_LONG, JoinDialog, KEY_NOTE, QrCode } from "./JoinDialog";
import { RemoteView } from "./RemoteView";
import type { RemoteMessage, RoomCredentials } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "https://docwalk.example/app/";

/**
 * An in-memory relay with the Worker's behaviour: every frame goes to every
 * other open socket in the room, asynchronously, and never back to its sender.
 */
class FakeRelay {
  readonly urls: string[] = [];
  readonly sockets = new Set<{ url: string; handlers: SocketHandlers; open: boolean }>();
  /** Every frame the relay carried, as the server would see it. */
  readonly wire: string[] = [];

  factory: SocketFactory = (url, handlers) => {
    const entry = { url, handlers, open: false };
    this.urls.push(url);
    this.sockets.add(entry);
    setTimeout(() => {
      if (!this.sockets.has(entry)) return;
      entry.open = true;
      handlers.open();
    }, 0);
    return {
      send: (data) => {
        this.wire.push(data);
        for (const other of this.sockets) {
          if (other !== entry && other.open && other.url === url) {
            setTimeout(() => other.handlers.message(data), 0);
          }
        }
      },
      close: () => {
        this.sockets.delete(entry);
        setTimeout(() => handlers.close(), 0);
      },
    };
  };

  /** The server drops a socket (deploy, network loss). */
  drop(index: number) {
    const entry = [...this.sockets][index]!;
    this.sockets.delete(entry);
    setTimeout(() => entry.handlers.close(), 0);
  }
}

interface Peer {
  conn: RoomConnection;
  received: RemoteMessage[];
  statuses: RemoteStatus[];
}

const peers: RoomConnection[] = [];

function peer(relay: FakeRelay, creds: RoomCredentials, role: RemoteRole, base = BASE): Peer {
  const received: RemoteMessage[] = [];
  const statuses: RemoteStatus[] = [];
  const conn = connectRoom({
    creds,
    role,
    socketFactory: relay.factory,
    base,
    onMessage: (m) => received.push(m),
    onStatus: (s) => statuses.push(s),
  });
  peers.push(conn);
  return { conn, received, statuses };
}

const opened = (p: Peer) =>
  vi.waitFor(() => {
    if (p.statuses.at(-1) !== "open") throw new Error(`status ${p.statuses.at(-1)}`);
  });

const ofType = <T extends RemoteMessage["type"]>(p: Peer, type: T) =>
  p.received.filter((m): m is Extract<RemoteMessage, { type: T }> => m.type === type);

type FakeController = DeckController & {
  next: Mock<() => void>;
  prev: Mock<() => void>;
  goTo: Mock<(address: string) => boolean>;
};

/** `count` one-page sections, or the given `[sectionId, page]` slides in order. */
function fakeController(count = 10, pages?: Array<[string, number]>): FakeController {
  let index = 0;
  const listeners = new Set<(slide: SlideInfo) => void>();
  const layout =
    pages ?? Array.from({ length: count }, (_, i): [string, number] => [`section-${i}`, 1]);
  const slides: SlideInfo[] = layout.map(([sectionId, page], i) => ({
    index: i,
    address: `${sectionId}/${page}`,
    sectionId,
    page,
    title: `Title ${i}`,
    flagged: false,
    note: null,
  }));
  count = slides.length;
  const emit = () => listeners.forEach((l) => l(slides[index]!));
  return {
    slides: () => slides,
    current: () => slides[index] ?? null,
    goTo: vi.fn<(address: string) => boolean>((address) => {
      const i = slides.findIndex((s) => s.address === address);
      if (i < 0) return false;
      index = i;
      emit();
      return true;
    }),
    next: vi.fn<() => void>(() => {
      index = Math.min(index + 1, count - 1);
      emit();
    }),
    prev: vi.fn<() => void>(() => {
      index = Math.max(index - 1, 0);
      emit();
    }),
    onChange(listener) {
      listeners.add(listener);
      listener(slides[index]!);
      return () => listeners.delete(listener);
    },
    stage: () => document.body,
  };
}

let root: Root | null = null;

function mount(element: ReactElement) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(element));
}

type HostProps = Parameters<typeof useRemoteHost>[0];
type FollowerProps = Parameters<typeof useRemoteFollower>[0];

function HostProbe({ report, ...props }: HostProps & { report: (r: RemoteHost) => void }) {
  report(useRemoteHost(props));
  return null;
}

function FollowerProbe({
  report,
  ...props
}: FollowerProps & { report: (r: RemoteFollower) => void }) {
  report(useRemoteFollower(props));
  return null;
}

function mountHost(props: HostProps) {
  const result: { current: RemoteHost | null } = { current: null };
  mount(h(HostProbe, { ...props, report: (r) => (result.current = r) }));
  return result;
}

function mountFollower(props: FollowerProps) {
  const result: { current: RemoteFollower | null } = { current: null };
  const render = (next: FollowerProps) =>
    mount(h(FollowerProbe, { ...next, report: (r) => (result.current = r) }));
  render(props);
  return { result, rerender: render };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const conn of peers.splice(0)) conn.close();
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("room connection", () => {
  test("joins wss://<host>/api/remote/<room>, or ws: on plain http, so the Worker route matches", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    peer(relay, creds, "remote");
    peer(relay, creds, "remote", "http://localhost:5173/");
    // The socket opens once the key is imported, which is async.
    await vi.waitFor(() => expect(relay.urls).toHaveLength(2));
    expect(relay.urls).toEqual([
      `wss://docwalk.example/api/remote/${creds.room}`,
      `ws://localhost:5173/api/remote/${creds.room}`,
    ]);
  });

  test("the relay only ever carries ciphertext frames", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const remote = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(remote);
    await remote.conn.send({ type: "goto", address: "secret-section/1" });
    await vi.waitFor(() => expect(ofType(presenter, "goto")).toHaveLength(1));
    for (const frame of relay.wire) {
      expect(Object.keys(JSON.parse(frame)).toSorted()).toEqual(["data", "iv", "v"]);
      expect(frame).not.toContain("secret-section");
      expect(frame).not.toContain(creds.key);
    }
  });

  test("a socket with the wrong key cannot steer the room: its frames are dropped", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const stranger = peer(relay, { room: creds.room, key: createRoomCredentials().key }, "remote");
    const friend = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(stranger);
    await opened(friend);
    await stranger.conn.send({ type: "step", direction: 1 });
    await friend.conn.send({ type: "step", direction: -1 });
    await vi.waitFor(() => expect(ofType(presenter, "step")).toHaveLength(1));
    expect(ofType(presenter, "step")[0]!.direction).toBe(-1);
    // Only the friend's hello got through, too.
    expect(ofType(presenter, "hello")).toHaveLength(1);
  });

  test("reconnects after the relay drops it and says hello again, so the presenter resends state", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const remote = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(remote);
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(1));

    relay.drop(1);
    await vi.waitFor(() => expect(remote.statuses.at(-1)).toBe("reconnecting"));
    expect(await remote.conn.send({ type: "step", direction: 1 })).toBe("not-open");
    await vi.waitFor(() => expect(remote.statuses.at(-1)).toBe("open"), { timeout: 2000 });
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(2));
    const [first, second] = ofType(presenter, "hello");
    expect(second!.id).toBe(first!.id);
    expect(relay.urls).toHaveLength(3);
  });

  test("backoff doubles from 0.5 s and stops at 10 s, so a down relay is not hammered", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([
      500,
      1000,
      2000,
      4000,
      8000,
      MAX_RECONNECT_DELAY_MS,
      MAX_RECONNECT_DELAY_MS,
    ]);
  });

  test("close is final: no reconnect, no sends, status closed", async () => {
    const relay = new FakeRelay();
    const remote = peer(relay, createRoomCredentials(), "remote");
    await opened(remote);
    remote.conn.close();
    expect(remote.statuses.at(-1)).toBe("closed");
    expect(await remote.conn.send({ type: "step", direction: 1 })).toBe("not-open");
    await new Promise((r) => setTimeout(r, 700));
    expect(relay.urls).toHaveLength(1);
    expect(relay.sockets.size).toBe(0);
  });

  test("laser points are throttled to ~30/s but the last point always arrives", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const remote = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(remote);
    const results = [];
    for (let i = 1; i <= 50; i++)
      results.push(remote.conn.send({ type: "laser", x: i / 50, y: 0.5 }));
    expect(await results[0]).toBe("sent");
    expect(await results[1]).toBe("queued");
    await new Promise((r) => setTimeout(r, LASER_INTERVAL_MS * 4));
    const lasers = ofType(presenter, "laser");
    expect(lasers).toHaveLength(2);
    expect(lasers.at(-1)).toEqual({ type: "laser", x: 1, y: 0.5 });
  });

  test("laser-off cancels a waiting point, so the laser does not reappear after release", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const remote = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(remote);
    void remote.conn.send({ type: "laser", x: 0.1, y: 0.1 });
    void remote.conn.send({ type: "laser", x: 0.2, y: 0.2 });
    void remote.conn.send({ type: "laser-off" });
    await new Promise((r) => setTimeout(r, LASER_INTERVAL_MS * 4));
    expect(presenter.received.filter((m) => m.type.startsWith("laser")).map((m) => m.type)).toEqual(
      ["laser", "laser-off"],
    );
  });

  test("a handler that throws once does not stop later frames, and the error is reported", async () => {
    // Without this, one exception (say, a deck torn down mid-rebuild) would
    // leave the presenter deaf to every remote until a reload.
    const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => {});
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const received: RemoteMessage[] = [];
    const presenter = connectRoom({
      creds,
      role: "presenter",
      socketFactory: relay.factory,
      base: BASE,
      onStatus: () => {},
      onMessage: (m) => {
        if (m.type === "hello") throw new Error("handler failed");
        received.push(m);
      },
    });
    peers.push(presenter);
    const remote = peer(relay, creds, "remote");
    await opened(remote);
    await vi.waitFor(() => expect(reported).toHaveBeenCalledTimes(1));
    await remote.conn.send({ type: "step", direction: 1 });
    await vi.waitFor(() => expect(received).toEqual([{ type: "step", direction: 1 }]));
  });
});

describe("presenter host", () => {
  test("answers a remote's hello with the current slide", async () => {
    const relay = new FakeRelay();
    const controller = fakeController();
    controller.goTo("section-2/1");
    const host = mountHost({
      controller,
      docLink: "https://docwalk.example/?src=x",
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = parseJoinFragment(new URL(host.current!.joinUrls.remote).hash)!;
    const remote = peer(relay, creds, "remote");
    await vi.waitFor(() =>
      expect(ofType(remote, "state").at(-1)).toEqual({
        type: "state",
        current: "section-2/1",
        index: 2,
        total: 10,
        title: "Title 2",
        docLink: "https://docwalk.example/?src=x",
      }),
    );
    await vi.waitFor(() => expect(host.current!.status).toBe("open"));
  });

  test("a remote's step and goto drive the presenter's deck, and every change is announced", async () => {
    const relay = new FakeRelay();
    const controller = fakeController();
    const host = mountHost({
      controller,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = parseJoinFragment(new URL(host.current!.joinUrls.remote).hash)!;
    const remote = peer(relay, creds, "remote");
    await vi.waitFor(() => expect(ofType(remote, "state").length).toBeGreaterThan(0));

    await remote.conn.send({ type: "step", direction: 1 });
    await vi.waitFor(() => expect(controller.next).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(ofType(remote, "state").at(-1)?.current).toBe("section-1/1"));

    await remote.conn.send({ type: "step", direction: -1 });
    await vi.waitFor(() => expect(controller.prev).toHaveBeenCalledTimes(1));

    await remote.conn.send({ type: "goto", address: "section-7/1" });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenCalledWith("section-7/1"));
    await vi.waitFor(() => expect(ofType(remote, "state").at(-1)?.index).toBe(7));
  });

  test("exposes the remote's laser point for the stage, and hides it on laser-off", async () => {
    const relay = new FakeRelay();
    const host = mountHost({
      controller: fakeController(),
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = parseJoinFragment(new URL(host.current!.joinUrls.remote).hash)!;
    const remote = peer(relay, creds, "remote");
    await opened(remote);
    await remote.conn.send({ type: "laser", x: 0.25, y: 0.75 });
    await vi.waitFor(() => expect(host.current!.laser).toEqual({ x: 0.25, y: 0.75 }));
    await remote.conn.send({ type: "laser-off" });
    await vi.waitFor(() => expect(host.current!.laser).toBeNull());
  });

  test("counts each device once, even when it reconnects", async () => {
    const relay = new FakeRelay();
    const host = mountHost({
      controller: fakeController(),
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = parseJoinFragment(new URL(host.current!.joinUrls.follow).hash)!;
    const remote = peer(relay, creds, "remote");
    peer(relay, creds, "follower");
    peer(relay, creds, "follower");
    await vi.waitFor(() =>
      expect(host.current!.participants).toEqual({ remotes: 1, followers: 2 }),
    );
    await opened(remote);
    // Sockets in join order: the host, the remote, two followers.
    relay.drop(1);
    await vi.waitFor(() => expect(remote.statuses.filter((s) => s === "open")).toHaveLength(2), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.current!.participants).toEqual({ remotes: 1, followers: 2 });
  });

  test("a doc link too long for the relay is left out and reported, instead of losing the whole state", async () => {
    const relay = new FakeRelay();
    const host = mountHost({
      controller: fakeController(),
      docLink: `https://docwalk.example/#doc=${"a".repeat(20_000)}`,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = parseJoinFragment(new URL(host.current!.joinUrls.follow).hash)!;
    const follower = peer(relay, creds, "follower");
    await vi.waitFor(() => expect(ofType(follower, "state").at(-1)?.docLink).toBeNull());
    expect(ofType(follower, "state").at(-1)?.current).toBe("section-0/1");
    await vi.waitFor(() => expect(host.current!.docLinkTooLong).toBe(true));
  });

  test("keeps the room across a reload of the presenter tab, so joined phones stay valid", () => {
    const relay = new FakeRelay();
    const first = mountHost({
      controller: null,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const url = first.current!.joinUrls.remote;
    act(() => root?.unmount());
    root = null;
    const second = mountHost({
      controller: null,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    expect(second.current!.joinUrls.remote).toBe(url);
  });

  test("connects nothing while disabled (static mode or remote control off)", () => {
    const relay = new FakeRelay();
    const host = mountHost({
      controller: fakeController(),
      docLink: null,
      enabled: false,
      socketFactory: relay.factory,
      base: BASE,
    });
    expect(relay.urls).toHaveLength(0);
    expect(host.current!.status).toBe("closed");
    expect(sessionStorage.length).toBe(0);
  });
});

describe("follower", () => {
  test("says hello and goes to each slide the presenter announces", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const controller = fakeController();
    const { result } = mountFollower({
      creds,
      controller,
      socketFactory: relay.factory,
      base: BASE,
    });
    await vi.waitFor(() =>
      expect(ofType(presenter, "hello")).toEqual([expect.objectContaining({ role: "follower" })]),
    );
    await presenter.conn.send({
      type: "state",
      current: "section-4/1",
      index: 4,
      total: 10,
      title: "Title 4",
      docLink: null,
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("section-4/1"));
    await presenter.conn.send({
      type: "state",
      current: "section-5/1",
      index: 5,
      total: 10,
      title: "Title 5",
      docLink: null,
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("section-5/1"));
    expect(result.current!.status).toBe("open");
  });

  test("catches up once its deck is ready, since state can arrive before the document loads", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const { result, rerender } = mountFollower({
      creds,
      controller: null,
      socketFactory: relay.factory,
      base: BASE,
    });
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(1));
    await presenter.conn.send({
      type: "state",
      current: "section-3/1",
      index: 3,
      total: 10,
      title: "T",
      docLink: "https://docwalk.example/?src=a",
    });
    await vi.waitFor(() =>
      expect(result.current!.state?.docLink).toBe("https://docwalk.example/?src=a"),
    );
    const controller = fakeController();
    rerender({ creds, controller, socketFactory: relay.factory, base: BASE });
    expect(controller.goTo).toHaveBeenCalledWith("section-3/1");
  });

  test("on a screen that paginates a section into fewer pages, shows that section's last page", async () => {
    // Pagination is measured per viewport (decision 21): the presenter's
    // "intro/3" may not exist on a smaller follower screen, and staying on the
    // previous slide would silently show the audience the wrong content.
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const controller = fakeController(0, [
      ["intro", 1],
      ["intro", 2],
      ["retries", 1],
    ]);
    mountFollower({ creds, controller, socketFactory: relay.factory, base: BASE });
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(1));
    await presenter.conn.send({
      type: "state",
      current: "intro/3",
      index: 2,
      total: 6,
      title: "Intro",
      docLink: null,
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("intro/2"));
    expect(controller.current()?.address).toBe("intro/2");
  });

  test("ignores a doc link to another site: a key holder must not steer followers off docwalk", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const { result } = mountFollower({
      creds,
      controller: null,
      socketFactory: relay.factory,
      base: BASE,
    });
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(1));
    await presenter.conn.send({
      type: "state",
      current: "a/1",
      index: 0,
      total: 1,
      title: "A",
      docLink: "https://phish.example/?src=a",
    });
    await vi.waitFor(() => expect(result.current!.state?.current).toBe("a/1"));
    expect(result.current!.state?.docLink).toBeNull();
  });
});

/** A room with a minimal presenter that answers the first hello with state, like useRemoteHost. */
async function setupRemoteView() {
  const relay = new FakeRelay();
  const creds = createRoomCredentials();
  const presenter = peer(relay, creds, "presenter");
  await opened(presenter);
  // A minimal presenter: answer every hello with state, like useRemoteHost.
  const answer = setInterval(() => {
    if (ofType(presenter, "hello").length > 0) {
      clearInterval(answer);
      void presenter.conn.send({
        type: "state",
        current: "retries/1",
        index: 2,
        total: 10,
        title: "Retries",
        docLink: null,
      });
    }
  }, 5);
  mount(h(RemoteView, { creds, socketFactory: relay.factory, base: BASE }));
  await vi.waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Retries"));
  return presenter;
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(name))!;

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

describe("phone remote view", () => {
  test("shows the slide title, position and connection without loading the document", async () => {
    await setupRemoteView();
    expect(document.body.textContent).toContain("3 / 10");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Connected");
  });

  test("announces the slide position in words, so a screen reader confirms each press", async () => {
    await setupRemoteView();
    const count = document.querySelector<HTMLElement>(".docwalk-remote-count")!;
    expect(count.getAttribute("aria-live")).toBe("polite");
    // The visual "3 / 10" is hidden from assistive tech; the words are not drawn.
    expect(count.querySelector('[aria-hidden="true"]')?.textContent).toBe("3 / 10");
    const words = count.querySelector<HTMLElement>(".docwalk-remote-sr")!;
    expect(words.textContent).toBe("Slide 3 of 10");
    expect(words.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  test("Previous and Next are big thumb targets that send step messages", async () => {
    const presenter = await setupRemoteView();
    for (const name of ["Previous", "Next"]) {
      const box = button(name).getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(52);
    }
    await userEvent.click(button("Next"));
    await vi.waitFor(() => expect(ofType(presenter, "step").map((m) => m.direction)).toEqual([1]));
    await userEvent.click(button("Previous"));
    await vi.waitFor(() =>
      expect(ofType(presenter, "step").map((m) => m.direction)).toEqual([1, -1]),
    );
  });

  test("the laser pad maps a touch to slide coordinates and hides the laser on release", async () => {
    const presenter = await setupRemoteView();
    const pad = document.querySelector<HTMLElement>(".docwalk-remote-pad")!;
    const box = pad.getBoundingClientRect();
    const at = (type: string, fx: number, fy: number) =>
      act(() => {
        pad.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            clientX: box.left + box.width * fx,
            clientY: box.top + box.height * fy,
          }),
        );
      });
    at("pointerdown", 0.25, 0.5);
    await vi.waitFor(() => expect(ofType(presenter, "laser")).toHaveLength(1));
    const first = ofType(presenter, "laser")[0]!;
    expect(first.x).toBeCloseTo(0.25, 2);
    expect(first.y).toBeCloseTo(0.5, 2);
    at("pointerup", 0.25, 0.5);
    await vi.waitFor(() => expect(ofType(presenter, "laser-off")).toHaveLength(1));
  });

  test("an incomplete link says so instead of spinning forever", () => {
    mount(h(RemoteView, { creds: null }));
    expect(document.querySelector("h1")?.textContent).toBe("This remote link is incomplete");
  });
});

describe("join dialog", () => {
  const host = {
    joinUrls: {
      remote: `${BASE}?view=remote#room=${"r".repeat(22)}&k=${"k".repeat(43)}`,
      follow: `${BASE}?view=follow#room=${"r".repeat(22)}&k=${"k".repeat(43)}`,
    },
    participants: { remotes: 1, followers: 2 },
    status: "open" as const,
    docLinkTooLong: false,
  };

  test("is a named dialog with both QR codes, the key warning and 44px targets", () => {
    mount(h(JoinDialog, { isOpen: true, onOpenChange: () => {}, host }));
    const titleId = dialog().getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Remote control");
    const qrs = [...dialog().querySelectorAll('svg[role="img"]')].map((s) =>
      s.getAttribute("aria-label"),
    );
    expect(qrs).toEqual(["QR code for the phone remote link", "QR code for the follow along link"]);
    expect(dialog().textContent).toContain(KEY_NOTE);
    expect(dialog().textContent).toContain("1 remote and 2 followers joined");
    expect(dialog().textContent).not.toContain(DOC_LINK_TOO_LONG);
    for (const b of dialog().querySelectorAll("button")) {
      const box = b.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });

  test("copy puts the exact join link on the clipboard", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    mount(h(JoinDialog, { isOpen: true, onOpenChange: () => {}, host }));
    const copy = [...dialog().querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Copy phone remote link"),
    )!;
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(host.joinUrls.remote);
  });

  test("tells the presenter when followers will not get the document", () => {
    mount(
      h(JoinDialog, {
        isOpen: true,
        onOpenChange: () => {},
        host: { ...host, docLinkTooLong: true },
      }),
    );
    expect(dialog().textContent).toContain(DOC_LINK_TOO_LONG);
  });

  test("the QR code draws exactly the encoder's modules with a quiet zone, not transposed", () => {
    const value = host.joinUrls.remote;
    mount(h(QrCode, { value, label: "QR" }));
    const svg = document.querySelector("svg")!;
    const qr = qrcodeGenerator(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${n + 8} ${n + 8}`);
    const drawn = new Set(
      [
        ...svg
          .querySelector("path")!
          .getAttribute("d")!
          .matchAll(/M(\d+) (\d+)/g),
      ].map(([, x, y]) => `${Number(y) - 4},${Number(x) - 4}`),
    );
    const expected = new Set<string>();
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) expected.add(`${r},${c}`);
    expect(drawn).toEqual(expected);
  });
});
