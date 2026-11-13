/**
 * Comment storage in IndexedDB (decision 55): one record per document
 * identity, plus aliases (the draft slot). Nothing leaves the browser.
 *
 * IndexedDB can be missing (some private modes), blocked or full. Then the
 * store keeps comments in memory for this page and says so (`persistent`
 * is false), instead of failing: the panel tells the user to export.
 * What it reads back is validated like any other input (decision 46).
 */
import * as v from "valibot";
import { CommentSchema, dedupe, dedupeTombstones, mergeSets, TombstoneSchema } from "./schema";
import {
  MAX_COMMENTS,
  MAX_TOMBSTONES,
  type CommentSet,
  type DocComment,
  type Tombstone,
} from "./types";

export const DB_NAME = "docwalk-comments";
const DB_VERSION = 1;
const DOCS = "documents";
const ALIASES = "aliases";

export interface CommentStore {
  /** False when comments live only in this page's memory. */
  readonly persistent: boolean;
  /** A document's comments. A record with no comments reads as an empty list. */
  load(key: string): Promise<DocComment[]>;
  /** A document's comments and tombstones (decision 95). Rejects when the store cannot be read. */
  read(key: string): Promise<CommentSet>;
  /**
   * Replaces a document's comments and keeps its tombstones. For callers that
   * mean exactly that (fixtures); the app writes through `merge`.
   */
  save(key: string, comments: readonly DocComment[]): Promise<void>;
  /**
   * Merges `incoming` into the stored record inside one transaction and
   * returns what is stored now (decisions 65 and 95). A second tab that saves
   * a stale list neither overwrites the first tab's comments nor brings back
   * its deletions. Rejects, and writes nothing, when the merged comments
   * would pass the per-document cap.
   */
  merge(key: string, incoming: CommentSet): Promise<CommentSet>;
  /**
   * Merges the record under `from` into the one under `to` and deletes it, in
   * one transaction, and returns what `to` holds now (decision 120's move,
   * decision 132): either both happen or neither does. A missing `from` writes
   * nothing. Rejects, and changes nothing, past the per-document cap.
   */
  move(from: string, to: string): Promise<CommentSet>;
  /** Deletes a document's record, tombstones included: the document itself is gone. */
  remove(key: string): Promise<void>;
  getAlias(name: string): Promise<string | null>;
  setAlias(name: string, key: string): Promise<void>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error("IndexedDB request failed")));
  });
}

/** Resolves once the transaction has committed: a request's success can still be rolled back. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.addEventListener("upgradeneeded", () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(ALIASES))
        db.createObjectStore(ALIASES, { keyPath: "name" });
    });
    req.addEventListener("success", () => {
      // Let another tab upgrade or delete the database instead of blocking it forever.
      req.result.addEventListener("versionchange", () => req.result.close());
      resolve(req.result);
    });
    req.addEventListener("error", () => reject(req.error ?? new Error("IndexedDB open failed")));
    req.addEventListener("blocked", () => reject(new Error("IndexedDB open blocked")));
  });
}

/**
 * The valid comments and tombstones of a record another build or a damaged
 * profile wrote. A bad entry is dropped alone: refusing the whole record
 * would read as "no comments", and the next save would write that over the
 * good ones.
 */
function validSet(value: unknown): CommentSet {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const comments: DocComment[] = [];
  if (Array.isArray(record["comments"])) {
    for (const item of record["comments"].slice(0, MAX_COMMENTS)) {
      const result = v.safeParse(CommentSchema, item);
      if (result.success) comments.push(result.output);
    }
  }
  // A record from before decision 95 has no `deleted`.
  const deleted: Tombstone[] = [];
  if (Array.isArray(record["deleted"])) {
    for (const item of record["deleted"].slice(0, MAX_TOMBSTONES)) {
      const result = v.safeParse(TombstoneSchema, item);
      if (result.success) deleted.push(result.output);
    }
  }
  return { comments: dedupe(comments), deleted: dedupeTombstones(deleted) };
}

const OVER_CAP = "The merged comments would pass the per-document cap.";

export function memoryStore(): CommentStore {
  const docs = new Map<string, CommentSet>();
  const aliases = new Map<string, string>();
  const read = async (key: string): Promise<CommentSet> => {
    const set = docs.get(key);
    return { comments: [...(set?.comments ?? [])], deleted: [...(set?.deleted ?? [])] };
  };
  return {
    persistent: false,
    load: async (key) => (await read(key)).comments,
    read,
    save: async (key, comments) => {
      docs.set(key, { comments: [...comments], deleted: (await read(key)).deleted });
    },
    merge: async (key, incoming) => {
      const merged = mergeSets(await read(key), incoming);
      if (!merged) throw new Error(OVER_CAP);
      docs.set(key, { comments: merged.comments, deleted: merged.deleted });
      return read(key);
    },
    move: async (from, to) => {
      const old = docs.get(from);
      if (!old) return read(to);
      const merged = mergeSets(await read(to), old);
      if (!merged) throw new Error(OVER_CAP);
      docs.set(to, { comments: merged.comments, deleted: merged.deleted });
      docs.delete(from);
      return read(to);
    },
    remove: async (key) => {
      docs.delete(key);
    },
    getAlias: async (name) => aliases.get(name) ?? null,
    setAlias: async (name, key) => {
      aliases.set(name, key);
    },
  };
}

/**
 * Reads a record and writes `change` of it in one readwrite transaction, so
 * two tabs cannot interleave between the read and the write. A record with
 * no comments and no tombstones is removed, so nothing is left behind.
 */
function transact(
  db: IDBDatabase,
  key: string,
  change: (stored: CommentSet) => CommentSet,
): Promise<CommentSet> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCS, "readwrite");
    const os = tx.objectStore(DOCS);
    let result: CommentSet | undefined;
    const get = os.get(key);
    get.addEventListener("success", () => {
      try {
        result = change(validSet(get.result));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      if (result.comments.length === 0 && result.deleted.length === 0) os.delete(key);
      else os.put({ key, comments: result.comments, deleted: result.deleted });
    });
    tx.addEventListener("complete", () => resolve(result ?? { comments: [], deleted: [] }));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

/** `CommentStore.move` in one readwrite transaction: the write to `to` and the delete of `from` commit together. */
function moveRecord(db: IDBDatabase, from: string, to: string): Promise<CommentSet> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOCS, "readwrite");
    const os = tx.objectStore(DOCS);
    let result: CommentSet | undefined;
    const getFrom = os.get(from);
    const getTo = os.get(to);
    // Requests in one transaction complete in order: both reads are in.
    getTo.addEventListener("success", () => {
      try {
        if (getFrom.result === undefined) {
          result = validSet(getTo.result);
          return;
        }
        const merged = mergeSets(validSet(getTo.result), validSet(getFrom.result));
        if (!merged) throw new Error(OVER_CAP);
        result = { comments: merged.comments, deleted: merged.deleted };
        if (result.comments.length === 0 && result.deleted.length === 0) os.delete(to);
        else os.put({ key: to, comments: result.comments, deleted: result.deleted });
        os.delete(from);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
    tx.addEventListener("complete", () => resolve(result ?? { comments: [], deleted: [] }));
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

function idbStore(db: IDBDatabase): CommentStore {
  const tx = (store: string, mode: IDBTransactionMode) =>
    db.transaction(store, mode).objectStore(store);
  const read = async (key: string) => validSet(await request(tx(DOCS, "readonly").get(key)));
  return {
    persistent: true,
    load: async (key) => (await read(key)).comments,
    read,
    save: async (key, comments) => {
      await transact(db, key, (stored) => ({ comments: [...comments], deleted: stored.deleted }));
    },
    merge: (key, incoming) =>
      transact(db, key, (stored) => {
        const merged = mergeSets(stored, incoming);
        if (!merged) throw new Error(OVER_CAP);
        return { comments: merged.comments, deleted: merged.deleted };
      }),
    move: (from, to) => moveRecord(db, from, to),
    remove: async (key) => {
      const os = tx(DOCS, "readwrite");
      os.delete(key);
      await committed(os.transaction);
    },
    getAlias: async (name) => {
      const rec: unknown = await request(tx(ALIASES, "readonly").get(name));
      const target =
        typeof rec === "object" && rec !== null ? (rec as { key?: unknown }).key : null;
      return typeof target === "string" && target.length <= 4096 ? target : null;
    },
    setAlias: async (name, key) => {
      const os = tx(ALIASES, "readwrite");
      os.put({ name, key });
      await committed(os.transaction);
    },
  };
}

/** Opens the IndexedDB store, or a memory store when IndexedDB is unavailable. */
export async function openCommentStore(name = DB_NAME): Promise<CommentStore> {
  try {
    if (typeof indexedDB === "undefined") return memoryStore();
    return idbStore(await openDb(name));
  } catch {
    return memoryStore();
  }
}
