import type { Parent, PhrasingContent, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * remark-math finds `$…$` with none of the guards GitHub applies, so
 * `It costs $5 and $10` would parse as a formula, and `$a_b$` has to stay out
 * of Markdown's reach. This runs once on the parsed tree and settles each
 * single-dollar span (decision 101):
 *
 * - `` $`…`$ `` loses its backticks; they only keep Markdown out of the way.
 * - A plain `$…$` stays math only under Pandoc's rules, which GitHub follows:
 *   no space right after the opening `$` or right before the closing one, and
 *   no digit right after the closing one. `$5 and $10` fails the second rule,
 *   `$20,000 and $30,000` the second as well.
 * - A span that fails is read again as ordinary Markdown, so `$5, **or** $10`
 *   keeps its bold text.
 *
 * `$$…$$` has no such rules and is left as it is.
 */
const plain = unified().use(remarkParse).use(remarkGfm);

export function settleInlineMath(tree: Root, source: string): void {
  visit(tree, "inlineMath", (node, index, parent) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (parent === undefined || index === undefined || start === undefined || end === undefined) {
      return;
    }
    const raw = source.slice(start, end);
    if (!raw.startsWith("$") || raw.startsWith("$$")) return;
    const inner = raw.slice(1, -1);
    if (inner.length > 2 && inner.startsWith("`") && inner.endsWith("`")) {
      const value = inner.slice(1, -1);
      node.value = value;
      // remark-rehype writes the node's `hChildren`, not `value`.
      const data = node.data as { hChildren?: { type: string; value?: string }[] } | undefined;
      const code = data?.hChildren?.[0];
      if (code?.type === "text") code.value = value;
      return;
    }
    const closedByDigit = /\d/.test(source[end] ?? "");
    if (!/^\s|\s$/.test(inner) && !closedByDigit && inner.length > 0) return;
    const replacement = reread(raw);
    (parent as Parent).children.splice(index, 1, ...replacement);
    return index + replacement.length;
  });
}

/** The span as Markdown without math: its inline nodes, or the plain text when it is not one paragraph. */
function reread(raw: string): PhrasingContent[] {
  const [paragraph, ...rest] = plain.parse(raw).children;
  if (paragraph?.type !== "paragraph" || rest.length > 0) return [{ type: "text", value: raw }];
  // Positions are relative to the span, which would mislead anything that reads them.
  visit(paragraph, (child) => {
    delete child.position;
  });
  return paragraph.children;
}
