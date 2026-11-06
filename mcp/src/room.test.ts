import { afterEach, describe, expect, test } from "vitest";
import { answerAgent, isAgentRequest, type AgentHostContext } from "../../src/remote/agent.ts";
import {
  connectRoom,
  type RoomConnection,
  type SocketFactory,
  type SocketHandlers,
} from "../../src/remote/client.ts";
import { createRoomCredentials, formatJoinUrl } from "../../src/remote/crypto.ts";
import type { RemoteMessage } from "../../src/remote/types.ts";
import { parseJoinLink, RoomAgent, RoomError } from "./room.ts";

/**
 * The agent's side of the room, against a presenter that answers with the
 * app's own rules (src/remote/agent.ts) through a relay that forwards frames
 * like the Worker. This is the wire contract both sides share: if either
 * side changes a message shape, these tests stop passing.
 */

/** Frames the relay carried, and a way to send one again to everyone, as a hostile relay could. */
let recorded: { frames: string[]; replay: (frame: string) => void } = {
  frames: [],
  replay: () => {},
};

/** Forwards every frame to every other socket, as the Worker's room does. */
function relay() {
  const sockets = new Set<SocketHandlers>();
  const frames: string[] = [];
  recorded = {
    frames,
    replay: (frame) => {
      for (const socket of sockets) setTimeout(() => socket.message(frame), 0);
    },
  };
  const factory: SocketFactory = (_url, handlers) => {
    sockets.add(handlers);
    setTimeout(() => handlers.open(), 0);
    return {
      send(data) {
        frames.push(data);
        for (const other of sockets)
          if (other !== handlers) setTimeout(() => other.message(data), 0);
      },
      close() {
        sockets.delete(handlers);
      },
    };
  };
  return factory;
}

const BASE = "https://docwalk.example/";
const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
});

/** A presenter whose document is `markdown` and whose deck has one slide per `## ` heading. */
function presenter(factory: SocketFactory, markdown: string, allowEdits: () => boolean) {
  const creds = createRoomCredentials();
  const doc = { markdown };
  const ctx: AgentHostContext = {
    markdown: () => doc.markdown,
    slides: async () => {
      const titles = [...doc.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      return {
        current: titles.length ? "s0/1" : null,
        slides: titles.map((title, i) => ({ address: `s${i}/1`, title, note: null })),
      };
    },
    allowEdits,
    apply: (next) => (doc.markdown = next),
    refused: () => {},
  };
  let index = 0;
  const conn: RoomConnection = connectRoom({
    creds,
    role: "presenter",
    base: BASE,
    socketFactory: factory,
    onStatus: () => {},
    onMessage: (message: RemoteMessage) => {
      if (isAgentRequest(message)) {
        void answerAgent(message, ctx).then((reply) => conn.send(reply));
      } else if (message.type === "goto") {
        const match = /^s(\d+)(\/1)?$/.exec(message.address);
        if (match) index = Number(match[1]);
        void conn.send({
          type: "state",
          current: `s${index}/1`,
          index,
          total: 10,
          title: `Slide ${index}`,
          docLink: null,
          docLinkTooLong: false,
          level: "auto",
        });
      }
    },
  });
  open.push(conn);
  return { link: formatJoinUrl(BASE, "remote", creds), doc };
}

function agent(factory: SocketFactory, link: string, timeoutMs = 2000) {
  const room = new RoomAgent({ link, socketFactory: factory, timeoutMs });
  open.push(room);
  return room;
}

describe("join links", () => {
  test("the phone remote link works; anything without a room key does not", () => {
    const creds = createRoomCredentials();
    expect(parseJoinLink(` ${formatJoinUrl(BASE, "remote", creds)}\n`)?.creds).toEqual({
      room: creds.room,
      key: creds.key,
      view: null,
    });
    expect(parseJoinLink("https://docwalk.example/?view=remote")).toBeNull();
    expect(parseJoinLink("javascript:alert(1)#room=x&k=y")).toBeNull();
    expect(parseJoinLink("not a url")).toBeNull();
    expect(() => new RoomAgent({ link: "nope" })).toThrow("not a docwalk join link");
  });

  test("the follow along link is refused with a pointer to the remote link: it can only watch", () => {
    // The follow link goes to an audience, so it holds only the view key
    // (decision 68): it reads no document and steers nothing.
    const follow = formatJoinUrl(BASE, "follow", createRoomCredentials());
    expect(() => new RoomAgent({ link: follow })).toThrow("follow along link");
  });
});

describe("room agent", () => {
  test("reads the document, writes it with the read revision, and the presenter's text changes", async () => {
    const factory = relay();
    const { link, doc } = presenter(factory, "# Deck\n\n## One\n", () => true);
    const room = agent(factory, link);
    const read = await room.getDocument();
    expect(read.markdown).toBe("# Deck\n\n## One\n");
    const written = await room.writeDocument("# Deck\n\n## One\n\n## Two\n", {
      name: "codex",
      base: read.revision,
    });
    expect(doc.markdown).toBe("# Deck\n\n## One\n\n## Two\n");
    expect(written.revision).not.toBe(read.revision);
    expect((await room.listSlides()).slides.map((s) => s.title)).toEqual(["One", "Two"]);
  });

  test("a refused write rejects with the presenter's reason, so the tool can explain it", async () => {
    const factory = relay();
    const { link, doc } = presenter(factory, "# Deck\n", () => false);
    const room = agent(factory, link);
    await expect(
      room.writeDocument("# Mine\n", { name: "codex", base: null }),
    ).rejects.toMatchObject({
      code: "edits-off",
    });
    expect(doc.markdown).toBe("# Deck\n");
  });

  test("a stale revision is refused rather than overwriting the presenter's edit", async () => {
    const factory = relay();
    const { link, doc } = presenter(factory, "# Deck\n", () => true);
    const room = agent(factory, link);
    const { revision } = await room.getDocument();
    doc.markdown = "# Deck, edited by hand\n";
    await expect(
      room.writeDocument("# Agent\n", { name: "codex", base: revision }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(doc.markdown).toBe("# Deck, edited by hand\n");
  });

  test("goto resolves with the slide the presenter shows afterwards", async () => {
    const factory = relay();
    const { link } = presenter(factory, "# Deck\n", () => true);
    const room = agent(factory, link);
    expect((await room.goTo("s4")).current).toBe("s4/1");
    expect(room.state?.index).toBe(4);
  });

  test("with no presenter in the room, a request fails with a message instead of hanging", async () => {
    const factory = relay();
    const room = agent(factory, formatJoinUrl(BASE, "remote", createRoomCredentials()), 100);
    const error = await room.getDocument().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).message).toContain("did not answer");
  });

  test("a relay that replays an agent's earlier write cannot revert the document", async () => {
    const factory = relay();
    const { link, doc } = presenter(factory, "# Deck\n", () => true);
    const room = agent(factory, link);
    await room.writeDocument("# First\n", { name: "codex", base: null });
    const firstWrite = recorded.frames.slice();
    await room.writeDocument("# Second\n", { name: "codex", base: null });
    for (const frame of firstWrite) recorded.replay(frame);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(doc.markdown).toBe("# Second\n");
  });

  test("a replayed state does not move the agent's idea of the current slide back", async () => {
    const factory = relay();
    const { link } = presenter(factory, "# Deck\n", () => true);
    const room = agent(factory, link);
    await room.goTo("s4");
    const atFour = recorded.frames.slice();
    await room.goTo("s2");
    for (const frame of atFour) recorded.replay(frame);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(room.state?.current).toBe("s2/1");
  });

  test("two agents in one room each get their own answers", async () => {
    const factory = relay();
    const { link } = presenter(factory, "# Deck\n\n## One\n", () => true);
    const first = agent(factory, link);
    const second = agent(factory, link);
    const [a, b] = await Promise.all([first.getDocument(), second.listSlides()]);
    expect(a.markdown).toContain("## One");
    expect(b.slides).toHaveLength(1);
  });
});
