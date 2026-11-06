import { describe, expect, test } from "vitest";
import { ReplayGuard } from "./replay";

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
