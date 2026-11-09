import GithubSlugger, { slug } from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { onlyComments } from "./notes";

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
  /** The anchor of every heading GitHub anchors, slide-opening or not (see `headingIds`). */
  headingIds: ReadonlyMap<Heading, string>;
  /**
   * Link reference and footnote definitions, wherever they appear. They are
   * not slide content: a slide that uses one gets it at render time, since
   * the definition usually sits in another section (often the last).
   */
  definitions: RootContent[];
  /**
   * The comment-only parts that open the document, before its first slide.
   * They open no slide (decision 107); `speakerNotes` gives their notes to
   * the first slide.
   */
  leadingComments: RootContent[];
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

/** Longest run of code points a fallback anchor spells out; longer headings are cut there. */
const FALLBACK_CODE_POINTS = 8;

/**
 * The address of a heading whose GitHub anchor is empty, because its text
 * has nothing the slugger keeps (`## 🚀`, `## ???`). GitHub gives such a
 * heading the anchor `#`, which cannot address a slide. The fallback spells
 * the text's code points in hex (`heading-1f680`): it depends on that
 * heading's own text only, like a slug, so it survives edits elsewhere and
 * never depends on the viewport.
 */
export function fallbackHeadingId(text: string): string {
  const points = [...text.replace(/\s+/g, "")]
    .slice(0, FALLBACK_CODE_POINTS)
    .map((c) => (c.codePointAt(0) as number).toString(16));
  return points.length > 0 ? `heading-${points.join("-")}` : "heading";
}

/**
 * The headings GitHub gives an anchor, in document order: every heading,
 * also inside a quote, an alert or a list item, except inside a footnote
 * definition (decision 107). GitHub prints footnotes after the text, so
 * leaving their headings out changes no other heading's number.
 */
export function anchoredHeadings(root: Root): Heading[] {
  const headings: Heading[] = [];
  visit(root, (node) => {
    if (node.type === "footnoteDefinition") return SKIP;
    if (node.type === "heading") headings.push(node);
  });
  return headings;
}

/**
 * The anchor of every heading in `anchoredHeadings`: GitHub's own
 * (github-slugger, with its duplicate numbering counted over those headings
 * in document order), or a `fallbackHeadingId` when GitHub's would be empty.
 * The sections take their ids from here, and the renderer writes them as
 * `id="user-content-<anchor>"`, so a link to a sub-heading can find the
 * slide that holds it.
 */
export function headingIds(root: Root): Map<Heading, string> {
  const slugger = new GithubSlugger();
  const ids = new Map<Heading, string>();
  const empty: Heading[] = [];
  const headings = anchoredHeadings(root);
  for (const node of headings) {
    const text = headingText(node);
    // Keep the slugger counting, so later duplicates get GitHub's numbers.
    const id = slugger.slug(text);
    // The counter turns a second empty slug into "-1"; the static slug says
    // whether the text itself had anything to keep.
    if (slug(text) === "") empty.push(node);
    else ids.set(node, id);
  }
  const used = new Set(ids.values());
  for (const node of empty) {
    const base = fallbackHeadingId(headingText(node));
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(node, id);
  }
  // Document order, so callers iterating the map see headings as written.
  return new Map(headings.map((n) => [n, ids.get(n)!]));
}

const isDefinition = (node: RootContent): boolean =>
  node.type === "definition" || node.type === "footnoteDefinition";

/** Split a parsed document into sections. Never splits with a regex: setext headings and fences are already nodes. */
export function sectionize(root: Root, option: LevelOption = "auto"): SectionPlan {
  const titleHeading = option === "auto" ? findTitleHeading(root) : null;
  const levels = resolveLevels(option, root, titleHeading);
  const minLevel = levels.length > 0 ? Math.min(...levels) : Number.POSITIVE_INFINITY;

  const slugs = headingIds(root);
  const definitions = root.children.filter(isDefinition);
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

    // Definitions render nothing where they stand; kept in `definitions`, so
    // a block of them after a break never becomes an empty slide.
    if (isDefinition(node)) continue;

    appendContent(node);
  }

  // A comment above the first heading (a linter directive, a note for the
  // cover) shows nothing, so the parts at the start that hold only comments
  // open no slide (decision 107).
  let lead = 0;
  while (sections[lead]?.heading === null && onlyComments(sections[lead]!.nodes)) lead++;
  const leadingComments = sections.slice(0, lead).flatMap((s) => s.nodes);
  // A title-level heading with no content of its own is a breadcrumb only.
  const kept = sections.slice(lead).filter((s) => s.kind !== "title" || s.nodes.length > 0);
  return { levels, titleHeading, sections: kept, headingIds: slugs, definitions, leadingComments };
}

function lineOf(node: RootContent): number {
  return node.position?.start.line ?? 1;
}
