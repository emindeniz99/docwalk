import { describe, expect, test } from "vitest";
import { randomId } from "./crypto";
import { EpochGuard, MAX_EPOCH, presenterSender, ReplayGuard, senderEpoch } from "./replay";

/**
 * A relay that records frames must not be able to send them again: a
 * replayed step moves the deck, a replayed agent write reverts the document.
 */
describe("replay guard", () => {
  test("a frame is accepted once; a repeat or an older counter from the same sender is dropped", () => {
    const guard = new ReplayGuard();
    expect(guard.accept("senderAAAAAA", 1)).toBe(true);
    expect(guard.accept("senderAAAAAA", 1)).toBe(false);
    expect(guard.accept("senderAAAAAA", 3)).toBe(true);
    expect(guard.accept("senderAAAAAA", 2)).toBe(false);
  });

  test("counters are per sender, so one participant's frames never block another's", () => {
    const guard = new ReplayGuard();
    expect(guard.accept("senderAAAAAA", 50)).toBe(true);
    expect(guard.accept("senderBBBBBB", 1)).toBe(true);
  });

  test("the table is bounded, dropping the sender heard from least recently", () => {
    const guard = new ReplayGuard(2);
    guard.accept("a", 5);
    guard.accept("b", 5);
    guard.accept("a", 6); // a is now the most recent
    guard.accept("c", 1); // evicts b
    expect(guard.accept("a", 6)).toBe(false);
    expect(guard.accept("b", 1)).toBe(true);
  });
});

/**
 * Decision 170: a reload of the presenter's tab seals with a sender id the
 * guard above has never seen, so a recording of the earlier tab's frames
 * passed it. The epoch in front of the presenter's id, which the presenter
 * signs with the id, says which connection is newer.
 */
describe("presenter connections in order", () => {
  test("a presenter's sender id carries its epoch whole, from 0 to the largest 6 bytes hold", () => {
    for (const epoch of [0, 1, 255, 256, 65_536, Date.now(), MAX_EPOCH - 1, MAX_EPOCH]) {
      const sender = presenterSender(epoch);
      // The relay's and every client's seal schema take 8 to 64 base64url characters.
      expect(sender).toMatch(/^[A-Za-z0-9_-]{20}$/);
      expect(senderEpoch(sender)).toBe(epoch);
    }
  });

  test("ids of one epoch still differ, so two connections never share a replay counter", () => {
    expect(presenterSender(5)).not.toBe(presenterSender(5));
  });

  test("an id without an epoch, as a presenter built before 170 sends, reads as the oldest", () => {
    expect(senderEpoch(randomId())).toBe(0);
    // Its first 8 characters would read as the largest epoch if the length were not checked.
    expect(senderEpoch("_".repeat(12))).toBe(0);
  });

  test("a client takes the newest connection, and the same one again, and drops an older one", () => {
    const guard = new EpochGuard();
    const earlier = presenterSender(1_000);
    const later = presenterSender(1_001);
    expect(guard.accept(earlier)).toBe(true);
    expect(guard.accept(later)).toBe(true);
    expect(guard.accept(later)).toBe(true);
    expect(guard.accept(earlier)).toBe(false);
    // Nor a presenter built before 170, once a newer one has spoken.
    expect(guard.accept(randomId())).toBe(false);
  });

  test("two connections with the same epoch both pass", () => {
    const guard = new EpochGuard();
    expect(guard.accept(presenterSender(7))).toBe(true);
    expect(guard.accept(presenterSender(7))).toBe(true);
  });

  test("until an epoch arrives, ids without one pass: a presenter built before 170 still works", () => {
    const guard = new EpochGuard();
    expect(guard.accept(randomId())).toBe(true);
    expect(guard.accept(randomId())).toBe(true);
    expect(guard.accept(presenterSender(1))).toBe(true);
  });
});
