/**
 * File operations on a directory handle. The OPFS workspace and a picked
 * local folder are both `FileSystemDirectoryHandle`s, so this one module
 * serves both (decisions 57, 58). Paths are slash-separated and relative to
 * the handle; every name is checked by `validateName` before it reaches the
 * platform. Reading goes through `loadFromFile`, so a workspace file gets the
 * same size cap and strict UTF-8 check as a dropped one.
 */
import { describeLoadError, loadFromFile } from "../inputs/load";
import { m } from "../paraglide/messages.js";
import { WorkspaceError } from "./errors";
import { isDocumentName, joinPath, validateName } from "./names";
import { MAX_LISTED_ENTRIES, type WorkspaceListing, type WorkspaceNode } from "./types";

export { WorkspaceError };

function segments(path: string): string[] {
  const parts = path.split("/").filter((p) => p !== "");
  for (const part of parts) {
    const problem = validateName(part);
    if (problem) throw new WorkspaceError(m.ws_err_bad_segment({ name: part, problem }));
  }
  return parts;
}

/** The directory at `path` (`""` is the root); creates missing folders when asked. */
export async function directoryAt(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of segments(path)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

function split(path: string): { dir: string; name: string } {
  const parts = segments(path);
  const name = parts.pop();
  if (name === undefined) throw new WorkspaceError(m.ws_err_needs_name());
  return { dir: parts.join("/"), name };
}

async function fileAt(root: FileSystemDirectoryHandle, path: string, create = false) {
  const { dir, name } = split(path);
  return (await directoryAt(root, dir, create)).getFileHandle(name, { create });
}

/** The platform's answer for "nothing by that name" (or a file where a folder was asked, and back). */
const absent = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "NotFoundError" || error.name === "TypeMismatchError");

/**
 * The entry called `name` in `parent`, or `null`. The platform is asked, not
 * the listing compared: on a case-insensitive disk (macOS, Windows) `Plan.md`
 * finds the stored `plan.md`, which a name comparison would miss.
 */
async function entryIn(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return null;
}

/** What is at `path`, or `null` when nothing is (by the platform's own name matching). */
export async function kindAt(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<"file" | "directory" | null> {
  const { dir, name } = split(path);
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await directoryAt(root, dir);
  } catch {
    return null;
  }
  return (await entryIn(parent, name))?.kind ?? null;
}

/** Folders a listing never enters: version control, dependencies, build output. */
function skipped(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * The tree of folders and document files (`.md`, `.markdown`, `.txt`),
 * sorted folders first then by name. Other files are left out: docwalk
 * cannot open them. Stops after `MAX_LISTED_ENTRIES` entries.
 */
export async function listTree(root: FileSystemDirectoryHandle): Promise<WorkspaceListing> {
  let seen = 0;
  let truncated = false;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const walk = async (dir: FileSystemDirectoryHandle, base: string): Promise<WorkspaceNode[]> => {
    const nodes: WorkspaceNode[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (++seen > MAX_LISTED_ENTRIES) {
        truncated = true;
        break;
      }
      const path = joinPath(base, name);
      if (handle.kind === "directory") {
        if (skipped(name)) continue;
        nodes.push({
          path,
          name,
          kind: "directory",
          children: await walk(handle as FileSystemDirectoryHandle, path),
        });
      } else if (isDocumentName(name)) {
        nodes.push({ path, name, kind: "file" });
      }
    }
    return nodes.toSorted((a, b) =>
      a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "directory" ? -1 : 1,
    );
  };
  const nodes = await walk(root, "");
  return { nodes, truncated };
}

/**
 * Every document file at or under `path`, read from the directory itself and
 * not from a listing: a listing stops at `MAX_LISTED_ENTRIES`, and the
 * comments and sketches of a file past that point must still follow it
 * (decision 92). Skips what a listing skips.
 */
export async function documentPathsUnder(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string[]> {
  if (path !== "" && (await kindAt(root, path)) === "file") return [path];
  const out: string[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, base: string) => {
    for await (const [name, handle] of dir.entries()) {
      const child = joinPath(base, name);
      if (handle.kind === "directory") {
        if (!skipped(name)) await walk(handle as FileSystemDirectoryHandle, child);
      } else if (isDocumentName(name)) out.push(child);
    }
  };
  await walk(await directoryAt(root, path), path);
  return out;
}

/** Whether two listings show the same tree, so a poll that finds nothing new changes nothing on screen. */
export function sameListing(a: WorkspaceListing, b: WorkspaceListing): boolean {
  const same = (x: WorkspaceNode[], y: WorkspaceNode[]): boolean =>
    x.length === y.length &&
    x.every((n, i) => {
      const o = y[i]!;
      return n.path === o.path && n.kind === o.kind && same(n.children ?? [], o.children ?? []);
    });
  return a.truncated === b.truncated && same(a.nodes, b.nodes);
}

export interface FileText {
  text: string;
  lastModified: number;
}

export async function readText(root: FileSystemDirectoryHandle, path: string): Promise<FileText> {
  let file: File;
  try {
    file = await (await fileAt(root, path)).getFile();
  } catch {
    throw new WorkspaceError(m.ws_err_unreadable({ path }));
  }
  const result = await loadFromFile(file);
  if (!result.ok)
    throw new WorkspaceError(m.ws_err_load({ path, reason: describeLoadError(result.error) }));
  return { text: result.doc.markdown, lastModified: file.lastModified };
}

/** The file's modification time, or `null` when it no longer exists. */
export async function lastModified(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<number | null> {
  try {
    return (await (await fileAt(root, path)).getFile()).lastModified;
  } catch {
    return null;
  }
}

/** Replaces the file's contents (creating it and its folders if needed); returns the new modification time. */
export async function writeText(
  root: FileSystemDirectoryHandle,
  path: string,
  data: string | Blob | Uint8Array<ArrayBuffer>,
): Promise<number> {
  const handle = await fileAt(root, path, true);
  // createWritable writes to a swap file and swaps it in on close, so a crash never leaves half a file.
  const stream = await handle.createWritable();
  try {
    await stream.write(data);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
  return (await handle.getFile()).lastModified;
}

/** Creates a file that must not exist yet. */
export async function createFile(
  root: FileSystemDirectoryHandle,
  path: string,
  text: string,
): Promise<void> {
  if ((await kindAt(root, path)) !== null) throw new WorkspaceError(m.ws_err_exists({ path }));
  await writeText(root, path, text);
}

/** Creates a folder that must not exist yet. */
export async function createFolder(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  if ((await kindAt(root, path)) !== null) throw new WorkspaceError(m.ws_err_exists({ path }));
  await directoryAt(root, path, true);
}

export async function remove(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const { dir, name } = split(path);
  await (await directoryAt(root, dir)).removeEntry(name, { recursive: true });
}

/** Copies `source` to a new entry `name` in `target`; refuses to write onto anything already there. */
async function copyInto(
  source: FileSystemHandle,
  target: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  if ((await entryIn(target, name)) !== null) {
    throw new WorkspaceError(m.ws_err_exists({ path: name }));
  }
  if (source.kind === "file") {
    const file = await (source as FileSystemFileHandle).getFile();
    const handle = await target.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    await stream.write(file);
    await stream.close();
    return;
  }
  const dir = await target.getDirectoryHandle(name, { create: true });
  for await (const [child, handle] of (source as FileSystemDirectoryHandle).entries()) {
    await copyInto(handle, dir, child);
  }
}

/**
 * Renames a file or folder in place and returns its new path. Copies then
 * deletes: `FileSystemHandle.move()` is not available for every kind of
 * handle in every Chromium version, and a copy works everywhere.
 */
export async function rename(
  root: FileSystemDirectoryHandle,
  path: string,
  newName: string,
): Promise<string> {
  const problem = validateName(newName);
  if (problem) throw new WorkspaceError(problem);
  const { dir, name } = split(path);
  if (name === newName) return path;
  const target = joinPath(dir, newName);
  const parent = await directoryAt(root, dir);
  const source = await entryIn(parent, name);
  if (!source) throw new WorkspaceError(m.ws_err_gone({ path }));
  const existing = await entryIn(parent, newName);
  if (existing !== null) {
    // Only the entry itself may answer to the new name: a case-only rename
    // (plan.md -> Plan.md) on a case-insensitive disk. Anything else is
    // another file or folder, and a copy onto it would destroy it.
    if (!(await existing.isSameEntry(source))) {
      throw new WorkspaceError(m.ws_err_exists({ path: target }));
    }
    // Go through a temporary name so the copy never lands on the original.
    const temp = `${name}.docwalk-rename`;
    await copyInto(source, parent, temp);
    await parent.removeEntry(name, { recursive: true });
    const tempHandle = await entryIn(parent, temp);
    if (!tempHandle) throw new WorkspaceError(m.ws_err_gone({ path: joinPath(dir, temp) }));
    await copyInto(tempHandle, parent, newName);
    await parent.removeEntry(temp, { recursive: true });
    return target;
  }
  await copyInto(source, parent, newName);
  await parent.removeEntry(name, { recursive: true });
  return target;
}

/** Every document file under the root with its bytes, for a zip export. */
export async function collectFiles(
  root: FileSystemDirectoryHandle,
): Promise<{ path: string; data: Uint8Array<ArrayBuffer> }[]> {
  const { nodes } = await listTree(root);
  const out: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const visit = async (list: WorkspaceNode[]) => {
    for (const node of list) {
      if (node.kind === "directory") await visit(node.children ?? []);
      else {
        const file = await (await fileAt(root, node.path)).getFile();
        out.push({ path: node.path, data: new Uint8Array(await file.arrayBuffer()) });
      }
    }
  };
  await visit(nodes);
  return out;
}

/** Folders in the listing, so an empty one survives a zip round trip. */
export function folderPaths(nodes: WorkspaceNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === "directory" ? [n.path, ...folderPaths(n.children ?? [])] : [],
  );
}
