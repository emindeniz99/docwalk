import { expect, test } from "vitest";
import type { CodeToken } from "./highlight";
import { createShikiClient } from "./shiki";
import type { ShikiReply, ShikiRequest } from "./shikiTokens";

/**
 * Decision 76: the highlighting worker is stopped when it keeps blocks
 * waiting too long, so a pattern that never returns cannot hold the deck's
 * measurement. "Too long" must mean silent: a deck with hundreds of blocks
 * posts them all at once, and a worker that answers them one after another
 * is busy, not stuck.
 */

const SILENCE_MS = 200;

/** A worker that answers one message at a time, `stepMs` apart, and never again once it meets `stuck`. */
class FakeWorker extends EventTarget {
  static started: FakeWorker[] = [];
  messages: ShikiRequest[] = [];
  terminated = false;
  private queue = Promise.resolve();
  constructor(
    private readonly stepMs: number,
    private readonly stuck: string | null,
  ) {
    super();
    FakeWorker.started.push(this);
  }
  postMessage(message: ShikiRequest): void {
    this.messages.push(message);
    this.queue = this.queue.then(() => this.answer(message));
  }
  terminate(): void {
    this.terminated = true;
  }
  private async answer(message: ShikiRequest): Promise<void> {
    if (message.kind === "tokenize" && message.text === this.stuck) await new Promise(() => {});
    if (message.kind === "tokenize") await new Promise((r) => setTimeout(r, this.stepMs));
    if (this.terminated) return;
    const data: ShikiReply =
      message.kind === "load"
        ? { kind: "loaded", id: message.id, languages: ["typescript"] }
        : { kind: "tokens", id: message.id, lines: [[{ text: message.text, kind: null }]] };
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function client(stepMs: number, stuck: string | null = null) {
  return createShikiClient({
    createWorker: () => new FakeWorker(stepMs, stuck),
    silenceMs: SILENCE_MS,
  });
}

const tokenized = (lines: CodeToken[][] | null) => lines !== null;

test("a worker that keeps answering colours every block of a long queue", async () => {
  FakeWorker.started = [];
  const tokenize = await client(20).loadTokenizer(["typescript"]);
  const blocks = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`);
  // 40 blocks 20 ms apart take 800 ms, four times the wait, with no gap over 20 ms.
  const lines = await Promise.all(blocks.map((text) => tokenize(text, "typescript")));
  expect(lines.filter(tokenized).length).toBe(40);
  expect(FakeWorker.started[0]?.terminated).toBe(false);
  // An idle worker is never stopped: the wait runs only while blocks wait.
  await new Promise((r) => setTimeout(r, SILENCE_MS * 2));
  expect(FakeWorker.started[0]?.terminated).toBe(false);
});

test("a block that never returns stops the worker; the next build does not send it again", async () => {
  FakeWorker.started = [];
  const stuck = "x".repeat(50);
  const shiki = client(5, stuck);
  const tokenize = await shiki.loadTokenizer(["typescript"]);
  const started = performance.now();
  const first = await Promise.all(
    ["before", stuck, "after"].map((text) => tokenize(text, "typescript")),
  );
  expect(first.map(tokenized)).toEqual([true, false, false]);
  expect(FakeWorker.started[0]?.terminated).toBe(true);
  expect(performance.now() - started).toBeGreaterThanOrEqual(SILENCE_MS);

  // The rebuild starts a new worker and leaves the block that ran over plain at once.
  const again = await shiki.loadTokenizer(["typescript"]);
  const second = await Promise.all([stuck, "after"].map((text) => again(text, "typescript")));
  expect(second.map(tokenized)).toEqual([false, true]);
  expect(FakeWorker.started).toHaveLength(2);
  const sent = FakeWorker.started[1]!.messages.filter((m) => m.kind === "tokenize");
  expect(sent.map((m) => (m.kind === "tokenize" ? m.text : ""))).toEqual(["after"]);
});
