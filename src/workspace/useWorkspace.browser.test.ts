import { act, createElement as h, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
import { writeText } from "./fs";
import { opfsRoot } from "./store";
import type { WorkspaceNode } from "./types";
import { useWorkspace, type Workspace } from "./useWorkspace";
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

const PASTED = { markdown: "# My own draft\n\nOnly copy.\n", source: { kind: "paste" } };

beforeEach(() => {
  localStorage.clear();
  releaseDraft();
  dir = `ws-test-${crypto.randomUUID()}`;
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  await (await opfsRoot()).removeEntry(dir, { recursive: true }).catch(() => undefined);
});

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
        source: { kind: "workspace", root: "folder", path: "notes.md" },
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
