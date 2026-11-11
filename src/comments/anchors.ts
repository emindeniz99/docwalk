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
import { m } from "../paraglide/messages.js";
import { anchoredHeadings, headingText, type SectionPlan } from "../sectioning/sectionize";
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
  /** `diagramSig` of the source, so comments can find the diagram again when it moves. */
  sig: string;
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

/**
 * A 53-bit hash (cyrb53), in hex, of a diagram's source with its whitespace
 * collapsed (decision 96). Not a security hash: it only tells two diagrams
 * apart, and a node anchor carries it so the comment can follow its diagram
 * when diagrams are reordered.
 */
export function diagramSig(source: string): string {
  const text = source.replace(/\s+/g, " ").trim();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
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
  // Same slugging as sectionize: every heading GitHub anchors, nested ones
  // too (decision 107), in order, so duplicate titles get GitHub's `-1`,
  // `-2` suffixes in the same places. Comments attach to top-level ones.
  const slugger = new GithubSlugger();
  const slugs = new Map(anchoredHeadings(root).map((h) => [h, slugger.slug(headingText(h))]));
  const headings: HeadingTarget[] = [];
  const diagrams: DiagramTarget[] = [];
  const perHeading = new Map<string, number>();
  let currentHeading = "";
  for (const node of root.children) {
    if (node.type === "heading") {
      const title = headingText(node);
      const slug = slugs.get(node) ?? "";
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
        sig: diagramSig(code.value),
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
function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === "heading") return m.anchor_heading({ slug: anchor.slug });
  const number = anchor.diagram + 1;
  return anchor.heading
    ? m.anchor_node_under({ node: anchor.node, number, heading: anchor.heading })
    : m.anchor_node({ node: anchor.node, number });
}

/**
 * The anchor as it reads against the current document (decision 96): a node
 * anchor whose diagram moved gets the diagram's number now. The stored
 * anchor is never rewritten. `null` when the comment cannot be placed
 * without a guess: several diagrams under the heading are equal to the one
 * it was written on, and none sits at the recorded number.
 */
export function currentAnchor(anchor: Anchor, index: AnchorIndex): Anchor | null {
  if (anchor.kind === "heading" || anchor.sig === undefined) return anchor;
  const same = index.diagrams.filter((d) => d.heading === anchor.heading && d.sig === anchor.sig);
  // No equal diagram (it was edited, or left the heading): the recorded number decides.
  if (same.length === 0 || same.some((d) => d.diagram === anchor.diagram)) return anchor;
  const [only] = same;
  return same.length === 1 && only ? { ...anchor, diagram: only.diagram } : null;
}

/** Like `anchorKey`, for where the anchor points now: a moved comment groups, counts and marks with its diagram. */
export function currentKey(anchor: Anchor, index: AnchorIndex): string {
  return anchorKey(currentAnchor(anchor, index) ?? anchor);
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
  const here = currentAnchor(anchor, index);
  if (here?.kind !== "node") return { status: "orphaned", label: describeAnchor(anchor) };
  const at = index.diagrams.findIndex(
    (d) => d.heading === here.heading && d.diagram === here.diagram,
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
    label: m.anchor_diagram_node({ node: shown }),
    // After its heading, before the next one.
    order: headingAt * 1000 + 1 + at,
  };
}

/**
 * Open comments per anchor key, by where each comment points now (decision 96).
 * A comment that cannot be placed without a guess is orphaned and marks nothing.
 */
export function openCounts(
  comments: readonly DocComment[],
  index: AnchorIndex,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments) {
    const here = c.resolved ? null : currentAnchor(c.anchor, index);
    if (!here) continue;
    const k = anchorKey(here);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
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
