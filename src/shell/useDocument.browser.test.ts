import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DRAFT_DEBOUNCE_MS, releaseDraft, useDraftAutosave } from "../share/draft";
import { encodeDoc } from "../share/fragment";
import { DRAFT_STORAGE_KEY } from "../share/types";
import { writeText } from "../workspace/fs";
import { opfsRoot, rememberFile } from "../workspace/store";
import { DRAFT_KEPT, useDocument } from "./useDocument";

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
