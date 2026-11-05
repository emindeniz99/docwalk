import { describe, expect, test, vi } from "vitest";
import { answerAgent, isAgentRequest, revisionOf, type AgentHostContext } from "./agent";
import { decrypt, encrypt, importKey, createRoomCredentials } from "./crypto";
import type { AgentSlide, RemoteMessage } from "./types";

/**
 * The presenter's side of decision 59. The rules that matter to the person
 * presenting: an agent can always read, but it changes the document only
 * while "Allow agent edits" is on, never over edits it has not seen, and the
 * presenter learns who changed it.
 */

const FROM = "AgentAgentAg";

function context(overrides: Partial<AgentHostContext> = {}) {
  let markdown: string | null = "# Deck\n\n## One\n\nA.\n";
  const slides: AgentSlide[] = [
    { address: "one/1", title: "One", note: null },
    { address: "two/1", title: "Two", note: "Overflows by 120 px." },
  ];
  const ctx: AgentHostContext = {
    markdown: () => markdown,
    slides: async () => ({ current: "one/1", slides }),
    allowEdits: () => false,
    apply: vi.fn<(md: string, name: string) => void>((md) => {
      markdown = md;
    }),
    refused: vi.fn<(name: string) => void>(),
    ...overrides,
  };
  return { ctx, setMarkdown: (md: string | null) => (markdown = md) };
}

const write = (
  markdown: string,
  base: string | null = null,
): RemoteMessage & { type: "doc-write" } => ({
  type: "doc-write",
  request: "WriteWriteWr",
  from: FROM,
  name: "claude-code",
  markdown,
  base,
});

describe("revisions", () => {
  test("are a stable hash of the text, so a reloaded tab and an agent agree without shared state", async () => {
    expect(await revisionOf("abc")).toBe(await revisionOf("abc"));
    expect(await revisionOf("abc")).not.toBe(await revisionOf("abd"));
    expect(await revisionOf("")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("answering an agent", () => {
  test("reading needs no permission: the document comes back with its revision, addressed to the asker", async () => {
    const { ctx } = context();
    const reply = await answerAgent({ type: "doc-get", request: "GetGetGetGet", from: FROM }, ctx);
    expect(reply).toEqual({
      type: "doc",
      request: "GetGetGetGet",
      to: FROM,
      markdown: "# Deck\n\n## One\n\nA.\n",
      revision: await revisionOf("# Deck\n\n## One\n\nA.\n"),
    });
  });

  test("the slide list carries each slide's note, so an agent can find and fix overflowing slides", async () => {
    const { ctx } = context();
    const reply = await answerAgent(
      { type: "slides-get", request: "SlidesSlides", from: FROM },
      ctx,
    );
    expect(reply).toMatchObject({ type: "slides", to: FROM, current: "one/1" });
    expect(reply.type === "slides" && reply.slides[1]?.note).toBe("Overflows by 120 px.");
  });

  test("a write while agent edits are off changes nothing, and the presenter hears who tried", async () => {
    const { ctx } = context();
    const reply = await answerAgent(write("# Replaced\n"), ctx);
    expect(reply).toEqual({
      type: "result",
      request: "WriteWriteWr",
      to: FROM,
      ok: false,
      error: "edits-off",
    });
    expect(ctx.apply).not.toHaveBeenCalled();
    expect(ctx.refused).toHaveBeenCalledWith("claude-code");
  });

  test("with edits on, a write replaces the document under the agent's name and returns the new revision", async () => {
    const { ctx } = context({ allowEdits: () => true });
    const reply = await answerAgent(write("# Replaced\n"), ctx);
    expect(ctx.apply).toHaveBeenCalledWith("# Replaced\n", "claude-code");
    expect(reply).toEqual({
      type: "result",
      request: "WriteWriteWr",
      to: FROM,
      ok: true,
      revision: await revisionOf("# Replaced\n"),
    });
  });

  test("a write based on an old revision is refused, so the presenter's own edits are not overwritten", async () => {
    const { ctx, setMarkdown } = context({ allowEdits: () => true });
    const seen = await revisionOf("# Deck\n\n## One\n\nA.\n");
    setMarkdown("# Deck\n\n## One\n\nA, edited by the presenter.\n");
    expect(await answerAgent(write("# Agent version\n", seen), ctx)).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(ctx.apply).not.toHaveBeenCalled();
    const current = await revisionOf("# Deck\n\n## One\n\nA, edited by the presenter.\n");
    expect(await answerAgent(write("# Agent version\n", current), ctx)).toMatchObject({ ok: true });
  });

  test("while the document loads there is nothing to read or write", async () => {
    const { ctx, setMarkdown } = context({ allowEdits: () => true });
    setMarkdown(null);
    for (const request of [
      { type: "doc-get", request: "GetGetGetGet", from: FROM } as const,
      write("x"),
    ]) {
      expect(await answerAgent(request, ctx)).toMatchObject({ ok: false, error: "no-document" });
    }
  });

  test("only agent requests are routed here; navigation keeps its own path", () => {
    expect(isAgentRequest({ type: "step", direction: 1 })).toBe(false);
    expect(isAgentRequest({ type: "slides-get", request: "SlidesSlides", from: FROM })).toBe(true);
  });
});

describe("agent messages on the wire", () => {
  test("every new message type survives encryption and validation unchanged", async () => {
    const key = await importKey(createRoomCredentials().key);
    const messages: RemoteMessage[] = [
      { type: "hello", role: "agent", id: FROM },
      { type: "doc-get", request: "GetGetGetGet", from: FROM },
      {
        type: "doc",
        request: "GetGetGetGet",
        to: FROM,
        markdown: "# Ü 🚀\n",
        revision: "r".repeat(22),
      },
      write("# x\n", "b".repeat(22)),
      { type: "slides-get", request: "SlidesSlides", from: FROM },
      { type: "slides", request: "SlidesSlides", to: FROM, current: null, slides: [] },
      { type: "result", request: "WriteWriteWr", to: FROM, ok: true, revision: "r".repeat(22) },
      { type: "result", request: "WriteWriteWr", to: FROM, ok: false, error: "edits-off" },
      { type: "part", to: FROM, id: "PartPartPart", seq: 0, total: 1, data: "AAAA" },
    ];
    for (const message of messages)
      expect(await decrypt(key, await encrypt(key, message))).toEqual(message);
  });

  test("an agent name cannot carry control characters or run long, since the presenter's notice shows it", async () => {
    const key = await importKey(createRoomCredentials().key);
    for (const name of ["", "evil\nname", "x".repeat(65)]) {
      expect(await decrypt(key, await encrypt(key, { ...write("x"), name }))).toBeNull();
    }
  });

  test("a part outside its transfer, or a result with an unknown error, is dropped", async () => {
    const key = await importKey(createRoomCredentials().key);
    const bad = [
      { type: "part", to: FROM, id: "PartPartPart", seq: 1, total: 1, data: "AAAA" },
      { type: "part", to: FROM, id: "PartPartPart", seq: 0, total: 100_000, data: "AAAA" },
      { type: "result", request: "WriteWriteWr", to: FROM, ok: false, error: "teapot" },
      { type: "doc", request: "GetGetGetGet", to: FROM, markdown: "x", revision: "short" },
    ];
    for (const message of bad) {
      expect(await decrypt(key, await encrypt(key, message as RemoteMessage))).toBeNull();
    }
  });
});
