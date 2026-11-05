/**
 * Diagram nodes from the rendered, sanitized SVG: Mermaid writes each
 * node's source id into its element id, so no Mermaid parser runs here.
 */
import {
  diagramKey,
  type AnchorIndex,
  type DiagramNode,
  type DiagramNodes,
  type DiagramTarget,
} from "./anchors";

/**
 * Mermaid 12 names node elements `<render-id>-<kind>-<source id>-<n>`:
 * `flowchart` (flowcharts and `graph`), `classId`, `state` and `entity` (ER).
 * Checked against Mermaid 12.2 output in `diagramNodes.browser.test.ts`. Other
 * diagram types (sequence, gantt, …) name no nodes, so they take no node comments.
 */
const NODE_ID = /^docwalk-mermaid-\d+-(flowchart|classId|state|entity)-(.+)-\d+$/;

const nodeLabel = (g: Element) => (g.textContent ?? "").replace(/\s+/g, " ").trim();

/** The id written in the Mermaid source for a rendered node element, or `null` when it has none. */
export function sourceNodeId(g: Element): string | null {
  const match = NODE_ID.exec(g.id);
  if (!match) return null;
  // State diagrams draw `[*]` as an unlabelled pseudo-node (`root_start`)
  // that has no name in the source to point at.
  if (match[1] === "state" && nodeLabel(g) === "") return null;
  return match[2] ?? null;
}

/** The source ids of the nodes in one rendered diagram host, in drawing order, without duplicates. */
export function nodesInDiagram(host: Element): DiagramNode[] {
  const out = new Map<string, DiagramNode>();
  for (const g of host.querySelectorAll("svg g.node[id]")) {
    const id = sourceNodeId(g);
    if (id === null || out.has(id)) continue;
    out.set(id, { id, label: nodeLabel(g) || id });
  }
  return [...out.values()];
}

/** The diagram's source text as the renderer stored it (code text ends with a newline). */
function sameSource(host: HTMLElement, target: DiagramTarget): boolean {
  return (host.dataset["source"] ?? "").trimEnd() === target.source.trimEnd();
}

/**
 * Pairs the diagram hosts under `container` (in document order) with the
 * index's diagrams. Hosts are matched in order by source, so a host that
 * is missing (not rendered on this surface) does not shift the rest.
 */
export function matchDiagramHosts(
  container: ParentNode,
  index: AnchorIndex,
  selector = "figure.docwalk-diagram",
): { host: HTMLElement; target: DiagramTarget }[] {
  const out: { host: HTMLElement; target: DiagramTarget }[] = [];
  let next = 0;
  for (const host of container.querySelectorAll<HTMLElement>(selector)) {
    let i = next;
    while (i < index.diagrams.length && !sameSource(host, index.diagrams[i]!)) i++;
    const target = index.diagrams[i];
    if (!target) continue;
    out.push({ host, target });
    next = i + 1;
  }
  return out;
}

/** Node lists of every rendered diagram under `container`. A diagram still rendering is left out. */
export function collectDiagramNodes(container: ParentNode, index: AnchorIndex): DiagramNodes {
  const out = new Map<string, DiagramNode[]>();
  for (const { host, target } of matchDiagramHosts(container, index)) {
    const failed = host.classList.contains("docwalk-diagram-error");
    if (!failed && !host.querySelector("svg")) continue;
    out.set(diagramKey(target.heading, target.diagram), failed ? [] : nodesInDiagram(host));
  }
  return out;
}
