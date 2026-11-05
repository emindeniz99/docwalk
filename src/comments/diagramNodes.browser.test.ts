import { afterEach, describe, expect, test } from "vitest";
import { renderDiagrams } from "../deck/mermaid";
import { purifyHtml } from "../deck/purify";
import { nodesToHtml } from "../render/toHtml";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { buildAnchorIndex, diagramKey } from "./anchors";
import { collectDiagramNodes } from "./diagramNodes";
import { markDiagramNodes, markHeadings, MARKER_CLASS, NODE_ATTR } from "./markers";
import type { DocComment } from "./types";

/**
 * Node anchors depend on Mermaid writing each node's source id into the
 * sanitized SVG. That is Mermaid's behaviour, not a contract, so these tests
 * render real diagrams: a Mermaid upgrade that renames node elements fails
 * here instead of silently orphaning every node comment.
 */

const DOC = `# Ledger

## Architecture

\`\`\`mermaid
flowchart LR
  client[Client] --> api_gw[API gateway]
  api_gw --> ledger-db[(Ledger)]
\`\`\`

\`\`\`mermaid
classDiagram
  class Entry
  class Account
  Entry --> Account
\`\`\`

## States

\`\`\`mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Busy
\`\`\`

\`\`\`mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
\`\`\`

\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: Hi
\`\`\`
`;

let mounted: HTMLElement | null = null;
afterEach(() => mounted?.remove());

async function render(markdown: string) {
  const root = parseMarkdown(markdown);
  const index = buildAnchorIndex(root, sectionize(root));
  const article = document.createElement("article");
  article.className = "docwalk-document";
  article.append(purifyHtml(nodesToHtml(root.children)));
  document.body.append(article);
  mounted = article;
  await renderDiagrams(article);
  return { index, host: article };
}

describe("diagram nodes from rendered Mermaid", () => {
  test("flowchart, class, state and ER nodes map back to their source ids", async () => {
    const { index, host } = await render(DOC);
    const nodes = collectDiagramNodes(host, index);
    const ids = (heading: string, n: number) => nodes.get(diagramKey(heading, n))?.map((x) => x.id);
    // A dash inside an id (ledger-db) survives; labels are kept for the picker.
    expect(ids("architecture", 0)).toEqual(["client", "api_gw", "ledger-db"]);
    expect(nodes.get(diagramKey("architecture", 0))?.[1]?.label).toBe("API gateway");
    expect(ids("architecture", 1)).toEqual(["Entry", "Account"]);
    // `[*]` has no name in the source, so it is not offered as an anchor.
    expect(ids("states", 0)).toEqual(["Idle", "Busy"]);
    expect(ids("states", 1)).toEqual(["CUSTOMER", "ORDER"]);
    // Sequence diagrams name no nodes: rendered, with nothing to point at.
    expect(ids("states", 2)).toEqual([]);
  });

  test("a diagram that failed to render has no nodes, so its node comments show as orphaned", async () => {
    const { index, host } = await render("## Broken\n\n```mermaid\nflowchart LR\n  a -->\n```\n");
    expect(collectDiagramNodes(host, index).get(diagramKey("broken", 0))).toEqual([]);
  });
});

const comment = (anchor: DocComment["anchor"], resolved = false): DocComment => ({
  id: crypto.randomUUID(),
  anchor,
  text: "<img src=x onerror=alert(1)>",
  created: 1,
  updated: 1,
  resolved,
});

describe("markers", () => {
  test("commented nodes are marked, others are not, and resolving clears the mark", async () => {
    const { index, host } = await render(DOC);
    const onGw = comment({ kind: "node", heading: "architecture", diagram: 0, node: "api_gw" });
    markDiagramNodes(host, index, [onGw]);
    const marked = [...host.querySelectorAll(`g[${NODE_ATTR}]`)];
    expect(marked.map((g) => g.textContent?.trim())).toEqual(["API gateway"]);
    markDiagramNodes(host, index, [{ ...onGw, resolved: true }]);
    expect(host.querySelectorAll(`g[${NODE_ATTR}]`)).toHaveLength(0);
  });

  test("headings get one count button each, named for screen readers, with no comment text in the page", async () => {
    const { index, host } = await render(DOC);
    const opened: string[] = [];
    const list = [
      comment({ kind: "heading", slug: "states" }),
      comment({ kind: "heading", slug: "states" }),
      comment({ kind: "heading", slug: "architecture" }, true),
    ];
    markHeadings(host, index, list, (slug) => opened.push(slug));
    markHeadings(host, index, list, (slug) => opened.push(slug)); // re-render: no duplicates
    const markers = [...host.querySelectorAll<HTMLButtonElement>(`.${MARKER_CLASS}`)];
    expect(markers.map((m) => m.getAttribute("aria-label"))).toEqual(["2 comments on “States”"]);
    expect(host.querySelector("img")).toBeNull();
    markers[0]!.click();
    expect(opened).toEqual(["states"]);
  });
});
