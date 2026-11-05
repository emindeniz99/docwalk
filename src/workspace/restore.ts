import type { LoadedDocument } from "../inputs/types";
import { readText } from "./fs";
import { opfsSupported, queryWrite } from "./platform";
import { loadFolderHandle, opfsRoot, type OpenFile } from "./store";

/**
 * Reopens the workspace file a previous visit showed, or returns `null` when
 * it is gone, unreadable, or in a local folder whose permission must be asked
 * for again (that needs a click, so the file panel offers "Reconnect").
 */
export async function restoreFile(open: OpenFile): Promise<LoadedDocument | null> {
  try {
    let root: FileSystemDirectoryHandle | null = null;
    if (open.root === "opfs") {
      if (opfsSupported()) root = await opfsRoot();
    } else {
      const handle = await loadFolderHandle();
      if (handle && (await queryWrite(handle)) === "granted") root = handle;
    }
    if (!root) return null;
    const { text } = await readText(root, open.path);
    return { markdown: text, source: { kind: "workspace", root: open.root, path: open.path } };
  } catch {
    return null;
  }
}
