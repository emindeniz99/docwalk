/**
 * Sketches live in this browser's IndexedDB only (decision 54): nothing is
 * uploaded and nothing is written into the Markdown (rule 1). One record per
 * document and diagram, replaced on every save.
 */

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

/** The saved sketch, or null when there is none. Throws when the browser blocks IndexedDB. */
export async function loadSketch(key: string): Promise<StoredSketch | null> {
  const found: unknown = await run("readonly", (store) => store.get(key));
  return isStoredSketch(found) ? found : null;
}

export async function saveSketch(sketch: StoredSketch): Promise<void> {
  await run("readwrite", (store) => store.put(sketch));
}

export async function deleteSketch(key: string): Promise<void> {
  await run("readwrite", (store) => store.delete(key));
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
