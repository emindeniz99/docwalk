import * as v from "valibot";
import { describe, expect, test } from "vitest";
import { MirrorMessageSchema } from "./mirrorSchema";
import { MAX_SLIDE_ADDRESS_CHARS } from "./mirrorTypes";

/**
 * The schema every mirror op passes where it arrives (decisions 88, 103 and
 * 110). A follower built before the board and the shapes rejects the new ops
 * here, whole, and keeps showing the slide; these tests pin what the current
 * schema accepts and refuses.
 */

const ok = (message: unknown) => v.is(MirrorMessageSchema, message);
const shape = (tool: string, over: Record<string, unknown> = {}) => ({
  type: "mirror",
  op: "stroke",
  slide: "retries/board",
  id: 1,
  tool,
  color: "primary",
  from: 0,
  points: [100, 200, 3000, 2000],
  end: true,
  ...over,
});

describe("rectangles and ellipses (decision 110)", () => {
  test.each(["rect", "ellipse"])(
    "a %s of four numbers, sent whole, is a stroke a receiver draws",
    (tool) => {
      expect(ok(shape(tool))).toBe(true);
      expect(ok(shape(tool, { points: [0, 0, 4096, 4096] }))).toBe(true);
    },
  );

  test.each(["rect", "ellipse", "arrow"])(
    "a %s with two or six numbers is refused: its box is two corners",
    (tool) => {
      expect(ok(shape(tool, { points: [100, 200] }))).toBe(false);
      expect(ok(shape(tool, { points: [100, 200, 300, 400, 500, 600] }))).toBe(false);
      expect(ok(shape(tool, { points: [] }))).toBe(false);
    },
  );

  test.each(["rect", "ellipse", "arrow"])(
    "a %s that does not start at 0 or does not end in one chunk is refused: a hostile sender cannot grow it",
    (tool) => {
      expect(ok(shape(tool, { from: 4, points: [300, 400] }))).toBe(false);
      expect(ok(shape(tool, { from: 4 }))).toBe(false);
      expect(ok(shape(tool, { end: false }))).toBe(false);
    },
  );

  test("a pen stroke still comes in chunks, any length, ending when it ends", () => {
    expect(ok(shape("pen", { end: false, points: [1, 2] }))).toBe(true);
    expect(ok(shape("pen", { from: 2, end: true, points: [3, 4, 5, 6, 7, 8] }))).toBe(true);
  });

  test("a tool the schema does not name is refused", () => {
    expect(ok(shape("line"))).toBe(false);
    expect(ok(shape("highlighter"))).toBe(false);
    expect(ok(shape("rectangle"))).toBe(false);
  });
});

describe("the board ops (decision 110)", () => {
  const open = { type: "mirror", op: "board-open", slide: "retries/2" };

  test("board-open names the page the board covers, and board-close names nothing", () => {
    expect(ok(open)).toBe(true);
    expect(ok({ type: "mirror", op: "board-close" })).toBe(true);
  });

  test("board-open needs an address of 1 to 2048 characters, as every op does", () => {
    expect(ok({ ...open, slide: "" })).toBe(false);
    expect(ok({ ...open, slide: "x".repeat(MAX_SLIDE_ADDRESS_CHARS) })).toBe(true);
    expect(ok({ ...open, slide: "x".repeat(MAX_SLIDE_ADDRESS_CHARS + 1) })).toBe(false);
    expect(ok({ type: "mirror", op: "board-open" })).toBe(false);
    expect(ok({ ...open, slide: 3 })).toBe(false);
    expect(ok({ ...open, slide: null })).toBe(false);
  });

  test("an extra field fails the whole op, so nothing rides along", () => {
    expect(ok({ ...open, html: "<img onerror=x>" })).toBe(false);
    expect(ok({ ...open, title: "Retries" })).toBe(false);
    expect(ok({ type: "mirror", op: "board-close", slide: "retries/2" })).toBe(false);
    expect(ok({ type: "mirror", op: "board-close", extra: 1 })).toBe(false);
  });

  test("an op name the schema does not know fails, which is what an older follower does with the new ones", () => {
    expect(ok({ type: "mirror", op: "board-toggle" })).toBe(false);
    expect(ok({ type: "mirror", op: "board" })).toBe(false);
    expect(ok({ type: "mirror", op: "boards-open", slide: "a/1" })).toBe(false);
  });
});
