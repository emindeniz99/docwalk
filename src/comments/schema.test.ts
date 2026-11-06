import { describe, expect, test } from "vitest";
import {
  DAMAGED_FILE,
  mergeComments,
  NEWER_VERSION,
  NOT_A_COMMENTS_FILE,
  parseCommentsText,
  serializeComments,
  TOO_MANY,
} from "./schema";
import { MAX_COMMENT_CHARS, MAX_COMMENTS, type DocComment } from "./types";

/**
 * A sidecar is a file anyone can hand-make (decision 46), so import must
 * refuse anything that is not exactly what export writes, say why in words
 * a user can act on, and never import half a file.
 */

const comment = (over: Partial<DocComment> = {}): DocComment => ({
  id: "c1",
  anchor: { kind: "heading", slug: "goals" },
  text: "Why not a queue?",
  created: 1_700_000_000_000,
  updated: 1_700_000_000_000,
  resolved: false,
  ...over,
});

const file = (comments: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "docwalk-comments", version: 1, comments, ...extra });

describe("sidecar parsing", () => {
  test("what export writes, import reads back unchanged", () => {
    const list = [
      comment(),
      comment({
        id: "c2",
        anchor: { kind: "node", heading: "architecture", diagram: 0, node: "api_gw" },
        resolved: true,
      }),
    ];
    expect(parseCommentsText(serializeComments(list))).toEqual({ ok: true, comments: list });
  });

  test("non-JSON and JSON that is not a comments file are refused as not ours", () => {
    expect(parseCommentsText("not json")).toEqual({ ok: false, message: NOT_A_COMMENTS_FILE() });
    expect(parseCommentsText("[]")).toEqual({ ok: false, message: NOT_A_COMMENTS_FILE() });
    expect(parseCommentsText(JSON.stringify({ format: "excalidraw" }))).toEqual({
      ok: false,
      message: NOT_A_COMMENTS_FILE(),
    });
  });

  test("a file from a newer docwalk asks for an update instead of calling it damaged", () => {
    expect(parseCommentsText(file([], { version: 2 }))).toEqual({
      ok: false,
      message: NEWER_VERSION(),
    });
  });

  test("one bad comment refuses the whole file, so an import is never partial", () => {
    const bad = [
      comment(),
      { ...comment({ id: "c2" }), anchor: { kind: "heading", slug: "" } }, // empty anchor
    ];
    expect(parseCommentsText(file(bad))).toEqual({ ok: false, message: DAMAGED_FILE() });
  });

  test.each([
    ["an id with markup", { id: '<img src=x onerror="alert(1)">' }],
    ["an empty comment", { text: "   " }],
    ["an overlong comment", { text: "x".repeat(MAX_COMMENT_CHARS + 1) }],
    ["a negative diagram index", { anchor: { kind: "node", heading: "", diagram: -1, node: "a" } }],
    ["a control character in a slug", { anchor: { kind: "heading", slug: "a\u0000b" } }],
    ["a timestamp that is not a date", { created: Number.MAX_VALUE }],
    ["a string where a flag belongs", { resolved: "yes" }],
  ])("refuses %s", (_name, over) => {
    expect(parseCommentsText(file([{ ...comment(), ...over }])).ok).toBe(false);
  });

  test("more comments than a document keeps are refused with the cap in the message", () => {
    const many = Array.from({ length: MAX_COMMENTS + 1 }, (_, i) => comment({ id: `c${i}` }));
    expect(parseCommentsText(file(many))).toEqual({ ok: false, message: TOO_MANY() });
  });

  test("unknown fields are dropped, so nothing unvalidated reaches storage", () => {
    const result = parseCommentsText(
      file([{ ...comment(), html: "<script>", __proto__: { polluted: true } }]),
    );
    expect(result.ok && Object.keys(result.comments[0]!)).toEqual([
      "id",
      "anchor",
      "text",
      "created",
      "updated",
      "resolved",
    ]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("two copies of one comment keep the one edited last", () => {
    const old = comment({ text: "old" });
    const edited = comment({ text: "new", updated: old.updated + 5 });
    expect(parseCommentsText(file([edited, old]))).toEqual({ ok: true, comments: [edited] });
  });
});

describe("merging an import", () => {
  test("nothing local is lost and the newer copy of a shared comment wins", () => {
    const mine = comment({ id: "a", text: "mine, newer", updated: 20 });
    const theirsOld = comment({ id: "a", text: "theirs, older", updated: 10 });
    const theirsNew = comment({ id: "b", text: "only theirs" });
    const merged = mergeComments([mine], [theirsOld, theirsNew]);
    expect(merged?.comments).toEqual([mine, theirsNew]);
    expect(merged?.changed).toBe(1);
  });

  test("an import that would pass the per-document cap is refused, not truncated", () => {
    const local = Array.from({ length: MAX_COMMENTS }, (_, i) => comment({ id: `l${i}` }));
    expect(mergeComments(local, [comment({ id: "extra" })])).toBeNull();
  });
});
