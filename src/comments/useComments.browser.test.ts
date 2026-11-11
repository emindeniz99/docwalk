import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LoadedDocument } from "../inputs/types";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import {
  clearDraft,
  draftWouldBeReplaced,
  holdDraft,
  loadDraft,
  releaseDraft,
  saveDraft,
} from "../share/draft";
import { buildAnchorIndex, resolveAnchor } from "./anchors";
import { AUTHOR_KEY } from "./author";
import { contentKey, DRAFT_ALIAS } from "./identity";
import { decodeComments, encodeComments } from "./payload";
import { parseCommentsText, serializeComments } from "./schema";
import { openCommentStore } from "./store";
import type { Anchor, DocComment } from "./types";
import { useComments, type CommentNotice, type CommentsApi } from "./useComments";

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

/** Every notice the hook raised in the page (a share link's import), newest last. */
const notices: CommentNotice[] = [];

function Harness({ doc, report }: { doc: LoadedDocument; report: (api: CommentsApi) => void }) {
  report(useComments({ doc, onNotice: (notice) => notices.push(notice) }));
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
  notices.length = 0;
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

  test("a file that would delete a comment here keeps it and asks; Delete removes it (decision 119)", async () => {
    // A file can carry up to 500 tombstones for any ids. Applied silently, a
    // file someone sent could wipe a reviewer's comments without a word.
    const doc = freshDoc();
    const api = mount(doc);
    await ready(api);
    act(() => void api.current!.add(heading, "Mine"));
    const mine = api.current!.comments[0]!;
    const file = new File(
      [serializeComments([comment()], [{ id: mine.id, deleted: mine.updated + 10 }])],
      "x.comments.json",
    );
    const notice = await act(() => api.current!.importFile(file));
    expect(notice.message).toBe(
      "Imported 1 comment. It also deletes 1 of your comments here; it stays unless you delete it.",
    );
    expect(api.current!.comments.map((c) => c.id).toSorted()).toEqual(
      [mine.id, "from-a-file"].toSorted(),
    );
    // Nothing deleted is stored either, so a reload keeps the comment too.
    await settle();
    const store = await openCommentStore();
    expect((await store.read(keyOf(doc))).deleted).toEqual([]);

    expect(notice.action?.label).toBe("Delete 1 comment");
    let after: CommentNotice | undefined;
    act(() => {
      after = notice.action!.run();
    });
    expect(after).toEqual({ message: "Deleted 1 comment.", tone: "info" });
    expect(api.current!.comments.map((c) => c.id)).toEqual(["from-a-file"]);
    await settle();
    expect((await store.read(keyOf(doc))).deleted.map((t) => t.id)).toEqual([mine.id]);
  });

  test("leaving the question unanswered keeps the comment", async () => {
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
    expect(notice.message).toBe(
      "It also deletes 1 of your comments here; it stays unless you delete it.",
    );
    // Another change saves the list: the held deletion must not ride along with it.
    act(() => api.current!.setResolved(mine.id, true));
    await settle();
    expect(api.current!.comments.map((c) => c.id)).toEqual([mine.id]);
    expect((await (await openCommentStore()).read(keyOf(doc))).comments).toHaveLength(1);
  });

  test("a share link that would delete a comment here keeps it and asks too", async () => {
    const doc: LoadedDocument = {
      markdown: "# T\n\n## Goals\n\nText.\n",
      source: { kind: "url", url: `https://docs.example/${crypto.randomUUID()}.md`, trusted: true },
    };
    const key = `url:${(doc.source as { url: string }).url}`;
    const store = await openCommentStore();
    const mine = comment({ id: "mine-before-the-link", text: "Mine" });
    await store.save(key, [mine]);
    const value = await encodeComments([], [{ id: mine.id, deleted: mine.updated + 10 }]);
    history.replaceState(null, "", `#c=${value}`);

    const api = mount(doc);
    await ready(api);
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]!.message).toBe(
      "This link carries 0 comments; open Comments to read them. It also deletes 1 of your comments here; it stays unless you delete it.",
    );
    expect(api.current!.comments.map((c) => c.id)).toEqual([mine.id]);
    expect(location.hash).toBe("");

    act(() => void notices[0]!.action!.run());
    expect(api.current!.comments).toEqual([]);
    expect(notices.at(-1)).toEqual({ message: "Deleted 1 comment.", tone: "info" });
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

describe("a ?src= document's key (decision 120)", () => {
  test("is the address without its query, and comments under the old key move to it once", async () => {
    const path = `https://docs.example/${crypto.randomUUID()}.md`;
    const doc: LoadedDocument = {
      markdown: "# T\n\n## Goals\n\nText.\n",
      source: { kind: "url", url: `${path}?t=secret-token`, trusted: true },
    };
    const store = await openCommentStore();
    const old = comment({ id: "saved-under-the-old-key", text: "Before 120" });
    await store.save(`url:${path}?t=secret-token`, [old]);

    const api = mount(doc);
    await ready(api);
    expect(api.current!.key).toBe(`url:${path}`);
    expect(api.current!.comments.map((c) => c.id)).toEqual([old.id]);
    await settle();
    // The token is gone from the database: the old record is deleted once it moved.
    expect((await store.read(`url:${path}?t=secret-token`)).comments).toEqual([]);
    expect((await store.read(`url:${path}`)).comments.map((c) => c.id)).toEqual([old.id]);
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

/** Mounts the hook on a document that can be swapped or rendered again, as the app does. */
function mountSwappable(doc: LoadedDocument) {
  const api: { current: CommentsApi | null } = { current: null };
  const report = (a: CommentsApi) => (api.current = a);
  const container = document.createElement("div");
  document.body.append(container);
  const own = createRoot(container);
  const render = (next: LoadedDocument) => act(() => own.render(h(Harness, { doc: next, report })));
  render(doc);
  return { api, render, unmount: () => act(() => own.unmount()) };
}

describe("a heading whose GitHub slug is empty (decision 132)", () => {
  test("keeps its comment over a reload, and the comment exports and shares", async () => {
    // `## ???` has no GitHub slug. An anchor with an empty slug was stored,
    // then dropped by the schema on the next load, and an export or share
    // link that held it was refused whole as damaged.
    const doc: LoadedDocument = {
      markdown: "# T\n\n## ???\n\nText.\n",
      source: { kind: "file", name: `empty-slug-${crypto.randomUUID()}.md` },
    };
    const tree = parseMarkdown(doc.markdown);
    const index = buildAnchorIndex(tree, sectionize(tree));
    const anchor: Anchor = { kind: "heading", slug: index.headings[1]!.slug };

    const first = mountSwappable(doc);
    await ready(first.api);
    act(() => void first.api.current!.add(anchor, "Which question?"));
    await settle();
    const written = first.api.current!.comments;
    expect(parseCommentsText(serializeComments(written)).ok).toBe(true);
    expect((await decodeComments(await encodeComments(written))).ok).toBe(true);
    first.unmount();

    const reloaded = mountSwappable(doc);
    await ready(reloaded.api);
    expect(reloaded.api.current!.comments.map((c) => c.text)).toEqual(["Which question?"]);
    const [kept] = reloaded.api.current!.comments;
    expect(resolveAnchor(kept!.anchor, index, new Map()).status).toBe("attached");
    reloaded.unmount();
  });
});

describe("Replace draft (decision 132)", () => {
  afterEach(() => {
    releaseDraft();
    clearDraft();
  });

  test("moves the draft alias at once, so a reload shows the new draft's comments", async () => {
    // A pasted draft D has comments; a share link S is opened and edited (the
    // draft would be replaced, so the alias stays on D); then the user presses
    // "Replace draft" and reloads without typing again.
    const store = await openCommentStore();
    const draftKey = `sha256:draft-d-${crypto.randomUUID()}`;
    await store.setAlias(DRAFT_ALIAS, draftKey);
    const d = `# D ${crypto.randomUUID()}\n\n## Goals\n\nText.\n`;
    saveDraft(d, { kind: "paste" });

    const page = mountSwappable({ markdown: d, source: { kind: "paste" } });
    await ready(page.api);
    expect(page.api.current!.key).toBe(draftKey);
    act(() => void page.api.current!.add(heading, "On D"));
    await settle();

    // A share link replaces the document on screen and lets go of the draft slot.
    releaseDraft();
    const s = `# S ${crypto.randomUUID()}\n\n## Goals\n\nText.\n`;
    const sKey = await contentKey(s);
    page.render({ markdown: s, source: { kind: "fragment" } });
    await expect.poll(() => page.api.current!.key).toBe(sKey);
    act(() => void page.api.current!.add(heading, "On S"));
    await settle();

    // An edit makes it the user's own text, which would replace the draft: not yet.
    const edited: LoadedDocument = { markdown: `${s}\nMore.\n`, source: { kind: "paste" } };
    act(() => page.api.current!.markEdit(edited.markdown));
    page.render(edited);
    await settle();
    expect(page.api.current!.key).toBe(sKey);
    expect(draftWouldBeReplaced()).toBe(true);

    // "Replace draft" (`replaceDraft` in src/shell/useDocument.ts) holds the
    // slot, saves the open text and renders the page again; the document is the same.
    holdDraft();
    saveDraft(edited.markdown, { kind: "paste" });
    page.render(edited);
    await settle();
    page.unmount();

    // Reload: the draft opens as a paste and finds its comments through the alias.
    const reloaded = mountSwappable({ markdown: loadDraft()!.markdown, source: { kind: "paste" } });
    await ready(reloaded.api);
    expect(reloaded.api.current!.key).toBe(sKey);
    expect(reloaded.api.current!.comments.map((c) => c.text)).toEqual(["On S"]);
    reloaded.unmount();
  });
});

/** A `?src=` document whose URL carries a token, with its key now and its key before decision 120. */
const urlDoc = (): { doc: LoadedDocument; next: string; legacy: string } => {
  const path = `https://docs.example/${crypto.randomUUID()}.md`;
  return {
    doc: {
      markdown: "# T\n\n## Goals\n\nText.\n",
      source: { kind: "url", url: `${path}?t=secret-token`, trusted: true },
    },
    next: `url:${path}`,
    legacy: `url:${path}?t=secret-token`,
  };
};

describe("the move of decision 120 (decision 132)", () => {
  test("an old record left beside a new key that has comments is merged and deleted at the next open", async () => {
    // A move whose delete did not happen left the token-bearing record behind;
    // the new key was no longer empty, so no later open looked at it again.
    const { doc, next, legacy } = urlDoc();
    const store = await openCommentStore();
    await store.save(next, [comment({ id: "under-the-new-key", text: "New" })]);
    await store.save(legacy, [comment({ id: "left-under-the-old-key", text: "Old" })]);

    const api = mount(doc);
    await ready(api);
    const both = ["left-under-the-old-key", "under-the-new-key"];
    expect(api.current!.comments.map((c) => c.id).toSorted()).toEqual(both);
    await settle();
    expect(await store.read(legacy)).toEqual({ comments: [], deleted: [] });
    expect((await store.read(next)).comments.map((c) => c.id).toSorted()).toEqual(both);
  });

  test("is one transaction: when the delete fails, the new key gets nothing and the next open moves it", async () => {
    // Merge and delete as two transactions: a delete that failed after the
    // merge left the token in the database for good.
    const { doc, next, legacy } = urlDoc();
    const store = await openCommentStore();
    const old = comment({ id: "saved-under-the-old-key", text: "Before 120" });
    await store.save(legacy, [old]);

    let broken = true;
    const del = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof del>
    ) {
      if (broken) throw new DOMException("delete failed", "UnknownError");
      return del.apply(this, args);
    });

    const page = mountSwappable(doc);
    await ready(page.api);
    await settle();
    broken = false;
    expect((await store.read(legacy)).comments.map((c) => c.id)).toEqual([old.id]);
    expect(await store.read(next)).toEqual({ comments: [], deleted: [] });
    page.unmount();

    const again = mountSwappable(doc);
    await ready(again.api);
    expect(again.api.current!.comments.map((c) => c.id)).toEqual([old.id]);
    await settle();
    expect(await store.read(legacy)).toEqual({ comments: [], deleted: [] });
    expect((await store.read(next)).comments.map((c) => c.id)).toEqual([old.id]);
    again.unmount();
  });
});
