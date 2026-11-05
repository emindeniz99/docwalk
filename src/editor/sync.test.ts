import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { announceDiagnostics, clampLine, groupDiagnostics, minimalChange } from "./sync";

const apply = (text: string, c: { from: number; to: number; insert: string }) =>
  text.slice(0, c.from) + c.insert + text.slice(c.to);

/** True when `at` falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, at: number) =>
  /[\uD800-\uDBFF]/.test(text[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[at] ?? "");

describe("minimalChange: applying the parent's value without resetting the editor", () => {
  test("an echo of the same text is no change at all, so the cursor and history stay put", () => {
    expect(minimalChange("# Title\n", "# Title\n")).toBeNull();
  });

  test("only the edited middle is replaced, so a cursor before or after it keeps its place", () => {
    expect(minimalChange("one two three", "one 2 three")).toEqual({ from: 4, to: 7, insert: "2" });
  });

  test("a repeated character is not counted twice by the prefix and the suffix", () => {
    // "aa" -> "aaa": prefix and suffix overlap; the change must still be an insert of one "a".
    expect(apply("aa", minimalChange("aa", "aaa")!)).toBe("aaa");
    expect(minimalChange("aa", "aaa")).toEqual({ from: 2, to: 2, insert: "a" });
  });

  test("a surrogate pair is never split, so the editor never holds half an emoji", () => {
    // Two emoji that share their high surrogate differ only in the low half.
    const c = minimalChange("x\u{1F600}y", "x\u{1F601}y")!;
    expect(c).toEqual({ from: 1, to: 3, insert: "\u{1F601}" });
  });

  fcTest.prop([fc.string({ unit: "binary" }), fc.string({ unit: "binary" })])(
    "applying the change always yields exactly the new text",
    (before, after) => {
      const c = minimalChange(before, after);
      expect(c === null ? before : apply(before, c)).toBe(after);
      if (c) for (const at of [c.from, c.to]) expect(splitsPair(before, at)).toBe(false);
    },
  );
});

describe("clampLine: a line from the outline or a diagnostic never crashes the editor", () => {
  test("lines past either end land on the first or last line", () => {
    expect(clampLine(0, 10)).toBe(1);
    expect(clampLine(99, 10)).toBe(10);
    expect(clampLine(4.7, 10)).toBe(4);
  });

  test("something that is not a line number is ignored rather than guessed", () => {
    expect(clampLine(Number.NaN, 10)).toBeNull();
  });
});

describe("groupDiagnostics: one marker per line, never a lost note", () => {
  test("notes on one line merge, and a warning outranks an info note", () => {
    const groups = groupDiagnostics(
      [
        { line: 5, message: "Split into 3 slides", severity: "info" },
        { line: 2, message: "Diagram scaled to 40%", severity: "info" },
        { line: 5, message: "Code block taller than a slide", severity: "warning" },
      ],
      10,
    );
    expect(groups).toEqual([
      { line: 2, severity: "info", messages: ["Diagram scaled to 40%"] },
      {
        line: 5,
        severity: "warning",
        messages: ["Split into 3 slides", "Code block taller than a slide"],
      },
    ]);
  });

  test("a stale note past the end of a shortened document stays visible on the last line", () => {
    const groups = groupDiagnostics([{ line: 40, message: "Too tall", severity: "warning" }], 3);
    expect(groups.map((g) => g.line)).toEqual([3]);
  });
});

describe("announceDiagnostics: what a screen reader hears when notes change", () => {
  test("says how many notes and where, so the user can go to them", () => {
    expect(
      announceDiagnostics([
        { line: 2, severity: "info", messages: ["a"] },
        { line: 5, severity: "warning", messages: ["b", "c"] },
        { line: 9, severity: "info", messages: ["d"] },
      ]),
    ).toBe("4 notes in the source, on lines 2, 5 and 9.");
    expect(announceDiagnostics([{ line: 1, severity: "info", messages: ["a"] }])).toBe(
      "1 note in the source, on line 1.",
    );
  });

  test("says nothing when there are no notes, so clearing them is not noise", () => {
    expect(announceDiagnostics([])).toBe("");
  });
});
