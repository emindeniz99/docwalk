import { act, createElement as h, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { documentKey, sketchKey } from "../canvas/identity";
import { loadSketch, saveSketch } from "../canvas/store";
import { sourceKey } from "../comments/identity";
import { openCommentStore } from "../comments/store";
import type { DocComment } from "../comments/types";
import { releaseDraft, useDraftAutosave } from "../share/draft";
import { DRAFT_STORAGE_KEY } from "../share/types";
import { useDocument } from "../shell/useDocument";
import { workspaceCommands } from "./commands";
import { FilesPanel } from "./FilesPanel";
import { kindAt, writeText } from "./fs";
import { folderId, opfsRoot, rememberedFile, rememberFile, saveFolderHandle } from "./store";
import { MAX_LISTED_ENTRIES, type WorkspaceNode } from "./types";
import { AUTOSAVE_MS, useWorkspace, type Workspace } from "./useWorkspace";
import { WorkspaceDialogs } from "./WorkspaceDialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Inputs = ReturnType<typeof useDocument>;
interface Wired {
  inputs: Inputs;
  workspace: Workspace;
}

/** The document, the draft autosave and the workspace wired as App wires them. */
function Harness({ report }: { report: (wired: Wired) => void }) {
  const inputs = useDocument({ follow: false });
  useDraftAutosave(inputs.doc?.markdown ?? "", inputs.doc?.source ?? { kind: "sample" });
  const workspace = useWorkspace({ inputs, enabled: true });
  report({ inputs, workspace });
  return h(Fragment, null, h(FilesPanel, { workspace }), h(WorkspaceDialogs, { workspace }));
}

let root: Root | null = null;
/** The roots of further "tabs" a test mounted next to the first. */
const extraRoots: Root[] = [];
/** A folder of the real OPFS workspace that only this test uses. */
let dir = "";

async function mount() {
  const result: { current: Wired | null } = { current: null };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness, { report: (r) => (result.current = r) })));
  await vi.waitFor(() => expect(result.current!.workspace.listing).not.toBeNull());
  return result;
}

/** Another tab: a second workspace hook on the same origin, in the same page. */
async function mountTab() {
  const result: { current: Wired | null } = { current: null };
  const container = document.createElement("div");
  document.body.append(container);
  const tab = createRoot(container);
  extraRoots.push(tab);
  act(() => tab.render(h(Harness, { report: (r) => (result.current = r) })));
  await vi.waitFor(() => expect(result.current!.workspace.listing).not.toBeNull());
  return result;
}

const PASTED ={ markdown: "# My own draft\n\nOnly copy.\n", source: { kind: "paste" } };

beforeEach(() => {
  localStorage.clear();
  releaseDraft();
  dir = `ws-test-${crypto.randomUUID()}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const extra of extraRoots.splice(0)) act(() => extra.unmount());
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  // Chromium aborts when another document reads an OPFS handle back from
  // IndexedDB (MEMORY.md), so no picked folder outlives the test.
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase("docwalk-workspace");
    for (const event of ["success", "error", "blocked"]) request.addEventListener(event, resolve);
  });
  await (await opfsRoot()).removeEntry(dir, { recursive: true }).catch(() => undefined);
});

/**
 * Chromium aborts (SIGTRAP) when a document reads back an OPFS directory
 * handle another document stored in IndexedDB (MEMORY.md), and test files
 * run side by side on one origin. As in e2e/workspace.spec.ts, handles go
 * into IndexedDB as markers that only this document maps back.
 */
const putHandle = IDBObjectStore.prototype.put;
const resultOf = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!;
beforeAll(() => {
  const kept = new Map<string, FileSystemDirectoryHandle>();
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    if (!(value instanceof FileSystemDirectoryHandle)) return putHandle.call(this, value, key);
    const marker = `docwalk-test:handle:${crypto.randomUUID()}`;
    kept.set(marker, value);
    return putHandle.call(this, marker, key);
  };
  Object.defineProperty(IDBRequest.prototype, "result", {
    configurable: true,
    get(this: IDBRequest) {
      const value: unknown = resultOf.get!.call(this);
      return typeof value === "string" && kept.has(value) ? kept.get(value) : value;
    },
  });
});
afterAll(() => {
  IDBObjectStore.prototype.put = putHandle;
  Object.defineProperty(IDBRequest.prototype, "result", resultOf);
});

/** OPFS directory `dir/<name>`, which stands in for a folder on disk. */
async function disk(name: string): Promise<FileSystemDirectoryHandle> {
  const top = await (await opfsRoot()).getDirectoryHandle(dir, { create: true });
  return top.getDirectoryHandle(name, { create: true });
}
const readDisk = async (name: string, path: string) =>
  (await (await (await disk(name)).getFileHandle(path)).getFile()).text();

/**
 * `showDirectoryPicker` handing out `dir/<name>`, as e2e/workspace.spec.ts
 * stubs it; set before mount, since support is read once. OPFS handles report
 * write permission as granted.
 */
function pickNext(name: string) {
  (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = () => disk(name);
}

/** Picks `name` through "Open folder…" and opens its `path`. */
async function openInFolder(wired: { current: Wired | null }, name: string, path: string) {
  pickNext(name);
  await act(() => wired.current!.workspace.openFolder());
  await vi.waitFor(() => expect(wired.current!.workspace.folderName).toBe(name));
  await vi.waitFor(() =>
    expect(wired.current!.workspace.listing?.nodes.map((n) => n.path)).toContain(path),
  );
  act(() => wired.current!.workspace.openFile(path));
  await vi.waitFor(() => expect(wired.current!.workspace.source?.path).toBe(path));
}

const alertButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
    (b) => b.textContent === name,
  )!;

function showDiscard(save: () => Promise<boolean>) {
  const proceed = vi.fn<() => void>();
  const workspace = {
    dialog: { kind: "discard", path: "notes.md", proceed },
    setDialog: vi.fn<(dialog: unknown) => void>(),
    save: vi.fn<() => Promise<boolean>>(save),
    root: "folder",
    folderName: "notes",
  } as unknown as Workspace;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(WorkspaceDialogs, { workspace })));
  return { proceed, workspace };
}
const saveButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
    (b) => b.textContent === "Save",
  )!;

const comment: DocComment = {
  id: "c1",
  anchor: { kind: "heading", slug: "goals" },
  text: "Keep this",
  created: 1,
  updated: 1,
  resolved: false,
};
const at = (path: string) => ({ kind: "workspace", root: "opfs", path }) as const;
const commentsAt = async (path: string) => (await openCommentStore()).load(sourceKey(at(path))!);
const sketchAt = (path: string) => loadSketch(sketchKey(documentKey(at(path)), "ab12"));
async function seed(path: string) {
  await writeText(await opfsRoot(), path, "# Plan\n");
  await (await openCommentStore()).save(sourceKey(at(path))!, [comment]);
  await saveSketch({
    key: sketchKey(documentKey(at(path)), "ab12"),
    elements: [],
    appState: {},
    files: {},
    savedAt: 1,
  });
}

describe("the unsaved-changes dialog (review finding 8)", () => {
  test("Save that fails does not go on: the other file would replace the only copy of the edits", async () => {
    const { proceed, workspace } = showDiscard(async () => false);
    await userEvent.click(saveButton());
    await vi.waitFor(() => expect(workspace.save).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(proceed).not.toHaveBeenCalled();
  });

  test("Save that works goes on with what the user asked for", async () => {
    const { proceed } = showDiscard(async () => true);
    await userEvent.click(saveButton());
    await vi.waitFor(() => expect(proceed).toHaveBeenCalledOnce());
  });

  test("save() reports a local file it could not write as not saved", async () => {
    const wired = await mount();
    act(() =>
      wired.current!.inputs.openDocument({
        markdown: "# Edited\n",
        source: { kind: "workspace", root: "folder", folder: "f1", path: "notes.md" },
      }),
    );
    // No folder permission: the write cannot happen, and the caller must hear so.
    let saved: boolean | null = null;
    await act(async () => {
      saved = await wired.current!.workspace.save();
    });
    expect(saved).toBe(false);
    expect(wired.current!.inputs.notice?.tone).toBe("error");
  });
});

describe("comments and sketches follow the file (review finding 13)", () => {
  test("renaming a file, then its folder, takes its comments and sketches along", async () => {
    const wired = await mount();
    await seed(`${dir}/plan.md`);
    const file: WorkspaceNode = { path: `${dir}/plan.md`, name: "plan.md", kind: "file" };
    expect(await act(() => wired.current!.workspace.renameEntry(file, "roadmap"))).toBeNull();
    expect(await commentsAt(`${dir}/roadmap.md`)).toEqual([comment]);
    expect(await sketchAt(`${dir}/roadmap.md`)).not.toBeNull();
    expect(await commentsAt(`${dir}/plan.md`)).toEqual([]);
    expect(await sketchAt(`${dir}/plan.md`)).toBeNull();

    const folder: WorkspaceNode = {
      path: dir,
      name: dir,
      kind: "directory",
      children: [{ path: `${dir}/roadmap.md`, name: "roadmap.md", kind: "file" }],
    };
    expect(
      await act(() => wired.current!.workspace.renameEntry(folder, `${dir}-moved`)),
    ).toBeNull();
    const moved = `${dir}-moved/roadmap.md`;
    expect(await commentsAt(moved)).toEqual([comment]);
    expect(await sketchAt(moved)).not.toBeNull();
    await (await opfsRoot()).removeEntry(`${dir}-moved`, { recursive: true });
  });

  test("deleting a file clears them, so a new file at that path starts clean", async () => {
    const wired = await mount();
    await seed(`${dir}/notes.md`);
    const folder: WorkspaceNode = {
      path: dir,
      name: dir,
      kind: "directory",
      children: [{ path: `${dir}/notes.md`, name: "notes.md", kind: "file" }],
    };
    await act(() => wired.current!.workspace.removeEntry(folder));
    expect(await commentsAt(`${dir}/notes.md`)).toEqual([]);
    expect(await sketchAt(`${dir}/notes.md`)).toBeNull();
  });
});

describe("the draft stays reachable (review finding 15)", () => {
  test("with a workspace file open, Files and the palette offer the draft, and it opens", async () => {
    // A plain visit reopens the workspace file ahead of the draft (decision
    // 66), so without this entry the draft could not be reached at all.
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    await writeText(await opfsRoot(), `${dir}/other.md`, "# Other\n");
    const wired = await mount();
    expect(wired.current!.inputs.doc).toEqual(PASTED);
    expect(document.querySelector(".docwalk-files-draft")).toBeNull();

    act(() =>
      wired.current!.inputs.openDocument({
        markdown: "# Other\n",
        source: { kind: "workspace", root: "opfs", path: `${dir}/other.md` },
      }),
    );
    expect(workspaceCommands(wired.current!.workspace).map((c) => c.id)).toContain("open-draft");
    const entry = await vi.waitFor(() => {
      const button = document.querySelector<HTMLElement>(".docwalk-files-draft");
      expect(button?.textContent).toBe("Open draft");
      return button!;
    });
    await userEvent.click(entry);
    await vi.waitFor(() => expect(wired.current!.inputs.doc).toEqual(PASTED));
    expect(document.querySelector(".docwalk-files-draft")).toBeNull();
    expect(workspaceCommands(wired.current!.workspace).map((c) => c.id)).not.toContain(
      "open-draft",
    );
  });
});

/** Two folders that both hold README.md, as two projects usually do; fa/README.md open. */
async function twoProjects() {
  await writeText(await disk("fa"), "README.md", "# Project A\n");
  await writeText(await disk("fb"), "README.md", "# Project B\n");
  pickNext("fa");
  const wired = await mount();
  await openInFolder(wired, "fa", "README.md");
  return wired;
}

describe("opening another local folder (review pass 2, finding 3)", () => {
  test("with unsaved edits it asks first, and Save writes them to the folder they came from", async () => {
    // The open file used to be pointed at fb/README.md: a false "changed on
    // disk" question, then Save overwrote project B's README with A's text.
    const wired = await twoProjects();
    act(() => wired.current!.inputs.edit("# Project A, edited\n"));
    pickNext("fb");
    await act(() => wired.current!.workspace.openFolder());
    expect(wired.current!.workspace.dialog?.kind).toBe("discard");
    expect(wired.current!.workspace.folderName).toBe("fa");

    await userEvent.click(alertButton("Save"));
    await vi.waitFor(() => expect(wired.current!.workspace.folderName).toBe("fb"));
    expect(await readDisk("fa", "README.md")).toBe("# Project A, edited\n");
    expect(await readDisk("fb", "README.md")).toBe("# Project B\n");
    // No file of the old folder stays open against the new one.
    expect(wired.current!.workspace.source).toBeNull();
  });

  test("Cancel keeps the folder and the edits; Discard closes the file, writing nothing", async () => {
    const wired = await twoProjects();
    act(() => wired.current!.inputs.edit("# Project A, edited\n"));
    pickNext("fb");
    await act(() => wired.current!.workspace.openFolder());
    await userEvent.click(alertButton("Cancel"));
    await vi.waitFor(() => expect(wired.current!.workspace.dialog).toBeNull());
    expect(wired.current!.workspace.folderName).toBe("fa");
    expect(wired.current!.inputs.doc?.markdown).toBe("# Project A, edited\n");

    await act(() => wired.current!.workspace.openFolder());
    await userEvent.click(alertButton("Discard changes"));
    await vi.waitFor(() => expect(wired.current!.workspace.folderName).toBe("fb"));
    expect(wired.current!.workspace.source).toBeNull();
    expect(await readDisk("fa", "README.md")).toBe("# Project A\n");
    expect(await readDisk("fb", "README.md")).toBe("# Project B\n");
  });

  test("without edits the file closes, and never turns into the other folder's file", async () => {
    // With no edits the disk poll used to swap B's README in under A's name.
    const wired = await twoProjects();
    pickNext("fb");
    await act(() => wired.current!.workspace.openFolder());
    expect(wired.current!.workspace.dialog).toBeNull();
    await vi.waitFor(() => expect(wired.current!.workspace.folderName).toBe("fb"));
    expect(wired.current!.workspace.source).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(wired.current!.inputs.doc?.markdown).not.toBe("# Project B\n");
  });

  test("picking the same folder again keeps its open file", async () => {
    const wired = await twoProjects();
    act(() => wired.current!.inputs.edit("# Project A, edited\n"));
    pickNext("fa");
    await act(() => wired.current!.workspace.openFolder());
    expect(wired.current!.workspace.dialog).toBeNull();
    expect(wired.current!.workspace.source?.path).toBe("README.md");
    expect(wired.current!.inputs.doc?.markdown).toBe("# Project A, edited\n");
  });
});

describe("comments and sketches of local folders (review pass 2, finding 4)", () => {
  test("README.md in two folders has two sets of comments, and each folder finds its own again", async () => {
    // Keyed by path alone, project A's private notes showed on project B's
    // README (and travelled in B's share links), and deleting or renaming
    // B's README dropped or moved A's comments.
    await writeText(await disk("fa"), "README.md", "# Project A\n");
    await writeText(await disk("fb"), "README.md", "# Project B\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "README.md");
    const a = wired.current!.workspace.source!;
    await (await openCommentStore()).save(sourceKey(a)!, [comment]);

    await openInFolder(wired, "fb", "README.md");
    const b = wired.current!.workspace.source!;
    expect(sourceKey(b)).not.toBe(sourceKey(a));
    expect(documentKey(b)).not.toBe(documentKey(a));
    const readme: WorkspaceNode = { path: "README.md", name: "README.md", kind: "file" };
    expect(await act(() => wired.current!.workspace.renameEntry(readme, "INDEX"))).toBeNull();
    expect(await (await openCommentStore()).load(sourceKey(a)!)).toEqual([comment]);

    // The identity is the folder, not the visit: picking A again finds A's comments.
    await openInFolder(wired, "fa", "README.md");
    expect(sourceKey(wired.current!.workspace.source!)).toBe(sourceKey(a));
  });
});

describe("a folder's id", () => {
  test("is one id even when start-up looks it up twice at once", async () => {
    // restore.ts and the workspace hook both ask at start-up; two ids for one
    // folder left the restored file unsaveable (its folder "not the open one").
    const [one, same] = [await disk("fa"), await disk("fa")];
    const [a, b] = await Promise.all([folderId(one), folderId(same)]);
    expect(a).toBe(b);
    expect(await folderId(await disk("fb"))).not.toBe(a);
  });
});

describe("a form that needs the unsaved-changes question (review pass 2, finding 5)", () => {
  test("New file over unsaved local edits asks Save or Discard, then opens the new file", async () => {
    // The form's own close wiped the question it had just raised: the file
    // was created, nothing opened and nothing was asked.
    await writeText(await disk("fa"), "a.md", "# File A\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "a.md");
    act(() => wired.current!.inputs.edit("# File A, edited\n"));
    act(() => wired.current!.workspace.setDialog({ kind: "new-file", dir: "" }));
    const field = await vi.waitFor(() =>
      document.querySelector<HTMLInputElement>("dialog input, [role=dialog] input")!,
    );
    await userEvent.clear(field);
    await userEvent.type(field, "second{Enter}");
    await vi.waitFor(() => expect(wired.current!.workspace.dialog?.kind).toBe("discard"));
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await userEvent.click(alertButton("Discard changes"));
    await vi.waitFor(() => expect(wired.current!.workspace.source?.path).toBe("second.md"));
  });
});

describe("New file takes a full name (review pass 2, finding 11)", () => {
  test("typing notes.md over the default name makes notes.md, not notes.md.md", async () => {
    // The hint talks about extensions, so people type one; only "untitled"
    // used to be selected, and the default ".md" stayed after what they typed.
    const wired = await mount();
    act(() => wired.current!.workspace.setDialog({ kind: "new-file", dir }));
    const field = await vi.waitFor(() =>
      document.querySelector<HTMLInputElement>("[role=dialog] input")!,
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.keyboard(`notes.md{Enter}`);
    await vi.waitFor(() => expect(wired.current!.workspace.source?.path).toBe(`${dir}/notes.md`));
  });
});

const row = (path: string) =>
  document.querySelector<HTMLElement>(`[role="row"][data-key="${CSS.escape(path)}"]`);
const rowMenu = (name: string) =>
  document.querySelector<HTMLElement>(`button[aria-label="Actions for ${name}"]`)!;

describe("focus after a dialog changes the tree (review pass 2, finding 10)", () => {
  test("creating a project from the empty folder's button focuses the new file's row", async () => {
    // The button that opened the dialog is replaced by the tree, so focus fell
    // to <body> and keyboard users had to Tab through the header again (WCAG 2.4.3).
    await disk("empty");
    pickNext("empty");
    const wired = await mount();
    pickNext("empty");
    await act(() => wired.current!.workspace.openFolder());
    const start = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLElement>(".docwalk-files-note button")].find(
        (b) => b.textContent === "New project",
      );
      expect(button).toBeDefined();
      return button!;
    });
    start.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] input")).not.toBeNull());
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(wired.current!.workspace.source).not.toBeNull());
    const opened = wired.current!.workspace.source!.path;
    await vi.waitFor(() => expect(document.activeElement).toBe(row(opened)));
  });

  test("renaming focuses the renamed row; deleting focuses its neighbour", async () => {
    await writeText(await opfsRoot(), `${dir}/a.md`, "# A\n");
    await writeText(await opfsRoot(), `${dir}/notes.md`, "# Notes\n");
    await writeText(await opfsRoot(), `${dir}/z.md`, "# Z\n");
    const wired = await mount();
    act(() => wired.current!.workspace.setExpanded(new Set([dir])));
    await vi.waitFor(() => expect(row(`${dir}/notes.md`)).not.toBeNull());

    await userEvent.click(rowMenu("notes.md"));
    await userEvent.click(
      await vi.waitFor(() =>
        document.querySelector<HTMLElement>('[role="menuitem"][data-key="rename"]')!,
      ),
    );
    await vi.waitFor(() => expect(document.querySelector("[role=dialog] input")).not.toBeNull());
    await userEvent.keyboard("ideas{Enter}");
    await vi.waitFor(() => expect(row(`${dir}/ideas.md`)).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(row(`${dir}/ideas.md`)));

    await userEvent.click(rowMenu("ideas.md"));
    await userEvent.click(
      await vi.waitFor(() =>
        document.querySelector<HTMLElement>('[role="menuitem"][data-key="delete"]')!,
      ),
    );
    await userEvent.click(await vi.waitFor(() => alertButton("Delete")));
    await vi.waitFor(() => expect(row(`${dir}/ideas.md`)).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(row(`${dir}/z.md`)));
  });
});

describe("the last keystrokes of a browser-workspace file (review pass 2, finding 7)", () => {
  test("reach OPFS when another kind of document replaces the file inside the autosave delay", async () => {
    // The pending save lost its timer and waited for pagehide, whose async
    // write a closing tab does not wait for.
    await writeText(await opfsRoot(), `${dir}/plan.md`, "# Plan\n");
    const wired = await mount();
    act(() => wired.current!.workspace.setExpanded(new Set([dir])));
    act(() => wired.current!.workspace.openFile(`${dir}/plan.md`));
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# Plan, last words\n"));
    act(() =>
      wired.current!.inputs.apply({
        ok: true,
        doc: { markdown: "# Dropped\n", source: { kind: "file", name: "dropped.md" } },
      }),
    );
    await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_MS + 400)));
    const file = await (await opfsRoot()).getDirectoryHandle(dir);
    expect(await (await (await file.getFileHandle("plan.md")).getFile()).text()).toBe(
      "# Plan, last words\n",
    );
  });
});

describe("a folder file waiting for Reconnect (review pass 2, finding 8)", () => {
  test("stays the file a plain visit reopens until the user opens something else", async () => {
    // It was forgotten as soon as the fallback document showed, so a second
    // reload before "Reconnect" lost it.
    const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
    const query = Object.getOwnPropertyDescriptor(proto, "queryPermission");
    Object.defineProperty(proto, "queryPermission", {
      configurable: true,
      value: async () => "prompt",
    });
    try {
      await writeText(await disk("fa"), "README.md", "# Project A\n");
      await saveFolderHandle(await disk("fa"));
      rememberFile({ root: "folder", path: "README.md" });
      localStorage.setItem("docwalk.workspace.root", JSON.stringify("opfs"));
      pickNext("fa");
      const wired = await mount();
      await vi.waitFor(() => expect(wired.current!.workspace.folderPermission).toBe("prompt"));
      await vi.waitFor(() => expect(wired.current!.inputs.doc).not.toBeNull());
      await act(() => new Promise((r) => setTimeout(r, 100)));
      expect(rememberedFile()).toEqual({ root: "folder", path: "README.md" });

      // Opening a file is the user moving on: that file is remembered instead.
      await writeText(await opfsRoot(), `${dir}/other.md`, "# Other\n");
      act(() => wired.current!.workspace.setExpanded(new Set([dir])));
      await vi.waitFor(() =>
        expect(wired.current!.workspace.listing?.nodes.map((n) => n.path)).toContain(dir),
      );
      act(() => wired.current!.workspace.openFile(`${dir}/other.md`));
      await vi.waitFor(() =>
        expect(rememberedFile()).toEqual({ root: "opfs", path: `${dir}/other.md` }),
      );
    } finally {
      if (query) Object.defineProperty(proto, "queryPermission", query);
      else delete proto["queryPermission"];
    }
  });
});

/**
 * A FileSystemObserver whose change notices the test sends, so a notice can
 * land exactly while a check of the disk is running. It also turns polling
 * off, as a real observer does.
 */
function fakeObserver() {
  const g = globalThis as { FileSystemObserver?: unknown };
  const real = g.FileSystemObserver;
  const live = new Set<(records: unknown[]) => void>();
  g.FileSystemObserver = class {
    #callback: (records: unknown[]) => void;
    constructor(callback: (records: unknown[]) => void) {
      this.#callback = callback;
    }
    async observe() {
      live.add(this.#callback);
    }
    disconnect() {
      live.delete(this.#callback);
    }
  };
  return {
    notify: () => act(() => [...live].forEach((callback) => callback([]))),
    restore: () => {
      if (real === undefined) delete g.FileSystemObserver;
      else g.FileSystemObserver = real;
    },
  };
}

describe("an external change to an open local file (review pass 3, findings 5 and 7)", () => {
  let observer: ReturnType<typeof fakeObserver>;
  beforeEach(() => {
    observer = fakeObserver();
  });
  afterEach(() => observer.restore());

  test("a change notice that arrives while a check is reading the disk is not lost", async () => {
    // With FileSystemObserver nothing polls, so a dropped notice stayed lost:
    // an editor's temp-file-plus-rename sends two, and the second one landed
    // while the first check was still reading the old text.
    await writeText(await disk("fa"), "notes.md", "# V0\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "notes.md");
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));

    const arrayBuffer = Blob.prototype.arrayBuffer;
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let reading = false;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      reading = true;
      await gate;
      return arrayBuffer.call(this);
    };
    try {
      observer.notify();
      await vi.waitFor(() => expect(reading).toBe(true));
      await writeText(await disk("fa"), "notes.md", "# V1\n");
      observer.notify();
    } finally {
      Blob.prototype.arrayBuffer = arrayBuffer;
      release();
    }
    await vi.waitFor(() => expect(wired.current!.inputs.doc?.markdown).toBe("# V1\n"));
  });

  test("Save over an external change no check has seen asks, instead of overwriting it", async () => {
    // save() wrote without looking, so the promise of decision 58 (a disk
    // change over unsaved edits asks which to keep) rested on the watcher
    // having seen the change first.
    await writeText(await disk("fa"), "notes.md", "# V0\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "notes.md");
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# V0, my edits\n"));
    await writeText(await disk("fa"), "notes.md", "# V1 from an agent\n");

    let saved: boolean | null = null;
    await act(async () => {
      saved = await wired.current!.workspace.save();
    });
    expect(saved).toBe(false);
    expect(await readDisk("fa", "notes.md")).toBe("# V1 from an agent\n");
    expect(wired.current!.workspace.dialog?.kind).toBe("conflict");

    // "Keep my edits" is the user's answer; the next Save then writes them.
    await userEvent.click(alertButton("Keep my edits"));
    await act(async () => {
      saved = await wired.current!.workspace.save();
    });
    expect(saved).toBe(true);
    expect(await readDisk("fa", "notes.md")).toBe("# V0, my edits\n");
  });

  test("a disk change does not replace the Save-or-discard question, and the file the user clicked opens", async () => {
    await writeText(await disk("fa"), "a.md", "# File A\n");
    await writeText(await disk("fa"), "b.md", "# File B\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "a.md");
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# File A, edited\n"));
    act(() => wired.current!.workspace.openFile("b.md"));
    expect(wired.current!.workspace.dialog?.kind).toBe("discard");

    await writeText(await disk("fa"), "a.md", "# File A from an agent\n");
    observer.notify();
    await act(() => new Promise((r) => setTimeout(r, 200)));
    // The conflict used to overwrite this dialog and drop its pending action.
    expect(wired.current!.workspace.dialog?.kind).toBe("discard");
    await userEvent.click(alertButton("Discard changes"));
    await vi.waitFor(() => expect(wired.current!.workspace.source?.path).toBe("b.md"));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(wired.current!.workspace.dialog).toBeNull();
  });

  test("a disk change seen while a dialog was open is asked about once the user cancels it", async () => {
    await writeText(await disk("fa"), "a.md", "# File A\n");
    await writeText(await disk("fa"), "b.md", "# File B\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "a.md");
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# File A, edited\n"));
    act(() => wired.current!.workspace.openFile("b.md"));
    await writeText(await disk("fa"), "a.md", "# File A from an agent\n");
    observer.notify();
    await act(() => new Promise((r) => setTimeout(r, 200)));

    await userEvent.click(alertButton("Cancel"));
    await vi.waitFor(() => expect(wired.current!.workspace.dialog?.kind).toBe("conflict"));
    expect(wired.current!.workspace.source?.path).toBe("a.md");
  });
});

const opfsText = async (path: string) => {
  try {
    const parts = path.split("/");
    const name = parts.pop()!;
    let at = await opfsRoot();
    for (const part of parts) at = await at.getDirectoryHandle(part);
    return await (await (await at.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
};

describe("the browser workspace in two tabs (decision 90)", () => {
  async function bothOpen() {
    const path = `${dir}/plan.md`;
    await writeText(await opfsRoot(), path, "# Plan\n");
    const a = await mount();
    const b = await mountTab();
    for (const tab of [a, b]) {
      act(() => tab.current!.workspace.openFile(path));
      await vi.waitFor(() => expect(tab.current!.workspace.source?.path).toBe(path));
      await vi.waitFor(() => expect(tab.current!.workspace.saveState).toBe("saved"));
    }
    return { a, b, path };
  }

  test("an edit in one tab reaches the other, which had no edits of its own", async () => {
    // OPFS edits in another tab were not watched: this tab kept showing the old text.
    const { a, b } = await bothOpen();
    act(() => b.current!.inputs.edit("# Plan, from tab B\n"));
    await vi.waitFor(() => expect(a.current!.inputs.doc?.markdown).toBe("# Plan, from tab B\n"));
  });

  test("a new file made in one tab shows in the other's tree without a focus event", async () => {
    const a = await mount();
    const b = await mountTab();
    expect(await act(() => b.current!.workspace.newFile(dir, "fresh"))).toBeNull();
    await vi.waitFor(() =>
      expect(JSON.stringify(a.current!.workspace.listing?.nodes)).toContain(`${dir}/fresh.md`),
    );
  });

  test("two tabs that both edited ask instead of letting the slower one overwrite the other", async () => {
    const { a, b, path } = await bothOpen();
    act(() => a.current!.inputs.edit("# From tab A\n"));
    act(() => b.current!.inputs.edit("# From tab B\n"));
    const [winner, loser] = await vi.waitFor(() => {
      const asking = [a, b].map((tab) => tab.current!.workspace.dialog?.kind === "conflict");
      expect(asking.filter(Boolean)).toHaveLength(1);
      return asking[0] ? [b, a] : [a, b];
    });
    const winning = winner!.current!.inputs.doc!.markdown;
    const losing = loser!.current!.inputs.doc!.markdown;
    // The text that reached OPFS first is still there while the question is open.
    expect(await opfsText(path)).toBe(winning);

    await userEvent.click(alertButton("Keep my edits"));
    await vi.waitFor(async () => expect(await opfsText(path)).toBe(losing));
  });

  test("a file deleted in another tab is not created again by autosave, and Save writes it back", async () => {
    const { a, b, path } = await bothOpen();
    const node: WorkspaceNode = { path, name: "plan.md", kind: "file" };
    await act(() => b.current!.workspace.removeEntry(node));
    await vi.waitFor(() => expect(a.current!.workspace.saveState).toBe("missing"));

    act(() => a.current!.inputs.edit("# Kept typing\n"));
    await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_MS + 400)));
    expect(await kindAt(await opfsRoot(), path)).toBeNull();

    let saved: boolean | null = null;
    await act(async () => {
      saved = await a.current!.workspace.save();
    });
    expect(saved).toBe(true);
    expect(await opfsText(path)).toBe("# Kept typing\n");
  });

  test("edits held back because the file is gone are asked about before another file opens", async () => {
    const { a, b, path } = await bothOpen();
    await writeText(await opfsRoot(), `${dir}/other.md`, "# Other\n");
    await act(() => b.current!.workspace.removeEntry({ path, name: "plan.md", kind: "file" }));
    await vi.waitFor(() => expect(a.current!.workspace.saveState).toBe("missing"));
    act(() => a.current!.inputs.edit("# Only copy\n"));
    await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_MS + 400)));

    act(() => a.current!.workspace.openFile(`${dir}/other.md`));
    expect(a.current!.workspace.dialog?.kind).toBe("discard");
    expect(a.current!.workspace.source?.path).toBe(path);
  });
});

describe("a local folder's tree without FileSystemObserver (decision 91)", () => {
  /** Runs `body` with no FileSystemObserver, as in a Chromium that predates it. */
  async function withoutObserver(body: () => Promise<void>) {
    const g = globalThis as { FileSystemObserver?: unknown };
    const real = g.FileSystemObserver;
    delete g.FileSystemObserver;
    try {
      await body();
    } finally {
      if (real !== undefined) g.FileSystemObserver = real;
    }
  }
  const listed = (wired: { current: Wired | null }) =>
    wired.current!.workspace.listing?.nodes.map((n) => n.path);

  test("a file made on disk shows up within seconds while the window keeps focus", async () => {
    await withoutObserver(async () => {
      await writeText(await disk("fa"), "a.md", "# A\n");
      pickNext("fa");
      const wired = await mount();
      await openInFolder(wired, "fa", "a.md");
      await writeText(await disk("fa"), "later.md", "# Later\n");
      await vi.waitFor(() => expect(listed(wired)).toContain("later.md"), { timeout: 9000 });
    });
  });

  /** Makes listing the folder named `fa` fail with `name`, until the returned restore runs. */
  function breakListing(name: string) {
    const proto = FileSystemDirectoryHandle.prototype as unknown as {
      entries: () => AsyncIterable<unknown>;
    };
    const real = proto.entries;
    proto.entries = function (this: FileSystemDirectoryHandle) {
      if (this.name !== "fa") return real.call(this);
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new DOMException("", name)),
        }),
      };
    };
    return () => {
      proto.entries = real;
    };
  }

  test("a listing that fails keeps the tree on screen instead of showing an empty folder", async () => {
    // It showed "No Markdown files" and invited writes into a folder that was not there.
    await writeText(await disk("fa"), "a.md", "# A\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "a.md");
    const restore = breakListing("UnknownError");
    try {
      globalThis.dispatchEvent(new Event("focus"));
      await act(() => new Promise((r) => setTimeout(r, 300)));
      expect(listed(wired)).toEqual(["a.md"]);
    } finally {
      restore();
    }
  });

  test("a listing the browser refuses turns the folder back into Reconnect", async () => {
    await writeText(await disk("fa"), "a.md", "# A\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "a.md");
    const restore = breakListing("NotAllowedError");
    try {
      globalThis.dispatchEvent(new Event("focus"));
      await vi.waitFor(() => expect(wired.current!.workspace.folderPermission).toBe("prompt"));
    } finally {
      restore();
    }
  });
});

describe("keeping the browser workspace (decision 91)", () => {
  test("is asked for after the first save, not at start-up, and a refusal shows as a note", async () => {
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(false);
    vi.spyOn(navigator.storage, "persisted").mockResolvedValue(false);
    const path = `${dir}/plan.md`;
    await writeText(await opfsRoot(), path, "# Plan\n");
    const wired = await mount();
    act(() => wired.current!.workspace.openFile(path));
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    expect(persist).not.toHaveBeenCalled();

    act(() => wired.current!.inputs.edit("# Plan, saved\n"));
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    act(() => wired.current!.inputs.edit("# Plan, saved twice\n"));
    await vi.waitFor(async () => expect(await opfsText(path)).toBe("# Plan, saved twice\n"));
    expect(persist).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(wired.current!.workspace.persistent).toBe(false));
    await vi.waitFor(() =>
      expect(document.querySelector(".docwalk-files")?.textContent).toContain("may clear"),
    );
  });

  test("storage that is already persistent is not asked again and shows no note", async () => {
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
    vi.spyOn(navigator.storage, "persisted").mockResolvedValue(true);
    const path = `${dir}/plan.md`;
    await writeText(await opfsRoot(), path, "# Plan\n");
    const wired = await mount();
    act(() => wired.current!.workspace.openFile(path));
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# Plan, saved\n"));
    await vi.waitFor(async () => expect(await opfsText(path)).toBe("# Plan, saved\n"));
    expect(persist).not.toHaveBeenCalled();
    expect(wired.current!.workspace.persistent).toBe(true);
    expect(document.querySelector(".docwalk-files")?.textContent).not.toContain("may clear");
  });

  test("a full storage says how much is used", async () => {
    vi.spyOn(navigator.storage, "estimate").mockResolvedValue({
      usage: 50 * 1024 * 1024,
      quota: 60 * 1024 * 1024,
    });
    await writeText(await opfsRoot(), `${dir}/plan.md`, "# Plan\n");
    const wired = await mount();
    act(() => wired.current!.workspace.openFile(`${dir}/plan.md`));
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    vi.spyOn(FileSystemFileHandle.prototype, "createWritable").mockRejectedValue(
      new DOMException("", "QuotaExceededError"),
    );
    act(() => wired.current!.inputs.edit("# Plan, too big\n"));
    await vi.waitFor(() =>
      expect(wired.current!.inputs.notice?.message).toContain("50 MB of 60 MB"),
    );
  });
});

describe("a local file that cannot be read on disk (decision 93)", () => {
  test("Save does not write over it", async () => {
    // The check failed to read the file and counted that as "no change", then wrote over it.
    await writeText(await disk("fa"), "notes.md", "# V0\n");
    pickNext("fa");
    const wired = await mount();
    await openInFolder(wired, "fa", "notes.md");
    await vi.waitFor(() => expect(wired.current!.workspace.saveState).toBe("saved"));
    act(() => wired.current!.inputs.edit("# V0, my edits\n"));
    const binary = new Uint8Array([0xff, 0xfe, 0x80, 0x81]);
    await writeText(await disk("fa"), "notes.md", binary);

    let saved: boolean | null = null;
    await act(async () => {
      saved = await wired.current!.workspace.save();
    });
    expect(saved).toBe(false);
    const file = await (await (await disk("fa")).getFileHandle("notes.md")).getFile();
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...binary]);
    expect(wired.current!.inputs.notice?.tone).toBe("error");
    expect(wired.current!.workspace.saveState).toBe("error");
  });
});

describe("a workspace past the listing's 5000-entry cap (decisions 92, 93)", () => {
  let big = "";
  beforeAll(async () => {
    big = `ws-big-${crypto.randomUUID()}`;
    const folder = await (await opfsRoot()).getDirectoryHandle(big, { create: true });
    for (let i = 0; i <= MAX_LISTED_ENTRIES; i++) {
      await folder.getFileHandle(`n${String(i).padStart(4, "0")}.md`, { create: true });
    }
  }, 120_000);
  afterAll(async () => {
    await (await opfsRoot()).removeEntry(big, { recursive: true }).catch(() => undefined);
  });

  test("the zip export refuses a listing that was cut short, instead of leaving files out", async () => {
    const download = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:docwalk-test");
    const wired = await mount();
    expect(wired.current!.workspace.listing?.truncated).toBe(true);
    await act(() => wired.current!.workspace.exportZip());
    expect(download).not.toHaveBeenCalled();
    expect(wired.current!.inputs.notice?.tone).toBe("error");
    expect(wired.current!.inputs.notice?.message).toContain("too large to export");
  }, 60_000);

  test("deleting the folder drops the comments of a file the listing never reached", async () => {
    // Only the listed files were cleaned: a new file at that path inherited the old comments.
    const wired = await mount();
    const flatten = (nodes: WorkspaceNode[]): string[] =>
      nodes.flatMap((n) => (n.kind === "file" ? [n.path] : flatten(n.children ?? [])));
    const node = wired.current!.workspace.listing!.nodes.find((n) => n.path === big) ?? {
      path: big,
      name: big,
      kind: "directory" as const,
    };
    const reached = new Set(flatten([node]));
    const bigDir = await (await opfsRoot()).getDirectoryHandle(big);
    const names = await Array.fromAsync(bigDir.keys());
    const unreached = names.map((name) => `${big}/${name}`).find((p) => !reached.has(p))!;
    expect(unreached).toBeDefined();
    await (await openCommentStore()).save(sourceKey(at(unreached))!, [comment]);

    await act(() => wired.current!.workspace.removeEntry(node));
    expect(await commentsAt(unreached)).toEqual([]);
  }, 60_000);
});
