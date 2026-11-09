/**
 * Nodes and edges of a rendered diagram, for the tour (decision 109). Nodes
 * come from `nodesInDiagram`, so this side and the mirror's other side number
 * them alike. Edge endpoints come from Mermaid's own parse, kept by
 * `renderDiagram` (`diagramEdges`), because the SVG cannot say which nodes an
 * edge joins. Ids from the parse are compared and never written to the page
 * or used to build a selector (rule 5).
 */
import { nodesInDiagram, sourceNodeId } from "../comments/diagramNodes";
import { diagramEdges } from "./mermaid";

export interface GraphNode {
  /** The id written in the Mermaid source. */
  id: string;
  label: string;
  /** Every `g.node` that draws it; usually one. */
  elements: SVGGElement[];
}

export interface GraphEdge {
  path: SVGPathElement;
  /** Node numbers from 1 in `nodes` order; `null` when an end is not a node (a subgraph, `[*]`). */
  from: number | null;
  to: number | null;
}

export interface DiagramGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The graph of one rendered diagram. `svg` is the slide's SVG or a clone that
 * kept its ids; `source` is the diagram's Markdown text. A diagram without
 * nodes, or one whose edges Mermaid's parse did not keep, has no edges.
 */
export function diagramGraph(svg: SVGSVGElement, source: string): DiagramGraph {
  const listed = nodesInDiagram(svg);
  const byId = new Map<string, GraphNode>();
  const nodes: GraphNode[] = listed.map((node) => {
    const graphNode: GraphNode = { id: node.id, label: node.label, elements: [] };
    byId.set(node.id, graphNode);
    return graphNode;
  });
  // Mermaid names an ER entity's edge end by its element id minus the render
  // id (`entity-CUSTOMER-0`); the other types name the source id.
  const byElementId = new Map<string, number>();
  for (const g of svg.querySelectorAll<SVGGElement>("g.node[id]")) {
    const id = sourceNodeId(g);
    const node = id === null ? undefined : byId.get(id);
    if (!node) continue;
    node.elements.push(g);
    byElementId.set(g.id, nodes.indexOf(node) + 1);
  }
  const bySourceId = new Map(nodes.map((node, i) => [node.id, i + 1]));
  const numberOf = (end: string): number | null =>
    bySourceId.get(end) ?? byElementId.get(`${svg.id}-${end}`) ?? null;

  const paths = new Map<string, SVGPathElement>();
  for (const path of svg.querySelectorAll<SVGPathElement>("path[id]")) paths.set(path.id, path);

  const edges: GraphEdge[] = [];
  if (nodes.length > 0) {
    for (const edge of diagramEdges(source)) {
      const path = paths.get(`${svg.id}-${edge.id}`);
      if (path) edges.push({ path, from: numberOf(edge.start), to: numberOf(edge.end) });
    }
  }
  return { nodes, edges };
}
