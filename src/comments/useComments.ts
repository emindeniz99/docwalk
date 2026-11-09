import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadedDocument } from "../inputs/types";
import { m } from "../paraglide/messages.js";
import { draftWouldBeReplaced } from "../share/draft";
import { readAuthor, writeAuthor } from "./author";
import { contentKey, DRAFT_ALIAS, legacySourceKey, sourceKey } from "./identity";
import { commentsParam, decodeComments, hashWithoutComments } from "./payload";
import {
  cleanAuthor,
  dedupeTombstones,
  mergeKeepingLocal,
  mergeSets,
  parseCommentsText,
  tombstoneFor,
} from "./schema";
import { openCommentStore, type CommentStore } from "./store";
import {
  MAX_COMMENTS,
  MAX_SIDECAR_BYTES,
  type Anchor,
  type CommentSet,
  type DocComment,
  type Tombstone,
} from "./types";

export type CommentNotice = {
  message: string;
  tone: "info" | "error";
  /** Deletes the comments a link or file would delete here (decision 119), and says so. */
  action?: { label: string; run: () => CommentNotice };
};

export interface CommentsApi {
  /** The current document's comments; empty until they have loaded. */
  comments: DocComment[];
  /** The deletions that go with them (decision 95), for the sidecar and the share link. */
  deleted: Tombstone[];
  /** False while the document's comments load. */
  ready: boolean;
  /** The document's identity (decision 65), null while it loads; saved marks use it too (105). */
  key: string | null;
  /** The identity the document had before decision 120, or null: saved marks move from it once. */
  legacyKey: string | null;
  /**
   * True when the document has no identity because the browser cannot hash
   * its text (no `crypto.subtle`: plain http outside localhost). `key` then
   * stays null for good, and so do the comments and the saved marks.
   */
  unidentified: boolean;
  /** False when this browser cannot keep comments (no IndexedDB): they last until the page closes. */
  persistent: boolean;
  /** True when the document's saved comments could not be read: new ones stay in this page until they can be. */
  unreadable: boolean;
  /** The display name typed in the panel, as typed (decision 97). Empty when none is set. */
  author: string;
  setAuthor: (name: string) => void;
  /** Call before handing an editor change to the document: an edit keeps the document's identity. */
  markEdit: (markdown: string) => void;
  add: (anchor: Anchor, text: string) => boolean;
  update: (id: string, text: string) => void;
  remove: (id: string) => void;
  setResolved: (id: string, resolved: boolean) => void;
  /** Merges a sidecar file; resolves to the message to show. */
  importFile: (file: File) => Promise<CommentNotice>;
}

export const IMPORT_TOO_LARGE = m.comments_import_too_large;
export const IMPORT_OVER_CAP = (): string => m.comments_import_over_cap({ max: MAX_COMMENTS });
export const LINK_COMMENTS_IGNORED = m.comments_link_ignored;

interface State extends CommentSet {
  key: string | null;
  /** The key the document had before decision 120, when it differs: saved marks move from it too. */
  legacyKey?: string | null;
  /** The saved comments could not be read, so nothing is written over them. */
  loadFailed: boolean;
  /** The document's text could not be hashed, so it has no key. */
  unidentified: boolean;
}

const EMPTY: State = {
  key: null,
  comments: [],
  deleted: [],
  loadFailed: false,
  unidentified: false,
};

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
  const [state, setState] = useState<State>(EMPTY);
  const [author, setAuthorState] = useState(readAuthor);
  const stateRef = useRef(state);
  const authorRef = useRef(author);
  const notify = useRef(onNotice);
  useEffect(() => {
    stateRef.current = state;
    authorRef.current = author;
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
  const pending = useRef<{ raw: string; set: CommentSet | null } | null>(null);
  /** Whether the current document came from a link (share fragment, `?src=`, `?repo=`). */
  const linkDoc = useRef(false);
  /** Merges the link's comments once both they and the document's own have loaded. */
  const applyPending = useRef(() => {});
  const readLink = useCallback((hash: string) => {
    const raw = commentsParam(hash);
    if (raw === null) return;
    const entry: { raw: string; set: CommentSet | null } = { raw, set: null };
    pending.current = entry;
    void decodeComments(raw).then((result) => {
      if (pending.current !== entry) return;
      if (!result.ok) {
        pending.current = null;
        replaceHash(hashWithoutComments(location.hash));
        notify.current({ message: result.message, tone: "error" });
        return;
      }
      entry.set = { comments: result.comments, deleted: result.deleted };
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

  /** Takes what the store holds after a save: another tab's comments and deletions join this page's. */
  const adopt = useCallback((key: string, stored: CommentSet) => {
    const cur = stateRef.current;
    if (cur.key !== key) return;
    const next = mergeSets(cur, stored);
    if (!next || (!next.dirty && !cur.loadFailed)) return;
    stateRef.current = {
      key,
      comments: next.comments,
      deleted: next.deleted,
      loadFailed: false,
      unidentified: false,
    };
    setState(stateRef.current);
  }, []);

  const saving = useRef(Promise.resolve());
  const persist = useCallback(
    (key: string, set: CommentSet) => {
      if (!store) return;
      saving.current = saving.current
        .then(async () => {
          // The saved comments could not be read: write only once they can be,
          // and merge with them, never over them (decision 95).
          const cur = stateRef.current;
          if (cur.key === key && cur.loadFailed) await store.read(key);
          adopt(key, await store.merge(key, set));
        })
        .catch(() =>
          notify.current({
            message: m.comments_store_failed(),
            tone: "error",
          }),
        );
    },
    [store, adopt],
  );

  /**
   * Applies tombstones a link or a file brought that would delete comments here,
   * once the user asks (decision 119). An edit made since still wins (decision 95).
   */
  const deleteHeld = useCallback(
    (key: string, held: Tombstone[]): CommentNotice => {
      const { key: now, comments, deleted } = stateRef.current;
      const merged =
        now === key ? mergeSets({ comments, deleted }, { comments: [], deleted: held }) : null;
      const count = merged?.removed ?? 0;
      if (merged?.dirty) {
        const { comments: next, deleted: gone } = merged;
        stateRef.current = { ...stateRef.current, comments: next, deleted: gone };
        setState(stateRef.current);
        persist(key, { comments: next, deleted: gone });
      }
      return { message: m.comments_deleted_held({ count }), tone: "info" };
    },
    [persist],
  );

  /** The question that goes with held tombstones, as a notice action; `report` also hears the answer. */
  const askToDelete = useCallback(
    (key: string, held: Tombstone[], report?: (notice: CommentNotice) => void) =>
      held.length === 0
        ? {}
        : {
            action: {
              label: m.comments_delete_held({ count: held.length }),
              run: () => {
                const done = deleteHeld(key, held);
                report?.(done);
                return done;
              },
            },
          },
    [deleteHeld],
  );

  useEffect(() => {
    applyPending.current = () => {
      const entry = pending.current;
      const { key, comments, deleted } = stateRef.current;
      if (!entry?.set || key === null) return;
      pending.current = null;
      replaceHash(hashWithoutComments(location.hash));
      if (!linkDoc.current) {
        notify.current({ message: LINK_COMMENTS_IGNORED(), tone: "error" });
        return;
      }
      // A link names any ids it likes: it deletes nothing here without asking (decision 119).
      const { merged, held } = mergeKeepingLocal({ comments, deleted }, entry.set);
      if (!merged) {
        notify.current({ message: IMPORT_OVER_CAP(), tone: "error" });
        return;
      }
      if (merged.dirty) {
        stateRef.current = {
          ...stateRef.current,
          comments: merged.comments,
          deleted: merged.deleted,
        };
        setState(stateRef.current);
        persist(key, merged);
      }
      const n = entry.set.comments.length;
      const carries = m.comments_link_carries({ count: n });
      notify.current({
        message:
          held.length === 0
            ? carries
            : `${carries} ${m.comments_would_delete({ count: held.length })}`,
        tone: "info",
        ...askToDelete(key, held, (done) => notify.current(done)),
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
    stateRef.current = EMPTY;
    void (async () => {
      setState(stateRef.current);
      if (!doc) return;
      let next = sourceKey(doc.source);
      if (next === null && doc.source.kind === "paste") {
        next = await store.getAlias(DRAFT_ALIAS).catch(() => null);
        if (next) aliased.current = next;
      }
      if (next === null) {
        try {
          next = await contentKey(doc.markdown);
        } catch {
          // No crypto.subtle: the document has no identity. Comments need one; the rest of the page does not.
          if (live) {
            stateRef.current = { ...EMPTY, unidentified: true };
            setState(stateRef.current);
          }
          return;
        }
      }
      // A list that cannot be read stays unread: the document opens empty, saves
      // nothing, and the panel says so, rather than writing over what is there.
      let loaded: CommentSet = { comments: [], deleted: [] };
      let loadFailed = false;
      try {
        loaded = await store.read(next);
      } catch {
        loadFailed = true;
      }
      // Decision 120: a `?src=` key used to keep the query, where a token can sit. What is
      // stored under that key moves to the new one, once, and the old record goes.
      const legacy = legacySourceKey(doc.source);
      if (legacy && !loadFailed && loaded.comments.length === 0 && loaded.deleted.length === 0) {
        try {
          const old = await store.read(legacy);
          if (old.comments.length > 0 || old.deleted.length > 0) {
            loaded = await store.merge(next, old);
            await store.remove(legacy);
          }
        } catch {
          // The old record stays where it is; the next open tries again.
        }
      }
      if (!live) return;
      const kind = doc.source.kind;
      linkDoc.current = kind === "fragment" || kind === "url" || kind === "repo";
      stateRef.current = {
        key: next,
        legacyKey: legacy,
        ...loaded,
        loadFailed,
        unidentified: false,
      };
      setState(stateRef.current);
      applyPending.current();
    })();
    return () => {
      live = false;
    };
  }, [doc, store]);

  // ---- Mutations -----------------------------------------------------------
  const change = useCallback(
    (fn: (set: CommentSet) => CommentSet) => {
      const { key, comments, deleted, loadFailed } = stateRef.current;
      if (key === null) return;
      const next = fn({ comments, deleted });
      stateRef.current = { key, ...next, loadFailed, unidentified: false };
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
      const name = cleanAuthor(authorRef.current);
      change((set) => ({
        ...set,
        comments: [
          ...set.comments,
          {
            id: newId(),
            anchor,
            text,
            ...(name === null ? {} : { author: name }),
            created: now,
            updated: now,
            resolved: false,
          },
        ],
      }));
      return true;
    },
    [change],
  );
  const update = useCallback(
    (id: string, text: string) =>
      change((set) => ({
        ...set,
        comments: set.comments.map((c) =>
          c.id === id ? { ...c, text, updated: Math.max(Date.now(), c.updated + 1) } : c,
        ),
      })),
    [change],
  );
  const setResolved = useCallback(
    (id: string, resolved: boolean) =>
      change((set) => ({
        ...set,
        comments: set.comments.map((c) =>
          c.id === id ? { ...c, resolved, updated: Math.max(Date.now(), c.updated + 1) } : c,
        ),
      })),
    [change],
  );
  const remove = useCallback(
    (id: string) =>
      change((set) => {
        const gone = set.comments.find((c) => c.id === id);
        if (!gone) return set;
        return {
          comments: set.comments.filter((c) => c.id !== id),
          deleted: dedupeTombstones([tombstoneFor(gone, Date.now()), ...set.deleted]),
        };
      }),
    [change],
  );

  const importFile = useCallback(
    async (file: File): Promise<CommentNotice> => {
      if (file.size > MAX_SIDECAR_BYTES) return { message: IMPORT_TOO_LARGE(), tone: "error" };
      let text: string;
      try {
        text = await file.text();
      } catch {
        return { message: m.comments_file_unreadable(), tone: "error" };
      }
      const result = parseCommentsText(text);
      if (!result.ok) return { message: result.message, tone: "error" };
      const { key, comments, deleted } = stateRef.current;
      if (key === null) return { message: m.comments_doc_loading(), tone: "error" };
      // A file deletes nothing here without asking either (decision 119).
      const { merged, held } = mergeKeepingLocal({ comments, deleted }, result);
      if (!merged) return { message: IMPORT_OVER_CAP(), tone: "error" };
      if (merged.dirty) change(() => ({ comments: merged.comments, deleted: merged.deleted }));
      const parts = [
        merged.changed > 0 ? m.comments_imported({ count: merged.changed }) : "",
        held.length > 0 ? m.comments_would_delete({ count: held.length }) : "",
      ].filter(Boolean);
      return {
        message: parts.length === 0 ? m.comments_nothing_new() : parts.join(" "),
        tone: "info",
        ...askToDelete(key, held),
      };
    },
    [change, askToDelete],
  );

  const setAuthor = useCallback((name: string) => {
    setAuthorState(name);
    writeAuthor(name);
  }, []);

  return {
    comments: state.comments,
    deleted: state.deleted,
    ready: state.key !== null,
    key: state.key,
    legacyKey: state.legacyKey ?? null,
    unidentified: state.unidentified,
    persistent: (store?.persistent ?? true) && !state.loadFailed,
    unreadable: state.loadFailed,
    author,
    setAuthor,
    markEdit,
    add,
    update,
    remove,
    setResolved,
    importFile,
  };
}
