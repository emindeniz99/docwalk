import { describe, expect, test, vi } from "vitest";
import {
  DAMAGED_FILE,
  mergeSets,
  NEWER_VERSION,
  NOT_A_COMMENTS_FILE,
  parseCommentsText,
  serializeComments,
  tombstoneFor,
  TOO_MANY,
} from "./schema";
import {
  FUTURE_SKEW_MS,
  MAX_AUTHOR_CHARS,
  MAX_COMMENT_CHARS,
  MAX_COMMENTS,
  MAX_TOMBSTONES,
  type DocComment,
  type Tombstone,
} from "./types";

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

const merge = (
  local: DocComment[],
  incoming: DocComment[],
  deleted: { local?: Tombstone[]; incoming?: Tombstone[] } = {},
) =>
  mergeSets(
    { comments: local, deleted: deleted.local ?? [] },
    { comments: incoming, deleted: deleted.incoming ?? [] },
  );

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
    expect(parseCommentsText(serializeComments(list))).toEqual({
      ok: true,
      comments: list,
      deleted: [],
    });
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
    expect(parseCommentsText(file([edited, old]))).toEqual({
      ok: true,
      comments: [edited],
      deleted: [],
    });
  });
});

describe("merging an import", () => {
  test("nothing local is lost and the newer copy of a shared comment wins", () => {
    const mine = comment({ id: "a", text: "mine, newer", updated: 20 });
    const theirsOld = comment({ id: "a", text: "theirs, older", updated: 10 });
    const theirsNew = comment({ id: "b", text: "only theirs" });
    const merged = merge([mine], [theirsOld, theirsNew]);
    expect(merged?.comments).toEqual([mine, theirsNew]);
    expect(merged?.changed).toBe(1);
  });

  test("a copy dated far in the future cannot beat a local edit, now or on a later re-import", () => {
    // The old rule clamped a future time to the clock at parse time. That made
    // a forged or badly skewed copy "edited just now", so it won every merge
    // against comments edited before the import, and won again each time the
    // same link or file was imported later.
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const mine = comment({
        id: "a",
        text: "mine",
        created: 1_700_000_000_000,
        updated: 1_799_999_990_000,
      });
      const forged = {
        ...comment({ id: "a", text: "forged" }),
        created: 1_700_000_000_000,
        updated: 8.64e15,
      };
      const first = parseCommentsText(file([forged]));
      expect(first.ok && merge([mine], first.comments)?.comments).toEqual([mine]);

      vi.advanceTimersByTime(60_000);
      const again = parseCommentsText(file([forged]));
      expect(again.ok && merge([mine], again.comments)?.comments).toEqual([mine]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a future time falls back to the creation time, or to 0 when that is forged too", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const honestCreation = parseCommentsText(
        file([{ ...comment(), created: 1_790_000_000_000, updated: 8.64e15 }]),
      );
      expect(honestCreation.ok && honestCreation.comments[0]).toMatchObject({
        created: 1_790_000_000_000,
        updated: 1_790_000_000_000,
      });
      const bothForged = parseCommentsText(
        file([{ ...comment(), created: 8.64e15, updated: 8.64e15 }]),
      );
      expect(bothForged.ok && bothForged.comments[0]).toMatchObject({ created: 0, updated: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a time within the clock-skew allowance is kept as written, so re-importing changes nothing", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const ahead = 1_800_000_000_000 + FUTURE_SKEW_MS - 1000;
      const text = file([{ ...comment(), created: ahead - 5, updated: ahead }]);
      const first = parseCommentsText(text);
      vi.advanceTimersByTime(30_000);
      const second = parseCommentsText(text);
      expect(first.ok && first.comments[0]?.updated).toBe(ahead);
      expect(second.ok && second.comments[0]?.updated).toBe(ahead);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an edit made after a distrusted time still produces a time the schema accepts", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const parsed = parseCommentsText(
        file([{ ...comment(), created: 8.64e15, updated: 8.64e15 }]),
      );
      const imported = parsed.ok ? parsed.comments[0]! : comment();
      const edited = {
        ...imported,
        text: "mine",
        updated: Math.max(Date.now(), imported.updated + 1),
      };
      expect(parseCommentsText(file([edited])).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an import that would pass the per-document cap is refused, not truncated", () => {
    const local = Array.from({ length: MAX_COMMENTS }, (_, i) => comment({ id: `l${i}` }));
    expect(merge(local, [comment({ id: "extra" })])).toBeNull();
  });
});

const gone = (id: string, deleted: number): Tombstone => ({ id, deleted });

describe("tombstones", () => {
  test("a deleted comment does not come back from an older sidecar or link", () => {
    const old = comment({ id: "a", updated: 100 });
    const merged = merge([], [old], { local: [gone("a", 200)] });
    expect(merged?.comments).toEqual([]);
    expect(merged?.deleted).toEqual([gone("a", 200)]);
    expect(merged?.changed).toBe(0);
  });

  test("a tombstone that arrives removes the local copy, and counts as a change", () => {
    const mine = comment({ id: "a", updated: 100 });
    const merged = merge([mine], [], { incoming: [gone("a", 150)] });
    expect(merged?.comments).toEqual([]);
    expect(merged?.changed).toBe(1);
    expect(merged?.dirty).toBe(true);
  });

  test("an edit made after the deletion wins, and its tombstone is dropped", () => {
    const edited = comment({ id: "a", text: "edited later", updated: 300 });
    const merged = merge([], [edited], { local: [gone("a", 200)] });
    expect(merged?.comments).toEqual([edited]);
    expect(merged?.deleted).toEqual([]);
  });

  test("deleting stamps a time after the comment's last edit, so the deletion wins a tie", () => {
    const c = comment({ id: "a", updated: 500 });
    expect(tombstoneFor(c, 400).deleted).toBe(501);
    expect(tombstoneFor(c, 900).deleted).toBe(900);
    expect(merge([], [c], { local: [tombstoneFor(c, 400)] })?.comments).toEqual([]);
  });

  test("tombstones merge by id and keep the later time; one for a comment never seen is kept", () => {
    const merged = merge([], [], {
      local: [gone("a", 10), gone("b", 50)],
      incoming: [gone("a", 30), gone("c", 5)],
    });
    expect(merged?.deleted).toEqual([gone("b", 50), gone("a", 30), gone("c", 5)]);
    expect(merged?.dirty).toBe(true);
  });

  test("merging what is already here changes nothing and is not dirty", () => {
    const mine = comment({ id: "a", updated: 100 });
    const set = { comments: [mine], deleted: [gone("b", 90)] };
    expect(mergeSets(set, set)).toMatchObject({
      comments: [mine],
      deleted: [gone("b", 90)],
      changed: 0,
      dirty: false,
    });
  });

  test("a document keeps at most MAX_TOMBSTONES tombstones, the newest ones", () => {
    const many = Array.from({ length: MAX_TOMBSTONES + 20 }, (_, i) => gone(`t${i}`, i + 1));
    const merged = merge([], [], { incoming: many });
    expect(merged?.deleted).toHaveLength(MAX_TOMBSTONES);
    expect(merged?.deleted.some((t) => t.id === "t0")).toBe(false);
    expect(merged?.deleted[0]).toEqual(gone(`t${MAX_TOMBSTONES + 19}`, MAX_TOMBSTONES + 20));
  });

  test("a time in the future is not trusted: it becomes 0, so it cannot delete anything edited", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      const parsed = parseCommentsText(file([], { deleted: [{ id: "a", deleted: 8.64e15 }] }));
      expect(parsed.ok && parsed.deleted).toEqual([gone("a", 0)]);
      const mine = comment({ id: "a", updated: 1_700_000_000_000 });
      expect(parsed.ok && merge([mine], [], { incoming: parsed.deleted })?.comments).toEqual([
        mine,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the sidecar format with tombstones, names and diagram signatures", () => {
  test("a file with no deletions has exactly the keys a build without tombstones wrote", () => {
    const parsed: unknown = JSON.parse(serializeComments([comment()]));
    expect(Object.keys(parsed as object)).toEqual(["format", "version", "comments"]);
    expect(parsed).toMatchObject({ version: 1 });
  });

  test("tombstones are written beside the comments in a version 1 file, and read back", () => {
    const deleted = [{ id: "b", deleted: 7 }];
    const text = serializeComments([comment()], deleted);
    expect(JSON.parse(text)).toMatchObject({ version: 1, deleted });
    expect(parseCommentsText(text)).toEqual({ ok: true, comments: [comment()], deleted });
  });

  test("a file written before tombstones existed reads as having none", () => {
    expect(parseCommentsText(file([comment()]))).toEqual({
      ok: true,
      comments: [comment()],
      deleted: [],
    });
  });

  test("a bad tombstone refuses the whole file, like a bad comment", () => {
    expect(parseCommentsText(file([], { deleted: [{ id: "<x>", deleted: 1 }] }))).toEqual({
      ok: false,
      message: DAMAGED_FILE(),
    });
    expect(parseCommentsText(file([], { deleted: [{ id: "a", deleted: -1 }] })).ok).toBe(false);
    expect(parseCommentsText(file([], { deleted: "all" })).ok).toBe(false);
  });

  test("more tombstones than a document keeps refuse the file", () => {
    const many = Array.from({ length: MAX_TOMBSTONES + 1 }, (_, i) => ({
      id: `t${i}`,
      deleted: 1,
    }));
    expect(parseCommentsText(file([], { deleted: many })).ok).toBe(false);
  });

  test("a tombstone carries an id and a time and nothing else", () => {
    const parsed = parseCommentsText(
      file([], { deleted: [{ id: "a", deleted: 3, text: "the deleted words" }] }),
    );
    expect(parsed.ok && parsed.deleted).toEqual([{ id: "a", deleted: 3 }]);
  });

  test("an author name round-trips, and a comment without one stays without the key", () => {
    const named = comment({ id: "n", author: "Reviewer A" });
    const parsed = parseCommentsText(serializeComments([named, comment()]));
    expect(parsed.ok && parsed.comments.map((c) => c.author)).toEqual(["Reviewer A", undefined]);
    expect(parsed.ok && "author" in parsed.comments[1]!).toBe(false);
  });

  test.each([
    ["an empty name", ""],
    ["a name with a control character", "Re\u0000viewer"],
    ["a name with a line break", "Re\nviewer"],
    ["a name past the limit", "x".repeat(MAX_AUTHOR_CHARS + 1)],
    ["a name that is not text", 42],
  ])("refuses %s", (_name, author) => {
    expect(parseCommentsText(file([{ ...comment(), author }])).ok).toBe(false);
  });

  test("a diagram signature is optional on a node anchor and must be short hex", () => {
    const node = { kind: "node", heading: "arch", diagram: 0, node: "a" };
    const withSig = parseCommentsText(
      file([{ ...comment(), anchor: { ...node, sig: "0123abcd" } }]),
    );
    expect(withSig.ok && withSig.comments[0]?.anchor).toEqual({ ...node, sig: "0123abcd" });
    const without = parseCommentsText(file([{ ...comment(), anchor: node }]));
    expect(without.ok && "sig" in without.comments[0]!.anchor).toBe(false);
    for (const sig of ["<img>", "", "0".repeat(17), 5]) {
      expect(parseCommentsText(file([{ ...comment(), anchor: { ...node, sig } }])).ok).toBe(false);
    }
  });
});
