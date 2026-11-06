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
import { createPresenterCredentials, createRoomCredentials, parseJoinFragment } from "./crypto";
import {
  followedDocument,
  NO_DOC_LINK,
  useRemoteFollower,
  type FollowState,
  type RemoteFollower,
} from "./follower";
import { ROOM_STORAGE_KEY, useRemoteHost, type RemoteHost } from "./host";
import {
  AGENT_NOTE,
  describeAgentEdit,
  DOC_LINK_TOO_LONG,
  JoinDialog,
  KEY_NOTE,
  QrCode,
} from "./JoinDialog";
import { PRESENTER_AWAY, PRESENTER_REPLY_MS, RemoteView } from "./RemoteView";
import { SEAT_TAKEN_CLOSE, type RemoteMessage, type RoomCredentials } from "./types";

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
  /** Rooms whose control seats someone else's token took first: a seat token there is refused, as worker/room.ts does. */
  readonly taken = new Set<string>();

  factory: SocketFactory = (url, handlers, seat) => {
    if (seat && this.taken.has(url)) {
      this.urls.push(url);
      setTimeout(() => handlers.close(SEAT_TAKEN_CLOSE), 0);
      return { send: () => {}, close: () => {} };
    }
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

  /** A hostile relay sends a frame it carried earlier to every socket again. */
  replay(frame: string) {
    for (const entry of this.sockets) setTimeout(() => entry.handlers.message(frame), 0);
  }

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

/**
 * The credentials in the host's join link, once it shows one: the links
 * appear only after the presenter's socket has opened (decision 74).
 */
async function joinCreds(host: { current: RemoteHost | null }, kind: "remote" | "follow") {
  const url = await vi.waitFor(() => {
    const urls = host.current?.joinUrls;
    if (!urls) throw new Error("no join links yet");
    return urls[kind];
  });
  return parseJoinFragment(new URL(url).hash)!;
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
    const stranger = peer(
      relay,
      { room: creds.room, key: createRoomCredentials().key, view: null },
      "remote",
    );
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

  test("a relay that replays a remote's press cannot move the deck again", async () => {
    // The relay is untrusted (decision 8): recording one Next and sending it
    // again later would move the presenter's deck without anyone pressing.
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const presenter = peer(relay, creds, "presenter");
    const remote = peer(relay, creds, "remote");
    await opened(presenter);
    await opened(remote);
    await vi.waitFor(() => expect(ofType(presenter, "hello")).toHaveLength(1));
    const before = relay.wire.length;
    await remote.conn.send({ type: "step", direction: 1 });
    await vi.waitFor(() => expect(ofType(presenter, "step")).toHaveLength(1));
    const press = relay.wire[before]!;
    relay.replay(press);
    relay.replay(press);
    await new Promise((r) => setTimeout(r, 50));
    expect(ofType(presenter, "step")).toHaveLength(1);
    // A real second press still gets through.
    await remote.conn.send({ type: "step", direction: 1 });
    await vi.waitFor(() => expect(ofType(presenter, "step")).toHaveLength(2));
  });

  test("a follower cannot read an agent's answers, nor forge one: the view key does not reach them", async () => {
    // Before the key split, any audience member could answer an agent's
    // doc-get with a forged document (prompt injection) or report a failed
    // write as done, since every frame was under the one room key.
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const presenter = peer(relay, creds, "presenter");
    const agent = peer(relay, { ...creds, view: null }, "agent");
    const follower = peer(relay, { ...creds, key: null }, "follower");
    await opened(presenter);
    await opened(agent);
    await opened(follower);
    const doc = (markdown: string): RemoteMessage => ({
      type: "doc",
      request: "GetGetGetGet",
      to: agent.conn.id,
      markdown,
      revision: "r".repeat(22),
    });
    await follower.conn.send(doc("# Forged\n"));
    await presenter.conn.send(doc("# Real\n"));
    await vi.waitFor(() => expect(ofType(agent, "doc")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(ofType(agent, "doc").map((m) => m.markdown)).toEqual(["# Real\n"]);
    expect(follower.received.filter((m) => m.type !== "hello")).toEqual([]);
  });

  test("a follow link opened as a remote cannot connect: it has no control key", async () => {
    const relay = new FakeRelay();
    const creds = createRoomCredentials();
    const remote = peer(relay, { ...creds, key: null }, "remote");
    await vi.waitFor(() => expect(remote.statuses.at(-1)).toBe("closed"));
    expect(relay.urls).toHaveLength(0);
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
    const creds = await joinCreds(host, "remote");
    const remote = peer(relay, creds, "remote");
    await vi.waitFor(() =>
      expect(ofType(remote, "state").at(-1)).toEqual({
        type: "state",
        current: "section-2/1",
        index: 2,
        total: 10,
        title: "Title 2",
        docLink: "https://docwalk.example/?src=x",
        docLinkTooLong: false,
        level: "auto",
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
    const creds = await joinCreds(host, "remote");
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
    const creds = await joinCreds(host, "remote");
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
    const remoteCreds = await joinCreds(host, "remote");
    const creds = await joinCreds(host, "follow");
    // The host connects once it holds the room, which is async; wait so the join order is fixed.
    await vi.waitFor(() => expect(host.current!.status).toBe("open"));
    const remote = peer(relay, remoteCreds, "remote");
    peer(relay, creds, "follower");
    peer(relay, creds, "follower");
    await vi.waitFor(() =>
      expect(host.current!.participants).toEqual({ remotes: 1, followers: 2, agents: 0 }),
    );
    await opened(remote);
    // Sockets in join order: the host, the remote, two followers.
    relay.drop(1);
    await vi.waitFor(() => expect(remote.statuses.filter((s) => s === "open")).toHaveLength(2), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(host.current!.participants).toEqual({ remotes: 1, followers: 2, agents: 0 });
  });

  test("the follow link only follows: a modified follower client cannot steer the deck or touch the document", async () => {
    // The follow link is posted to an audience. With the control key in it,
    // an attendee could move the deck, read the document over the room and,
    // with agent edits on, replace it (decision 68).
    const relay = new FakeRelay();
    const controller = fakeController();
    const onAgentEdit = vi.fn<(markdown: string, name: string) => void>();
    const host = mountHost({
      controller,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
      markdown: "# Private notes\n",
      onAgentEdit,
    });
    const creds = await joinCreds(host, "follow");
    act(() => host.current!.setAllowAgentEdits(true));
    expect(host.current!.allowAgentEdits).toBe(true);
    expect(creds.key).toBeNull();
    const attendee = peer(relay, creds, "follower");
    await vi.waitFor(() => expect(ofType(attendee, "state").length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(host.current!.participants.followers).toBe(1));

    const from = attendee.conn.id;
    await attendee.conn.send({ type: "hello", role: "remote", id: "PretendRemote" });
    await attendee.conn.send({ type: "step", direction: 1 });
    await attendee.conn.send({ type: "goto", address: "section-5/1" });
    await attendee.conn.send({ type: "laser", x: 0.5, y: 0.5 });
    await attendee.conn.send({ type: "doc-get", request: "GetGetGetGet", from });
    await attendee.conn.send({
      type: "doc-write",
      request: "WriteWriteWr",
      from,
      name: "attendee",
      markdown: "# Replaced\n",
      base: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(controller.next).not.toHaveBeenCalled();
    expect(controller.goTo).not.toHaveBeenCalled();
    expect(host.current!.laser).toBeNull();
    expect(onAgentEdit).not.toHaveBeenCalled();
    expect(attendee.received.filter((m) => m.type !== "state")).toEqual([]);
    expect(host.current!.participants).toEqual({ remotes: 0, followers: 1, agents: 0 });
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
    const creds = await joinCreds(host, "follow");
    const follower = peer(relay, creds, "follower");
    await vi.waitFor(() => expect(ofType(follower, "state").at(-1)?.docLink).toBeNull());
    expect(ofType(follower, "state").at(-1)?.current).toBe("section-0/1");
    await vi.waitFor(() => expect(host.current!.docLinkTooLong).toBe(true));
  });

  test("sends the slide level, because a follower on another level has other section ids and cannot follow", async () => {
    const relay = new FakeRelay();
    const props = { docLink: null, enabled: true, socketFactory: relay.factory, base: BASE };
    const host = mountHost({ ...props, controller: fakeController(), level: [2, 3] });
    const creds = await joinCreds(host, "follow");
    const follower = peer(relay, creds, "follower");
    await vi.waitFor(() => expect(ofType(follower, "state").at(-1)?.level).toEqual([2, 3]));
    // A level change rebuilds the deck, and the new level goes out with it.
    mountHost({ ...props, controller: fakeController(), level: 3 });
    await vi.waitFor(() => expect(ofType(follower, "state").at(-1)?.level).toBe(3));
  });

  test("tells followers to wait while the doc link is built, and only says 'too long' when there is none", async () => {
    // A presenter that just turned remote on sends state before its link is
    // ready; a follower shown "too long" then never loaded the real link.
    const relay = new FakeRelay();
    const props = { enabled: true, socketFactory: relay.factory, base: BASE };
    const controller = fakeController();
    const host = mountHost({ ...props, controller, docLink: undefined });
    const creds = await joinCreds(host, "follow");
    const follower = peer(relay, creds, "follower");
    await vi.waitFor(() => expect(ofType(follower, "state").length).toBeGreaterThan(0));
    expect(ofType(follower, "state").at(-1)).toMatchObject({
      docLink: null,
      docLinkTooLong: false,
    });
    expect(host.current!.docLinkTooLong).toBe(false);

    mountHost({ ...props, controller, docLink: "https://docwalk.example/?src=x" });
    await vi.waitFor(() =>
      expect(ofType(follower, "state").at(-1)).toMatchObject({
        docLink: "https://docwalk.example/?src=x",
        docLinkTooLong: false,
      }),
    );
    const none = mountHost({ ...props, controller, docLink: null });
    await vi.waitFor(() =>
      expect(ofType(follower, "state").at(-1)).toMatchObject({
        docLink: null,
        docLinkTooLong: true,
      }),
    );
    await vi.waitFor(() => expect(none.current!.docLinkTooLong).toBe(true));
  });

  test("answers a press that moves nothing, so a remote can tell the presenter is there", async () => {
    const relay = new FakeRelay();
    const controller = fakeController(3);
    controller.goTo("section-2/1");
    // Like reveal.js on its last slide: Next changes nothing and reports nothing.
    controller.next.mockImplementation(() => {});
    const host = mountHost({
      controller,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const creds = await joinCreds(host, "remote");
    const remote = peer(relay, creds, "remote");
    await vi.waitFor(() => expect(ofType(remote, "state").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const before = ofType(remote, "state").length;
    await remote.conn.send({ type: "step", direction: 1 });
    await vi.waitFor(() => expect(ofType(remote, "state").length).toBe(before + 1));
    expect(ofType(remote, "state").at(-1)?.current).toBe("section-2/1");
  });

  test("a duplicated tab opens its own room: it must not join the stored one as a second presenter", async () => {
    // Duplicating a tab copies sessionStorage, room included. Two presenters
    // in one room would both obey every press and fight over the followers.
    const stored = await createPresenterCredentials();
    sessionStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(stored));
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      void navigator.locks.request(
        `docwalk.remote-room:${stored.room}`,
        () =>
          new Promise<void>((r) => {
            release = r;
            resolve();
          }),
      );
    });
    await held; // The original tab holds the room.
    try {
      const relay = new FakeRelay();
      const host = mountHost({
        controller: fakeController(),
        docLink: null,
        enabled: true,
        socketFactory: relay.factory,
        base: BASE,
      });
      await vi.waitFor(() => expect(host.current!.status).toBe("open"));
      const room = (await joinCreds(host, "remote")).room;
      expect(room).not.toBe(stored.room);
      expect(relay.urls.some((u) => u.endsWith(stored.room))).toBe(false);
      expect(JSON.parse(sessionStorage.getItem(ROOM_STORAGE_KEY)!).room).toBe(room);
    } finally {
      release?.();
    }
  });

  test("keeps the room across a reload of the presenter tab, so joined phones stay valid", async () => {
    const relay = new FakeRelay();
    const first = mountHost({
      controller: null,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const url = await vi.waitFor(() => first.current!.joinUrls!.remote);
    act(() => root?.unmount());
    root = null;
    const second = mountHost({
      controller: null,
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    await vi.waitFor(() => expect(second.current!.joinUrls?.remote).toBe(url));
    // The follow link too: its state key must survive, or joined followers stop trusting the presenter.
    expect(second.current!.joinUrls!.follow).toBe(first.current!.joinUrls!.follow);
  });

  test("shows no join link until the presenter's socket is open, so nobody reaches the relay first", async () => {
    // Review pass 3: the links showed while the dialog said "Connecting", and
    // an attendee who read the room id off the follow QR code could claim the
    // room's control seats with a made-up token before the presenter.
    // A relay that never answers: the presenter's socket stays "connecting".
    let asked = 0;
    const factory: SocketFactory = () => {
      asked += 1;
      return { send: () => {}, close: () => {} };
    };
    const host = mountHost({
      controller: fakeController(),
      docLink: null,
      enabled: true,
      socketFactory: factory,
      base: BASE,
    });
    await vi.waitFor(() => expect(asked).toBe(1));
    expect(host.current!.status).toBe("connecting");
    expect(host.current!.joinUrls).toBeNull();
    mount(h(JoinDialog, { isOpen: true, onOpenChange: () => {}, host: host.current! }));
    expect(document.querySelector(".docwalk-join-qr")).toBeNull();
    expect(document.querySelector('[data-testid="join-links-wait"]')?.textContent).toBe(
      "The links appear here once the room is open.",
    );
  });

  test("a room whose seat someone else took is left for a new one, with new keys and links", async () => {
    // A squatter who reached the relay first with a made-up seat token would
    // demote the presenter and its phones to follower seats; the presenter
    // moves instead of running degraded (decision 74).
    const stored = await createPresenterCredentials();
    sessionStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify(stored));
    const relay = new FakeRelay();
    relay.taken.add(`wss://docwalk.example/api/remote/${stored.room}`);
    const host = mountHost({
      controller: fakeController(),
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
    });
    const remote = await joinCreds(host, "remote");
    const follow = await joinCreds(host, "follow");
    expect(remote.room).not.toBe(stored.room);
    expect(remote.key).not.toBe(stored.key);
    expect(follow.view).not.toBe(stored.view);
    expect(follow.verify).not.toBe(stored.verify);
    expect(relay.urls.filter((u) => u.endsWith(stored.room))).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(ROOM_STORAGE_KEY)!).room).toBe(remote.room);
    expect(host.current!.status).toBe("open");
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

/** The presenter's reply to an agent's request. */
const agentReply = (p: Peer, request: string) =>
  vi.waitFor(() => {
    const reply = p.received.find((m) => "request" in m && m.request === request);
    if (!reply) throw new Error(`no answer to ${request}`);
    return reply;
  });

describe("presenter host and agents (decision 59)", () => {
  const DOC = "# Deck\n\n## One\n\nA.\n";

  async function mountAgentHost(props: Partial<HostProps> & { controller: DeckController | null }) {
    const relay = new FakeRelay();
    const result: { current: RemoteHost | null } = { current: null };
    const onAgentEdit = vi.fn<(markdown: string, name: string) => void>();
    const onAgentEditRefused = vi.fn<(name: string) => void>();
    let current: HostProps = {
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
      markdown: DOC,
      onAgentEdit,
      onAgentEditRefused,
      ...props,
    };
    const render = (next: Partial<HostProps>) => {
      current = { ...current, ...next };
      mount(h(HostProbe, { ...current, report: (r) => (result.current = r) }));
    };
    render({});
    // The agent joins an open room, as it does when started from the dialog's link.
    await vi.waitFor(() => expect(result.current!.status).toBe("open"));
    const creds = await joinCreds(result, "remote");
    const agent = peer(relay, creds, "agent");
    return { relay, host: result, agent, render, onAgentEdit, onAgentEditRefused };
  }

  test("an agent reads the document, and changes it only after the presenter allows agent edits", async () => {
    const { host, agent, onAgentEdit, onAgentEditRefused } = await mountAgentHost({
      controller: fakeController(),
    });
    await opened(agent);
    await vi.waitFor(() => expect(host.current!.participants.agents).toBe(1));

    await agent.conn.send({ type: "doc-get", request: "GetGetGetGet", from: agent.conn.id });
    expect(await agentReply(agent, "GetGetGetGet")).toMatchObject({ type: "doc", markdown: DOC });

    const write = (request: string) =>
      agent.conn.send({
        type: "doc-write",
        request,
        from: agent.conn.id,
        name: "claude-code",
        markdown: "# Changed\n",
        base: null,
      });
    await write("WriteOneWrit");
    expect(await agentReply(agent, "WriteOneWrit")).toMatchObject({
      ok: false,
      error: "edits-off",
    });
    expect(onAgentEditRefused).toHaveBeenCalledWith("claude-code");
    expect(onAgentEdit).not.toHaveBeenCalled();

    act(() => host.current!.setAllowAgentEdits(true));
    await write("WriteTwoWrit");
    expect(await agentReply(agent, "WriteTwoWrit")).toMatchObject({ ok: true });
    expect(onAgentEdit).toHaveBeenCalledWith("# Changed\n", "claude-code");
    await vi.waitFor(() => expect(host.current!.lastAgentEdit?.name).toBe("claude-code"));
  });

  test("the slide list waits until the deck shows the agent's write, so the agent never reads the old deck", async () => {
    const before = fakeController(2);
    const { host, agent, render } = await mountAgentHost({ controller: before });
    await opened(agent);
    act(() => host.current!.setAllowAgentEdits(true));
    await agent.conn.send({
      type: "doc-write",
      request: "WriteWriteWr",
      from: agent.conn.id,
      name: "codex",
      markdown: "# Changed\n",
      base: null,
    });
    await agentReply(agent, "WriteWriteWr");
    // App passes the new text before the deck has rebuilt from it.
    render({ markdown: "# Changed\n" });
    await agent.conn.send({ type: "slides-get", request: "SlidesSlides", from: agent.conn.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.received.some((m) => m.type === "slides")).toBe(false);

    render({ controller: fakeController(5) });
    const reply = await agentReply(agent, "SlidesSlides");
    expect(reply.type === "slides" && reply.slides).toHaveLength(5);
  });
});

/** A state with an attacker's document link, as a forging follower would send it. */
const forgedState = (current: string): RemoteMessage => ({
  type: "state",
  current,
  index: 0,
  total: 1,
  title: "Forged",
  docLink: "https://docwalk.example/app/#doc=forged",
  docLinkTooLong: false,
  level: "auto",
});

describe("follower", () => {
  test("says hello and goes to each slide the presenter announces", async () => {
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
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
      docLinkTooLong: false,
      level: "auto",
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("section-4/1"));
    await presenter.conn.send({
      type: "state",
      current: "section-5/1",
      index: 5,
      total: 10,
      title: "Title 5",
      docLink: null,
      docLinkTooLong: false,
      level: "auto",
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("section-5/1"));
    expect(result.current!.status).toBe("open");
  });

  test("catches up once its deck is ready, since state can arrive before the document loads", async () => {
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
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
      docLinkTooLong: false,
      level: "auto",
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
    const creds = await createPresenterCredentials();
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
      docLinkTooLong: false,
      level: "auto",
    });
    await vi.waitFor(() => expect(controller.goTo).toHaveBeenLastCalledWith("intro/2"));
    expect(controller.current()?.address).toBe("intro/2");
  });

  test("ignores a doc link to another site: a key holder must not steer followers off docwalk", async () => {
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
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
      docLinkTooLong: false,
      level: "auto",
    });
    await vi.waitFor(() => expect(result.current!.state?.current).toBe("a/1"));
    expect(result.current!.state?.docLink).toBeNull();
    // Dropped, not pending: the follower says it has no document instead of waiting forever.
    expect(result.current!.state?.docLinkTooLong).toBe(true);
  });

  test("a state another follower forged is dropped: only the presenter's signature counts", async () => {
    // Review pass 3: every follower holds the view key, so before state was
    // signed one attendee could seal {docLink: "#doc=<their markdown>"} and
    // every other follower's screen loaded it as the presenter's document.
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const presenter = peer(relay, creds, "presenter");
    const { sign: _sign, ...followLink } = creds;
    const forger = peer(relay, { ...followLink, key: null }, "follower");
    // The forger even holds a signing key of its own; it is not the room's.
    const own = await createPresenterCredentials();
    const forgerWithKey = peer(
      relay,
      { room: creds.room, key: own.key, view: creds.view, sign: own.sign },
      "presenter",
    );
    const { result } = mountFollower({
      creds: { ...followLink, key: null },
      controller: null,
      socketFactory: relay.factory,
      base: BASE,
    });
    await vi.waitFor(() => expect(ofType(presenter, "hello").length).toBeGreaterThan(0));
    await opened(forger);
    await forger.conn.send(forgedState("forged/1"));
    await forgerWithKey.conn.send(forgedState("forged/2"));
    await presenter.conn.send({
      type: "state",
      current: "real/1",
      index: 0,
      total: 1,
      title: "Real",
      docLink: "https://docwalk.example/app/?src=real",
      docLinkTooLong: false,
      level: "auto",
    });
    await vi.waitFor(() => expect(result.current!.state?.current).toBe("real/1"));
    await forger.conn.send(forgedState("forged/3"));
    await new Promise((r) => setTimeout(r, 100));
    expect(result.current!.state).toMatchObject({
      current: "real/1",
      docLink: "https://docwalk.example/app/?src=real",
    });
  });

  test("a follow link without the state key connects nothing: such a follower could trust no state", () => {
    const relay = new FakeRelay();
    const { room, view } = createRoomCredentials();
    const { result } = mountFollower({
      creds: { room, key: null, view },
      controller: null,
      socketFactory: relay.factory,
      base: BASE,
    });
    expect(result.current!.status).toBe("closed");
    expect(relay.urls).toHaveLength(0);
  });

  test("names the document to load: each new link, none while the link is built, a notice when there is none", () => {
    const state: FollowState = {
      current: "a/1",
      index: 0,
      total: 1,
      title: "A",
      docLink: null,
      docLinkTooLong: false,
      level: "auto",
    };
    expect(followedDocument(state)).toBeNull();
    expect(followedDocument({ ...state, docLink: "https://docwalk.example/#doc=x" })).toBe(
      "https://docwalk.example/#doc=x",
    );
    expect(followedDocument({ ...state, docLinkTooLong: true })).toBe(NO_DOC_LINK);
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
        docLinkTooLong: false,
        level: "auto",
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

const status = () => document.querySelector('[role="status"]')?.textContent;

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

  test(
    "when the presenter stops answering, the remote says so and stops offering presses that go nowhere",
    { timeout: PRESENTER_REPLY_MS + 5000 },
    async () => {
      // The relay reports no departures: after the presenter's tab closed, the
      // phone showed "Connected" and silently dropped every press.
      const presenter = await setupRemoteView();
      await userEvent.click(button("Next"));
      await vi.waitFor(() => expect(status()).toBe(PRESENTER_AWAY()), {
        timeout: PRESENTER_REPLY_MS + 2000,
      });
      expect(button("Next").disabled).toBe(true);
      expect(document.querySelector("h1")?.textContent).toBe("Waiting for the presenter…");

      // The presenter is back: its state brings the controls back.
      await presenter.conn.send({
        type: "state",
        current: "retries/1",
        index: 2,
        total: 10,
        title: "Retries",
        docLink: null,
        docLinkTooLong: false,
        level: "auto",
      });
      await vi.waitFor(() => expect(status()).toBe("Connected"));
      expect(button("Next").disabled).toBe(false);
    },
  );

  test("an incomplete link says so instead of spinning forever", () => {
    mount(h(RemoteView, { creds: null }));
    expect(document.querySelector("h1")?.textContent).toBe("This remote link is incomplete");
  });

  test("a follow link opened as a remote says the link is incomplete: it has no control key", () => {
    const { room, view } = createRoomCredentials();
    mount(h(RemoteView, { creds: { room, key: null, view } }));
    expect(document.querySelector("h1")?.textContent).toBe("This remote link is incomplete");
  });
});

describe("join dialog", () => {
  const host = {
    joinUrls: {
      remote: `${BASE}?view=remote#room=${"r".repeat(22)}&k=${"k".repeat(43)}`,
      follow: `${BASE}?view=follow#room=${"r".repeat(22)}&v=${"v".repeat(43)}&p=${"p".repeat(87)}`,
    },
    participants: { remotes: 1, followers: 2, agents: 0 },
    status: "open" as const,
    docLinkTooLong: false,
    allowAgentEdits: false,
    setAllowAgentEdits: () => {},
    lastAgentEdit: null,
  };

  test("is a named dialog with both QR codes, the key warning and 44px targets", () => {
    mount(h(JoinDialog, { isOpen: true, onOpenChange: () => {}, host }));
    const titleId = dialog().getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("Remote control");
    const qrs = [...dialog().querySelectorAll('svg[role="img"]')].map((s) =>
      s.getAttribute("aria-label"),
    );
    expect(qrs).toEqual(["QR code for the phone remote link", "QR code for the follow along link"]);
    expect(dialog().textContent).toContain(KEY_NOTE());
    expect(dialog().textContent).toContain("1 remote and 2 followers joined");
    expect(dialog().textContent).not.toContain(DOC_LINK_TOO_LONG());
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
    expect(dialog().textContent).toContain(DOC_LINK_TOO_LONG());
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

describe("join dialog: agents", () => {
  const host = {
    joinUrls: {
      remote: `${BASE}?view=remote#room=${"r".repeat(22)}&k=${"k".repeat(43)}`,
      follow: `${BASE}?view=follow#room=${"r".repeat(22)}&v=${"v".repeat(43)}&p=${"p".repeat(87)}`,
    },
    participants: { remotes: 0, followers: 0, agents: 1 },
    status: "open" as const,
    docLinkTooLong: false,
    allowAgentEdits: false,
    setAllowAgentEdits: vi.fn<(allow: boolean) => void>(),
    lastAgentEdit: null,
  };

  test("a named switch, off by default, with a 44px target, says what turning it on allows", async () => {
    mount(h(JoinDialog, { isOpen: true, onOpenChange: () => {}, host }));
    const toggle = dialog().querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(false);
    const label = toggle.closest("label")!;
    expect(label.textContent).toBe("Allow agent edits");
    expect(label.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent).toBe(
      AGENT_NOTE(),
    );
    expect(dialog().textContent).toContain("1 agent connected");
    await userEvent.click(label);
    expect(host.setAllowAgentEdits).toHaveBeenCalledWith(true);
  });

  test("shows which agent changed the document last", () => {
    const at = new Date(2026, 10, 5, 14, 3).getTime();
    mount(
      h(JoinDialog, {
        isOpen: true,
        onOpenChange: () => {},
        host: { ...host, allowAgentEdits: true, lastAgentEdit: { name: "claude-code", at } },
      }),
    );
    expect(dialog().querySelector('input[role="switch"]')).toHaveProperty("checked", true);
    expect(dialog().textContent).toContain(describeAgentEdit({ name: "claude-code", at }));
    expect(describeAgentEdit({ name: "claude-code", at })).toMatch(
      /^Last changed by claude-code at .*03/,
    );
  });
});
