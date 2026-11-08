/**
 * Sketches live in this browser's IndexedDB only (decision 54): nothing is
 * uploaded and nothing is written into the Markdown (rule 1). One record per
 * document and diagram, replaced on every save.
 */

import { inlineFiles } from "./files";
import { sketchKey, sketchKeyBounds } from "./identity";

const DB_NAME = "docwalk-canvas";
const STORE = "sketches";

export interface StoredSketch {
  /** `sketchKey(documentKey, diagramHash)`. */
  key: string;
  /** Excalidraw's scene elements, as `serializeAsJSON` writes them. */
  elements: readonly unknown[];
  /** The view to reopen at: scroll, zoom and background. */
  appState: Record<string, unknown>;
  /** Images in the scene (a diagram type Excalidraw cannot draw arrives as one). */
  files: Record<string, unknown>;
  savedAt: number;
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore(STORE, { keyPath: "key" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB did not open")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("IndexedDB is blocked by another tab")),
    );
  }).catch((error: unknown) => {
    // A later call may succeed (another tab closed); do not cache the failure.
    opening = null;
    throw error;
  });
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = act(tx.objectStore(STORE));
        tx.addEventListener("complete", () => resolve(request.result));
        tx.addEventListener("error", () =>
          reject(tx.error ?? new Error("IndexedDB transaction failed")),
        );
        tx.addEventListener("abort", () =>
          reject(tx.error ?? new Error("IndexedDB transaction aborted")),
        );
      }),
  );
}

/**
 * The saved sketch, or null when there is none. Throws when the browser
 * blocks IndexedDB. Images that are not inline are dropped (files.ts), also
 * from a record saved before they were.
 */
export async function loadSketch(key: string): Promise<StoredSketch | null> {
  const found: unknown = await run("readonly", (store) => store.get(key));
  return isStoredSketch(found) ? { ...found, files: inlineFiles(found.files) } : null;
}

/** Saves the sketch without images that are not inline, so reopening it fetches nothing. */
export async function saveSketch(sketch: StoredSketch): Promise<void> {
  const kept = { ...sketch, files: inlineFiles(sketch.files) };
  await run("readwrite", (store) => store.put(kept));
}

export async function deleteSketch(key: string): Promise<void> {
  await run("readwrite", (store) => store.delete(key));
}

/** Deletes several sketches in one transaction: all of them go, or none. */
export async function deleteSketches(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const key of keys) store.delete(key);
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed")),
    );
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

/** What the Saved sketches panel shows of one stored sketch. */
export interface SketchSummary {
  key: string;
  savedAt: number;
  /** The record's size as JSON, which the images in it dominate. */
  bytes: number;
}

/**
 * Every stored sketch this version can read, newest first. Only the summary
 * is kept while the records are read, so a store full of images is not held
 * in memory at once. Throws when the browser blocks IndexedDB.
 */
export async function listSketches(): Promise<SketchSummary[]> {
  const db = await openDb();
  const encoder = new TextEncoder();
  const found: SketchSummary[] = [];
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.addEventListener("success", () => {
      const at = cursor.result;
      if (!at) return;
      const value: unknown = at.value;
      if (isStoredSketch(value)) {
        const bytes = encoder.encode(JSON.stringify(value)).length;
        found.push({ key: value.key, savedAt: Number(value.savedAt) || 0, bytes });
      }
      at.continue();
    });
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed")),
    );
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
  return found.toSorted((a, b) => b.savedAt - a.savedAt || a.key.localeCompare(b.key));
}

/**
 * Moves every sketch of one document to another document key, or deletes
 * them when `to` is null: a workspace file was renamed, moved or deleted.
 */
export async function moveSketches(from: string, to: string | null): Promise<void> {
  if (from === to) return;
  const db = await openDb();
  const [lower, upper] = sketchKeyBounds(from);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const cursor = store.openCursor(IDBKeyRange.bound(lower, upper));
    cursor.addEventListener("success", () => {
      const at = cursor.result;
      if (!at) return;
      const value: unknown = at.value;
      if (to !== null && isStoredSketch(value)) {
        store.put({ ...value, key: sketchKey(to, value.key.slice(lower.length)) });
      }
      at.delete();
      at.continue();
    });
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed")),
    );
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });
}

/** A record another version (or another tab's bug) wrote in a shape this one cannot read is ignored. */
function isStoredSketch(value: unknown): value is StoredSketch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["key"] === "string" &&
    Array.isArray(v["elements"]) &&
    typeof v["appState"] === "object" &&
    v["appState"] !== null &&
    typeof v["files"] === "object" &&
    v["files"] !== null
  );
}
