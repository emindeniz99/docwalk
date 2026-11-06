/**
 * Comment markers on rendered content: a count button after each heading
 * in document mode and a highlight on each commented Mermaid node. Both
 * surfaces are DOM the app builds from sanitized HTML outside React, so
 * markers are added (and removed) after each render. Markers carry only
 * counts and heading titles set as text; no comment text reaches the DOM here.
 */
import { m } from "../paraglide/messages.js";
import { anchorKey, type AnchorIndex } from "./anchors";
import { matchDiagramHosts, sourceNodeId } from "./diagramNodes";
import type { DocComment } from "./types";

export const MARKER_CLASS = "docwalk-comment-marker";
export const NODE_ATTR = "data-docwalk-comments";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Open comments per anchor key. */
export function openCounts(comments: readonly DocComment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments) {
    if (c.resolved) continue;
    const k = anchorKey(c.anchor);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Lucide's message-square, drawn here because these buttons live outside React. */
function icon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  );
  svg.append(path);
  return svg;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Adds a count button to each top-level heading under `article` that has
 * open comments. DOM headings are paired with the index by title, in
 * order, so a heading written as raw HTML (not in the index) is skipped
 * instead of shifting every marker after it.
 */
export function markHeadings(
  article: HTMLElement,
  index: AnchorIndex,
  comments: readonly DocComment[],
  onOpen: (slug: string) => void,
): void {
  for (const old of article.querySelectorAll(`.${MARKER_CLASS}`)) old.remove();
  const counts = openCounts(comments);
  let next = 0;
  for (const el of article.querySelectorAll<HTMLElement>(":scope > :is(h1, h2, h3, h4, h5, h6)")) {
    const title = normalize(el.textContent ?? "");
    let i = next;
    while (i < index.headings.length && index.headings[i]!.title !== title) i++;
    const target = index.headings[i];
    if (!target) continue;
    next = i + 1;
    const n = counts.get(anchorKey({ kind: "heading", slug: target.slug })) ?? 0;
    if (n === 0) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = MARKER_CLASS;
    button.setAttribute("aria-label", m.comments_marker({ count: n, title: target.title }));
    button.append(icon(), document.createTextNode(String(n)));
    button.addEventListener("click", () => onOpen(target.slug));
    el.append(button);
  }
}

/** Marks every commented node of every diagram under `container`; clears the mark from the rest. */
export function markDiagramNodes(
  container: ParentNode,
  index: AnchorIndex,
  comments: readonly DocComment[],
): void {
  const counts = openCounts(comments);
  for (const { host, target } of matchDiagramHosts(container, index)) {
    for (const g of host.querySelectorAll<SVGGElement>("svg g.node[id]")) {
      const node = sourceNodeId(g);
      const n =
        node === null
          ? 0
          : (counts.get(
              anchorKey({ kind: "node", heading: target.heading, diagram: target.diagram, node }),
            ) ?? 0);
      if (n > 0) g.setAttribute(NODE_ATTR, String(n));
      else g.removeAttribute(NODE_ATTR);
    }
  }
}
