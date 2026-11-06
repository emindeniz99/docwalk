import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DRAFT_DEBOUNCE_MS, releaseDraft, useDraftAutosave } from "../share/draft";
import { encodeDoc } from "../share/fragment";
import { DRAFT_STORAGE_KEY } from "../share/types";
import { writeText } from "../workspace/fs";
import { opfsRoot, rememberFile } from "../workspace/store";
import { DRAFT_KEPT, FILE_DRAFT_KEPT, useDocument } from "./useDocument";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Inputs = ReturnType<typeof useDocument>;

/** useDocument wired to the draft autosave the way App wires them. */
function Harness({ report }: { report: (inputs: Inputs) => void }) {
  const inputs = useDocument({ follow: false });
  useDraftAutosave(inputs.doc?.markdown ?? "", inputs.doc?.source ?? { kind: "sample" });
  report(inputs);
  return null;
}

let root: Root | null = null;
let original = "";

function mount() {
  const result: { current: Inputs | null } = { current: null };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness, { report: (r) => (result.current = r) })));
  return result;
}

/** Sets the URL the "page" was opened with, without adding a history entry. */
function openAt(search: string, hash: string) {
  const url = new URL(original);
  url.search = search;
  url.hash = hash;
  window.history.replaceState(null, "", url);
}

const PASTED = {
  markdown: "# My own draft\n\n## Precious\n\nOnly copy.\n",
  source: { kind: "paste" },
};
const SHARED = "# Shared\n\n## Alpha\n\nA.\n";
const stored = () => JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null") as unknown;
const pause = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  original = window.location.href;
  localStorage.clear();
  releaseDraft();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", original);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the saved draft and linked documents", () => {
  test("the draft opened at start is the user's own: editing it saves over it", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    expect(inputs.current!.doc).toEqual(PASTED);
    act(() => inputs.current!.edit("# My own draft, edited\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual({ markdown: "# My own draft, edited\n", source: { kind: "paste" } });
    expect(inputs.current!.notice).toBeNull();
  });

  test("editing a #doc= share link keeps the saved pasted draft, and offers to replace it", async () => {
    // The pasted draft exists nowhere else; a typo fixed in a colleague's link
    // used to overwrite it 800 ms later with no warning.
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    openAt("", `#doc=${await encodeDoc(SHARED)}`);
    const inputs = mount();
    await vi.waitFor(() => expect(inputs.current!.doc?.source.kind).toBe("fragment"));

    act(() => inputs.current!.edit("# Shared, fixed\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual(PASTED);
    expect(inputs.current!.doc?.markdown).toBe("# Shared, fixed\n");
    expect(inputs.current!.notice?.message).toBe(DRAFT_KEPT());

    // Replacing is the user's explicit choice; from then on edits save.
    act(() => inputs.current!.notice!.action!.run());
    expect(stored()).toEqual({ markdown: "# Shared, fixed\n", source: { kind: "paste" } });
    expect(inputs.current!.notice).toBeNull();
    act(() => inputs.current!.edit("# Shared, fixed twice\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual({ markdown: "# Shared, fixed twice\n", source: { kind: "paste" } });
  });

  test("in a browser with no draft, edits of a share link are saved as before", async () => {
    openAt("", `#doc=${await encodeDoc(SHARED)}`);
    const inputs = mount();
    await vi.waitFor(() => expect(inputs.current!.doc?.source.kind).toBe("fragment"));
    act(() => inputs.current!.edit("# Shared, fixed\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual({ markdown: "# Shared, fixed\n", source: { kind: "paste" } });
    expect(inputs.current!.notice).toBeNull();
  });
});

describe("loading", () => {
  test("a share link pasted into the open tab's address bar loads its document", async () => {
    // Only the hash changes, so the browser does not reload the page; the old
    // document stayed on screen while the address bar named the shared one.
    openAt("", "");
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    expect(inputs.current!.doc).toEqual(PASTED);
    window.location.hash = `#doc=${await encodeDoc(SHARED)}`;
    await vi.waitFor(() =>
      expect(inputs.current!.doc).toEqual({ markdown: SHARED, source: { kind: "fragment" } }),
    );
  });

  test("a slow ?src= load from page start does not replace a file the user opened meanwhile", async () => {
    let respond: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (respond = resolve)),
    );
    openAt(`?src=${encodeURIComponent("https://raw.githubusercontent.com/a/b/main/c.md")}`, "");
    const inputs = mount();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(inputs.current!.doc).toBeNull();

    const file = {
      markdown: "# Local file\n",
      source: { kind: "file", name: "local.md" },
    } as const;
    act(() => inputs.current!.apply({ ok: true, doc: file }));
    respond!(new Response("# Remote doc\n", { headers: { "content-type": "text/plain" } }));
    await pause(100);
    expect(inputs.current!.doc).toEqual(file);
  });
});

describe("workspace files (decision 57)", () => {
  test("a plain visit reopens the workspace file shown last, ahead of the saved draft", async () => {
    await writeText(await opfsRoot(), "restore-test/plan.md", "# From the workspace\n");
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    rememberFile({ root: "opfs", path: "restore-test/plan.md" });
    openAt("", "");
    const inputs = mount();
    // Nothing is shown until the file is read: showing the draft first would flash the wrong document.
    expect(inputs.current!.doc).toBeNull();
    await vi.waitFor(() =>
      expect(inputs.current!.doc).toEqual({
        markdown: "# From the workspace\n",
        source: { kind: "workspace", root: "opfs", path: "restore-test/plan.md" },
      }),
    );
    await (await opfsRoot()).removeEntry("restore-test", { recursive: true });
  });

  test("a remembered file that is gone falls back to the draft, as before", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    rememberFile({ root: "opfs", path: "missing/nowhere.md" });
    openAt("", "");
    const inputs = mount();
    await vi.waitFor(() => expect(inputs.current!.doc).toEqual(PASTED));
  });

  test("editing a workspace file keeps its source and never touches the draft slot", async () => {
    // The workspace saves the file itself; writing the draft too would replace a pasted document.
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    const source = { kind: "workspace", root: "opfs", path: "a.md" } as const;
    act(() => inputs.current!.openDocument({ markdown: "# A\n", source }));
    act(() => inputs.current!.edit("# A, edited\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(inputs.current!.doc).toEqual({ markdown: "# A, edited\n", source });
    expect(stored()).toEqual(PASTED);
    expect(inputs.current!.notice).toBeNull();
  });
});

describe("the draft is never lost to another document (review findings 12, 14, 15)", () => {
  const FILE = { markdown: "# Some file\n", source: { kind: "file", name: "some.md" } } as const;
  const WORKSPACE = { kind: "workspace", root: "opfs", path: "a.md" } as const;

  test("opening a file keeps a pasted draft: the paste exists nowhere else, the file is on disk", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    expect(inputs.current!.doc).toEqual(PASTED);
    act(() => inputs.current!.apply({ ok: true, doc: FILE }));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    // The file used to be autosaved over the paste 800 ms later, with no word.
    expect(stored()).toEqual(PASTED);
    expect(inputs.current!.doc).toEqual(FILE);
    expect(inputs.current!.notice?.message).toBe(FILE_DRAFT_KEPT());

    // Replacing stays possible, as the user's explicit choice.
    act(() => inputs.current!.notice!.action!.run());
    expect(stored()).toEqual(FILE);
  });

  test("opening a file still becomes the draft when the slot is empty or holds another file", async () => {
    const inputs = mount();
    act(() => inputs.current!.apply({ ok: true, doc: FILE }));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual(FILE);
    const other = { markdown: "# Other\n", source: { kind: "file", name: "other.md" } } as const;
    act(() => inputs.current!.apply({ ok: true, doc: other }));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    // The earlier file is on disk, so nothing the user typed is lost.
    expect(stored()).toEqual(other);
    expect(inputs.current!.notice).toBeNull();
  });

  test("the last keystrokes before opening a workspace file reach the draft", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    act(() => inputs.current!.edit("# My own draft, last words\n"));
    // Well inside the debounce: the pending save used to be dropped with the document.
    act(() => inputs.current!.openDocument({ markdown: "# A\n", source: WORKSPACE }));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual({
      markdown: "# My own draft, last words\n",
      source: { kind: "paste" },
    });
  });

  test("with a workspace file open the draft stays reachable, and reopening it shows it", async () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    const inputs = mount();
    expect(inputs.current!.draftAvailable).toBe(false);
    act(() => inputs.current!.openDocument({ markdown: "# A\n", source: WORKSPACE }));
    expect(inputs.current!.draftAvailable).toBe(true);
    act(() => inputs.current!.reopenDraft());
    expect(inputs.current!.doc).toEqual(PASTED);
    expect(inputs.current!.draftAvailable).toBe(false);
    // It is the draft again: edits save over it.
    act(() => inputs.current!.edit("# My own draft, back\n"));
    await pause(DRAFT_DEBOUNCE_MS + 200);
    expect(stored()).toEqual({ markdown: "# My own draft, back\n", source: { kind: "paste" } });
  });
});

describe("replacing the document (review findings 9, 11)", () => {
  test("a share link pasted into the address bar asks the workspace guard before replacing", async () => {
    // Unsaved local-folder edits would otherwise vanish: a hash change fires no beforeunload.
    openAt("", "");
    const inputs = mount();
    const asked: (() => void)[] = [];
    act(() => inputs.current!.setReplaceGuard((proceed) => asked.push(proceed)));
    const before = inputs.current!.doc;
    window.location.hash = `#doc=${await encodeDoc(SHARED)}`;
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await pause(50);
    expect(inputs.current!.doc).toBe(before);
    act(() => asked[0]!());
    await vi.waitFor(() =>
      expect(inputs.current!.doc).toEqual({ markdown: SHARED, source: { kind: "fragment" } }),
    );
  });

  test("docId changes when another document is shown, never on an edit", () => {
    // The editor starts a fresh undo history on a new docId; an edit must keep it.
    const inputs = mount();
    const first = inputs.current!.docId;
    act(() => inputs.current!.edit("# Typed\n"));
    expect(inputs.current!.docId).toBe(first);
    act(() =>
      inputs.current!.openDocument({
        markdown: "# B\n",
        source: { kind: "workspace", root: "opfs", path: "b.md" },
      }),
    );
    expect(inputs.current!.docId).not.toBe(first);
  });
});

describe("the address bar follows the open document (review pass 2, finding 6)", () => {
  const SRC = `?src=${encodeURIComponent("https://raw.githubusercontent.com/a/b/main/c.md")}&level=2`;
  const linked = async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# From a link\n", { headers: { "content-type": "text/plain" } }),
    );
    openAt(SRC, "#from-a-link/1");
    const inputs = mount();
    await vi.waitFor(() => expect(inputs.current!.doc?.source.kind).toBe("url"));
    return inputs;
  };

  test("opening a workspace file drops ?src=, so a reload reopens the file, not the link", async () => {
    // Start-up puts a link before the remembered workspace file (decision 66):
    // with ?src= left in place, every reload went back to the shared document.
    const inputs = await linked();
    act(() =>
      inputs.current!.openDocument({
        markdown: "# Kept\n",
        source: { kind: "workspace", root: "opfs", path: "kept/README.md" },
      }),
    );
    // The viewer's own settings stay; only the link goes.
    expect(location.search).toBe("?level=2");
    expect(location.hash).toBe("#from-a-link/1");
  });

  test("opening a local file or the draft drops a #doc= share link", async () => {
    // Under #doc= the hash is reserved, so the file's slide address was never written either.
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(PASTED));
    openAt("", `#doc=${await encodeDoc(SHARED)}`);
    const inputs = mount();
    await vi.waitFor(() => expect(inputs.current!.doc?.source.kind).toBe("fragment"));
    act(() => inputs.current!.reopenDraft());
    expect(inputs.current!.doc).toEqual(PASTED);
    expect(location.hash).toBe("");

    openAt("", `#doc=${await encodeDoc(SHARED)}`);
    act(() =>
      inputs.current!.apply({
        ok: true,
        doc: { markdown: "# Some file\n", source: { kind: "file", name: "some.md" } },
      }),
    );
    expect(location.hash).toBe("");
  });

  test("a pasted share link the user then declines to load leaves the address as it was", async () => {
    // Cancelling the unsaved-changes question kept the old document on screen
    // under the new link, which a reload would then open.
    openAt("?level=2", "#intro/1");
    const inputs = mount();
    const asked: (() => void)[] = [];
    act(() => inputs.current!.setReplaceGuard((proceed) => asked.push(proceed)));
    const link = `#doc=${await encodeDoc(SHARED)}`;
    window.location.hash = link;
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(location.hash).toBe("#intro/1");
    // Agreeing later loads it and puts the link back in the address bar.
    act(() => asked[0]!());
    expect(location.hash).toBe(link);
    await vi.waitFor(() => expect(inputs.current!.doc?.source.kind).toBe("fragment"));
  });
});
