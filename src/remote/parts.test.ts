import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { API_LIMITS } from "../api/types";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { connectRoom, type SocketFactory, type SocketHandlers } from "./client";
import {
  createRoomCredentials,
  encrypt,
  importKey,
  MAX_ASSEMBLED_BYTES,
  MAX_PARTS,
  PART_BYTES,
  toBase64Url,
} from "./crypto";
import { MAX_OPEN_TRANSFERS, PartAssembler, splitMessage, TRANSFER_IDLE_MS } from "./parts";
import { PRESENTER_ID, type RemoteMessage } from "./types";

/**
 * Parts carry agent messages larger than the relay's 16 KB frame cap
 * (decision 59). The cap stays, because it is the relay's abuse guard; these
 * tests prove that a real design doc still crosses it whole, that only the
 * addressed participant spends memory on it, and that a hostile key holder
 * cannot use parts to make a peer hold or inflate unbounded data.
 */

const FIXTURE = readFileSync(new URL("../../fixtures/ledger-redesign.md", import.meta.url), "utf8");
const AGENT = "AgentAgentAg";

const docMessage = (markdown: string): Extract<RemoteMessage, { type: "doc" }> => ({
  type: "doc",
  request: "RequestReque",
  to: AGENT,
  markdown,
  revision: "r".repeat(22),
});

async function deflated(value: unknown): Promise<string> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** Text deflate cannot shrink, so the part count is the worst case for its length. */
function incompressible(bytes: number): string {
  const random = new Uint8Array(Math.ceil((bytes * 3) / 4));
  // getRandomValues fills at most 64 KB per call.
  for (let i = 0; i < random.length; i += 65_536)
    crypto.getRandomValues(random.subarray(i, i + 65_536));
  return toBase64Url(random).slice(0, bytes);
}

describe("splitting", () => {
  test("a message that fits a frame is never split, and only document-sized types may be", async () => {
    expect(await splitMessage({ type: "step", direction: 1 }, PRESENTER_ID)).toBeNull();
    expect(
      await splitMessage({ type: "goto", address: "x".repeat(2000) }, PRESENTER_ID),
    ).toBeNull();
    expect(await splitMessage(docMessage(FIXTURE), AGENT)).not.toBeNull();
  });

  test("every part, encrypted, fits under the relay's cap even with the longest ids", async () => {
    const key = await importKey(createRoomCredentials().key);
    const longId = "L".repeat(64);
    const parts = (await splitMessage(
      { ...docMessage(incompressible(3 * PART_BYTES)), to: longId },
      longId,
    ))!;
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      // The longest seal too: a 64-character sender id and the largest counter.
      const seal = { sender: longId, counter: Number.MAX_SAFE_INTEGER };
      const frame = JSON.stringify(await encrypt(key, { ...part, id: longId }, seal));
      expect(frame.length).toBeLessThanOrEqual(API_LIMITS.maxFrameBytes);
    }
  });

  test("the largest document docwalk loads still fits within the part limit", async () => {
    const parts = await splitMessage(docMessage(incompressible(MAX_DOCUMENT_BYTES)), AGENT);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBeLessThanOrEqual(MAX_PARTS);
  });
});

describe("reassembly", () => {
  test("parts in any order give back the exact message, once", async () => {
    const message = docMessage(FIXTURE);
    const parts = (await splitMessage(message, AGENT))!;
    const assembler = new PartAssembler(AGENT);
    const shuffled = parts.toReversed();
    const results = [];
    for (const part of [...shuffled, shuffled[0]!]) results.push(await assembler.add(part));
    expect(results.filter(Boolean)).toEqual([message]);
    expect(assembler.open).toBe(1); // the duplicate opened a transfer nothing will finish
  });

  test("parts for someone else are dropped unread, so a phone never inflates an agent's document", async () => {
    const parts = (await splitMessage(docMessage(FIXTURE), AGENT))!;
    const phone = new PartAssembler("PhonePhonePh");
    for (const part of parts) expect(await phone.add(part)).toBeNull();
    expect(phone.open).toBe(0);
  });

  test("a part that disagrees about the transfer size spoils the transfer", async () => {
    const parts = (await splitMessage(docMessage(incompressible(3 * PART_BYTES)), AGENT))!;
    const assembler = new PartAssembler(AGENT);
    await assembler.add(parts[0]!);
    expect(await assembler.add({ ...parts[1]!, total: parts.length + 1 })).toBeNull();
    for (const part of parts.slice(1)) expect(await assembler.add(part)).toBeNull();
  });

  test("a key holder cannot pile up partial transfers: the oldest goes, and idle ones expire", async () => {
    let now = 0;
    const assembler = new PartAssembler(AGENT, () => now);
    const piece = { type: "part", to: AGENT, seq: 0, total: 2, data: "AAAA" } as const;
    for (let i = 0; i < MAX_OPEN_TRANSFERS + 3; i++)
      await assembler.add({ ...piece, id: `id${i}xxxxxx` });
    expect(assembler.open).toBe(MAX_OPEN_TRANSFERS);
    now += TRANSFER_IDLE_MS + 1;
    await assembler.add({ ...piece, id: "freshxxxxxx" });
    expect(assembler.open).toBe(1);
  });

  test("a deflate bomb stops at the size cap instead of inflating", async () => {
    // Count what the inflater produces: the result alone would be null either way.
    let inflated = 0;
    const Real = DecompressionStream;
    vi.stubGlobal("DecompressionStream", function (format: "deflate-raw") {
      const inner = new Real(format);
      const count = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          inflated += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return { writable: inner.writable, readable: inner.readable.pipeThrough(count) };
    });
    // 64 MB of one character deflates to a few kilobytes.
    const bomb = new Blob([new Uint8Array(64 * 1024 * 1024).fill(32)])
      .stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    const compressed = new Uint8Array(await new Response(bomb).arrayBuffer());
    const total = Math.ceil(compressed.length / PART_BYTES);
    const assembler = new PartAssembler(AGENT);
    let result: RemoteMessage | null = null;
    for (let seq = 0; seq < total; seq++) {
      result = await assembler.add({
        type: "part",
        to: AGENT,
        id: "BombBombBomb",
        seq,
        total,
        data: toBase64Url(compressed.subarray(seq * PART_BYTES, (seq + 1) * PART_BYTES)),
      });
    }
    vi.unstubAllGlobals();
    expect(result).toBeNull();
    expect(inflated).toBeGreaterThan(MAX_ASSEMBLED_BYTES);
    expect(inflated).toBeLessThan(MAX_ASSEMBLED_BYTES + 1024 * 1024);
  });

  test("a reassembled message is validated like any other, and may not be a navigation event", async () => {
    const assembler = new PartAssembler(AGENT);
    const one = async (value: unknown, id: string) =>
      assembler.add({ type: "part", to: AGENT, id, seq: 0, total: 1, data: await deflated(value) });
    expect(await one({ type: "step", direction: 1 }, "StepStepStep")).toBeNull();
    expect(await one({ ...docMessage("x"), revision: "short" }, "BadRevBadRev")).toBeNull();
    expect(await one(docMessage("ok"), "GoodGoodGood")).toEqual(docMessage("ok"));
  });
});

/** The Worker relay's behaviour, frame cap included: oversized frames are dropped silently. */
function cappedRelay() {
  const sockets = new Set<SocketHandlers>();
  const wire: string[] = [];
  const factory: SocketFactory = (_url, handlers) => {
    sockets.add(handlers);
    setTimeout(() => handlers.open(), 0);
    return {
      send(data) {
        if (data.length > API_LIMITS.maxFrameBytes) return;
        wire.push(data);
        for (const other of sockets)
          if (other !== handlers) setTimeout(() => other.message(data), 0);
      },
      close() {
        sockets.delete(handlers);
      },
    };
  };
  return { factory, wire };
}

describe("over the relay", () => {
  test("a design doc larger than a frame reaches the agent whole, and nobody else", async () => {
    const relay = cappedRelay();
    const creds = createRoomCredentials();
    const base = "https://docwalk.example/";
    const got = {
      presenter: [] as RemoteMessage[],
      agent: [] as RemoteMessage[],
      phone: [] as RemoteMessage[],
    };
    const join = (role: "presenter" | "agent" | "remote", into: RemoteMessage[]) =>
      connectRoom({
        creds,
        role,
        base,
        socketFactory: relay.factory,
        onMessage: (m) => into.push(m),
        onStatus: () => {},
      });
    const presenter = join("presenter", got.presenter);
    const agent = join("agent", got.agent);
    const phone = join("remote", got.phone);
    await vi.waitFor(() => expect(got.presenter.filter((m) => m.type === "hello")).toHaveLength(2));

    const big = FIXTURE.repeat(4);
    expect(big.length).toBeGreaterThan(API_LIMITS.maxFrameBytes * 4);
    const message = { ...docMessage(big), to: agent.id };
    expect(await presenter.send(message)).toBe("sent");
    await vi.waitFor(() => expect(got.agent.filter((m) => m.type === "doc")).toEqual([message]));
    expect(relay.wire.every((frame) => frame.length <= API_LIMITS.maxFrameBytes)).toBe(true);
    expect(got.phone.filter((m) => m.type !== "hello")).toEqual([]);

    // And back: the agent's write reaches only the presenter.
    const write: RemoteMessage = {
      type: "doc-write",
      request: "WriteWriteWr",
      from: agent.id,
      name: "test agent",
      markdown: big + "\n\nOne more line.\n",
      base: null,
    };
    expect(await agent.send(write)).toBe("sent");
    await vi.waitFor(() =>
      expect(got.presenter.filter((m) => m.type === "doc-write")).toEqual([write]),
    );
    expect(got.phone.filter((m) => m.type !== "hello")).toEqual([]);
    for (const conn of [presenter, agent, phone]) conn.close();
  });
});
