/**
 * Saved marks in IndexedDB (decision 105): one record per document and slide
 * address, keyed `[doc, slide]`, so a stroke rewrites one slide and deleting
 * a document's marks is one key range. Nothing leaves the browser (rule 8).
 *
 * IndexedDB can be missing (some private modes) or blocked; then marks live
 * in memory for this page, as they did before they were saved. What a load
 * returns is unchecked: `readSlides` (savedMarks.ts) validates it.
 */
import { MAX_SAVED_SLIDES, memoryMarksStore, type MarksStore } from "./savedMarks";

export const MARKS_DB = "docwalk-marks";
const DB_VERSION = 1;
const SLIDES = "slides";

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
      if (!db.objectStoreNames.contains(SLIDES)) {
        db.createObjectStore(SLIDES, { keyPath: ["doc", "slide"] });
      }
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
 * Every `[doc, slide]` key: `[doc]` sorts before them and `[doc, []]` after,
 * because an array sorts after any string. A document whose key merely
 * starts with `doc` sorts outside.
 */
const documentRange = (doc: string) => IDBKeyRange.bound([doc], [doc, []]);

function idbStore(db: IDBDatabase): MarksStore {
  /**
   * A write counts once its transaction commits: a full disk aborts the
   * transaction after the request itself has succeeded. A request that
   * throws (a record IndexedDB refuses) aborts it too, so the requests
   * before it are undone instead of committed.
   */
  const write = (act: (slides: IDBObjectStore) => void) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SLIDES, "readwrite");
      try {
        act(tx.objectStore(SLIDES));
      } catch (error) {
        tx.abort();
        throw error;
      }
      tx.addEventListener("complete", () => resolve());
      tx.addEventListener("error", () => reject(tx.error ?? new Error("IndexedDB write failed")));
      tx.addEventListener("abort", () => reject(tx.error ?? new Error("IndexedDB write aborted")));
    });
  return {
    persistent: true,
    // More than the cap would be skipped anyway; reading them costs memory for nothing.
    load: (doc) =>
      request(
        db
          .transaction(SLIDES, "readonly")
          .objectStore(SLIDES)
          .getAll(documentRange(doc), MAX_SAVED_SLIDES),
      ),
    put: (record) => write((slides) => slides.put(record)),
    remove: (doc, slide) => write((slides) => slides.delete([doc, slide])),
    clear: (doc, replacement = []) =>
      write((slides) => {
        slides.delete(documentRange(doc));
        for (const record of replacement) slides.put(record);
      }),
  };
}

/** Opens the IndexedDB store, or a memory store when IndexedDB is unavailable. */
export async function openMarksStore(name = MARKS_DB): Promise<MarksStore> {
  try {
    if (typeof indexedDB === "undefined") return memoryMarksStore();
    return idbStore(await openDb(name));
  } catch {
    return memoryMarksStore();
  }
}
