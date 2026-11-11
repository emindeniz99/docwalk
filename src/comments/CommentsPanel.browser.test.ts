import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { diagramKey, type AnchorIndex } from "./anchors";
import { CommentsPanel } from "./CommentsPanel";
import { cleanAuthor } from "./schema";
import type { Anchor, DocComment } from "./types";
import type { CommentsApi } from "./useComments";

/**
 * Keyboard and screen-reader users post a comment with Tab and Enter. The
 * Add button disables as the text clears, and a disabled button loses focus
 * to <body>: the user lost their place, and in the phone sheet focus left
 * the open dialog. Focus must stay in the panel, on the text box, ready for
 * the next comment (WCAG 2.4.3).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const index: AnchorIndex = {
  headings: [{ slug: "goals", title: "Goals", depth: 2, sectionId: "goals" }],
  bySlug: new Map([["goals", { slug: "goals", title: "Goals", depth: 2, sectionId: "goals" }]]),
  diagrams: [],
};

function Harness({ sheet, unreadable = false }: { sheet: boolean; unreadable?: boolean }) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const [author, setAuthor] = useState("");
  const api: CommentsApi = {
    comments,
    deleted: [],
    ready: true,
    key: "sha256:test",
    legacyKey: null,
    unidentified: false,
    persistent: !unreadable,
    unreadable,
    author,
    setAuthor,
    markEdit: () => {},
    add: (anchor: Anchor, text: string) => {
      const name = cleanAuthor(author);
      setComments((list) => [
        ...list,
        {
          id: `c${list.length}`,
          anchor,
          text,
          ...(name === null ? {} : { author: name }),
          created: 1,
          updated: 1,
          resolved: false,
        },
      ]);
      return true;
    },
    update: () => {},
    remove: () => {},
    setResolved: () => {},
    importFile: async () => ({ message: "", tone: "info" }),
  };
  return h(CommentsPanel, {
    isOpen: true,
    onClose: () => {},
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
function mount(props: { sheet: boolean; unreadable?: boolean }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Harness, props)));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("adding a comment keeps keyboard focus in the panel", () => {
  test.each([
    ["side panel", false],
    ["phone sheet: focus stays inside the open dialog", true],
  ])("%s", async (_name, sheet) => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(h(Harness, { sheet })));
    const textarea = document.querySelector<HTMLTextAreaElement>(".docwalk-comments-textarea")!;
    await userEvent.click(textarea);
    await userEvent.keyboard("Why not a queue?");
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Add comment");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.body.textContent).toContain("Why not a queue?");
    expect(document.activeElement).toBe(textarea);
    const panel = document.querySelector(sheet ? '[role="dialog"]' : ".docwalk-comments-side")!;
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

const nameField = () => document.querySelector<HTMLInputElement>(".docwalk-comments-author-input")!;

describe("the optional display name (decision 97)", () => {
  test("is empty by default and comments are written without a name", async () => {
    mount({ sheet: false });
    expect(nameField().value).toBe("");
    expect(nameField().getAttribute("maxlength")).toBe("40");
    await userEvent.click(document.querySelector(".docwalk-comments-textarea")!);
    await userEvent.keyboard("No name here");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => document.body.textContent).toContain("No name here");
    expect(document.querySelector(".docwalk-comments-author")).toBeNull();
  });

  test("a name shows on the comments written under it, as plain text", async () => {
    mount({ sheet: false });
    await userEvent.click(nameField());
    // Markup in a name is text, never an element.
    await userEvent.keyboard("<b>Reviewer A</b>");
    await userEvent.click(document.querySelector(".docwalk-comments-textarea")!);
    await userEvent.keyboard("Named note");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => document.querySelector(".docwalk-comments-author")).not.toBeNull();
    const author = document.querySelector(".docwalk-comments-author")!;
    expect(author.textContent).toBe("<b>Reviewer A</b>");
    expect(author.children).toHaveLength(0);
    expect(author.closest(".docwalk-comments-item")?.querySelector("b")).toBeNull();
  });

  test("the field says where the name goes", () => {
    mount({ sheet: false });
    const field = nameField();
    const note = document.getElementById(field.getAttribute("aria-describedby") ?? "none");
    expect(note?.textContent).toContain("in the clear");
  });
});

test("a document whose saved comments cannot be read says so instead of claiming the browser cannot save", () => {
  mount({ sheet: false, unreadable: true });
  expect(document.querySelector(".docwalk-comments-warning")?.textContent).toContain(
    "could not be read",
  );
});

/** A comment on node `node` of the one diagram under Goals. */
const on = (node: string, id: string, created: number): DocComment => ({
  id,
  anchor: { kind: "node", heading: "goals", diagram: 0, node },
  text: `On ${node}, ${id}`,
  created,
  updated: created,
  resolved: false,
});

describe("comments on the nodes of one diagram (decision 132)", () => {
  test("group by node, one group per node, whatever order they were written in", () => {
    // Every node of one diagram sorts at the same place, so the comments fell
    // back to creation order: a, b, a gave three groups and two with one key.
    const diagramIndex: AnchorIndex = {
      ...index,
      diagrams: [{ heading: "goals", diagram: 0, source: "a --> b", sig: "1", sectionId: "goals" }],
    };
    const comments = [on("a", "first", 1), on("b", "second", 2), on("a", "third", 3)];
    const api: CommentsApi = {
      comments,
      deleted: [],
      ready: true,
      key: "sha256:test",
      legacyKey: null,
      unidentified: false,
      persistent: true,
      unreadable: false,
      author: "",
      setAuthor: () => {},
      markEdit: () => {},
      add: () => true,
      update: () => {},
      remove: () => {},
      setResolved: () => {},
      importFile: async () => ({ message: "", tone: "info" }),
    };
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        h(CommentsPanel, {
          isOpen: true,
          onClose: () => {},
          sheet: false,
          api,
          index: diagramIndex,
          nodes: new Map([
            [
              diagramKey("goals", 0),
              [
                { id: "a", label: "a" },
                { id: "b", label: "b" },
              ],
            ],
          ]),
          defaultAnchor: null,
          focusAnchor: null,
          onGoTo: () => {},
          sidecarName: "doc.comments.json",
        }),
      ),
    );
    const groups = [...document.querySelectorAll(".docwalk-comments-group")].map((g) => [
      g.querySelector(".docwalk-comments-anchor")?.textContent,
      [...g.querySelectorAll(".docwalk-comments-item")].length,
    ]);
    expect(groups).toEqual([
      ["Diagram node a", 2],
      ["Diagram node b", 1],
    ]);
    // React reports two siblings with one key as an error.
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });
});
