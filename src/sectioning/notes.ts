import type { Html, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";
import type { SectionPlan } from "./sectionize";

/**
 * Speaker notes (decision 79): the HTML comments of a section. GitHub hides
 * them, so the Markdown file stays the one GitHub shows. They are read from
 * the parsed tree, so a `<!--` in a code block is code, and they leave this
 * module as plain strings for the presenter window to print as text.
 */

/**
 * Comments that tell a tool what to do and say nothing to an audience. The
 * list is checked against a comment's first word only; extend it here.
 */
const TOOL_DIRECTIVE =
  /^(?:prettier-ignore(?:-start|-end)?|markdownlint-\S+|eslint-\S+|textlint-\S+|cspell:\S+|\/?toc|tocstop)(?=\s|$)/i;

export function isToolDirective(text: string): boolean {
  return TOOL_DIRECTIVE.test(text.trim());
}

/**
 * A comment ends at `-->` or `--!>`, and `<!-->` and `<!--->` are empty ones,
 * as in a browser. The search starts inside the opener so those two match.
 */
const COMMENT_END = /--!?>/g;

/**
 * The text of every closed comment in a piece of raw HTML, and what is left
 * of the HTML without them. A comment that is never closed stays in `rest`:
 * it is not a note.
 */
function comments(html: string): { texts: string[]; rest: string } {
  const texts: string[] = [];
  let rest = "";
  let from = 0;
  for (;;) {
    const open = html.indexOf("<!--", from);
    if (open === -1) break;
    COMMENT_END.lastIndex = open + 2;
    const end = COMMENT_END.exec(html);
    if (!end) break;
    const start = open + 4;
    texts.push(end.index >= start ? html.slice(start, end.index) : "");
    rest += html.slice(from, open);
    from = end.index + end[0].length;
  }
  return { texts, rest: rest + html.slice(from) };
}

interface Found {
  notes: string[];
  /** True when the nodes hold comments and nothing else (directives and empty comments count). */
  onlyComments: boolean;
}

function scan(nodes: readonly RootContent[]): Found {
  const root: Root = { type: "root", children: nodes as RootContent[] };
  const notes: string[] = [];
  let onlyComments = true;
  visit(root, (node) => {
    if (node.type === "html") {
      const { texts, rest } = comments((node as Html).value);
      if (rest.trim() !== "") onlyComments = false;
      for (const raw of texts) {
        const text = raw.trim();
        if (text !== "" && !isToolDirective(text)) notes.push(text);
      }
    } else if (node.type === "text") {
      if (node.value.trim() !== "") onlyComments = false;
    } else if (node.type !== "root" && node.type !== "paragraph") {
      onlyComments = false;
    }
  });
  return { notes, onlyComments };
}

/**
 * The notes of each section that has any, by section id. A note belongs to
 * the section whose nodes hold it. A slide with no heading and nothing but
 * comments (what a comment above the first heading opens) passes its notes
 * to the next slide, so a note above the cover reaches the cover.
 */
export function speakerNotes(plan: SectionPlan): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let carried: string[] = [];
  for (const section of plan.sections) {
    const found = scan(section.nodes);
    const notes = [...carried, ...found.notes];
    carried = [];
    if (section.heading === null && found.onlyComments) carried = notes;
    else if (notes.length > 0) result.set(section.id, notes);
  }
  // Nothing follows the last slide, so what it could not pass on stays with it.
  const last = plan.sections.at(-1);
  if (last && carried.length > 0) result.set(last.id, carried);
  return result;
}
