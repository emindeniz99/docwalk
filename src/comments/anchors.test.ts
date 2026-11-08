import { describe, expect, test } from "vitest";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import {
  anchorKey,
  buildAnchorIndex,
  countBySection,
  currentAnchor,
  diagramKey,
  diagramSig,
  openCounts,
  resolveAnchor,
  type DiagramNodes,
} from "./anchors";
import { contentKey, sourceKey } from "./identity";
import { sidecarFileName } from "./sidecar";
import type { DocComment } from "./types";

/**
 * Anchors must survive what people do to a document: edits elsewhere, a
 * different slide level, duplicate headings. And when an anchor really is
 * gone, its comment must stay visible as orphaned (decision 55), never vanish.
 */

const DOC = `# Ledger

Intro.

## Goals

Text.

## Goals

Second goals section.

### Detail

More.

## Architecture

\`\`\`mermaid
flowchart LR
  a --> api_gw
\`\`\`

\`\`\`js
not a diagram
\`\`\`

\`\`\`mermaid
graph TD
  x --> y
\`\`\`
`;

const indexFor = (markdown: string, level: Parameters<typeof sectionize>[1] = "auto") => {
  const root = parseMarkdown(markdown);
  return buildAnchorIndex(root, sectionize(root, level));
};

const at = (over: Partial<DocComment>): DocComment => ({
  id: "c",
  anchor: { kind: "heading", slug: "goals" },
  text: "t",
  created: 1,
  updated: 1,
  resolved: false,
  ...over,
});

describe("anchor index", () => {
  test("heading slugs match GitHub's, duplicates numbered the same way", () => {
    expect(indexFor(DOC).headings.map((h) => h.slug)).toEqual([
      "ledger",
      "goals",
      "goals-1",
      "detail",
      "architecture",
    ]);
  });

  test("a sub-heading belongs to the slide section that shows it, at any slide level", () => {
    expect(indexFor(DOC).bySlug.get("detail")?.sectionId).toBe("goals-1");
    expect(indexFor(DOC, 3).bySlug.get("detail")?.sectionId).toBe("detail");
  });

  test("only mermaid blocks are diagrams, numbered per heading", () => {
    expect(indexFor(DOC).diagrams.map((d) => [d.heading, d.diagram, d.sectionId])).toEqual([
      ["architecture", 0, "architecture"],
      ["architecture", 1, "architecture"],
    ]);
  });
});

describe("resolving anchors", () => {
  const nodes: DiagramNodes = new Map([
    [
      diagramKey("architecture", 0),
      [
        { id: "a", label: "a" },
        { id: "api_gw", label: "API gateway" },
      ],
    ],
  ]);

  test("a heading anchor survives an edit elsewhere in the document", () => {
    const edited = indexFor(DOC.replace("Text.", "Rewritten text, much longer."));
    expect(resolveAnchor({ kind: "heading", slug: "goals" }, edited, nodes)).toMatchObject({
      status: "attached",
      sectionId: "goals",
    });
  });

  test("a renamed heading orphans its comments, and says what they pointed at", () => {
    const renamed = indexFor(DOC.replace("## Architecture", "## Design"));
    expect(resolveAnchor({ kind: "heading", slug: "architecture" }, renamed, nodes)).toEqual({
      status: "orphaned",
      label: "Heading #architecture",
    });
  });

  test("a node anchor is attached while its diagram renders, orphaned once it rendered without the node", () => {
    const index = indexFor(DOC);
    const anchor = { kind: "node", heading: "architecture", diagram: 1, node: "x" } as const;
    expect(resolveAnchor(anchor, index, nodes).status).toBe("attached");
    const rendered: DiagramNodes = new Map([
      [diagramKey("architecture", 1), [{ id: "y", label: "y" }]],
    ]);
    expect(resolveAnchor(anchor, index, rendered)).toEqual({
      status: "orphaned",
      label: "Node x in diagram 2 under #architecture",
    });
  });

  test("a node shows its label and source id", () => {
    const anchor = { kind: "node", heading: "architecture", diagram: 0, node: "api_gw" } as const;
    expect(resolveAnchor(anchor, indexFor(DOC), nodes)).toMatchObject({
      label: "Diagram node API gateway (api_gw)",
    });
  });

  test("outline counts include only open, attached comments, per section", () => {
    const counts = countBySection(
      [
        at({ id: "1" }),
        at({ id: "2", anchor: { kind: "heading", slug: "detail" } }),
        at({ id: "3", resolved: true }),
        at({ id: "4", anchor: { kind: "heading", slug: "gone" } }),
        at({ id: "5", anchor: { kind: "node", heading: "architecture", diagram: 0, node: "a" } }),
      ],
      indexFor(DOC),
      nodes,
    );
    expect(Object.fromEntries(counts)).toEqual({ goals: 1, "goals-1": 1, architecture: 1 });
  });
});

// Diagrams under one "Architecture" heading, the rendered node ids of each,
// and a node anchor on one of them, with the signature of `source` if given.
const under = (...sources: string[]) =>
  `# T\n\n## Architecture\n\n${sources.map((s) => `\`\`\`mermaid\n${s}\n\`\`\`\n`).join("\n")}`;
const rendered = (...ids: string[][]): DiagramNodes =>
  new Map(
    ids.map((list, i) => [diagramKey("architecture", i), list.map((id) => ({ id, label: id }))]),
  );
const node = (diagram: number, name: string, source?: string) =>
  ({
    kind: "node",
    heading: "architecture",
    diagram,
    node: name,
    ...(source === undefined ? {} : { sig: diagramSig(source) }),
  }) as const;

describe("node comments and diagrams that move", () => {
  // Two diagrams under one heading that share the node id `a`, the case where
  // a position-only match sticks a comment to the wrong diagram without a word.
  const FIRST = "flowchart LR\n  a --> b";
  const SECOND = "flowchart TD\n  a --> c";

  test("after two diagrams swap, a comment on a node follows its diagram", () => {
    const swapped = indexFor(under(SECOND, FIRST));
    const nodes = rendered(["a", "c"], ["a", "b"]);
    const onB = node(0, "b", FIRST);
    expect(resolveAnchor(onB, swapped, nodes).status).toBe("attached");
    expect(currentAnchor(onB, swapped)).toMatchObject({ diagram: 1 });
  });

  test("a node id both diagrams share does not stick to the wrong diagram", () => {
    const swapped = indexFor(under(SECOND, FIRST));
    expect(currentAnchor(node(0, "a", FIRST), swapped)).toMatchObject({ diagram: 1 });
    expect(currentAnchor(node(1, "a", SECOND), swapped)).toMatchObject({ diagram: 0 });
  });

  test("a comment written before signatures existed keeps the recorded position, as before", () => {
    const swapped = indexFor(under(SECOND, FIRST));
    expect(currentAnchor(node(0, "a"), swapped)).toMatchObject({ diagram: 0 });
    expect(resolveAnchor(node(0, "b"), swapped, rendered(["a", "c"], ["a", "b"])).status).toBe(
      "orphaned",
    );
  });

  test("an edited diagram keeps its comments: no diagram matches the signature, so the position decides", () => {
    const edited = indexFor(under(`${FIRST}\n  b --> d`, SECOND));
    const onB = node(0, "b", FIRST);
    expect(currentAnchor(onB, edited)).toMatchObject({ diagram: 0 });
    expect(resolveAnchor(onB, edited, rendered(["a", "b", "d"], ["a", "c"])).status).toBe(
      "attached",
    );
  });

  test("when two equal diagrams could both be the one, the comment is orphaned instead of guessed", () => {
    const index = indexFor(under(FIRST, SECOND, FIRST));
    const onB = node(1, "b", FIRST);
    expect(resolveAnchor(onB, index, rendered(["a", "b"], ["a", "c"], ["a", "b"]))).toEqual({
      status: "orphaned",
      label: "Node b in diagram 2 under #architecture",
    });
  });

  test("an equal diagram at the recorded position wins over an equal one elsewhere", () => {
    const index = indexFor(under(FIRST, FIRST));
    expect(currentAnchor(node(1, "b", FIRST), index)).toMatchObject({ diagram: 1 });
    expect(currentAnchor(node(0, "b", FIRST), index)).toMatchObject({ diagram: 0 });
  });

  test("a diagram that left the heading orphans its comment: other headings are never searched", () => {
    const other = `\`\`\`mermaid\n${FIRST}\n\`\`\``;
    const index = indexFor(`# T\n\n## Other\n\n${other}\n\n## Architecture\n\nText.\n`);
    expect(resolveAnchor(node(0, "b", FIRST), index, rendered(["a", "b"])).status).toBe("orphaned");
  });

  test("the count on a section follows the diagram the comment now belongs to", () => {
    const swapped = indexFor(under(SECOND, FIRST));
    const counts = countBySection(
      [at({ anchor: node(0, "b", FIRST) })],
      swapped,
      rendered(["a", "c"], ["a", "b"]),
    );
    expect(Object.fromEntries(counts)).toEqual({ architecture: 1 });
  });

  test("the node marks follow the diagram, and a comment orphaned between equal diagrams marks no node", () => {
    // The panel lists the second comment as orphaned; a glow on the node at its old
    // number would point at a diagram with a different source.
    const swapped = indexFor(under(SECOND, FIRST));
    expect([...openCounts([at({ anchor: node(0, "b", FIRST) })], swapped).keys()]).toEqual([
      anchorKey(node(1, "b")),
    ]);
    const guess = indexFor(under(FIRST, SECOND, FIRST));
    expect(openCounts([at({ anchor: node(1, "b", FIRST) })], guess).size).toBe(0);
  });

  test("a signature ignores whitespace and tells different diagrams apart", () => {
    expect(diagramSig("flowchart LR\n  a --> b")).toBe(diagramSig("flowchart LR\r\n a   --> b\n"));
    expect(diagramSig(FIRST)).not.toBe(diagramSig(SECOND));
    expect(diagramSig(FIRST)).toMatch(/^[0-9a-f]{1,16}$/);
  });
});

describe("document identity", () => {
  test("a ?src= document is keyed by its URL without access tokens, so no token is stored", () => {
    expect(
      sourceKey({
        kind: "url",
        url: "https://raw.githubusercontent.com/o/r/main/a.md?token=SECRET#x",
        trusted: true,
      }),
    ).toBe("url:https://raw.githubusercontent.com/o/r/main/a.md");
  });

  test("a workspace file is keyed by its root and path, so an edit and a reload keep its comments", () => {
    // Workspace files skip the draft slot (and its alias); a content key
    // would change with every saved edit and strand the comments.
    expect(sourceKey({ kind: "workspace", root: "opfs", path: "talks/plan.md" })).toBe(
      "workspace:opfs:talks/plan.md",
    );
    const inF1 = sourceKey({
      kind: "workspace",
      root: "folder",
      folder: "f1",
      path: "talks/plan.md",
    });
    expect(inF1).not.toBe(sourceKey({ kind: "workspace", root: "opfs", path: "talks/plan.md" }));
    // Two picked folders that both hold talks/plan.md are two documents.
    expect(inF1).not.toBe(
      sourceKey({ kind: "workspace", root: "folder", folder: "f2", path: "talks/plan.md" }),
    );
  });

  test("text-only documents are keyed by content, so the same share link finds the same comments", async () => {
    expect(sourceKey({ kind: "fragment" })).toBeNull();
    expect(await contentKey("# A")).toBe(await contentKey("# A"));
    expect(await contentKey("# A")).not.toBe(await contentKey("# B"));
  });
});

describe("sidecar name", () => {
  test("sits next to the Markdown file it belongs to", () => {
    expect(sidecarFileName({ kind: "file", name: "design.md" }, "x")).toBe("design.comments.json");
    expect(
      sidecarFileName({ kind: "repo", repo: "o/r", path: "docs/ledger-plan.md", ref: null }, "x"),
    ).toBe("ledger-plan.comments.json");
  });

  test("a document without a file name is named after its title, never with path characters", () => {
    expect(sidecarFileName({ kind: "paste" }, "Q3 / plan: v2")).toBe("q3-plan-v2.comments.json");
    expect(sidecarFileName({ kind: "fragment" }, "")).toBe("document.comments.json");
  });
});
