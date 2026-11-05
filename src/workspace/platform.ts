/**
 * The parts of the File System Access API that TypeScript's DOM library does
 * not describe yet (Chromium-only: `showDirectoryPicker`, handle
 * permissions, `FileSystemObserver`), feature-detected so other browsers
 * keep the OPFS workspace (decision 58).
 */

type Mode = { mode: "read" | "readwrite" };

interface PermissionHandle {
  queryPermission?: (descriptor: Mode) => Promise<PermissionState>;
  requestPermission?: (descriptor: Mode) => Promise<PermissionState>;
}

type DirectoryPicker = (options?: {
  id?: string;
  mode?: "read" | "readwrite";
}) => Promise<FileSystemDirectoryHandle>;

export interface ObserverRecord {
  type: string;
  relativePathComponents: string[];
}

interface ObserverInstance {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

type ObserverConstructor = new (callback: (records: ObserverRecord[]) => void) => ObserverInstance;

/** True when the browser can keep and write files in OPFS (Safari before 26 cannot write from the page). */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

function picker(): DirectoryPicker | null {
  const fn = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof fn === "function" ? fn : null;
}

export function folderSupported(): boolean {
  return picker() !== null;
}

/** Asks the user for a folder; `null` when they cancel. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const fn = picker();
  if (!fn) return null;
  try {
    return await fn({ id: "docwalk", mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/** The handle's read-write permission; a browser without the method grants what it handed out. */
export async function queryWrite(handle: FileSystemHandle): Promise<PermissionState> {
  const h = handle as PermissionHandle;
  return h.queryPermission ? h.queryPermission({ mode: "readwrite" }) : "granted";
}

/** Asks again for read-write access; needs a user gesture when the state is `prompt`. */
export async function requestWrite(handle: FileSystemHandle): Promise<PermissionState> {
  const h = handle as PermissionHandle;
  return h.requestPermission ? h.requestPermission({ mode: "readwrite" }) : "granted";
}

/**
 * Watches `handle` recursively and calls `onChange` with what changed.
 * Resolves to `null` where `FileSystemObserver` does not exist or refuses
 * this handle; the caller polls instead.
 */
export async function observe(
  handle: FileSystemDirectoryHandle,
  onChange: (records: ObserverRecord[]) => void,
): Promise<(() => void) | null> {
  const Observer = (globalThis as { FileSystemObserver?: ObserverConstructor }).FileSystemObserver;
  if (typeof Observer !== "function") return null;
  try {
    const observer = new Observer(onChange);
    await observer.observe(handle, { recursive: true });
    return () => observer.disconnect();
  } catch {
    return null;
  }
}
