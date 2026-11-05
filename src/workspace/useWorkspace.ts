import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { downloadBlob } from "../export/download";
import type { DocumentSource, LoadedDocument } from "../inputs/types";
import type { Notice } from "../shell/useDocument";
import {
  collectFiles,
  createFile,
  createFolder,
  folderPaths,
  lastModified,
  listTree,
  readText,
  remove,
  rename,
  writeText,
  WorkspaceError,
  type FileText,
} from "./fs";
import {
  ancestorsOf,
  baseName,
  isWithin,
  joinPath,
  parentOf,
  uniqueName,
  validateName,
  withMarkdownExtension,
} from "./names";
import {
  folderSupported,
  observe,
  opfsSupported,
  pickFolder,
  queryWrite,
  requestWrite,
} from "./platform";
import {
  forgetFolderHandle,
  loadFolderHandle,
  opfsRoot,
  rememberedFile,
  rememberedRoot,
  rememberFile,
  rememberRoot,
  saveFolderHandle,
} from "./store";
import { starter, TEMPLATES, type ProjectTemplate } from "./templates";
import type { WorkspaceListing, WorkspaceNode, WorkspaceRoot } from "./types";

/** The browser workspace saves this long after the last keystroke. */
export const AUTOSAVE_MS = 500;
/** A local folder without `FileSystemObserver` is checked this often for changes on disk. */
export const POLL_MS = 1000;

type WorkspaceSource = Extract<DocumentSource, { kind: "workspace" }>;

export interface WorkspaceInputs {
  doc: LoadedDocument | null;
  openDocument: (doc: LoadedDocument) => void;
  closeDocument: () => void;
  retarget: (source: DocumentSource) => void;
  setNotice: (notice: Notice | null) => void;
}

/** A dialog the workspace needs answered; App renders it (src/workspace/WorkspaceDialogs.tsx). */
export type WorkspaceDialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "new-project" }
  | { kind: "rename"; node: WorkspaceNode }
  | { kind: "delete"; node: WorkspaceNode }
  /** Unsaved edits to a local-folder file would be lost by what the user asked for. */
  | { kind: "discard"; path: string; proceed: () => void }
  /** The file changed on disk while it has unsaved edits (decision 58). */
  | { kind: "conflict"; path: string; disk: FileText };

/** What the banner says about the open workspace file. */
export type SaveState = "saved" | "saving" | "unsaved" | "missing" | "error";

interface FolderState {
  handle: FileSystemDirectoryHandle;
  permission: PermissionState;
}

/** The text last read from or written to the open file, and the file's time then. */
interface Baseline {
  key: string;
  text: string;
  lastModified: number | null;
}

const keyOf = (s: WorkspaceSource) => `${s.root}:${s.path}`;
const workspaceSource = (doc: LoadedDocument | null): WorkspaceSource | null =>
  doc?.source.kind === "workspace" ? doc.source : null;

function message(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceError) return error.message;
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "docwalk no longer has access to this folder. Reconnect it in the file panel.";
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "The browser's storage for this site is full.";
  }
  return fallback;
}

/**
 * What happened to a local file since `known` (its last seen modification
 * time): gone, the same, or changed, with the new text. A version the user
 * is already being asked about (`asking`) counts as the same.
 */
async function diskChange(
  handle: FileSystemDirectoryHandle,
  path: string,
  known: number | null,
  asking: number | null,
): Promise<{ kind: "missing" } | { kind: "unchanged" } | { kind: "changed"; disk: FileText }> {
  const lm = await lastModified(handle, path);
  if (lm === null) return { kind: "missing" };
  if (lm === known || lm === asking) return { kind: "unchanged" };
  return { kind: "changed", disk: await readText(handle, path) };
}

/**
 * The workspace (decisions 57, 58): the file tree of the browser workspace or
 * of a local folder, the file operations behind the panel, autosave to OPFS,
 * explicit save to disk, and reload when a local file changes on disk.
 *
 * The open file is not separate state: it is the document's source
 * (`{ kind: "workspace" }`), so a document opened any other way simply means
 * no workspace file is open. With nothing in the workspace and no folder, the
 * hook only lists an empty directory: the app behaves as the single-document
 * viewer it was.
 */
export function useWorkspace({ inputs, enabled }: { inputs: WorkspaceInputs; enabled: boolean }) {
  const { doc, openDocument, closeDocument, retarget, setNotice } = inputs;
  const supported = useMemo(() => ({ opfs: opfsSupported(), folder: folderSupported() }), []);
  const [opfs, setOpfs] = useState<FileSystemDirectoryHandle | null>(null);
  const [folder, setFolder] = useState<FolderState | null>(null);
  // A browser without the folder picker always shows the browser workspace.
  const [root, setRoot] = useState<WorkspaceRoot>(() =>
    supported.folder ? rememberedRoot() : "opfs",
  );
  // Keyed by handle, so switching roots never shows the other root's files for a moment.
  const [listed, setListed] = useState<{
    handle: FileSystemDirectoryHandle;
    listing: WorkspaceListing;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null);
  const [baseline, setBaselineState] = useState<Baseline | null>(null);
  const [failed, setFailed] = useState(false);
  /** The key of an open local file that was deleted or moved on disk. */
  const [missingKey, setMissingKey] = useState<string | null>(null);

  const docRef = useRef(doc);
  const baselineRef = useRef(baseline);
  const dialogRef = useRef(dialog);
  useLayoutEffect(() => {
    docRef.current = doc;
    dialogRef.current = dialog;
  });
  const setBaseline = useCallback((next: Baseline | null) => {
    baselineRef.current = next;
    setBaselineState(next);
  }, []);
  /** The file the previous visit had open, read before anything clears it, for "Reconnect". */
  const initialFile = useRef(rememberedFile());

  const source = workspaceSource(doc);
  const sourceRoot = source?.root ?? null;
  const sourcePath = source?.path ?? null;
  const sourceKey = source ? keyOf(source) : null;
  const handleFor = useCallback(
    (r: WorkspaceRoot): FileSystemDirectoryHandle | null =>
      r === "opfs" ? opfs : folder?.permission === "granted" ? folder.handle : null,
    [opfs, folder],
  );
  const active = handleFor(root);
  const listing = listed && listed.handle === active ? listed.listing : null;
  const folderName = folder?.handle.name ?? null;

  // ---- Start: the OPFS directory and the remembered folder ----------------
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (supported.opfs) {
      opfsRoot()
        .then((h) => live && setOpfs(h))
        .catch(() => undefined);
    }
    if (supported.folder) {
      void loadFolderHandle().then(async (handle) => {
        if (!live) return;
        if (!handle) {
          setRoot("opfs");
          return;
        }
        const permission = await queryWrite(handle).catch((): PermissionState => "prompt");
        if (live) setFolder({ handle, permission });
      });
    }
    return () => {
      live = false;
    };
  }, [enabled, supported]);

  // ---- The tree ------------------------------------------------------------
  const listGeneration = useRef(0);
  const refresh = useCallback(async () => {
    if (!active) return;
    const gen = ++listGeneration.current;
    const next = await listTree(active).catch(() => ({ nodes: [], truncated: false }));
    if (gen === listGeneration.current) setListed({ handle: active, listing: next });
  }, [active]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Files added by other tabs or other programs show up when the user comes back.
  useEffect(() => {
    const onFocus = () => void refresh();
    globalThis.addEventListener("focus", onFocus);
    return () => globalThis.removeEventListener("focus", onFocus);
  }, [refresh]);

  // The open file's folders stay expanded, so the selection is visible.
  const openPath = sourceRoot === root ? sourcePath : null;
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  if (openPath !== expandedFor) {
    // Adjusting state while rendering (React's pattern for "when a prop changes").
    setExpandedFor(openPath);
    const parents = openPath ? ancestorsOf(openPath).filter((a) => !expanded.has(a)) : [];
    if (parents.length > 0) setExpanded(new Set([...expanded, ...parents]));
  }

  // ---- Which file a plain visit reopens ------------------------------------
  // Nothing is remembered before the first document is known (start-up may still be restoring it).
  const docKnown = enabled && doc !== null;
  useEffect(() => {
    if (!docKnown) return;
    rememberFile(sourceRoot && sourcePath !== null ? { root: sourceRoot, path: sourcePath } : null);
  }, [docKnown, sourceRoot, sourcePath]);

  // ---- The text the open file holds on disk --------------------------------
  useEffect(() => {
    // A file restored at start-up (src/workspace/restore.ts) arrives without a baseline.
    if (sourceRoot === null || sourcePath === null || sourceKey === null) return;
    if (baselineRef.current?.key === sourceKey) return;
    const handle = handleFor(sourceRoot);
    if (!handle) return;
    const text = docRef.current?.markdown ?? "";
    void lastModified(handle, sourcePath).then((lm) => {
      if (baselineRef.current?.key !== sourceKey) {
        setBaseline({ key: sourceKey, text, lastModified: lm });
      }
    });
  }, [sourceRoot, sourcePath, sourceKey, handleFor, setBaseline]);

  const base = baseline && sourceKey === baseline.key ? baseline : null;
  const dirty = source !== null && base !== null && doc !== null && doc.markdown !== base.text;

  // ---- Browser workspace: autosave ------------------------------------------
  const pending = useRef<{ source: WorkspaceSource; text: string } | null>(null);
  const flush = useCallback(async () => {
    const job = pending.current;
    pending.current = null;
    if (!job || !opfs) return;
    try {
      const lm = await writeText(opfs, job.source.path, job.text);
      setFailed(false);
      if (baselineRef.current?.key === keyOf(job.source)) {
        setBaseline({ key: keyOf(job.source), text: job.text, lastModified: lm });
      }
    } catch (error) {
      setFailed(true);
      setNotice({
        message: message(error, `${job.source.path} could not be saved in this browser.`),
        tone: "error",
      });
    }
  }, [opfs, setBaseline, setNotice]);

  const markdown = doc?.markdown;
  const baseText = base?.text;
  useEffect(() => {
    if (sourceRoot !== "opfs" || sourcePath === null || baseText === undefined) return;
    if (markdown === undefined || markdown === baseText) return;
    const target: WorkspaceSource = { kind: "workspace", root: "opfs", path: sourcePath };
    // Switching files saves the previous one at once instead of dropping its last edits.
    if (pending.current && keyOf(pending.current.source) !== keyOf(target)) void flush();
    pending.current = { source: target, text: markdown };
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [markdown, sourceRoot, sourcePath, baseText, flush]);
  useEffect(() => {
    const now = () => void flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") now();
    };
    globalThis.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      globalThis.removeEventListener("pagehide", now);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  // ---- Local folder: explicit save, reload on change ------------------------
  const save = useCallback(async () => {
    const current = docRef.current;
    const src = workspaceSource(current);
    if (!src || !current) return;
    if (src.root === "opfs") {
      await flush();
      return;
    }
    const handle = handleFor("folder");
    if (!handle) {
      setNotice({ message: message(new DOMException("", "NotAllowedError"), ""), tone: "error" });
      return;
    }
    try {
      const lm = await writeText(handle, src.path, current.markdown);
      setBaseline({ key: keyOf(src), text: current.markdown, lastModified: lm });
      setMissingKey(null);
      setFailed(false);
    } catch (error) {
      setFailed(true);
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setFolder((f) => (f ? { ...f, permission: "prompt" } : f));
      }
      setNotice({ message: message(error, `${src.path} could not be saved.`), tone: "error" });
    }
  }, [flush, handleFor, setBaseline, setNotice]);

  const checking = useRef(false);
  const checkDisk = useCallback(async () => {
    const src = workspaceSource(docRef.current);
    const handle = folder?.permission === "granted" ? folder.handle : null;
    const known = baselineRef.current;
    if (!src || src.root !== "folder" || !handle || checking.current) return;
    if (known?.key !== keyOf(src)) return;
    checking.current = true;
    const open = dialogRef.current;
    const change = await diskChange(
      handle,
      src.path,
      known.lastModified,
      open?.kind === "conflict" ? open.disk.lastModified : null,
    ).catch(() => null);
    checking.current = false;
    const key = keyOf(src);
    const current = docRef.current;
    // The user opened something else while the disk was read.
    if (
      !change ||
      baselineRef.current?.key !== key ||
      workspaceSource(current)?.path !== src.path
    ) {
      return;
    }
    if (change.kind === "missing") {
      setMissingKey(key);
      return;
    }
    setMissingKey(null);
    if (change.kind === "unchanged" || !current) return;
    const { disk } = change;
    // Our own save, or a change that matches what is on screen: nothing to ask.
    if (disk.text === known.text || disk.text === current.markdown) {
      setBaseline({ key, text: disk.text, lastModified: disk.lastModified });
    } else if (current.markdown !== known.text) {
      setDialog({ kind: "conflict", path: src.path, disk });
    } else {
      setBaseline({ key, text: disk.text, lastModified: disk.lastModified });
      openDocument({ markdown: disk.text, source: src });
    }
  }, [folder, openDocument, setBaseline]);

  const folderHandle = handleFor("folder");
  const watchedPath = sourceRoot === "folder" ? sourcePath : null;
  useEffect(() => {
    if (!enabled || !folderHandle || watchedPath === null) return;
    let stop: (() => void) | null = null;
    let live = true;
    // FileSystemObserver where it exists; otherwise compare lastModified every second.
    void observe(folderHandle, () => void checkDisk()).then((disconnect) => {
      if (!live) {
        disconnect?.();
        return;
      }
      if (disconnect) stop = disconnect;
      else {
        const timer = setInterval(() => void checkDisk(), POLL_MS);
        stop = () => clearInterval(timer);
      }
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [enabled, folderHandle, watchedPath, checkDisk]);

  // The tree of an open folder follows the disk too, where the browser can tell us.
  useEffect(() => {
    if (!enabled || root !== "folder" || !folderHandle) return;
    let stop: (() => void) | null = null;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void observe(folderHandle, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    }).then((disconnect) => {
      if (live) stop = disconnect;
      else disconnect?.();
    });
    return () => {
      live = false;
      clearTimeout(timer);
      stop?.();
    };
  }, [enabled, root, folderHandle, refresh]);

  // Ctrl/Cmd+S saves a workspace file instead of opening the browser's "Save page".
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s") {
        return;
      }
      if (!workspaceSource(docRef.current)) return;
      e.preventDefault();
      void save();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [enabled, save]);

  // Unsaved edits to a local file: the browser asks before the page goes away.
  const unsavedFolderEdits = dirty && sourceRoot === "folder";
  useEffect(() => {
    if (!unsavedFolderEdits) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedFolderEdits]);

  /** Runs `proceed` now, or after the user agrees to drop unsaved local edits. */
  const guard = useCallback(
    (proceed: () => void) => {
      if (unsavedFolderEdits && sourcePath !== null) {
        setDialog({ kind: "discard", path: sourcePath, proceed });
      } else proceed();
    },
    [unsavedFolderEdits, sourcePath],
  );

  // ---- Actions behind the panel ----------------------------------------------
  const load = useCallback(
    async (r: WorkspaceRoot, path: string): Promise<boolean> => {
      const handle = handleFor(r);
      if (!handle) return false;
      try {
        await flush();
        const { text, lastModified: lm } = await readText(handle, path);
        const next: WorkspaceSource = { kind: "workspace", root: r, path };
        setBaseline({ key: keyOf(next), text, lastModified: lm });
        setFailed(false);
        openDocument({ markdown: text, source: next });
        return true;
      } catch (error) {
        setNotice({ message: message(error, `${path} could not be opened.`), tone: "error" });
        return false;
      }
    },
    [handleFor, flush, openDocument, setBaseline, setNotice],
  );

  const openFile = useCallback(
    (path: string) => {
      if (sourceRoot === root && sourcePath === path) return;
      guard(() => void load(root, path));
    },
    [sourceRoot, sourcePath, root, guard, load],
  );

  const expand = useCallback((paths: string[]) => {
    setExpanded((prev) => new Set([...prev, ...paths]));
  }, []);

  /** Each returns an error message for the dialog to show, or null when it worked. */
  const newFile = useCallback(
    async (dir: string, rawName: string): Promise<string | null> => {
      const problem = validateName(rawName);
      if (problem) return problem;
      if (!active) return "The workspace is not available.";
      const name = withMarkdownExtension(rawName);
      const path = joinPath(dir, name);
      try {
        await createFile(active, path, starter(name.replace(/\.[^.]+$/, "")));
      } catch (error) {
        return message(error, `${path} could not be created.`);
      }
      await refresh();
      expand(ancestorsOf(path));
      guard(() => void load(root, path));
      return null;
    },
    [active, refresh, expand, guard, load, root],
  );

  const newFolder = useCallback(
    async (dir: string, name: string): Promise<string | null> => {
      const problem = validateName(name);
      if (problem) return problem;
      if (!active) return "The workspace is not available.";
      const path = joinPath(dir, name);
      try {
        await createFolder(active, path);
      } catch (error) {
        return message(error, `${path} could not be created.`);
      }
      await refresh();
      expand([...ancestorsOf(path), path]);
      return null;
    },
    [active, refresh, expand],
  );

  const newProject = useCallback(
    async (name: string, templateId: ProjectTemplate["id"]): Promise<string | null> => {
      const problem = validateName(name);
      if (problem) return problem;
      const template = TEMPLATES.find((t) => t.id === templateId);
      if (!active || !template) return "The workspace is not available.";
      try {
        await createFolder(active, name);
        for (const file of template.files(name)) {
          await writeText(active, joinPath(name, file.path), file.text);
        }
      } catch (error) {
        return message(error, `${name} could not be created.`);
      }
      await refresh();
      expand([name]);
      guard(() => void load(root, joinPath(name, template.main)));
      return null;
    },
    [active, refresh, expand, guard, load, root],
  );

  const renameEntry = useCallback(
    async (node: WorkspaceNode, rawName: string): Promise<string | null> => {
      const problem = validateName(rawName);
      if (problem) return problem;
      if (!active) return "The workspace is not available.";
      const name = node.kind === "file" ? withMarkdownExtension(rawName) : rawName;
      let next: string;
      try {
        await flush();
        next = await rename(active, node.path, name);
      } catch (error) {
        return message(error, `${node.path} could not be renamed.`);
      }
      // The open file, or the folder holding it, moved: same text, new address.
      const current = workspaceSource(docRef.current);
      if (current && current.root === root && isWithin(current.path, node.path)) {
        const moved: WorkspaceSource = {
          ...current,
          path: next + current.path.slice(node.path.length),
        };
        const known = baselineRef.current;
        if (known) setBaseline({ ...known, key: keyOf(moved) });
        retarget(moved);
      }
      setExpanded((prev) => {
        const out = new Set<string>();
        for (const p of prev)
          out.add(isWithin(p, node.path) ? next + p.slice(node.path.length) : p);
        return out;
      });
      await refresh();
      return null;
    },
    [active, flush, root, setBaseline, retarget, refresh],
  );

  const removeEntry = useCallback(
    async (node: WorkspaceNode): Promise<void> => {
      if (!active) return;
      const current = workspaceSource(docRef.current);
      const openInside =
        current !== null && current.root === root && isWithin(current.path, node.path);
      // A pending autosave of a file being deleted must not bring it back.
      if (openInside) pending.current = null;
      else await flush();
      try {
        await remove(active, node.path);
      } catch (error) {
        setNotice({ message: message(error, `${node.path} could not be deleted.`), tone: "error" });
        return;
      }
      if (openInside) {
        setBaseline(null);
        closeDocument();
      }
      await refresh();
    },
    [active, root, flush, setBaseline, closeDocument, refresh, setNotice],
  );

  const importZip = useCallback(
    async (file: File) => {
      if (!active) return;
      try {
        const { MAX_ARCHIVE_BYTES, readArchive } = await import("./zip");
        if (file.size > MAX_ARCHIVE_BYTES) {
          throw new WorkspaceError(
            `The zip file is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`,
          );
        }
        const contents = await readArchive(new Uint8Array(await file.arrayBuffer()));
        if (contents.files.length === 0) {
          setNotice({ message: "That zip file holds no Markdown or text files.", tone: "error" });
          return;
        }
        // Imported files land in one new folder, so nothing in the workspace is overwritten.
        const tops = new Set(
          [...contents.files.map((f) => f.path), ...contents.folders].map((p) => p.split("/")[0]),
        );
        const single = tops.size === 1 && contents.files.every((f) => f.path.includes("/"));
        const fromName = file.name.replace(/\.zip$/i, "").trim();
        const wanted = single
          ? [...tops][0]!
          : validateName(fromName) === null
            ? fromName
            : "Imported";
        const taken = new Set((listing?.nodes ?? []).map((n) => n.name));
        const target = uniqueName(wanted, taken);
        const strip = (p: string) => (single ? p.split("/").slice(1).join("/") : p);
        await createFolder(active, target);
        for (const dir of contents.folders) {
          const rel = strip(dir);
          if (rel) await createFolder(active, joinPath(target, rel)).catch(() => undefined);
        }
        for (const f of contents.files)
          await writeText(active, joinPath(target, strip(f.path)), f.data);
        await refresh();
        expand([target]);
        const first =
          contents.files.find(
            (f) => /^readme\.md$/i.test(baseName(strip(f.path))) && !strip(f.path).includes("/"),
          ) ?? contents.files[0]!;
        const count = contents.files.length;
        const report: Notice = {
          message:
            `Imported ${count} ${count === 1 ? "file" : "files"} into ${target}.` +
            (contents.skipped > 0
              ? ` Left out ${contents.skipped} ${contents.skipped === 1 ? "entry" : "entries"} that docwalk cannot open.`
              : ""),
          tone: "info",
        };
        setNotice(report);
        // Opening a document clears notices, so the report is shown again once the file is open.
        guard(
          () =>
            void load(root, joinPath(target, strip(first.path))).then(
              (ok) => ok && setNotice(report),
            ),
        );
      } catch (error) {
        setNotice({
          message: message(error, "The zip file could not be imported."),
          tone: "error",
        });
      }
    },
    [active, listing, refresh, expand, setNotice, guard, load, root],
  );

  const exportZip = useCallback(async () => {
    if (!active) return;
    try {
      await flush();
      const [{ buildArchive }, files, tree] = await Promise.all([
        import("./zip"),
        collectFiles(active),
        listTree(active),
      ]);
      const folders = folderPaths(tree.nodes);
      if (files.length === 0 && folders.length === 0) {
        setNotice({ message: "The workspace is empty: there is nothing to export.", tone: "info" });
        return;
      }
      const name = root === "folder" && folderName ? folderName : "docwalk-workspace";
      downloadBlob(await buildArchive(files, folders), `${name}.zip`);
    } catch (error) {
      setNotice({ message: message(error, "The workspace could not be exported."), tone: "error" });
    }
  }, [active, flush, root, folderName, setNotice]);

  const switchRoot = useCallback((next: WorkspaceRoot) => {
    setRoot(next);
    rememberRoot(next);
  }, []);

  const openFolder = useCallback(async () => {
    try {
      const handle = await pickFolder();
      if (!handle) return;
      await saveFolderHandle(handle);
      const permission = await queryWrite(handle).catch((): PermissionState => "granted");
      setFolder({ handle, permission });
      switchRoot("folder");
    } catch (error) {
      setNotice({ message: message(error, "The folder could not be opened."), tone: "error" });
    }
  }, [switchRoot, setNotice]);

  const reconnect = useCallback(async () => {
    if (!folder) return;
    const permission = await requestWrite(folder.handle).catch((): PermissionState => "denied");
    setFolder({ handle: folder.handle, permission });
    if (permission !== "granted") {
      setNotice({
        message: `docwalk was not given access to ${folder.handle.name}.`,
        tone: "error",
      });
      return;
    }
    switchRoot("folder");
    // Reopen the file this folder had open on the last visit, unless something else is open now.
    const last = initialFile.current;
    initialFile.current = null;
    if (last?.root === "folder" && !workspaceSource(docRef.current)) {
      try {
        const { text, lastModified: lm } = await readText(folder.handle, last.path);
        const next: WorkspaceSource = { kind: "workspace", root: "folder", path: last.path };
        setBaseline({ key: keyOf(next), text, lastModified: lm });
        openDocument({ markdown: text, source: next });
      } catch {
        // Moved or deleted since: the tree is there to pick another.
      }
    }
  }, [folder, switchRoot, setNotice, setBaseline, openDocument]);

  const closeFolder = useCallback(() => {
    guard(() => {
      void forgetFolderHandle();
      setFolder(null);
      switchRoot("opfs");
      if (workspaceSource(docRef.current)?.root === "folder") {
        setBaseline(null);
        closeDocument();
      }
    });
  }, [guard, switchRoot, setBaseline, closeDocument]);

  const resolveConflict = useCallback(
    (keep: "mine" | "disk") => {
      const open = dialogRef.current;
      const src = workspaceSource(docRef.current);
      setDialog(null);
      if (open?.kind !== "conflict" || !src || src.path !== open.path) return;
      const key = keyOf(src);
      if (keep === "disk") {
        setBaseline({ key, text: open.disk.text, lastModified: open.disk.lastModified });
        openDocument({ markdown: open.disk.text, source: src });
      } else {
        // Keep the edits unsaved, and stop asking about this version of the file.
        const known = baselineRef.current;
        setBaseline({
          key,
          text: known?.key === key ? known.text : open.disk.text,
          lastModified: open.disk.lastModified,
        });
      }
    },
    [setBaseline, openDocument],
  );

  let saveState: SaveState | null = null;
  if (source) {
    if (missingKey === sourceKey) saveState = "missing";
    else if (failed) saveState = "error";
    // The browser workspace has no unsaved state: an edit is on its way to OPFS.
    else if (source.root === "opfs") saveState = dirty ? "saving" : "saved";
    else saveState = dirty ? "unsaved" : "saved";
  }

  /** Where "New file" puts a file: next to the open one, or at the top. */
  const currentDir = openPath ? parentOf(openPath) : "";

  return {
    supported,
    available: enabled && (supported.opfs || supported.folder),
    root,
    folderName,
    folderPermission: folder?.permission ?? null,
    listing,
    expanded,
    setExpanded,
    openPath,
    currentDir,
    source,
    saveState,
    dialog,
    setDialog,
    openFile,
    /** Runs a replacement of the open document after any unsaved local edits are saved or dropped. */
    guard,
    newFile,
    newFolder,
    newProject,
    renameEntry,
    removeEntry,
    importZip,
    exportZip,
    openFolder,
    reconnect,
    closeFolder,
    useBrowserWorkspace: () => switchRoot("opfs"),
    useFolder: () => switchRoot("folder"),
    save,
    resolveConflict,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
