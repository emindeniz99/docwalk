import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { downloadBlob } from "../export/download";
import type { LoadedDocument } from "../inputs/types";
import { m } from "../paraglide/messages.js";
import type { Notice, ReplaceGuard } from "../shell/useDocument";
import {
  collectFiles,
  createFile,
  documentPathsUnder,
  createFolder,
  folderPaths,
  lastModified,
  listTree,
  readText,
  remove,
  rename,
  sameListing,
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
  folderId,
  forgetFolderHandle,
  loadFolderHandle,
  opfsRoot,
  rememberedFile,
  rememberedRoot,
  rememberFile,
  rememberRoot,
  saveFolderHandle,
} from "./store";
import { pollWhileVisible } from "./poll";
import { isPersistent, requestPersistence, storageUse } from "./storage";
import { openTabChannel, withWriteLock, type TabChange, type TabChannel } from "./tabs";
import { starter, TEMPLATES, type ProjectTemplate } from "./templates";
import {
  MAX_LISTED_ENTRIES,
  type WorkspaceListing,
  type WorkspaceNode,
  type WorkspaceRoot,
  type WorkspaceSource,
} from "./types";

/** The browser workspace saves this long after the last keystroke. */
export const AUTOSAVE_MS = 500;
/** A local folder without `FileSystemObserver` is checked this often for changes on disk. */
const POLL_MS = 1000;
/** Without `FileSystemObserver`, the tree of a local folder is listed this often while the page is visible. */
const LIST_POLL_MS = 3000;

interface WorkspaceInputs {
  doc: LoadedDocument | null;
  openDocument: (doc: LoadedDocument) => void;
  closeDocument: () => void;
  retarget: (source: WorkspaceSource) => void;
  setNotice: (notice: Notice | null) => void;
  /** Whether a saved draft exists that is not the open document. */
  draftAvailable: boolean;
  /** Shows the saved draft again. */
  reopenDraft: () => void;
  /** Lets the document ask the workspace before a share link replaces it. */
  setReplaceGuard: (guard: ReplaceGuard | null) => void;
}

/** A dialog the workspace needs answered; App renders it (src/workspace/WorkspaceDialogs.tsx). */
type WorkspaceDialog =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "new-project" }
  | { kind: "rename"; node: WorkspaceNode }
  | { kind: "delete"; node: WorkspaceNode }
  /** Unsaved edits to a local-folder file would be lost by what the user asked for. */
  | { kind: "discard"; path: string; proceed: () => void }
  /** The file changed on disk while it has unsaved edits (decision 58). */
  | { kind: "conflict"; path: string; disk: FileText };

/** What writing the pending autosave came to: written, held back for a question, or failed. */
type Flushed = "saved" | "held" | "failed";

/** What the banner says about the open workspace file. */
export type SaveState = "saved" | "saving" | "unsaved" | "missing" | "error";

interface FolderState {
  handle: FileSystemDirectoryHandle;
  /** Which folder this is (src/workspace/store.ts `folderId`); a local file's source names it. */
  id: string;
  permission: PermissionState;
}

/** The text last read from or written to the open file, and the file's time then. */
interface Baseline {
  key: string;
  text: string;
  lastModified: number | null;
  /** The disk text the user chose not to load ("Keep my edits"), if it differs from `text`. */
  declined?: string;
}

const keyOf = (s: WorkspaceSource) =>
  s.root === "folder" ? `folder:${s.folder}:${s.path}` : `opfs:${s.path}`;
const workspaceSource = (doc: LoadedDocument | null): WorkspaceSource | null =>
  doc?.source.kind === "workspace" ? doc.source : null;

/**
 * The row that takes focus when `path` is deleted: the next row beside it,
 * else the one before, else its folder; "" (the panel) for the last top-level
 * entry; `null` when `path` is not listed.
 */
function neighbourOf(nodes: WorkspaceNode[], path: string, parent = ""): string | null {
  const i = nodes.findIndex((n) => n.path === path);
  if (i >= 0) return (nodes[i + 1] ?? nodes[i - 1])?.path ?? parent;
  const holder = nodes.find((n) => n.children && isWithin(path, n.path));
  return holder ? neighbourOf(holder.children!, path, holder.path) : null;
}

const megabytes = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Like `message`; a full browser storage also says how full it is. */
async function failure(error: unknown, fallback: string, inBrowser: boolean): Promise<string> {
  if (inBrowser && error instanceof DOMException && error.name === "QuotaExceededError") {
    const use = await storageUse();
    if (use) return m.ws_err_quota_use({ used: megabytes(use.used), quota: megabytes(use.quota) });
  }
  return message(error, fallback);
}

/** The document files under `node` whose comments and sketches go with it; the listing is the fallback. */
async function annotatedFiles(handle: FileSystemDirectoryHandle, node: WorkspaceNode) {
  try {
    return await documentPathsUnder(handle, node.path);
  } catch {
    return (await import("./annotations")).filePaths(node);
  }
}

function message(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceError) return error.message;
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return m.ws_err_no_access();
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return m.ws_err_quota();
  }
  return fallback;
}

/**
 * Some file systems keep modification times in whole seconds (WebKit's OPFS
 * does), so a second write within the same second leaves the time as it was.
 * While a file's time is this recent, polling compares the text as well.
 */
const COARSE_MTIME_MS = 2000;

/**
 * What happened to a local file since `known` (its last seen text and
 * modification time): gone, the same, or changed, with the new text. A
 * version the user is already being asked about (`asking`) counts as the same.
 */
async function diskChange(
  handle: FileSystemDirectoryHandle,
  path: string,
  known: { text: string; lastModified: number | null; declined?: string },
  asking: FileText | null,
): Promise<{ kind: "missing" } | { kind: "unchanged" } | { kind: "changed"; disk: FileText }> {
  const lm = await lastModified(handle, path);
  if (lm === null) return { kind: "missing" };
  const sameTime = lm === known.lastModified || lm === asking?.lastModified;
  if (sameTime && Date.now() - lm > COARSE_MTIME_MS) return { kind: "unchanged" };
  const disk = await readText(handle, path);
  const seen = [known.text, known.declined, asking?.text];
  if (sameTime && seen.includes(disk.text)) {
    return { kind: "unchanged" };
  }
  return { kind: "changed", disk };
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
  const { doc, openDocument, closeDocument, retarget, setNotice, reopenDraft, setReplaceGuard } =
    inputs;
  const supported = useMemo(() => ({ opfs: opfsSupported(), folder: folderSupported() }), []);
  const [opfs, setOpfs] = useState<FileSystemDirectoryHandle | null>(null);
  // The API can exist and still refuse: Safari's private windows (and
  // Playwright's WebKit) reject getDirectory(). Then there is no workspace.
  const [opfsRefused, setOpfsRefused] = useState(false);
  const [folder, setFolder] = useState<FolderState | null>(null);
  /** Whether the folder remembered from an earlier visit has been looked up. */
  const [folderChecked, setFolderChecked] = useState(!supported.folder);
  // A browser without the folder picker always shows the browser workspace.
  const [root, setRoot] = useState<WorkspaceRoot>(() =>
    supported.folder ? rememberedRoot() : "opfs",
  );
  // Keyed by handle, so switching roots never shows the other root's files for a moment.
  const [listed, setListed] = useState<{
    handle: FileSystemDirectoryHandle;
    listing: WorkspaceListing;
  } | null>(null);
  /** The directory whose last listing failed; its tree stays as it was. */
  const [listFailed, setListFailed] = useState<FileSystemDirectoryHandle | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null);
  const [baseline, setBaselineState] = useState<Baseline | null>(null);
  const [failed, setFailed] = useState(false);
  /** The key of an open local file that was deleted or moved on disk. */
  const [missingKey, setMissingKey] = useState<string | null>(null);
  /**
   * The key of an open browser-workspace file whose autosave is held back:
   * another tab deleted it, or wrote different text over what this tab edited.
   * Its edits exist only on screen until the user answers.
   */
  const [heldKey, setHeldKey] = useState<string | null>(null);
  /** Whether the browser keeps the browser workspace; `null` while unknown. */
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const askedPersistence = useRef(false);
  /**
   * The tree row (its path; "" for the panel) that takes focus once the
   * dialog that changed the tree has closed: the element that opened the
   * dialog may be gone, and focus must not fall to the page (WCAG 2.4.3).
   */
  const [focusTarget, setFocusTarget] = useState<{ path: string } | null>(null);

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
  /**
   * The directory a workspace file lives in. A local file resolves only
   * against its own folder, never against another one picked since, where
   * the same path is a different file.
   */
  const handleOf = useCallback(
    (s: WorkspaceSource): FileSystemDirectoryHandle | null =>
      s.root === "opfs" ? opfs : folder?.id === s.folder ? handleFor("folder") : null,
    [opfs, folder, handleFor],
  );
  /** The source of `path` under root `r`; `null` for a folder when none is picked. */
  const sourceFor = useCallback(
    (r: WorkspaceRoot, path: string): WorkspaceSource | null =>
      r === "opfs"
        ? { kind: "workspace", root: "opfs", path }
        : folder
          ? { kind: "workspace", root: "folder", folder: folder.id, path }
          : null,
    [folder],
  );
  /** Whether `s` is a file of the tree on screen. */
  const inView = useCallback(
    (s: WorkspaceSource | null): s is WorkspaceSource =>
      s !== null && s.root === root && (s.root === "opfs" || s.folder === folder?.id),
    [root, folder],
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
        .catch(() => live && setOpfsRefused(true));
      void isPersistent().then((kept) => live && setPersistent(kept));
    }
    if (supported.folder) {
      void loadFolderHandle().then(async (handle) => {
        if (!live) return;
        if (!handle) {
          setRoot("opfs");
          setFolderChecked(true);
          return;
        }
        const permission = await queryWrite(handle).catch((): PermissionState => "prompt");
        const id = await folderId(handle);
        if (!live) return;
        setFolder({ handle, id, permission });
        setFolderChecked(true);
      });
    }
    return () => {
      live = false;
    };
  }, [enabled, supported]);

  // ---- The tree ------------------------------------------------------------
  const listGeneration = useRef(0);
  const refresh = useCallback((): Promise<void> => {
    if (!active) return Promise.resolve();
    const gen = ++listGeneration.current;
    return listTree(active).then(
      (fresh) => {
        if (gen !== listGeneration.current) return;
        setListFailed(null);
        // An unchanged tree keeps its objects, so a poll redraws nothing and moves no focus.
        setListed((prev) =>
          prev?.handle === active && sameListing(prev.listing, fresh)
            ? prev
            : { handle: active, listing: fresh },
        );
      },
      (error: unknown) => {
        if (gen !== listGeneration.current) return;
        // An empty tree would read as "no Markdown files" and invite writes into
        // a folder that cannot be read. The tree on screen stays as it was, and
        // a refused read sends the folder back to "Reconnect".
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          setFolder((f) => (f?.handle === active ? { ...f, permission: "prompt" } : f));
        }
        setListFailed(active);
      },
    );
  }, [active]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The open file's folders stay expanded, so the selection is visible.
  const openPath = inView(source) ? source.path : null;
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
  // A local file that could not be reopened for want of permission stays
  // remembered until a workspace file is opened, so "Reconnect" still finds
  // it after another reload.
  const folderWaiting = !folderChecked || (folder !== null && folder.permission !== "granted");
  useEffect(() => {
    if (!docKnown) return;
    if (sourceRoot === null && folderWaiting && rememberedFile()?.root === "folder") return;
    rememberFile(sourceRoot && sourcePath !== null ? { root: sourceRoot, path: sourcePath } : null);
  }, [docKnown, sourceRoot, sourcePath, folderWaiting]);

  // ---- The text the open file holds on disk --------------------------------
  useEffect(() => {
    // A file restored at start-up (src/workspace/restore.ts) arrives without a baseline.
    const src = workspaceSource(docRef.current);
    if (src === null || sourceKey === null || keyOf(src) !== sourceKey) return;
    if (baselineRef.current?.key === sourceKey) return;
    const handle = handleOf(src);
    if (!handle) return;
    const text = docRef.current?.markdown ?? "";
    void lastModified(handle, src.path).then((lm) => {
      if (baselineRef.current?.key !== sourceKey) {
        setBaseline({ key: sourceKey, text, lastModified: lm });
      }
    });
  }, [sourceKey, handleOf, setBaseline]);

  const base = baseline && sourceKey === baseline.key ? baseline : null;
  const dirty = source !== null && base !== null && doc !== null && doc.markdown !== base.text;

  // ---- Browser workspace: autosave ------------------------------------------
  const pending = useRef<{ source: WorkspaceSource; text: string } | null>(null);
  /**
   * A conflict found while another dialog was open: asked once that dialog
   * closes, since replacing it would drop what it holds (the action waiting
   * on Save or Discard, a half-typed name).
   */
  const askAfterDialog = useRef(false);
  /** The channel to the other tabs (src/workspace/tabs.ts); null until the workspace is open. */
  const tab = useRef<TabChannel | null>(null);
  const announce = useCallback((kind: TabChange) => tab.current?.announce(kind), []);
  /** Tells the other tabs the listing changed; only the browser workspace is shared. */
  const treeChanged = useCallback(() => {
    if (root === "opfs") announce("tree");
  }, [root, announce]);
  /**
   * The user saved something into the browser workspace: the first time in a
   * page's life, ask the browser to keep it. Nothing is asked before there is
   * something to keep, and a refusal changes nothing but a note in the panel.
   */
  const noteSaved = useCallback(() => {
    if (askedPersistence.current) return;
    askedPersistence.current = true;
    void requestPersistence().then((kept) => {
      if (kept !== null) setPersistent(kept);
    });
  }, []);
  /**
   * Writes the pending autosave now, unless the file is not what this tab last
   * saw (decision 90). Under the write lock the file is looked at first: a file
   * another tab deleted is not created again (`recreate`, an explicit Save,
   * does), and one it changed to other text is asked about, never overwritten.
   */
  const flush = useCallback(
    async (recreate = false): Promise<Flushed> => {
      const job = pending.current;
      pending.current = null;
      if (!job || !opfs) return "saved";
      const key = keyOf(job.source);
      const path = job.source.path;
      try {
        const outcome = await withWriteLock(async () => {
          const known = baselineRef.current?.key === key ? baselineRef.current : null;
          let created = false;
          if (known) {
            const change = await diskChange(opfs, path, known, null);
            if (change.kind === "missing") {
              if (!recreate) return { kind: "missing" as const };
              created = true;
            } else if (
              change.kind === "changed" &&
              change.disk.text !== known.text &&
              change.disk.text !== job.text
            ) {
              return { kind: "conflict" as const, disk: change.disk };
            }
          }
          const lm = await writeText(opfs, path, job.text);
          // Still under the lock: the next tab, or the next write of this one, compares with this.
          if (baselineRef.current?.key === key) {
            setBaseline({ key, text: job.text, lastModified: lm });
          }
          return { kind: "written" as const, created };
        });
        if (outcome.kind !== "written") {
          setHeldKey(key);
          if (outcome.kind === "missing") setMissingKey(key);
          else if (dialogRef.current?.kind !== "conflict") {
            if (dialogRef.current) askAfterDialog.current = true;
            else setDialog({ kind: "conflict", path, disk: outcome.disk });
          }
          return "held";
        }
        setFailed(false);
        setHeldKey((k) => (k === key ? null : k));
        setMissingKey((k) => (k === key ? null : k));
        announce(outcome.created ? "tree" : "file");
        noteSaved();
        return "saved";
      } catch (error) {
        setFailed(true);
        setNotice({
          message: await failure(error, m.ws_err_save_browser({ path }), true),
          tone: "error",
        });
        return "failed";
      }
    },
    [opfs, announce, noteSaved, setBaseline, setNotice],
  );

  const markdown = doc?.markdown;
  const baseText = base?.text;
  useEffect(() => {
    if (sourceRoot !== "opfs" || sourcePath === null || baseText === undefined) {
      // Another kind of document replaced the file: its last edits go now,
      // not at pagehide, whose write a closing tab does not wait for.
      if (pending.current) void flush();
      return;
    }
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
  /**
   * Saves the open workspace file. Resolves to whether the text is now on
   * disk: a caller that replaces the document afterwards (the "Save" choice
   * of the unsaved-changes dialog) must not go on when it is not.
   */
  const save = useCallback(async (): Promise<boolean> => {
    const current = docRef.current;
    const src = workspaceSource(current);
    if (!src || !current) return false;
    if (src.root === "opfs") {
      // Save is the user's answer to a held-back edit, so it also writes a file that is gone.
      pending.current = { source: src, text: current.markdown };
      return (await flush(true)) === "saved";
    }
    const handle = handleOf(src);
    if (!handle) {
      setNotice({ message: message(new DOMException("", "NotAllowedError"), ""), tone: "error" });
      return false;
    }
    // A change on disk that no check has seen yet (a notice still on its way,
    // the poll not due) is asked about, never written over (decision 58).
    // The version a conflict dialog still asks about is not an answer yet.
    const known = baselineRef.current;
    if (known?.key === keyOf(src)) {
      // A file that changed and cannot be read (not UTF-8, over the size cap)
      // cannot be compared, so it is not written over either.
      let change: Awaited<ReturnType<typeof diskChange>>;
      try {
        change = await diskChange(handle, src.path, known, null);
      } catch {
        setFailed(true);
        setNotice({ message: m.ws_err_save_unreadable({ path: src.path }), tone: "error" });
        return false;
      }
      if (
        change.kind === "changed" &&
        change.disk.text !== known.text &&
        change.disk.text !== current.markdown
      ) {
        setDialog({ kind: "conflict", path: src.path, disk: change.disk });
        return false;
      }
    }
    try {
      const lm = await writeText(handle, src.path, current.markdown);
      setBaseline({ key: keyOf(src), text: current.markdown, lastModified: lm });
      setMissingKey(null);
      setFailed(false);
      return true;
    } catch (error) {
      setFailed(true);
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setFolder((f) => (f ? { ...f, permission: "prompt" } : f));
      }
      setNotice({ message: message(error, m.ws_err_save({ path: src.path })), tone: "error" });
      return false;
    }
  }, [flush, handleOf, setBaseline, setNotice]);

  const checking = useRef(false);
  const checkAgain = useRef(false);
  /** Compares the open local file with the disk; a call while one runs is not dropped but runs after it. */
  const checkDisk = useCallback(async () => {
    if (checking.current) {
      checkAgain.current = true;
      return;
    }
    checking.current = true;
    const checkOnce = async () => {
      const src = workspaceSource(docRef.current);
      const handle = src ? handleOf(src) : null;
      const known = baselineRef.current;
      if (!src || !handle) return;
      if (known?.key !== keyOf(src)) return;
      const open = dialogRef.current;
      const change = await diskChange(
        handle,
        src.path,
        known,
        open?.kind === "conflict" ? open.disk : null,
      ).catch(() => null);
      const key = keyOf(src);
      const current = docRef.current;
      // The user opened something else while the disk was read.
      const now = workspaceSource(current);
      if (!change || baselineRef.current?.key !== key || !now || keyOf(now) !== key) {
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
        setHeldKey((k) => (k === key ? null : k));
        setBaseline({ key, text: disk.text, lastModified: disk.lastModified });
      } else if (current.markdown !== known.text) {
        const showing = dialogRef.current;
        if (showing && showing.kind !== "conflict") askAfterDialog.current = true;
        else setDialog({ kind: "conflict", path: src.path, disk });
      } else {
        setHeldKey((k) => (k === key ? null : k));
        setBaseline({ key, text: disk.text, lastModified: disk.lastModified });
        openDocument({ markdown: disk.text, source: src });
      }
    };
    await checkOnce();
    while (checkAgain.current) {
      checkAgain.current = false;
      await checkOnce();
    }
    checking.current = false;
  }, [handleOf, openDocument, setBaseline]);
  useEffect(() => {
    if (dialog !== null || !askAfterDialog.current) return;
    askAfterDialog.current = false;
    void checkDisk();
  }, [dialog, checkDisk]);

  // Other tabs of the browser workspace say when they changed it (decision 90).
  useEffect(() => {
    if (!enabled || !opfs) return;
    const channel = openTabChannel((kind) => {
      if (kind === "tree" && root === "opfs") void refresh();
      if (workspaceSource(docRef.current)?.root === "opfs") void checkDisk();
    });
    tab.current = channel;
    return () => {
      channel?.close();
      if (tab.current === channel) tab.current = null;
    };
  }, [enabled, opfs, root, refresh, checkDisk]);

  // Files added by other tabs or other programs, and a notice that never arrived, show on return.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
      void checkDisk();
    };
    globalThis.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      globalThis.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refresh, checkDisk]);

  const folderHandle = handleFor("folder");
  const watchedPath =
    source?.root === "folder" && source.folder === folder?.id ? source.path : null;
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
      if (!live) {
        disconnect?.();
        return;
      }
      // Without an observer, list again every few seconds while the page is visible.
      stop = disconnect ?? pollWhileVisible(refresh, LIST_POLL_MS);
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

  // Unsaved edits to a local file, or edits of a browser-workspace file that
  // another tab deleted or changed: the browser asks before the page goes away.
  const held = heldKey !== null && heldKey === sourceKey;
  const unsavedEdits = dirty && (sourceRoot === "folder" || held);
  useEffect(() => {
    if (!unsavedEdits) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    globalThis.addEventListener("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedEdits]);

  /** Runs `proceed` now, or after the user agrees to drop unsaved local edits. */
  const guard = useCallback(
    (proceed: () => void) => {
      if (unsavedEdits && sourcePath !== null) {
        setDialog({
          kind: "discard",
          path: sourcePath,
          // Saved or discarded, the edits are settled: a disk change found
          // meanwhile has nothing left to ask about.
          proceed: () => {
            askAfterDialog.current = false;
            proceed();
          },
        });
      } else proceed();
    },
    [unsavedEdits, sourcePath],
  );
  // A share link pasted into the address bar goes through the same question.
  useLayoutEffect(() => {
    if (!enabled) return;
    setReplaceGuard(guard);
    return () => setReplaceGuard(null);
  }, [enabled, guard, setReplaceGuard]);

  /** "Open draft": the saved draft, after any unsaved local edits are saved or dropped. */
  const openDraft = useCallback(() => guard(reopenDraft), [guard, reopenDraft]);

  // ---- Actions behind the panel ----------------------------------------------
  const load = useCallback(
    async (r: WorkspaceRoot, path: string): Promise<boolean> => {
      const next = sourceFor(r, path);
      const handle = next && handleOf(next);
      if (!next || !handle) return false;
      try {
        // Edits held back for a question are not dropped for another file.
        if ((await flush()) === "held") return false;
        const { text, lastModified: lm } = await readText(handle, path);
        setBaseline({ key: keyOf(next), text, lastModified: lm });
        setHeldKey(null);
        setFailed(false);
        openDocument({ markdown: text, source: next });
        return true;
      } catch (error) {
        setNotice({ message: message(error, m.ws_err_open({ path })), tone: "error" });
        return false;
      }
    },
    [sourceFor, handleOf, flush, openDocument, setBaseline, setNotice],
  );

  const openFile = useCallback(
    (path: string) => {
      if (openPath === path) return;
      guard(() => void load(root, path));
    },
    [openPath, root, guard, load],
  );

  const expand = useCallback((paths: string[]) => {
    setExpanded((prev) => new Set([...prev, ...paths]));
  }, []);

  /** Each returns an error message for the dialog to show, or null when it worked. */
  const newFile = useCallback(
    async (dir: string, rawName: string): Promise<string | null> => {
      const problem = validateName(rawName);
      if (problem) return problem;
      if (!active) return m.ws_err_unavailable();
      const name = withMarkdownExtension(rawName);
      const path = joinPath(dir, name);
      try {
        await createFile(active, path, starter(name.replace(/\.[^.]+$/, "")));
      } catch (error) {
        return failure(error, m.ws_err_create({ path }), root === "opfs");
      }
      treeChanged();
      if (root === "opfs") noteSaved();
      await refresh();
      expand(ancestorsOf(path));
      setFocusTarget({ path });
      guard(() => void load(root, path));
      return null;
    },
    [active, refresh, treeChanged, noteSaved, expand, guard, load, root],
  );

  const newFolder = useCallback(
    async (dir: string, name: string): Promise<string | null> => {
      const problem = validateName(name);
      if (problem) return problem;
      if (!active) return m.ws_err_unavailable();
      const path = joinPath(dir, name);
      try {
        await createFolder(active, path);
      } catch (error) {
        return message(error, m.ws_err_create({ path }));
      }
      treeChanged();
      await refresh();
      expand([...ancestorsOf(path), path]);
      setFocusTarget({ path });
      return null;
    },
    [active, refresh, treeChanged, expand],
  );

  const newProject = useCallback(
    async (name: string, templateId: ProjectTemplate["id"]): Promise<string | null> => {
      const problem = validateName(name);
      if (problem) return problem;
      const template = TEMPLATES.find((t) => t.id === templateId);
      if (!active || !template) return m.ws_err_unavailable();
      try {
        await createFolder(active, name);
        for (const file of template.files(name)) {
          await writeText(active, joinPath(name, file.path), file.text);
        }
      } catch (error) {
        return failure(error, m.ws_err_create({ path: name }), root === "opfs");
      }
      treeChanged();
      if (root === "opfs") noteSaved();
      await refresh();
      expand([name]);
      setFocusTarget({ path: joinPath(name, template.main) });
      guard(() => void load(root, joinPath(name, template.main)));
      return null;
    },
    [active, refresh, treeChanged, noteSaved, expand, guard, load, root],
  );

  const renameEntry = useCallback(
    async (node: WorkspaceNode, rawName: string): Promise<string | null> => {
      const problem = validateName(rawName);
      if (problem) return problem;
      if (!active) return m.ws_err_unavailable();
      const name = node.kind === "file" ? withMarkdownExtension(rawName) : rawName;
      let next: string;
      let movedFiles: string[];
      try {
        await flush();
        // Asked of the directory before it moves: the listing stops at 5000 entries.
        movedFiles = await annotatedFiles(active, node);
        next = await rename(active, node.path, name);
      } catch (error) {
        return message(error, m.ws_err_rename({ path: node.path }));
      }
      treeChanged();
      // Comments and sketches are keyed by path; they move with the file,
      // before the open document is retargeted and reloads them.
      const { moveAnnotations } = await import("./annotations");
      const at = (p: string) => sourceFor(root, p)!;
      await moveAnnotations(
        movedFiles.map((p) => [at(p), at(next + p.slice(node.path.length))] as const),
      );
      // The open file, or the folder holding it, moved: same text, new address.
      const current = workspaceSource(docRef.current);
      if (inView(current) && isWithin(current.path, node.path)) {
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
      setFocusTarget({ path: next });
      return null;
    },
    [active, flush, root, sourceFor, inView, setBaseline, retarget, refresh, treeChanged],
  );

  const removeEntry = useCallback(
    async (node: WorkspaceNode): Promise<void> => {
      if (!active) return;
      const current = workspaceSource(docRef.current);
      const openInside = inView(current) && isWithin(current.path, node.path);
      const neighbour = neighbourOf(listing?.nodes ?? [], node.path);
      let dropped: string[];
      // A pending autosave of a file being deleted must not bring it back.
      if (openInside) pending.current = null;
      else await flush();
      try {
        // Asked of the directory before it goes: the listing stops at 5000 entries.
        dropped = await annotatedFiles(active, node);
        await remove(active, node.path);
      } catch (error) {
        setNotice({ message: message(error, m.ws_err_delete({ path: node.path })), tone: "error" });
        return;
      }
      treeChanged();
      // A new file at the same path later must not inherit them.
      const { dropAnnotations } = await import("./annotations");
      await dropAnnotations(dropped.map((p) => sourceFor(root, p)!));
      if (openInside) {
        setBaseline(null);
        closeDocument();
      }
      await refresh();
      if (neighbour !== null) setFocusTarget({ path: neighbour });
    },
    [
      active,
      root,
      listing,
      inView,
      sourceFor,
      flush,
      setBaseline,
      closeDocument,
      refresh,
      treeChanged,
      setNotice,
    ],
  );

  const importZip = useCallback(
    async (file: File) => {
      if (!active) return;
      try {
        const { MAX_ARCHIVE_BYTES, readArchive } = await import("./zip");
        if (file.size > MAX_ARCHIVE_BYTES) {
          throw new WorkspaceError(m.ws_zip_too_large({ mb: MAX_ARCHIVE_BYTES / 1024 / 1024 }));
        }
        const contents = await readArchive(new Uint8Array(await file.arrayBuffer()));
        if (contents.files.length === 0) {
          setNotice({ message: m.ws_zip_empty(), tone: "error" });
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
            : m.ws_imported_folder();
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
        treeChanged();
        if (root === "opfs") noteSaved();
        await refresh();
        expand([target]);
        const first =
          contents.files.find(
            (f) => /^readme\.md$/i.test(baseName(strip(f.path))) && !strip(f.path).includes("/"),
          ) ?? contents.files[0]!;
        const count = contents.files.length;
        const report: Notice = {
          message:
            m.ws_imported({ count, target }) +
            (contents.skipped > 0 ? ` ${m.ws_skipped({ count: contents.skipped })}` : ""),
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
          message: await failure(error, m.ws_err_import(), root === "opfs"),
          tone: "error",
        });
      }
    },
    [active, listing, refresh, treeChanged, noteSaved, expand, setNotice, guard, load, root],
  );

  const exportZip = useCallback(async () => {
    if (!active) return;
    try {
      await flush();
      const tree = await listTree(active);
      // An archive that looks complete and lacks files is the worse backup.
      if (tree.truncated) {
        setNotice({ message: m.ws_export_truncated({ count: MAX_LISTED_ENTRIES }), tone: "error" });
        return;
      }
      const [{ buildArchive }, files] = await Promise.all([import("./zip"), collectFiles(active)]);
      const folders = folderPaths(tree.nodes);
      if (files.length === 0 && folders.length === 0) {
        setNotice({ message: m.ws_export_empty(), tone: "info" });
        return;
      }
      const name = root === "folder" && folderName ? folderName : "docwalk-workspace";
      downloadBlob(await buildArchive(files, folders), `${name}.zip`);
    } catch (error) {
      setNotice({ message: message(error, m.ws_err_export()), tone: "error" });
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
      const id = await folderId(handle);
      const permission = await queryWrite(handle).catch((): PermissionState => "granted");
      const show = () => {
        void saveFolderHandle(handle);
        setFolder({ handle, id, permission });
        switchRoot("folder");
      };
      const open = workspaceSource(docRef.current);
      if (open?.root !== "folder" || open.folder === id) {
        show();
        return;
      }
      // A file of the other folder is open. Its edits are saved or dropped
      // first, and it closes: the new folder may hold a different file at
      // the same path, which a save would overwrite.
      guard(() => {
        setBaseline(null);
        closeDocument();
        show();
      });
    } catch (error) {
      setNotice({ message: message(error, m.ws_err_open_folder()), tone: "error" });
    }
  }, [switchRoot, setNotice, guard, setBaseline, closeDocument]);

  const reconnect = useCallback(async () => {
    if (!folder) return;
    const permission = await requestWrite(folder.handle).catch((): PermissionState => "denied");
    setFolder({ ...folder, permission });
    if (permission !== "granted") {
      setNotice({
        message: m.ws_err_denied({ name: folder.handle.name }),
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
        const next: WorkspaceSource = {
          kind: "workspace",
          root: "folder",
          folder: folder.id,
          path: last.path,
        };
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
        // The edits that were waiting to be saved are the ones given up.
        pending.current = null;
        setHeldKey(null);
        setBaseline({ key, text: open.disk.text, lastModified: open.disk.lastModified });
        openDocument({ markdown: open.disk.text, source: src });
      } else {
        // Keep the edits unsaved, and stop asking about this version of the file.
        const known = baselineRef.current;
        setBaseline({
          key,
          text: known?.key === key ? known.text : open.disk.text,
          lastModified: open.disk.lastModified,
          declined: open.disk.text,
        });
        // The browser workspace has no Save button for this: keeping the edits is the save.
        const current = docRef.current;
        if (src.root === "opfs" && current) {
          pending.current = { source: src, text: current.markdown };
          void flush();
        }
      }
    },
    [setBaseline, openDocument, flush],
  );

  /** The panel moved focus to `target`, or found nothing to focus. */
  const focusDone = useCallback(
    (target: { path: string }) => setFocusTarget((t) => (t === target ? null : t)),
    [],
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
    supported: { opfs: supported.opfs && !opfsRefused, folder: supported.folder },
    available: enabled && ((supported.opfs && !opfsRefused) || supported.folder),
    root,
    /** Whether the browser promises to keep the browser workspace; `null` while unknown or unsupported. */
    persistent,
    folderName,
    folderPermission: folder?.permission ?? null,
    listing,
    /** The last attempt to list the tree on screen failed; with no tree yet, the panel says so. */
    listFailed: listFailed !== null && listFailed === active,
    expanded,
    setExpanded,
    openPath,
    currentDir,
    source,
    saveState,
    dialog,
    setDialog,
    focusTarget,
    focusDone,
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
    /** A saved draft exists that is not the open document (Files panel and palette offer it). */
    draftAvailable: enabled && inputs.draftAvailable,
    openDraft,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
