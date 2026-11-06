import * as v from "valibot";
import { readAll } from "../share/fragment";
import {
  fromBase64Url,
  MAX_ASSEMBLED_BYTES,
  MAX_PARTS,
  PART_BYTES,
  randomId,
  RemoteMessageSchema,
  toBase64Url,
} from "./crypto";
import type { RemoteMessage } from "./types";

/**
 * Messages larger than a relay frame (decision 59): a document or a slide
 * list for an agent, or an agent's write. The relay caps frames at 16 KB to
 * block abuse, and a design doc is often bigger, so such a message is
 * deflated and cut into `part`s, each encrypted like any other message. Only
 * the addressed participant reassembles them; everyone else drops a part
 * after decrypting it, so phones never inflate a document they do not need.
 *
 * Parts come from key holders only, but a key holder may still be hostile:
 * every limit here stops one from making a peer hold or inflate unbounded
 * data. A reassembled message is validated like a single-frame one.
 */

type Part = Extract<RemoteMessage, { type: "part" }>;

/** Partial transfers a receiver keeps at once; the oldest is dropped for a new one. */
export const MAX_OPEN_TRANSFERS = 4;
/** A transfer with no new part for this long is dropped. */
export const TRANSFER_IDLE_MS = 30_000;

/** Only these may be split: the messages that carry a document or a slide list. */
const SPLITTABLE: ReadonlySet<RemoteMessage["type"]> = new Set(["doc", "doc-write", "slides"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return readAll(stream, Number.POSITIVE_INFINITY);
}

/**
 * `message` as parts for `to`, or null when it may not be split or would
 * need more than MAX_PARTS. Each part's payload is at most PART_BYTES.
 */
export async function splitMessage(message: RemoteMessage, to: string): Promise<Part[] | null> {
  if (!SPLITTABLE.has(message.type)) return null;
  // Copied so the bytes are typed as ArrayBuffer-backed under the Workers types too.
  const compressed = await deflate(new Uint8Array(encoder.encode(JSON.stringify(message))));
  const total = Math.max(1, Math.ceil(compressed.byteLength / PART_BYTES));
  if (total > MAX_PARTS) return null;
  const id = randomId();
  return Array.from({ length: total }, (_, seq) => ({
    type: "part",
    to,
    id,
    seq,
    total,
    data: toBase64Url(compressed.subarray(seq * PART_BYTES, (seq + 1) * PART_BYTES)),
  }));
}

interface Transfer {
  total: number;
  parts: Array<Uint8Array<ArrayBuffer> | undefined>;
  received: number;
  touched: number;
}

/**
 * Reassembles parts addressed to one participant. `add` returns the whole
 * message once its last part arrives, in any order, and null until then or
 * when the transfer is invalid.
 */
export class PartAssembler {
  private readonly transfers = new Map<string, Transfer>();

  constructor(
    /** This participant's id: its hello id, or PRESENTER_ID. */
    private readonly self: string,
    private readonly now: () => number = Date.now,
  ) {}

  async add(part: Part): Promise<RemoteMessage | null> {
    if (part.to !== this.self) return null;
    const bytes = fromBase64Url(part.data);
    if (!bytes || bytes.byteLength > PART_BYTES) return null;
    this.expire();

    let transfer = this.transfers.get(part.id);
    if (!transfer) {
      if (this.transfers.size >= MAX_OPEN_TRANSFERS) {
        const oldest = this.transfers.keys().next().value;
        if (oldest !== undefined) this.transfers.delete(oldest);
      }
      transfer = { total: part.total, parts: [], received: 0, touched: this.now() };
      this.transfers.set(part.id, transfer);
    }
    // A part that disagrees about the transfer's size spoils the whole transfer.
    if (transfer.total !== part.total) {
      this.transfers.delete(part.id);
      return null;
    }
    transfer.touched = this.now();
    if (transfer.parts[part.seq] === undefined) {
      transfer.parts[part.seq] = bytes;
      transfer.received++;
    }
    if (transfer.received < transfer.total) return null;

    this.transfers.delete(part.id);
    return inflateMessage(transfer.parts as Array<Uint8Array<ArrayBuffer>>);
  }

  /** Transfers still waiting for parts, for tests. */
  get open(): number {
    return this.transfers.size;
  }

  private expire() {
    const cutoff = this.now() - TRANSFER_IDLE_MS;
    for (const [id, transfer] of this.transfers) {
      if (transfer.touched < cutoff) this.transfers.delete(id);
    }
  }
}

async function inflateMessage(
  parts: Array<Uint8Array<ArrayBuffer>>,
): Promise<RemoteMessage | null> {
  try {
    const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const json: unknown = JSON.parse(decoder.decode(await readAll(stream, MAX_ASSEMBLED_BYTES)));
    const parsed = v.safeParse(RemoteMessageSchema, json);
    // Parts inside parts would let a transfer grow past every limit above.
    if (!parsed.success || !SPLITTABLE.has(parsed.output.type)) return null;
    return parsed.output;
  } catch {
    return null;
  }
}
