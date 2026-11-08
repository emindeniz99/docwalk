import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { AnchorIndex } from "./anchors";
import { CommentsPanel } from "./CommentsPanel";
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

function Harness({ sheet }: { sheet: boolean }) {
  const [comments, setComments] = useState<DocComment[]>([]);
  const api: CommentsApi = {
    comments,
    ready: true,
    key: "sha256:test",
    persistent: true,
    markEdit: () => {},
    add: (anchor: Anchor, text: string) => {
      setComments((list) => [
        ...list,
        { id: `c${list.length}`, anchor, text, created: 1, updated: 1, resolved: false },
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
