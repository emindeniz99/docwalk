/**
 * Whether the browser will keep the workspace (decision 91). OPFS counts as
 * best-effort storage: the browser may clear it when space runs low unless the
 * site asked to be kept and was granted. Both calls are local to the browser
 * (rule 8); nothing here makes a request to a server.
 */
import { persistRefusedAt, rememberPersistRefused } from "./store";

/** After a refusal the request waits this long: Firefox shows a prompt every time. */
const ASK_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the storage is already persistent; `null` when the browser cannot say. */
export async function isPersistent(): Promise<boolean | null> {
  try {
    if (typeof navigator.storage?.persisted !== "function") return null;
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}

/**
 * Asks the browser to keep the storage, unless it already does or refused
 * within the last seven days. Resolves to whether it is persistent now, or
 * `null` when the browser has no such call. A refusal is not an error.
 */
export async function requestPersistence(now = Date.now()): Promise<boolean | null> {
  try {
    if (typeof navigator.storage?.persist !== "function") return null;
    if ((await isPersistent()) === true) return true;
    const refused = persistRefusedAt();
    if (refused !== null && refused <= now && now - refused < ASK_AGAIN_AFTER_MS) return false;
    const granted = await navigator.storage.persist();
    rememberPersistRefused(granted ? null : now);
    return granted;
  } catch {
    return null;
  }
}

/** The bytes this site uses and the most it may use, or `null` when the browser does not say. */
export async function storageUse(): Promise<{ used: number; quota: number } | null> {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return usage !== undefined && quota !== undefined ? { used: usage, quota } : null;
  } catch {
    return null;
  }
}
