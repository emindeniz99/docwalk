import { fromBase64Url, randomId, toBase64Url } from "./crypto";

/**
 * Replay protection for room frames (decision 68). The relay is untrusted
 * (decision 8): it, or anyone on a `ws:` connection, could record a frame
 * and send it again later, moving the deck or re-applying an agent's write.
 * Every frame carries its sender's random session id and a counter that only
 * goes up (crypto.ts `Seal`), so a receiver keeps the highest counter per
 * sender and drops anything not above it.
 *
 * Senders are remembered up to a bound, least recently heard first out, so a
 * hostile key holder cannot grow the table without limit. A receiver that
 * reloads starts with an empty table.
 *
 * Every presenter connection has a sender id of its own, so the table alone
 * lets an earlier connection's frames through. The presenter's id therefore
 * starts with its connection's epoch, and a receiver drops a signed frame
 * from an older epoch than one it took (decision 170, `EpochGuard`).
 */

/** Distinct senders remembered; matches the presenter's participant bound. */
const MAX_SENDERS = 1000;

export class ReplayGuard {
  private readonly last = new Map<string, number>();

  constructor(private readonly max = MAX_SENDERS) {}

  /** True for a frame newer than every earlier one from `sender`; remembers it. */
  accept(sender: string, counter: number): boolean {
    const previous = this.last.get(sender);
    if (previous !== undefined && counter <= previous) return false;
    // Re-inserting keeps the map in order of when each sender was last heard.
    this.last.delete(sender);
    this.last.set(sender, counter);
    if (this.last.size > this.max) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return true;
  }
}

/** An epoch is a count of milliseconds in 6 bytes, big-endian: 8 base64url characters. */
const EPOCH_BYTES = 6;
const EPOCH_CHARS = 8;
/** The largest epoch 6 bytes hold, about the year 10889. */
export const MAX_EPOCH = 2 ** (8 * EPOCH_BYTES) - 1;
/** An epoch and a `randomId()`; a presenter built before decision 170 sends the 12-character id alone. */
const PRESENTER_SENDER_CHARS = EPOCH_CHARS + 12;

/** A presenter connection's sender id: its epoch (0 to MAX_EPOCH, whole), then a random id. */
export function presenterSender(epoch: number): string {
  const bytes = new Uint8Array(EPOCH_BYTES);
  let rest = epoch;
  for (let i = EPOCH_BYTES - 1; i >= 0; i--) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return toBase64Url(bytes) + randomId();
}

/** The epoch at the front of a presenter's sender id, or 0 for an id without one. */
export function senderEpoch(sender: string): number {
  if (sender.length !== PRESENTER_SENDER_CHARS) return 0;
  const bytes = fromBase64Url(sender.slice(0, EPOCH_CHARS));
  if (!bytes) return 0;
  let epoch = 0;
  for (const byte of bytes) epoch = epoch * 256 + byte;
  return epoch;
}

/**
 * The newest presenter connection a client has taken a frame from (decision
 * 170). Only frames whose signature verified come here: the signature covers
 * the sender id, so only the presenter chooses an epoch, and nobody can push
 * this mark past the presenter's current connection.
 */
export class EpochGuard {
  private newest = 0;

  /** False for a signed frame from an older connection than one taken; otherwise remembers its epoch. */
  accept(sender: string): boolean {
    const epoch = senderEpoch(sender);
    if (epoch < this.newest) return false;
    this.newest = epoch;
    return true;
  }
}
