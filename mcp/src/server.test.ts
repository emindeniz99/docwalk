import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSlide } from "../../src/remote/types.ts";
import { RoomError, type RoomState } from "./room.ts";
import { cleanAgentName, createServer, type Room } from "./server.ts";

/**
 * The tools an agent sees (decision 59). What matters to the agent: the
 * revision it reads goes back with its write, a refusal explains what to do
 * next instead of failing the call, and a write reports the slides that now
 * need attention. What matters to the presenter: the edit carries a name.
 */

const SLIDES: AgentSlide[] = [
  { address: "intro/1", title: "Intro", note: null },
  { address: "retries/1", title: "Retries", note: null },
  { address: "retries/2", title: "Retries", note: "Content overflows the slide by 80 px." },
];

function state(index: number): RoomState {
  return {
    type: "state",
    current: SLIDES[index]!.address,
    index,
    total: SLIDES.length,
    title: SLIDES[index]!.title,
    docLink: null,
    docLinkTooLong: false,
    level: "auto",
  };
}

function fakeRoom() {
  return {
    getDocument: vi.fn<Room["getDocument"]>(async () => ({
      markdown: "# Deck\n",
      revision: "R".repeat(22),
    })),
    writeDocument: vi.fn<Room["writeDocument"]>(async () => ({ revision: "N".repeat(22) })),
    listSlides: vi.fn<Room["listSlides"]>(async () => ({ current: "intro/1", slides: SLIDES })),
    goTo: vi.fn<Room["goTo"]>(async (address) => {
      const index = SLIDES.findIndex(
        (s) => s.address === address || s.address.startsWith(`${address}/`),
      );
      return state(Math.max(index, 0));
    }),
  };
}

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function connect(
  room: Room,
  options: Parameters<typeof createServer>[1] = {},
  clientName = "claude-code",
) {
  const server = createServer(room, options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    client,
  };
}

const texts = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("docwalk-mcp tools", () => {
  test("offers exactly the four tools of decision 59, and marks which ones only read", async () => {
    const { client } = await connect(fakeRoom());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "get_document",
      "goto_slide",
      "list_slides",
      "write_document",
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints["get_document"]?.readOnlyHint).toBe(true);
    expect(hints["list_slides"]?.readOnlyHint).toBe(true);
    expect(hints["write_document"]?.destructiveHint).toBe(true);
  });

  test("get_document returns the text and the revision to write against", async () => {
    const { call } = await connect(fakeRoom());
    const result = await call("get_document");
    expect(result.content[0]).toEqual({ type: "text", text: "# Deck\n" });
    expect(texts(result)).toContain(`revision: ${"R".repeat(22)}`);
  });

  test("write_document sends the base revision and the client's name, then reports slides with notes", async () => {
    const room = fakeRoom();
    const { call } = await connect(room);
    const result = await call("write_document", {
      markdown: "# New\n",
      base_revision: "R".repeat(22),
    });
    expect(room.writeDocument).toHaveBeenCalledWith("# New\n", {
      name: "claude-code",
      base: "R".repeat(22),
    });
    expect(result.isError).toBeFalsy();
    expect(texts(result)).toContain(`New revision: ${"N".repeat(22)}`);
    expect(texts(result)).toContain("3 slides; 1 with notes");
    expect(texts(result)).toContain(
      "retries/2 | Retries (note: Content overflows the slide by 80 px.)",
    );
  });

  test("DOCWALK_AGENT_NAME overrides the client's name on the presenter's notice", async () => {
    const room = fakeRoom();
    const { call } = await connect(room, { agentName: "Docs bot" });
    await call("write_document", { markdown: "x" });
    expect(room.writeDocument).toHaveBeenCalledWith("x", { name: "Docs bot", base: null });
  });

  test("a refused write is a tool error that tells the agent what to ask the presenter", async () => {
    const room = fakeRoom();
    room.writeDocument.mockRejectedValue(
      new RoomError('switch on "Allow agent edits"', "edits-off"),
    );
    const { call } = await connect(room);
    const result = await call("write_document", { markdown: "x" });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain("Allow agent edits");
  });

  test("goto_slide takes an address, a section id or a 1-based number", async () => {
    const room = fakeRoom();
    const { call } = await connect(room);
    expect(texts(await call("goto_slide", { slide: "retries/2" }))).toBe(
      "Now on slide 3 of 3: retries/2 | Retries",
    );
    expect(texts(await call("goto_slide", { slide: "retries" }))).toContain("retries/1");
    await call("goto_slide", { slide: "2" });
    expect(room.goTo).toHaveBeenLastCalledWith("retries/1");
    const missing = await call("goto_slide", { slide: "9" });
    expect(missing.isError).toBe(true);
    expect(texts(missing)).toContain("the deck has 3");
  });

  test("an address the deck does not have is reported, not claimed as reached", async () => {
    const { call } = await connect(fakeRoom());
    const result = await call("goto_slide", { slide: "no-such-section" });
    expect(result.isError).toBe(true);
    expect(texts(result)).toContain("Call list_slides");
  });
});

describe("agent names", () => {
  test("control characters and length are cleaned before they reach the presenter's screen", () => {
    expect(cleanAgentName("claude\ncode")).toBe("claude code");
    expect(cleanAgentName("x".repeat(100))).toHaveLength(64);
    expect(cleanAgentName("  ")).toBe("An agent");
    expect(cleanAgentName(undefined)).toBe("An agent");
  });
});
