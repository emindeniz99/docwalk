import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadedDocument } from "../inputs/types";
import { draftWouldBeReplaced } from "../share/draft";
import { contentKey, DRAFT_ALIAS, sourceKey } from "./identity";
import { commentsParam, decodeComments, hashWithoutComments } from "./payload";
import { mergeComments, parseCommentsText } from "./schema";
import { openCommentStore, type CommentStore } from "./store";
import { MAX_COMMENTS, MAX_SIDECAR_BYTES, type Anchor, type DocComment } from "./types";

export type CommentNotice = { message: string; tone: "info" | "error" };

export interface CommentsApi {
  /** The current document's comments; empty until they have loaded. */
  comments: DocComment[];
  /** False while the document's comments load. */
  ready: boolean;
  /** False when this browser cannot keep comments (no IndexedDB): they last until the page closes. */
  persistent: boolean;
  /** Call before handing an editor change to the document: an edit keeps the document's identity. */
  markEdit: (markdown: string) => void;
  add: (anchor: Anchor, text: string) => boolean;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
  setResolved: (id: string, resolved: boolean) => void;
  /** Merges a sidecar file; resolves to the message to show. */
  importFile: (file: File) => Promise<CommentNotice>;
}

export const IMPORT_TOO_LARGE = "This file is too large to be a comments file.";
export const IMPORT_OVER_CAP = `A document keeps at most ${MAX_COMMENTS} comments; importing these would pass that.`;
export const LINK_COMMENTS_IGNORED =
  "This link carries comments but no document of its own, so they were not imported.";

function newId(): string {
  return crypto.randomUUID();
}

/** Rewrites the hash without adding a history entry; a sandboxed frame without history access keeps it. */
function replaceHash(hash: string): void {
  try {
    const url = new URL(location.href);
    url.hash = hash;
    history.replaceState(history.state, "", url);
  } catch {
    // SecurityError in a sandboxed frame: the comments are imported anyway.
  }
}

/**
 * The current document's comments (decision 55): which document they
 * belong to (src/comments/identity.ts), loading and saving them, and
 * importing the comments a share link carries.
 */
export function useComments({
  doc,
  onNotice,
}: {
  doc: LoadedDocument | null;
  onNotice: (notice: CommentNotice) => void;
}): CommentsApi {
  const [store, setStore] = useState<CommentStore | null>(null);
  const [state, setState] = useState<{ key: string | null; comments: DocComment[] }>({
    key: null,
    comments: [],
  });
  const stateRef = useRef(state);
  const notify = useRef(onNotice);
  useEffect(() => {
    stateRef.current = state;
    notify.current = onNotice;
  });

  useEffect(() => {
    let live = true;
    void openCommentStore().then((s) => {
      if (live) setStore(s);
    });
    return () => {
      live = false;
    };
  }, []);

  // ---- Comments a share link carries ------------------------------------
  // Read at once: the link's hash is rewritten as the deck navigates.
  const pending = useRef<{ raw: string; comments: DocComment[] | null } | null>(null);
  /** Whether the current document came from a link (share fragment, `?src=`, `?repo=`). */
  const linkDoc = useRef(false);
  /** Merges the link's comments once both they and the document's own have loaded. */
  const applyPending = useRef(() => {});
  const readLink = useCallback((hash: string) => {
    const raw = commentsParam(hash);
    if (raw === null) return;
    const entry: { raw: string; comments: DocComment[] | null } = { raw, comments: null };
    pending.current = entry;
    void decodeComments(raw).then((result) => {
      if (pending.current !== entry) return;
      if (!result.ok) {
        pending.current = null;
        replaceHash(hashWithoutComments(location.hash));
        notify.current({ message: result.message, tone: "error" });
        return;
      }
      entry.comments = result.comments;
      applyPending.current();
    });
  }, []);
  const [startHash] = useState(() => location.hash);
  useEffect(() => {
    readLink(startHash);
    const onHash = () => readLink(location.hash);
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, [readLink, startHash]);

  const saving = useRef(Promise.resolve());
  const persist = useCallback(
    (key: string, comments: DocComment[]) => {
      if (!store) return;
      saving.current = saving.current
        .then(() => store.save(key, comments))
        .catch(() =>
          notify.current({
            message: "Comments could not be saved in this browser. Export them to keep them.",
            tone: "error",
          }),
        );
    },
    [store],
  );

  useEffect(() => {
    applyPending.current = () => {
      const entry = pending.current;
      const { key, comments } = stateRef.current;
      if (!entry?.comments || key === null) return;
      pending.current = null;
      replaceHash(hashWithoutComments(location.hash));
      if (!linkDoc.current) {
        notify.current({ message: LINK_COMMENTS_IGNORED, tone: "error" });
        return;
      }
      const merged = mergeComments(comments, entry.comments);
      if (!merged) {
        notify.current({ message: IMPORT_OVER_CAP, tone: "error" });
        return;
      }
      if (merged.changed > 0) {
        stateRef.current = { key, comments: merged.comments };
        setState(stateRef.current);
        persist(key, merged.comments);
      }
      const n = entry.comments.length;
      notify.current({
        message: `This link carries ${n} comment${n === 1 ? "" : "s"}; open Comments to read ${n === 1 ? "it" : "them"}.`,
        tone: "info",
      });
    };
  });

  // ---- Document identity ---------------------------------------------------
  const editedTo = useRef<string | null>(null);
  const aliased = useRef<string | null>(null);
  const markEdit = useCallback((markdown: string) => {
    editedTo.current = markdown;
  }, []);

  useEffect(() => {
    if (!store) return;
    const key = stateRef.current.key;
    if (doc && editedTo.current !== null && editedTo.current === doc.markdown && key !== null) {
      // An edit: same document, same comments. If the edit made it the draft,
      // the draft alias finds these comments again after a reload.
      editedTo.current = null;
      const own = doc.source.kind === "paste" || doc.source.kind === "file";
      if (own && aliased.current !== key && !draftWouldBeReplaced()) {
        aliased.current = key;
        void store.setAlias(DRAFT_ALIAS, key).catch(() => {});
      }
      return;
    }
    editedTo.current = null;
    let live = true;
    // No mutation may land on the previous document's key while this one loads.
    stateRef.current = { key: null, comments: [] };
    void (async () => {
      setState(stateRef.current);
      if (!doc) return;
      let next = sourceKey(doc.source);
      if (next === null && doc.source.kind === "paste") {
        next = await store.getAlias(DRAFT_ALIAS).catch(() => null);
        if (next) aliased.current = next;
      }
      next ??= await contentKey(doc.markdown);
      const comments = await store.load(next).catch(() => []);
      if (!live) return;
      const kind = doc.source.kind;
      linkDoc.current = kind === "fragment" || kind === "url" || kind === "repo";
      stateRef.current = { key: next, comments };
      setState(stateRef.current);
      applyPending.current();
    })();
    return () => {
      live = false;
    };
  }, [doc, store]);

  // ---- Mutations -----------------------------------------------------------
  const change = useCallback(
    (fn: (comments: DocComment[]) => DocComment[]) => {
      const { key, comments } = stateRef.current;
      if (key === null) return;
      const next = fn(comments);
      stateRef.current = { key, comments: next };
      setState(stateRef.current);
      persist(key, next);
    },
    [persist],
  );

  const add = useCallback(
    (anchor: Anchor, text: string) => {
      const { key, comments } = stateRef.current;
      if (key === null || text.trim() === "" || comments.length >= MAX_COMMENTS) return false;
      const now = Date.now();
      change((list) => [
        ...list,
        { id: newId(), anchor, text, created: now, updated: now, resolved: false },
      ]);
      return true;
    },
    [change],
  );
  const update = useCallback(
    (id: string, text: string) =>
      change((list) =>
        list.map((c) =>
          c.id === id ? { ...c, text, updated: Math.max(Date.now(), c.updated + 1) } : c,
        ),
      ),
    [change],
  );
  const setResolved = useCallback(
    (id: string, resolved: boolean) =>
      change((list) =>
        list.map((c) =>
          c.id === id ? { ...c, resolved, updated: Math.max(Date.now(), c.updated + 1) } : c,
        ),
      ),
    [change],
  );
  const remove = useCallback(
    (id: string) => change((list) => list.filter((c) => c.id !== id)),
    [change],
  );

  const importFile = useCallback(
    async (file: File): Promise<CommentNotice> => {
      if (file.size > MAX_SIDECAR_BYTES) return { message: IMPORT_TOO_LARGE, tone: "error" };
      let text: string;
      try {
        text = await file.text();
      } catch {
        return { message: "This file could not be read.", tone: "error" };
      }
      const result = parseCommentsText(text);
      if (!result.ok) return { message: result.message, tone: "error" };
      const { key, comments } = stateRef.current;
      if (key === null) return { message: "The document is still loading.", tone: "error" };
      const merged = mergeComments(comments, result.comments);
      if (!merged) return { message: IMPORT_OVER_CAP, tone: "error" };
      change(() => merged.comments);
      const n = merged.changed;
      return {
        message:
          n === 0
            ? "Nothing new: every comment in the file is already here."
            : `Imported ${n} comment${n === 1 ? "" : "s"}.`,
        tone: "info",
      };
    },
    [change],
  );

  return {
    comments: state.comments,
    ready: state.key !== null,
    persistent: store?.persistent ?? true,
    markEdit,
    add,
    update,
    remove,
    setResolved,
    importFile,
  };
}
