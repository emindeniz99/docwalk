import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DeckController, SlideInfo } from "../deck/controller";
import {
  connectRoom,
  HELLO_AGAIN_GAP_MS,
  type RemoteRole,
  type RemoteStatus,
  type RoomConnection,
  type SocketFactory,
  type SocketHandlers,
} from "./client";
import { createPresenterCredentials, parseJoinFragment } from "./crypto";
import { ROOM_STORAGE_KEY, useRemoteHost, type RemoteHost } from "./host";
import type { RemoteMessage, RoomCredentials } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Decision 111: a client says hello again when it accepts a presenter state
 * from a sender id it has not seen, so a presenter that arrives after it (or
 * reloads) still counts it. These tests run the real client and host against
 * an in-memory relay that, like the Worker, forwards a frame only to the
 * sockets open at that moment and stores nothing.
 */

const BASE = "https://docwalk.example/app/";

/** The small relay of remote.browser.test.ts: every frame goes to every other open socket, never back. */
class FakeRelay {
  readonly sockets = new Set<{ url: string; handlers: SocketHandlers; open: boolean }>();

  factory: SocketFactory = (url, handlers) => {
    const entry = { url, handlers, open: false };
    this.sockets.add(entry);
    setTimeout(() => {
      if (!this.sockets.has(entry)) return;
      entry.open = true;
      handlers.open();
    }, 0);
    return {
      send: (data) => {
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

function peer(relay: FakeRelay, creds: RoomCredentials, role: RemoteRole): Peer {
  const received: RemoteMessage[] = [];
  const statuses: RemoteStatus[] = [];
  const conn = connectRoom({
    creds,
    role,
    socketFactory: relay.factory,
    base: BASE,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The hellos `p` received from the participant whose hello id is `id`. */
const helloesFrom = (p: Peer, id: string) =>
  p.received.filter((m) => m.type === "hello" && m.id === id);

const stateMessage = (title: string): Extract<RemoteMessage, { type: "state" }> => ({
  type: "state",
  current: "section-0/1",
  index: 0,
  total: 10,
  title,
  docLink: null,
  docLinkTooLong: false,
  level: "auto",
});

function fakeController(count = 10): DeckController {
  const slides: SlideInfo[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    address: `section-${i}/1`,
    sectionId: `section-${i}`,
    page: 1,
    title: `Title ${i}`,
    flagged: false,
    note: null,
    text: "",
  }));
  return {
    slides: () => slides,
    current: () => slides[0]!,
    goTo: () => true,
    next: () => {},
    prev: () => {},
    onChange(listener) {
      listener(slides[0]!);
      return () => {};
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

function unmount() {
  act(() => root?.unmount());
  root = null;
}

type HostProps = Parameters<typeof useRemoteHost>[0];

function HostProbe({ report, ...props }: HostProps & { report: (r: RemoteHost) => void }) {
  report(useRemoteHost(props));
  return null;
}

function mountHost(relay: FakeRelay) {
  const result: { current: RemoteHost | null } = { current: null };
  mount(
    h(HostProbe, {
      controller: fakeController(),
      docLink: null,
      enabled: true,
      socketFactory: relay.factory,
      base: BASE,
      report: (r: RemoteHost) => (result.current = r),
    }),
  );
  return result;
}

/** The credentials in the host's join link, once it shows one (they appear after its socket opened). */
async function joinCreds(host: { current: RemoteHost | null }, kind: "remote" | "follow") {
  const url = await vi.waitFor(() => {
    const urls = host.current?.joinUrls;
    if (!urls) throw new Error("no join links yet");
    return urls[kind];
  });
  return parseJoinFragment(new URL(url).hash)!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const conn of peers.splice(0)) conn.close();
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("hello again for a new presenter (decision 111)", () => {
  test("a remote, a follower and an agent that joined while the presenter's tab was reloading are counted when it comes back", async () => {
    // Their hellos went into a room with no presenter, and the relay keeps
    // nothing. The presenter's on-open state is the first thing they accept
    // from its new sender id, so they say hello again.
    const relay = new FakeRelay();
    const first = mountHost(relay);
    const remoteCreds = await joinCreds(first, "remote");
    const followCreds = await joinCreds(first, "follow");
    unmount();

    const remote = peer(relay, remoteCreds, "remote");
    const follower = peer(relay, followCreds, "follower");
    const agent = peer(relay, remoteCreds, "agent");
    await Promise.all([opened(remote), opened(follower), opened(agent)]);

    const second = mountHost(relay);
    await vi.waitFor(() =>
      expect(second.current!.participants).toEqual({ remotes: 1, followers: 1, agents: 1 }),
    );
  });

  test("a client says hello again once for a presenter sender it has not seen, and not for more states from the same one", async () => {
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const first = peer(relay, creds, "presenter");
    await opened(first);
    const remote = peer(relay, creds, "remote");
    await opened(remote);

    for (const title of ["a", "b", "c"]) await first.conn.send(stateMessage(title));
    // The hello on open, and one more for the presenter's first state.
    await vi.waitFor(() => expect(helloesFrom(first, remote.conn.id)).toHaveLength(2));
    await sleep(200);
    expect(helloesFrom(first, remote.conn.id)).toHaveLength(2);

    // A presenter tab that reloaded: same credentials, new connection, new sender id.
    await sleep(HELLO_AGAIN_GAP_MS + 100);
    const second = peer(relay, creds, "presenter");
    await opened(second);
    await second.conn.send(stateMessage("d"));
    await vi.waitFor(() => expect(helloesFrom(second, remote.conn.id)).toHaveLength(1));
    await sleep(200);
    expect(helloesFrom(second, remote.conn.id)).toHaveLength(1);
  });

  test("states that alternate between two senders cost one hello for each, not one for every change", async () => {
    // A replay of an earlier tab's states, or two presenter sockets that both
    // answer, interleave senders; the client remembers the last few it saw.
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const a = peer(relay, creds, "presenter");
    const b = peer(relay, creds, "presenter");
    await Promise.all([opened(a), opened(b)]);
    const remote = peer(relay, creds, "remote");
    await opened(remote);
    await vi.waitFor(() => expect(helloesFrom(a, remote.conn.id)).toHaveLength(1));

    for (const [i, presenter] of [a, b, a, b, a].entries()) {
      await presenter.conn.send(stateMessage(`s${i}`));
      await sleep(HELLO_AGAIN_GAP_MS + 100);
    }
    // The hello on open, one for A and one for B.
    expect(helloesFrom(a, remote.conn.id)).toHaveLength(3);
  });

  test("signed states from many senders make a remote say hello at most once a second", async () => {
    // Several presenter tabs of one room (duplicates, reloads) each sign with the room's key.
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const presenter = peer(relay, creds, "presenter");
    await opened(presenter);
    const victim = peer(relay, creds, "remote");
    await opened(victim);
    await vi.waitFor(() => expect(helloesFrom(presenter, victim.conn.id)).toHaveLength(1));

    const tabs = Array.from({ length: 5 }, () => peer(relay, creds, "presenter"));
    await Promise.all(tabs.map(opened));
    for (const [i, tab] of tabs.entries()) await tab.conn.send(stateMessage(`tab ${i}`));
    await sleep(1500);
    const extra = helloesFrom(presenter, victim.conn.id).length - 1;
    expect(extra).toBeGreaterThanOrEqual(1);
    expect(extra).toBeLessThanOrEqual(2);
  });

  test("unsigned states under fresh sender ids make a remote or an agent say no hello (decision 118)", async () => {
    // Anyone with the control key can seal a state under a new sender id. Before 118
    // each one cost a hello a second from every remote and agent, for as long as it went on.
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const presenter = peer(relay, creds, "presenter");
    await opened(presenter);
    const remote = peer(relay, creds, "remote");
    const agent = peer(relay, creds, "agent");
    await Promise.all([opened(remote), opened(agent)]);
    await vi.waitFor(() => expect(helloesFrom(presenter, remote.conn.id)).toHaveLength(1));
    await vi.waitFor(() => expect(helloesFrom(presenter, agent.conn.id)).toHaveLength(1));

    const forgers = Array.from({ length: 4 }, () => peer(relay, creds, "remote"));
    await Promise.all(forgers.map(opened));
    for (const [i, forger] of forgers.entries()) {
      await forger.conn.send(stateMessage(`forged ${i}`));
      await sleep(HELLO_AGAIN_GAP_MS / 2);
    }
    await sleep(HELLO_AGAIN_GAP_MS + 200);
    // The remote still shows the forged states (73 trusts the control key); it only stays quiet.
    expect(remote.received.filter((m) => m.type === "state").length).toBeGreaterThan(0);
    expect(helloesFrom(presenter, remote.conn.id)).toHaveLength(1);
    expect(helloesFrom(presenter, agent.conn.id)).toHaveLength(1);
  });

  test("a state another follower sealed does not make a follower say hello", async () => {
    // Followers share the view key; only the presenter's signature makes a state true (73).
    const relay = new FakeRelay();
    const creds = await createPresenterCredentials();
    const presenter = peer(relay, creds, "presenter");
    await opened(presenter);
    const follower = peer(relay, creds, "follower");
    const other = peer(relay, creds, "follower");
    await Promise.all([opened(follower), opened(other)]);
    await vi.waitFor(() => expect(helloesFrom(presenter, follower.conn.id)).toHaveLength(1));

    await other.conn.send(stateMessage("unsigned"));
    await sleep(300);
    expect(follower.received.filter((m) => m.type === "state")).toHaveLength(0);
    expect(helloesFrom(presenter, follower.conn.id)).toHaveLength(1);
  });

  test("the presenter's own reconnect costs no hellos", async () => {
    // The tab keeps its sender id across a socket that drops and reopens.
    const relay = new FakeRelay();
    const host = mountHost(relay);
    await vi.waitFor(() => expect(host.current!.status).toBe("open"));
    const stored = JSON.parse(sessionStorage.getItem(ROOM_STORAGE_KEY)!) as RoomCredentials;
    // A second presenter-role socket only listens: it sees every hello the host sees.
    const listener = peer(relay, stored, "presenter");
    await opened(listener);
    const follower = peer(relay, await joinCreds(host, "follow"), "follower");
    await opened(follower);
    await vi.waitFor(() => expect(helloesFrom(listener, follower.conn.id)).toHaveLength(2));
    await vi.waitFor(() => expect(follower.received.some((m) => m.type === "state")).toBe(true));
    const states = follower.received.filter((m) => m.type === "state").length;

    relay.drop(0);
    await vi.waitFor(() => expect(host.current!.status).toBe("reconnecting"));
    await vi.waitFor(() => expect(host.current!.status).toBe("open"), { timeout: 3000 });
    await vi.waitFor(() =>
      expect(follower.received.filter((m) => m.type === "state").length).toBeGreaterThan(states),
    );
    await sleep(300);
    expect(helloesFrom(listener, follower.conn.id)).toHaveLength(2);
  });
});
