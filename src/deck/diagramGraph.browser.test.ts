import { afterEach, describe, expect, test } from "vitest";
import { nodesInDiagram } from "../comments/diagramNodes";
import { diagramGraph, type DiagramGraph } from "./diagramGraph";
import { diagramEdges, renderDiagrams } from "./mermaid";

/**
 * The tour draws a line over each edge and needs to know which two nodes it
 * joins. Mermaid's SVG cannot say that (a state diagram numbers its edges,
 * and `L_api_gw_db_0` splits two ways when ids hold `_`), so `renderDiagram`
 * keeps the edge list from Mermaid's own parse and the graph pairs it with
 * the rendered paths by `<render id>-<edge id>`.
 *
 * Both halves are Mermaid internals, not a contract: the shape of
 * `getData().edges`, the edge ids it makes, and the ids `render` writes on
 * the paths. These tests render real diagrams, so an upgrade that renames
 * edge ids, drops `getData().edges` or numbers state edges differently
 * between the parse and the render fails here instead of leaving the tour
 * without lines.
 */

const FLOW = `flowchart LR
  api_gw[API gateway] --> ledger-db[(Ledger)]
  a --> b
  a --> b
  a e1@--> c
  subgraph sg [Group]
    d
  end
  c --> sg`;

const CLASS = `classDiagram
  class Entry
  class Account
  class Owner
  Entry --> Account
  Account --> Owner`;

const STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Busy
  Busy --> Idle
  Busy --> [*]`;

const ER = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains`;

const SEQUENCE = `sequenceDiagram
  Alice->>Bob: Hi
  Bob-->>Alice: Hello`;

const GANTT = `gantt
  title Plan
  dateFormat YYYY-MM-DD
  section A
  Task one :a1, 2026-01-01, 3d
  Task two :after a1, 2d`;

let mounted: HTMLElement | null = null;
afterEach(() => {
  mounted?.remove();
  mounted = null;
});

/** Render each source as its own diagram host in a fresh article, in order. */
async function render(sources: string[]): Promise<HTMLElement[]> {
  mounted?.remove();
  const article = document.createElement("article");
  for (const source of sources) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = `${source}\n`;
    pre.append(code);
    article.append(pre);
  }
  document.body.append(article);
  mounted = article;
  const results = await renderDiagrams(article);
  expect(results.map((r) => r.ok)).toEqual(sources.map(() => true));
  return [...article.querySelectorAll<HTMLElement>("figure.docwalk-diagram")];
}

function graphOf(host: HTMLElement): { svg: SVGSVGElement; graph: DiagramGraph } {
  const svg = host.querySelector("svg") as SVGSVGElement;
  return { svg, graph: diagramGraph(svg, diagramEdges(host)) };
}

/** Each edge as `from>to` in source ids, `null` for an end that is not a node. */
function ends(graph: DiagramGraph): string[] {
  const name = (k: number | null) => (k === null ? "null" : (graph.nodes[k - 1]?.id ?? "?"));
  return graph.edges.map((e) => `${name(e.from)}>${name(e.to)}`);
}

/** A graph without the render id, which differs between two renders of one source. */
function shape(svg: SVGSVGElement, graph: DiagramGraph) {
  return {
    nodes: graph.nodes.map((n) => [n.id, n.label, n.elements.length]),
    edges: graph.edges.map((e) => [e.path.id.slice(svg.id.length), e.from, e.to]),
  };
}

describe("diagramGraph: edges of a rendered diagram", () => {
  test("flowchart: every edge path is found and its ends are the right nodes", async () => {
    const [host] = await render([FLOW]);
    const { svg, graph } = graphOf(host as HTMLElement);
    // Mermaid draws the subgraph's content first. The subgraph itself is not a
    // node (comments skip it too), so `c --> sg` has no end there.
    expect(graph.nodes.map((n) => n.id)).toEqual(["d", "api_gw", "ledger-db", "a", "b", "c"]);
    expect(ends(graph)).toEqual(["api_gw>ledger-db", "a>b", "a>b", "a>c", "c>null"]);
    // Repeated a --> b are two paths; ids with `_` and `-` still resolve.
    const [first, second, , named] = graph.edges;
    expect(first?.path).not.toBe(second?.path);
    // An edge the author named keeps its name in the path id.
    expect(named?.path.id).toBe(`${svg.id}-e1`);
    for (const edge of graph.edges) {
      expect(edge.path.tagName.toLowerCase()).toBe("path");
      expect(svg.contains(edge.path)).toBe(true);
    }
  });

  test("class diagram: every edge joins the right classes", async () => {
    const [host] = await render([CLASS]);
    const { graph } = graphOf(host as HTMLElement);
    expect(ends(graph)).toEqual(["Entry>Account", "Account>Owner"]);
  });

  test("state diagram: `[*]` is not a node, so its edges have a null end", async () => {
    // The state renderer numbers edges (`edge3`) with a counter of its own.
    // The ids must come out the same in Mermaid's parse and in its render.
    const [host] = await render([STATE]);
    const { graph } = graphOf(host as HTMLElement);
    expect(ends(graph)).toEqual(["null>Idle", "Idle>Busy", "Busy>Idle", "Busy>null"]);
  });

  test("ER diagram: entities join through their internal ids", async () => {
    const [host] = await render([ER]);
    const { graph } = graphOf(host as HTMLElement);
    expect(ends(graph)).toEqual(["CUSTOMER>ORDER", "ORDER>LINE_ITEM"]);
  });

  test.each([
    ["sequence", SEQUENCE],
    ["gantt", GANTT],
  ])("%s diagram: no nodes and no edges, so there is no tour", async (_name, source) => {
    const [host] = await render([source]);
    const { graph } = graphOf(host as HTMLElement);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  test("a host that was never rendered has no edges", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const graph = diagramGraph(svg, diagramEdges(document.createElement("figure")));
    expect(graph).toEqual({ nodes: [], edges: [] });
  });
});

describe("diagramGraph: nodes", () => {
  test("nodes are the ones node comments use, in the same order", async () => {
    const hosts = await render([FLOW, CLASS, STATE, ER, SEQUENCE, GANTT]);
    for (const host of hosts) {
      const { graph } = graphOf(host);
      expect(graph.nodes.map((n) => n.id)).toEqual(nodesInDiagram(host).map((n) => n.id));
      expect(graph.nodes.map((n) => n.label)).toEqual(nodesInDiagram(host).map((n) => n.label));
      for (const node of graph.nodes) {
        expect(node.elements.length).toBeGreaterThan(0);
        for (const el of node.elements) expect(el.classList.contains("node")).toBe(true);
      }
    }
  });
});

describe("diagramGraph: the same diagram more than once", () => {
  const all = [FLOW, CLASS, STATE, ER];

  test("a second copy (rendered again, with its own ids) gives the same graph", async () => {
    // The copies come after other renders, so the counters inside Mermaid
    // have moved on: the state diagram's edge numbers must not depend on them.
    const hosts = await render([...all, ...all]);
    for (let i = 0; i < all.length; i += 1) {
      const a = graphOf(hosts[i] as HTMLElement);
      const b = graphOf(hosts[i + all.length] as HTMLElement);
      expect(b.svg.id).not.toBe(a.svg.id);
      expect(shape(b.svg, b.graph)).toEqual(shape(a.svg, a.graph));
      expect(b.graph.edges.length).toBeGreaterThan(0);
    }
  });

  test("a rebuild served from the cache gives the same graph", async () => {
    const first = await render(all);
    const before = first.map((host) => {
      const { svg, graph } = graphOf(host);
      return shape(svg, graph);
    });
    // The first article goes away, as it does when the deck rebuilds.
    const second = await render(all);
    const after = second.map((host) => {
      const { svg, graph } = graphOf(host);
      return shape(svg, graph);
    });
    expect(after).toEqual(before);
    expect(after.every((s) => s.edges.length > 0)).toBe(true);
  });
});

describe("a host on the page keeps its edges", () => {
  test("the oldest diagram of a deck over the cache limit still has its path lines", async () => {
    // 70 is more than the cache holds (RENDERED_LIMIT in mermaid.ts). The
    // cache drops the first SVGs, but their hosts stay on the page, so the
    // tour of the first diagram must still find its edges.
    const sources = Array.from({ length: 70 }, (_v, i) => `flowchart LR\n  n${i} --> m${i}`);
    const hosts = await render(sources);
    for (const host of [hosts[0], hosts[69]] as HTMLElement[]) {
      expect(graphOf(host).graph.edges).toHaveLength(1);
    }
  });
});
