import { act, createElement as h, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { AnchorIndex } from "./anchors";
import { CommentsPanel } from "./CommentsPanel";
import type { DocComment } from "./types";
import type { CommentNotice, CommentsApi } from "./useComments";

/**
 * Decision 135, the comments panel and the keyboard. Escape closes the side
 * panel only while focus is inside it: a button that unmounts under focus
 * drops focus to <body>, and the keyboard user can no longer close the panel
 * or find their place. And text the user typed is theirs: closing the panel
 * to look at the slide must not throw away a half-written comment or edit.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const index: AnchorIndex = {
  headings: [{ slug: "goals", title: "Goals", depth: 2, sectionId: "goals" }],
  bySlug: new Map([["goals", { slug: "goals", title: "Goals", depth: 2, sectionId: "goals" }]]),
  diagrams: [],
};

const first: DocComment = {
  id: "first",
  anchor: { kind: "heading", slug: "goals" },
  text: "Why not a queue?",
  created: 1,
  updated: 1,
  resolved: false,
};

/** What the test drives from outside the panel: opening it, and switching the document. */
let control: { setOpen: (open: boolean) => void; setKey: (key: string | null) => void } | null =
  null;

function Harness({ sheet, notice }: { sheet: boolean; notice?: CommentNotice }) {
  const [comments, setComments] = useState<DocComment[]>([first]);
  const [open, setOpen] = useState(true);
  const [key, setKey] = useState<string | null>("sha256:one");
  useEffect(() => {
    control = { setOpen, setKey };
  }, []);
  // Like useComments: every change moves `updated` on, which is how a merge picks the latest copy.
  const api: CommentsApi = {
    comments,
    deleted: [],
    ready: key !== null,
    key,
    legacyKey: null,
    unidentified: false,
    persistent: true,
    unreadable: false,
    author: "",
    setAuthor: () => {},
    markEdit: () => {},
    add: (anchor, text) => {
      setComments((list) => [
        ...list,
        { id: `c${list.length}`, anchor, text, created: 2, updated: 2, resolved: false },
      ]);
      return true;
    },
    update: (id, text) =>
      setComments((list) =>
        list.map((c) => (c.id === id ? { ...c, text, updated: c.updated + 1 } : c)),
      ),
    remove: (id) => setComments((list) => list.filter((c) => c.id !== id)),
    setResolved: (id, resolved) =>
      setComments((list) =>
        list.map((c) => (c.id === id ? { ...c, resolved, updated: c.updated + 1 } : c)),
      ),
    importFile: async () => notice ?? { message: "", tone: "info" },
  };
  return h(CommentsPanel, {
    isOpen: open,
    onClose: () => setOpen(false),
    sheet,
    api,
    index,
    nodes: new Map(),
    defaultAnchor: { kind: "heading", slug: "goals" },
    focusAnchor: null,
    onGoTo: () => {},
    sidecarName: "doc.comments.json",
  });
}

let root: Root | null = null;
function mount(props: { sheet: boolean; notice?: CommentNotice }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness, props)));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  control = null;
  document.body.replaceChildren();
});

const panelSelector = (sheet: boolean) => (sheet ? '[role="dialog"]' : ".docwalk-comments-side");
const panel = (sheet = false) => document.querySelector<HTMLElement>(panelSelector(sheet));
const item = () => document.querySelector<HTMLElement>(".docwalk-comments-item")!;
const labelled = (label: string, within: ParentNode = document) =>
  within.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
const button = (text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text)!;
const newText = () =>
  document.querySelector<HTMLTextAreaElement>(".docwalk-comments-add .docwalk-comments-textarea");
const editText = () =>
  document.querySelector<HTMLTextAreaElement>(".docwalk-comments-edit .docwalk-comments-textarea");

/** Escape from where focus now is closes the panel: focus was still inside it. */
async function escapeCloses(sheet = false) {
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => panel(sheet)).toBeNull();
}

describe("focus stays in the side panel when the focused control goes away", () => {
  test("Save of an edit: focus goes to the comment's Edit button", async () => {
    mount({ sheet: false });
    await userEvent.click(labelled("Edit comment"));
    await userEvent.keyboard("{End} Or a log?");
    await userEvent.click(button("Save"));
    await expect.poll(() => item().textContent).toContain("Why not a queue? Or a log?");
    expect(document.activeElement).toBe(labelled("Edit comment", item()));
    await escapeCloses();
  });

  test("Cancel of an edit: focus goes to the comment's Edit button", async () => {
    mount({ sheet: false });
    await userEvent.click(labelled("Edit comment"));
    await userEvent.click(button("Cancel"));
    expect(editText()).toBeNull();
    expect(document.activeElement).toBe(labelled("Edit comment", item()));
    await escapeCloses();
  });

  test("Cancel of a delete: focus goes back to the comment's Delete button", async () => {
    mount({ sheet: false });
    await userEvent.click(labelled("Delete comment"));
    await userEvent.click(button("Cancel", item()));
    expect(document.activeElement).toBe(labelled("Delete comment", item()));
    await escapeCloses();
  });

  test('"Delete N comments": the button goes once pressed, focus goes to the panel title', async () => {
    mount({
      sheet: false,
      notice: {
        message: "The file deletes 2 comments.",
        tone: "info",
        action: {
          label: "Delete 2 comments",
          run: () => ({ message: "Deleted 2 comments.", tone: "info" }),
        },
      },
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = new DataTransfer();
    files.items.add(new File(["{}"], "doc.comments.json", { type: "application/json" }));
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => button("Delete 2 comments")).toBeDefined();
    await userEvent.click(button("Delete 2 comments"));
    await expect.poll(() => button("Delete 2 comments")).toBeUndefined();
    expect(document.activeElement).toBe(document.querySelector(".docwalk-comments-title"));
    await escapeCloses();
  });
});

const close = () => userEvent.click(labelled("Close comments"));

describe.each([
  ["side panel", false],
  ["phone sheet", true],
])("typed text survives closing the panel (%s)", (_name, sheet) => {
  const reopen = async () => {
    act(() => control!.setOpen(true));
    await expect.poll(() => panel(sheet)).not.toBeNull();
  };

  test("a new comment's text is still there after close and reopen", async () => {
    mount({ sheet });
    await userEvent.click(newText()!);
    await userEvent.keyboard("Half a thought");
    await close();
    await expect.poll(() => panel(sheet)).toBeNull();
    await reopen();
    expect(newText()!.value).toBe("Half a thought");
  });

  test("an edit is still open, with its text, after close and reopen", async () => {
    mount({ sheet });
    await userEvent.click(labelled("Edit comment"));
    await userEvent.keyboard("{End} Or a log?");
    await close();
    await expect.poll(() => panel(sheet)).toBeNull();
    await reopen();
    expect(editText()?.value).toBe("Why not a queue? Or a log?");
  });

  test("Escape inside an edit cancels the edit; a second Escape closes the panel", async () => {
    mount({ sheet });
    await userEvent.click(labelled("Edit comment"));
    await userEvent.keyboard("{End} Or a log?");
    await userEvent.keyboard("{Escape}");
    expect(editText()).toBeNull();
    expect(panel(sheet)).not.toBeNull();
    expect(item().textContent).toContain("Why not a queue?");
    expect(item().textContent).not.toContain("Or a log?");
    // On the comment, not its Edit button: that button's tooltip opens on
    // keyboard focus and would take the second Escape.
    expect(document.activeElement).toBe(item());
    await escapeCloses(sheet);
    // A cancelled edit leaves nothing behind.
    await reopen();
    expect(editText()).toBeNull();
  });

  test("adding the comment clears the kept text", async () => {
    mount({ sheet });
    await userEvent.click(newText()!);
    await userEvent.keyboard("Posted note");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => document.body.textContent).toContain("Posted note");
    await close();
    await expect.poll(() => panel(sheet)).toBeNull();
    await reopen();
    expect(newText()!.value).toBe("");
  });

  test("another document does not get this document's draft", async () => {
    mount({ sheet });
    await userEvent.click(newText()!);
    await userEvent.keyboard("About document one");
    await close();
    await expect.poll(() => panel(sheet)).toBeNull();
    // useComments clears the key while the next document loads, then sets its own.
    act(() => control!.setKey(null));
    act(() => control!.setKey("sha256:two"));
    await reopen();
    expect(newText()!.value).toBe("");
  });

  test("switching document with the panel open drops the draft too", async () => {
    mount({ sheet });
    await userEvent.click(newText()!);
    await userEvent.keyboard("About document one");
    act(() => control!.setKey(null));
    act(() => control!.setKey("sha256:two"));
    await expect.poll(() => newText()!.value).toBe("");
  });
});
