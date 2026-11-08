import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LoadedDocument } from "../inputs/types";
import { AUTHOR_KEY } from "./author";
import { serializeComments } from "./schema";
import { openCommentStore } from "./store";
import type { Anchor, DocComment } from "./types";
import { useComments, type CommentsApi } from "./useComments";

/**
 * The hook that owns a document's comments: deleting leaves a tombstone so
 * nothing brings the comment back (decision 95), a saved name is stamped on
 * new comments only (decision 97), and a list that could not be read is never
 * written over.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const heading: Anchor = { kind: "heading", slug: "goals" };
let root: Root | null = null;
let n = 0;

/** A file name no other test used, so each test has its own record in the shared database. */
const freshDoc = (): LoadedDocument => ({
  markdown: "# T\n\n## Goals\n\nText.\n",
  source: { kind: "file", name: `hook-${crypto.randomUUID()}-${n++}.md` },
});
const keyOf = (doc: LoadedDocument) => `file:${(doc.source as { name: string }).name}`;

function Harness({ doc, report }: { doc: LoadedDocument; report: (api: CommentsApi) => void }) {
  report(useComments({ doc, onNotice: () => {} }));
  return null;
}

function mount(doc: LoadedDocument) {
  const result: { current: CommentsApi | null } = { current: null };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness, { doc, report: (api) => (result.current = api) })));
  return result;
}

const settle = (ms = 50) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const ready = async (api: { current: CommentsApi | null }) => {
  await expect.poll(() => api.current?.ready).toBe(true);
};

const comment = (over: Partial<DocComment> = {}): DocComment => ({
  id: "from-a-file",
  anchor: heading,
  text: "From a colleague",
  created: 1_700_000_000_000,
  updated: 1_700_000_000_000,
  resolved: false,
  ...over,
});
const sidecar = (comments: DocComment[]) =>
  new File([serializeComments(comments)], "x.comments.json", { type: "application/json" });

beforeEach(() => {
  localStorage.removeItem(AUTHOR_KEY);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("deleting a comment", () => {
  test("leaves a tombstone, so the same comment in an older sidecar does not return", async () => {
    const doc = freshDoc();
    const api = mount(doc);
    await ready(api);
    act(() => void api.current!.add(heading, "Doomed"));
    const added = api.current!.comments[0]!;
    // The colleague's file still has the comment as it was before the deletion.
    const before = sidecar([added]);
    act(() => api.current!.remove(added.id));
    expect(api.current!.comments).toEqual([]);
    expect(api.current!.deleted.map((t) => t.id)).toEqual([added.id]);

    const notice = await act(() => api.current!.importFile(before));
    expect(notice.message).toContain("Nothing new");
    expect(api.current!.comments).toEqual([]);

    // The deletion is stored, so a reload (a new hook on the same document) keeps it.
    await settle();
    const stored = await (await openCommentStore()).read(keyOf(doc));
    expect(stored.comments).toEqual([]);
    expect(stored.deleted.map((t) => t.id)).toEqual([added.id]);
  });

  test("a file that deletes a comment removes it here and says so", async () => {
    const doc = freshDoc();
    const api = mount(doc);
    await ready(api);
    act(() => void api.current!.add(heading, "Mine"));
    const mine = api.current!.comments[0]!;
    const file = new File(
      [serializeComments([], [{ id: mine.id, deleted: mine.updated + 10 }])],
      "x.comments.json",
    );
    const notice = await act(() => api.current!.importFile(file));
    expect(notice.message).toBe("1 comment was removed because the file deletes it.");
    expect(api.current!.comments).toEqual([]);
  });

  test("an edit made after the deletion brings the comment back", async () => {
    const doc = freshDoc();
    const api = mount(doc);
    await ready(api);
    act(() => void api.current!.add(heading, "First"));
    const first = api.current!.comments[0]!;
    act(() => api.current!.remove(first.id));
    const edited = { ...first, text: "Second thoughts", updated: first.updated + 60_000 };
    const notice = await act(() => api.current!.importFile(sidecar([edited])));
    expect(notice.message).toBe("Imported 1 comment.");
    expect(api.current!.comments.map((c) => c.text)).toEqual(["Second thoughts"]);
    expect(api.current!.deleted).toEqual([]);
  });
});

describe("a second tab", () => {
  test("a stale save does not overwrite its comments or bring back its deletions", async () => {
    const doc = freshDoc();
    const api = mount(doc);
    await ready(api);
    act(() => void api.current!.add(heading, "Kept"));
    act(() => void api.current!.add(heading, "Deleted in the other tab"));
    await settle();
    const [kept, gone] = api.current!.comments as [DocComment, DocComment];

    // The other tab deletes one comment and adds one, straight into the store.
    const store = await openCommentStore();
    const other = comment({ id: "from-tab-two", text: "Added in the other tab" });
    await store.merge(keyOf(doc), {
      comments: [other],
      deleted: [{ id: gone.id, deleted: gone.updated + 5 }],
    });

    // This tab still shows its stale list; its next change saves it.
    act(() => api.current!.setResolved(kept.id, true));
    await settle();
    const stored = await store.read(keyOf(doc));
    expect(stored.comments.map((c) => c.id).toSorted()).toEqual([kept.id, other.id].toSorted());
    expect(stored.deleted.map((t) => t.id)).toEqual([gone.id]);
    // And this tab now shows what the other one did.
    expect(api.current!.comments.map((c) => c.id).toSorted()).toEqual(
      [kept.id, other.id].toSorted(),
    );
  });
});

describe("a list that cannot be read", () => {
  test("is never written over: new comments stay in the page until it can be read again", async () => {
    const doc = freshDoc();
    const store = await openCommentStore();
    const saved = comment({ id: "saved-before", text: "Saved before" });
    await store.save(keyOf(doc), [saved]);

    // Reads fail (an unreadable profile, a blocked database) until `broken` is cleared.
    let broken = true;
    const get = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof get>
    ) {
      if (broken && this.transaction?.mode === "readonly") throw new DOMException("unreadable");
      return get.apply(this, args);
    });

    const api = mount(doc);
    await ready(api);
    expect(api.current!.unreadable).toBe(true);
    expect(api.current!.persistent).toBe(false);
    expect(api.current!.comments).toEqual([]);

    act(() => void api.current!.add(heading, "Written while unreadable"));
    await settle();
    broken = false;
    // Nothing was written: the saved comment is the only one stored.
    expect((await store.read(keyOf(doc))).comments.map((c) => c.id)).toEqual(["saved-before"]);

    // The next change finds the list readable, merges with it, and clears the warning.
    act(() => void api.current!.add(heading, "Written after"));
    await expect.poll(() => api.current!.unreadable).toBe(false);
    await settle();
    const texts = (await store.read(keyOf(doc))).comments.map((c) => c.text).toSorted();
    expect(texts).toEqual(["Saved before", "Written after", "Written while unreadable"]);
    expect(api.current!.comments).toHaveLength(3);
  });
});

describe("the display name (decision 97)", () => {
  test("is empty by default and new comments carry no name", async () => {
    const api = mount(freshDoc());
    await ready(api);
    expect(api.current!.author).toBe("");
    act(() => void api.current!.add(heading, "Anonymous"));
    expect("author" in api.current!.comments[0]!).toBe(false);
  });

  test("is kept in localStorage, stamped on new comments, and an edit keeps what a comment had", async () => {
    const api = mount(freshDoc());
    await ready(api);
    act(() => api.current!.setAuthor("  Reviewer A  "));
    expect(localStorage.getItem(AUTHOR_KEY)).toBe("  Reviewer A  ");
    act(() => void api.current!.add(heading, "Signed"));
    expect(api.current!.comments[0]?.author).toBe("Reviewer A");

    act(() => api.current!.setAuthor("Someone else"));
    act(() => api.current!.update(api.current!.comments[0]!.id, "Edited"));
    expect(api.current!.comments[0]).toMatchObject({ text: "Edited", author: "Reviewer A" });
  });

  test("clearing the field stops naming new comments and rewrites no old one", async () => {
    const api = mount(freshDoc());
    await ready(api);
    act(() => api.current!.setAuthor("Reviewer A"));
    act(() => void api.current!.add(heading, "Signed"));
    act(() => api.current!.setAuthor(""));
    expect(localStorage.getItem(AUTHOR_KEY)).toBeNull();
    act(() => void api.current!.add(heading, "Unsigned"));
    expect(api.current!.comments.map((c) => c.author)).toEqual(["Reviewer A", undefined]);
  });

  test("a saved name is read when the page opens", async () => {
    localStorage.setItem(AUTHOR_KEY, "Reviewer A");
    const api = mount(freshDoc());
    await ready(api);
    expect(api.current!.author).toBe("Reviewer A");
  });

  test("a name that is only spaces, or has a control character, is not stamped", async () => {
    const api = mount(freshDoc());
    await ready(api);
    for (const bad of ["   ", "Re\u0000viewer", "x".repeat(41)]) {
      act(() => api.current!.setAuthor(bad));
      act(() => void api.current!.add(heading, `Odd ${bad.length}`));
    }
    expect(api.current!.comments.map((c) => "author" in c)).toEqual([false, false, false]);
  });
});
