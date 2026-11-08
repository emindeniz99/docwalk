import { afterEach, describe, expect, test } from "vitest";
import { memoryStore, openCommentStore } from "./store";
import { MAX_COMMENTS, MAX_TOMBSTONES, type DocComment } from "./types";

/**
 * Comments live only in the browser (decision 55), so IndexedDB is their one
 * copy: they must survive reopening the database, stay apart per document,
 * and a damaged record must read as "no comments", not crash the app.
 */

const names: string[] = [];
function dbName() {
  const name = `docwalk-comments-test-${crypto.randomUUID()}`;
  names.push(name);
  return name;
}
afterEach(() => {
  for (const n of names.splice(0)) indexedDB.deleteDatabase(n);
});

const comment: DocComment = {
  id: "c1",
  anchor: { kind: "heading", slug: "goals" },
  text: "Keep this",
  created: 1,
  updated: 1,
  resolved: false,
};

describe("IndexedDB comment store", () => {
  test("comments survive closing and reopening the store, kept apart per document", async () => {
    const name = dbName();
    const first = await openCommentStore(name);
    expect(first.persistent).toBe(true);
    await first.save("sha256:a", [comment]);
    await first.save("url:https://example.com/b.md", [{ ...comment, id: "c2" }]);

    const again = await openCommentStore(name);
    expect(await again.load("sha256:a")).toEqual([comment]);
    expect((await again.load("url:https://example.com/b.md")).map((c) => c.id)).toEqual(["c2"]);
    expect(await again.load("sha256:unknown")).toEqual([]);
  });

  test("deleting the last comment leaves no record behind", async () => {
    const name = dbName();
    const store = await openCommentStore(name);
    await store.save("k", [comment]);
    await store.save("k", []);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open(name);
      req.addEventListener("success", () => resolve(req.result));
    });
    const count = await new Promise<number>((resolve) => {
      const req = db.transaction("documents").objectStore("documents").count();
      req.addEventListener("success", () => resolve(req.result));
    });
    db.close();
    expect(count).toBe(0);
  });

  test("a record another build or a damaged profile wrote reads as no comments", async () => {
    const name = dbName();
    const store = await openCommentStore(name);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open(name);
      req.addEventListener("success", () => resolve(req.result));
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put({
        key: "bad",
        comments: [{ id: "<x>", text: 42 }],
      });
      tx.addEventListener("complete", () => resolve());
    });
    db.close();
    expect(await store.load("bad")).toEqual([]);
  });

  test("one bad comment in a record is dropped alone; the document's other comments still load", async () => {
    // Refusing the whole record read as "no comments", and the next save wrote
    // that short list over it: one bad timestamp cost every comment for good.
    const name = dbName();
    const store = await openCommentStore(name);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open(name);
      req.addEventListener("success", () => resolve(req.result));
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put({
        key: "mixed",
        comments: [comment, { ...comment, id: "c2", updated: 8640000000000001 }],
      });
      tx.addEventListener("complete", () => resolve());
    });
    db.close();
    expect(await store.load("mixed")).toEqual([comment]);
  });

  test("the draft alias points a reloaded draft at the comments it had", async () => {
    const store = await openCommentStore(dbName());
    expect(await store.getAlias("draft")).toBeNull();
    await store.setAlias("draft", "url:https://example.com/a.md");
    expect(await store.getAlias("draft")).toBe("url:https://example.com/a.md");
  });
});

describe("merging into the stored record (decisions 65 and 95)", () => {
  const second = { ...comment, id: "c2", text: "From the other tab" };

  test("a second tab's stale list neither overwrites the first tab's comments nor revives its deletions", async () => {
    const name = dbName();
    const tabOne = await openCommentStore(name);
    const tabTwo = await openCommentStore(name);
    await tabOne.merge("k", { comments: [comment, second], deleted: [] });
    // Tab two loaded both comments. Tab one deletes c1 and adds c3; tab two never hears of it.
    const stale = await tabTwo.read("k");
    const third = { ...comment, id: "c3", text: "Tab one adds" };
    await tabOne.merge("k", { comments: [third], deleted: [{ id: "c1", deleted: 5 }] });
    // Tab two edits c2 from its stale list and saves it whole.
    const edited = { ...second, text: "Edited in tab two", updated: 9 };
    const stored = await tabTwo.merge("k", {
      comments: stale.comments.map((c) => (c.id === "c2" ? edited : c)),
      deleted: stale.deleted,
    });
    expect(stored.comments.map((c) => [c.id, c.text]).toSorted()).toEqual([
      ["c2", "Edited in tab two"],
      ["c3", "Tab one adds"],
    ]);
    expect(stored.deleted).toEqual([{ id: "c1", deleted: 5 }]);
    expect(await tabOne.read("k")).toEqual(stored);
  });

  test("tombstones are stored beside the comments and survive reopening", async () => {
    const name = dbName();
    const first = await openCommentStore(name);
    await first.merge("k", { comments: [], deleted: [{ id: "gone", deleted: 7 }] });
    const again = await openCommentStore(name);
    expect(await again.read("k")).toEqual({ comments: [], deleted: [{ id: "gone", deleted: 7 }] });
    // A record with only tombstones has no comments to load.
    expect(await again.load("k")).toEqual([]);
  });

  test("a record written before tombstones existed reads with none", async () => {
    const name = dbName();
    const store = await openCommentStore(name);
    await store.save("k", [comment]);
    expect(await store.read("k")).toEqual({ comments: [comment], deleted: [] });
  });

  test("save replaces the comments and keeps the tombstones; remove deletes the whole record", async () => {
    const store = await openCommentStore(dbName());
    await store.merge("k", { comments: [comment], deleted: [{ id: "gone", deleted: 7 }] });
    await store.save("k", [second]);
    expect(await store.read("k")).toEqual({
      comments: [second],
      deleted: [{ id: "gone", deleted: 7 }],
    });
    await store.remove("k");
    expect(await store.read("k")).toEqual({ comments: [], deleted: [] });
  });

  test("a bad tombstone in a record is dropped alone, like a bad comment", async () => {
    const name = dbName();
    const store = await openCommentStore(name);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open(name);
      req.addEventListener("success", () => resolve(req.result));
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put({
        key: "k",
        comments: [comment],
        deleted: [
          { id: "ok", deleted: 3 },
          { id: "<x>", deleted: 3 },
          { id: "late", deleted: -1 },
        ],
      });
      tx.addEventListener("complete", () => resolve());
    });
    db.close();
    expect(await store.read("k")).toEqual({
      comments: [comment],
      deleted: [{ id: "ok", deleted: 3 }],
    });
  });

  test("a merge that would pass the comment cap is refused and writes nothing", async () => {
    const store = await openCommentStore(dbName());
    const many = Array.from({ length: MAX_COMMENTS }, (_, i) => ({ ...comment, id: `m${i}` }));
    await store.merge("k", { comments: many, deleted: [] });
    await expect(store.merge("k", { comments: [second], deleted: [] })).rejects.toThrow(
      "per-document cap",
    );
    expect((await store.read("k")).comments).toHaveLength(MAX_COMMENTS);
  });

  test("a record keeps at most MAX_TOMBSTONES tombstones, the newest", async () => {
    const store = await openCommentStore(dbName());
    const deleted = Array.from({ length: MAX_TOMBSTONES + 10 }, (_, i) => ({
      id: `t${i}`,
      deleted: i + 1,
    }));
    const stored = await store.merge("k", { comments: [], deleted });
    expect(stored.deleted).toHaveLength(MAX_TOMBSTONES);
    expect(stored.deleted.at(-1)?.deleted).toBe(11);
  });

  test("the memory store merges the same way", async () => {
    const store = memoryStore();
    await store.merge("k", { comments: [comment], deleted: [] });
    const stored = await store.merge("k", {
      comments: [second],
      deleted: [{ id: "c1", deleted: 5 }],
    });
    expect(stored).toEqual({ comments: [second], deleted: [{ id: "c1", deleted: 5 }] });
  });
});

test("without IndexedDB the memory store still works and says it is not persistent", async () => {
  const store = memoryStore();
  await store.save("k", [comment]);
  expect(await store.load("k")).toEqual([comment]);
  expect(store.persistent).toBe(false);
});
