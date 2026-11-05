/**
 * Where the workspace remembers things between visits, all in this browser
 * (rule 8): the OPFS directory that holds the browser workspace, the picked
 * folder's handle in IndexedDB (a handle cannot go into localStorage), and
 * in localStorage which file was open and which root was in use. Storage can
 * be missing or blocked and what it returns is untrusted (decision 46), so
 * every access is caught and every read validated.
 */
import * as v from "valibot";
import { safeArchivePath } from "./names";
import type { WorkspaceRoot } from "./types";

/** The browser workspace lives in this directory of the origin private file system. */
const OPFS_DIRECTORY = "docwalk-workspace";

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const top = await navigator.storage.getDirectory();
  return top.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
}

// ---- The picked folder's handle (IndexedDB) ------------------------------

const DB = "docwalk-workspace";
const STORE = "handles";
const FOLDER_KEY = "folder";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB failed")));
  });
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("IndexedDB failed")),
      );
    });
  } finally {
    db.close();
  }
}

/** The folder picked on an earlier visit, or `null`. */
export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const value: unknown = await run("readonly", (s) => s.get(FOLDER_KEY));
    return typeof FileSystemDirectoryHandle !== "undefined" &&
      value instanceof FileSystemDirectoryHandle
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(handle, FOLDER_KEY));
  } catch {
    // Without IndexedDB the folder works for this visit and is asked for again next time.
  }
}

export async function forgetFolderHandle(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(FOLDER_KEY));
  } catch {
    // Nothing stored.
  }
}

// ---- The open file and the root in use (localStorage) --------------------

const OPEN_KEY = "docwalk.workspace.open";
const ROOT_KEY = "docwalk.workspace.root";

const RootSchema = v.picklist(["opfs", "folder"]);
const OpenSchema = v.object({
  root: RootSchema,
  path: v.pipe(
    v.string(),
    v.maxLength(4096),
    v.check((p) => safeArchivePath(p) === p),
  ),
});

export interface OpenFile {
  root: WorkspaceRoot;
  path: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Unavailable or full: the workspace still works, it just does not reopen the file next time.
  }
}

/** The workspace file this browser showed last, which a plain visit reopens. */
export function rememberedFile(): OpenFile | null {
  const parsed = v.safeParse(OpenSchema, read(OPEN_KEY));
  return parsed.success ? parsed.output : null;
}

export function rememberFile(file: OpenFile | null): void {
  write(OPEN_KEY, file === null ? null : { root: file.root, path: file.path });
}

export function rememberedRoot(): WorkspaceRoot {
  const parsed = v.safeParse(RootSchema, read(ROOT_KEY));
  return parsed.success ? parsed.output : "opfs";
}

export function rememberRoot(root: WorkspaceRoot): void {
  write(ROOT_KEY, root);
}
