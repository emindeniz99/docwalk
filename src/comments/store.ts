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
import { CommentSchema, dedupe } from "./schema";
import { MAX_COMMENTS, type DocComment } from "./types";

export const DB_NAME = "docwalk-comments";
const DB_VERSION = 1;
const DOCS = "documents";
const ALIASES = "aliases";

export interface CommentStore {
  /** False when comments live only in this page's memory. */
  readonly persistent: boolean;
  load(key: string): Promise<DocComment[]>;
  save(key: string, comments: readonly DocComment[]): Promise<void>;
  getAlias(name: string): Promise<string | null>;
  setAlias(name: string, key: string): Promise<void>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error("IndexedDB request failed")));
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
 * The valid comments of a record another build or a damaged profile wrote.
 * A bad comment is dropped alone: refusing the whole record would read as
 * "no comments", and the next save would write that over the good ones.
 */
function validList(value: unknown): DocComment[] {
  const comments =
    typeof value === "object" && value !== null ? (value as { comments?: unknown }).comments : [];
  if (!Array.isArray(comments)) return [];
  const valid: DocComment[] = [];
  for (const item of comments.slice(0, MAX_COMMENTS)) {
    const result = v.safeParse(CommentSchema, item);
    if (result.success) valid.push(result.output);
  }
  return dedupe(valid);
}

export function memoryStore(): CommentStore {
  const docs = new Map<string, DocComment[]>();
  const aliases = new Map<string, string>();
  return {
    persistent: false,
    load: async (key) => [...(docs.get(key) ?? [])],
    save: async (key, comments) => {
      docs.set(key, [...comments]);
    },
    getAlias: async (name) => aliases.get(name) ?? null,
    setAlias: async (name, key) => {
      aliases.set(name, key);
    },
  };
}

function idbStore(db: IDBDatabase): CommentStore {
  const tx = (store: string, mode: IDBTransactionMode) =>
    db.transaction(store, mode).objectStore(store);
  return {
    persistent: true,
    load: async (key) => validList(await request(tx(DOCS, "readonly").get(key))),
    save: async (key, comments) => {
      const os = tx(DOCS, "readwrite");
      // An empty list removes the record, so deleted comments leave nothing behind.
      if (comments.length === 0) await request(os.delete(key));
      else await request(os.put({ key, comments: [...comments] }));
    },
    getAlias: async (name) => {
      const rec: unknown = await request(tx(ALIASES, "readonly").get(name));
      const target =
        typeof rec === "object" && rec !== null ? (rec as { key?: unknown }).key : null;
      return typeof target === "string" && target.length <= 4096 ? target : null;
    },
    setAlias: async (name, key) => {
      await request(tx(ALIASES, "readwrite").put({ name, key }));
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
