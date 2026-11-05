/**
 * Where comments attach. Headings are found on the Markdown AST with the
 * same slugger and the same rules as `sectionize` (rule 2), so a heading
 * anchor equals the section id or GitHub anchor a reader already links to.
 * Diagram nodes are read from the rendered SVG (src/comments/diagramNodes.ts);
 * this module stays free of the DOM so it runs anywhere.
 */
import GithubSlugger from "github-slugger";
import type { Code, Heading, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";
import { headingText, type SectionPlan } from "../sectioning/sectionize";
import type { Anchor, DocComment } from "./types";

export interface HeadingTarget {
  slug: string;
  title: string;
  depth: Heading["depth"];
  /** The section (slide group) the heading is shown in. */
  sectionId: string | null;
}

export interface DiagramTarget {
  /** Slug of the nearest heading above the diagram; `""` before the first heading. */
  heading: string;
  /** 0-based position among the diagrams under that heading. */
  diagram: number;
  source: string;
  sectionId: string | null;
}

export interface AnchorIndex {
  headings: HeadingTarget[];
  bySlug: Map<string, HeadingTarget>;
  diagrams: DiagramTarget[];
}

export interface DiagramNode {
  /** The id written in the Mermaid source. */
  id: string;
  /** The node's visible text, for the anchor picker. */
  label: string;
}

/** Nodes per diagram (`diagramKey`), once that diagram has rendered. A failed diagram has an empty list. */
export type DiagramNodes = ReadonlyMap<string, readonly DiagramNode[]>;

export function diagramKey(heading: string, diagram: number): string {
  return `${heading}\u0000${diagram}`;
}

/** A string that is equal for two anchors exactly when they point at the same thing. */
export function anchorKey(anchor: Anchor): string {
  return anchor.kind === "heading"
    ? `h\u0000${anchor.slug}`
    : `n\u0000${diagramKey(anchor.heading, anchor.diagram)}\u0000${anchor.node}`;
}

/**
 * The section each top-level node is shown in. A node no section holds (a
 * thematic break, a title-level heading without content of its own, which
 * is only a breadcrumb) belongs to the next section that is shown.
 */
function sectionOfNodes(root: Root, plan: SectionPlan): Map<RootContent, string | null> {
  const owner = new Map<RootContent, string>();
  for (const sec of plan.sections) {
    if (sec.heading) owner.set(sec.heading, sec.id);
    for (const n of sec.nodes) owner.set(n, sec.id);
  }
  const out = new Map<RootContent, string | null>();
  let pending: RootContent[] = [];
  let last: string | null = null;
  for (const node of root.children) {
    const id = owner.get(node);
    if (id === undefined) {
      pending.push(node);
      continue;
    }
    for (const p of pending) out.set(p, id);
    pending = [];
    out.set(node, id);
    last = id;
  }
  for (const p of pending) out.set(p, last);
  return out;
}

/** Every heading and Mermaid diagram a comment can point at, in document order. */
export function buildAnchorIndex(root: Root, plan: SectionPlan): AnchorIndex {
  const sectionOf = sectionOfNodes(root, plan);
  // Same slugging as sectionize: every top-level heading, in order, so
  // duplicate titles get GitHub's `-1`, `-2` suffixes in the same places.
  const slugger = new GithubSlugger();
  const headings: HeadingTarget[] = [];
  const diagrams: DiagramTarget[] = [];
  const perHeading = new Map<string, number>();
  let currentHeading = "";
  for (const node of root.children) {
    if (node.type === "heading") {
      const title = headingText(node);
      const slug = slugger.slug(title);
      currentHeading = slug;
      headings.push({ slug, title, depth: node.depth, sectionId: sectionOf.get(node) ?? null });
      continue;
    }
    visit(node, "code", (code: Code) => {
      // The renderer turns exactly `lang === "mermaid"` into a diagram (language-mermaid).
      if (code.lang !== "mermaid") return;
      const n = perHeading.get(currentHeading) ?? 0;
      perHeading.set(currentHeading, n + 1);
      diagrams.push({
        heading: currentHeading,
        diagram: n,
        source: code.value,
        sectionId: sectionOf.get(node) ?? null,
      });
    });
  }
  return { headings, bySlug: new Map(headings.map((h) => [h.slug, h])), diagrams };
}

export type Resolved =
  | { status: "attached"; sectionId: string | null; label: string; order: number }
  | { status: "orphaned"; label: string };

/** How an anchor reads when its target is gone: what it pointed at, as written. */
export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === "heading") return `Heading #${anchor.slug}`;
  const where = anchor.heading ? ` under #${anchor.heading}` : "";
  return `Node ${anchor.node} in diagram ${anchor.diagram + 1}${where}`;
}

/**
 * Finds what an anchor points at now. A node anchor whose diagram has not
 * rendered yet counts as attached (its diagram exists); once the diagram
 * has rendered without that node, or the heading or diagram is gone, the
 * comment is orphaned: listed apart, never dropped.
 */
export function resolveAnchor(anchor: Anchor, index: AnchorIndex, nodes: DiagramNodes): Resolved {
  if (anchor.kind === "heading") {
    const at = index.headings.findIndex((h) => h.slug === anchor.slug);
    const h = index.headings[at];
    return h
      ? { status: "attached", sectionId: h.sectionId, label: h.title || h.slug, order: at * 1000 }
      : { status: "orphaned", label: describeAnchor(anchor) };
  }
  const at = index.diagrams.findIndex(
    (d) => d.heading === anchor.heading && d.diagram === anchor.diagram,
  );
  const d = index.diagrams[at];
  if (!d) return { status: "orphaned", label: describeAnchor(anchor) };
  const list = nodes.get(diagramKey(d.heading, d.diagram));
  const node = list?.find((n) => n.id === anchor.node);
  if (list && !node) return { status: "orphaned", label: describeAnchor(anchor) };
  const headingAt = index.headings.findIndex((h) => h.slug === d.heading);
  const shown = node && node.label !== node.id ? `${node.label} (${node.id})` : anchor.node;
  return {
    status: "attached",
    sectionId: d.sectionId,
    label: `Diagram node ${shown}`,
    // After its heading, before the next one.
    order: headingAt * 1000 + 1 + at,
  };
}

/** How many open (unresolved) comments each section holds, for the outline and the slide marker. */
export function countBySection(
  comments: readonly DocComment[],
  index: AnchorIndex,
  nodes: DiagramNodes,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments) {
    if (c.resolved) continue;
    const r = resolveAnchor(c.anchor, index, nodes);
    if (r.status !== "attached" || r.sectionId === null) continue;
    out.set(r.sectionId, (out.get(r.sectionId) ?? 0) + 1);
  }
  return out;
}
