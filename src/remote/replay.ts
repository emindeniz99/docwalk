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
 */

/** Distinct senders remembered; matches the presenter's participant bound. */
export const MAX_SENDERS = 1000;

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
