import { afterEach, describe, expect, test } from "vitest";
import { memoryStore, openCommentStore } from "./store";
import type { DocComment } from "./types";

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

test("without IndexedDB the memory store still works and says it is not persistent", async () => {
  const store = memoryStore();
  await store.save("k", [comment]);
  expect(await store.load("k")).toEqual([comment]);
  expect(store.persistent).toBe(false);
});
