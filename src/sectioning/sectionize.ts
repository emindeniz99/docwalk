import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type HeadingDepth = Heading["depth"];

/** How slides are started: picked from the document (`auto`), one level, or a list of levels. */
export type LevelOption = "auto" | HeadingDepth | readonly HeadingDepth[];

/**
 * - `cover`: the document title heading (a lone top-level heading) with its intro.
 * - `title`: a heading above the slide level that carries its own content.
 * - `content`: a normal slide-starting section, or a part created by a thematic break.
 */
export type SectionKind = "cover" | "title" | "content";

export interface Section {
  /** Stable id: the heading's GitHub anchor, or `<previous-id>-part-<n>` after a thematic break. */
  id: string;
  kind: SectionKind;
  /** The heading that opened the section; `null` for leading content and thematic-break parts. */
  heading: Heading | null;
  /** Plain-text title: the heading text, or the title of the section a part continues. */
  title: string;
  /** Titles of the enclosing headings, outermost first. */
  breadcrumb: string[];
  /** Body nodes in document order, without the opening heading. */
  nodes: RootContent[];
  /** 1-based source line where the section starts, for editor sync. */
  line: number;
}

export interface SectionPlan {
  /** The resolved slide levels; empty when the document has no headings. */
  levels: HeadingDepth[];
  /** The heading treated as the document title, if any. */
  titleHeading: Heading | null;
  sections: Section[];
}

/**
 * Heading text as a reader sees it: a setext heading can span lines, and a
 * soft line break renders as a space. Assumed to match GitHub's anchor input;
 * not yet checked against github.com for multi-line headings.
 */
export function headingText(heading: Heading): string {
  return toString(heading).replace(/\s+/g, " ").trim();
}

export function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown);
}

/**
 * The document title is the only H1, when it comes before every other
 * heading: the shape of a typical GitHub README (`# Name`, intro, then `##`
 * sections). It becomes the cover, so the slide level is picked from the
 * headings under it. Only H1 qualifies: a document whose single H2 is
 * followed by H3s is a section with subsections, not a titled document.
 */
export function findTitleHeading(root: Root): Heading | null {
  const headings = root.children.filter((n): n is Heading => n.type === "heading");
  const first = headings[0];
  if (!first || first.depth !== 1 || headings.length < 2) return null;
  return headings.filter((h) => h.depth === 1).length === 1 ? first : null;
}

/**
 * Pandoc's rule: the slide level is the highest heading level that is
 * followed immediately by content rather than by another heading
 * (https://pandoc.org/MANUAL.html#structuring-the-slide-show). The document
 * title heading is skipped, so a README-shaped document gets `##` slides.
 */
export function autoSlideLevel(
  root: Root,
  titleHeading = findTitleHeading(root),
): HeadingDepth | null {
  let level: HeadingDepth | null = null;
  const children = root.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node?.type !== "heading" || node === titleHeading) continue;
    const next = children[i + 1];
    if (next && next.type !== "heading" && next.type !== "thematicBreak") {
      if (level === null || node.depth < level) level = node.depth;
    }
  }
  return level;
}

function resolveLevels(
  option: LevelOption,
  root: Root,
  titleHeading: Heading | null,
): HeadingDepth[] {
  if (option === "auto") {
    const level = autoSlideLevel(root, titleHeading);
    return level === null ? [] : [level];
  }
  if (typeof option === "number") return [option];
  return [...new Set(option)].toSorted((a, b) => a - b);
}

/** Split a parsed document into sections. Never splits with a regex: setext headings and fences are already nodes. */
export function sectionize(root: Root, option: LevelOption = "auto"): SectionPlan {
  const titleHeading = option === "auto" ? findTitleHeading(root) : null;
  const levels = resolveLevels(option, root, titleHeading);
  const minLevel = levels.length > 0 ? Math.min(...levels) : Number.POSITIVE_INFINITY;

  // GitHub numbers duplicate anchors across every heading in document order,
  // so slug all of them, deep ones included, to stay link-compatible.
  const slugger = new GithubSlugger();
  const slugs = new Map<Heading, string>();
  for (const node of root.children) {
    if (node.type === "heading") slugs.set(node, slugger.slug(headingText(node)));
  }
  const usedIds = new Set(slugs.values());
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };

  const sections: Section[] = [];
  const stack: Heading[] = [];
  let current: Section | null = null;
  let partCount = 0;
  let lastOpened: Section | null = null;

  const breadcrumbFor = (depth: number) => stack.filter((h) => h.depth < depth).map(headingText);
  const push = (section: Section) => {
    sections.push(section);
    current = section;
  };

  // Body content goes into the open section. After a thematic break there is
  // none, so the content starts a part that continues the last opened section
  // (or, before any slide heading, a leading section).
  const appendContent = (node: RootContent) => {
    if (current) {
      current.nodes.push(node);
      return;
    }
    if (lastOpened) {
      partCount += 1;
      push({
        id: uniqueId(`${lastOpened.id}-part-${partCount}`),
        kind: "content",
        heading: null,
        title: lastOpened.title,
        breadcrumb: [...lastOpened.breadcrumb],
        nodes: [node],
        line: lineOf(node),
      });
      return;
    }
    const id = uniqueId(sections.length === 0 ? "intro" : `slide-${sections.length + 1}`);
    push({
      id,
      kind: "content",
      heading: null,
      title: "",
      breadcrumb: [],
      nodes: [node],
      line: lineOf(node),
    });
  };

  for (const node of root.children) {
    if (node.type === "heading") {
      while (stack.length > 0 && (stack.at(-1) as Heading).depth >= node.depth) stack.pop();
      const breadcrumb = breadcrumbFor(node.depth);
      stack.push(node);

      const opensSlide =
        node === titleHeading || node.depth < minLevel || levels.includes(node.depth);
      if (!opensSlide) {
        appendContent(node);
        continue;
      }
      const kind: SectionKind =
        node === titleHeading ? "cover" : node.depth < minLevel ? "title" : "content";
      const section: Section = {
        id: slugs.get(node) as string,
        kind,
        heading: node,
        title: headingText(node),
        breadcrumb,
        nodes: [],
        line: lineOf(node),
      };
      push(section);
      lastOpened = section;
      partCount = 1;
      continue;
    }

    if (node.type === "thematicBreak") {
      // A real thematic break forces a slide. The next part keeps the title
      // and breadcrumb of the section it continues.
      current = null;
      continue;
    }

    appendContent(node);
  }

  // A title-level heading with no content of its own is a breadcrumb only.
  const kept = sections.filter((s) => s.kind !== "title" || s.nodes.length > 0);
  return { levels, titleHeading, sections: kept };
}

function lineOf(node: RootContent): number {
  return node.position?.start.line ?? 1;
}
