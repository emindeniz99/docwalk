import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * remark-parse with GitHub's extensions to CommonMark (tables, task lists,
 * strikethrough, autolinks, footnotes) and, when `withMath` is true, the
 * `$…$` and `$$…$$` math forms (decision 101).
 *
 * remark-gfm and remark-math register these same extensions, with the same
 * defaults, plus a Markdown writer each. docwalk never writes a tree back to
 * Markdown, and the writers would bring mdast-util-to-markdown into the first
 * load (about 6 kB gzip, decision 43).
 */
export function markdownReader(withMath: boolean) {
  return unified()
    .use(remarkParse)
    .data("micromarkExtensions", withMath ? [gfm(), math()] : [gfm()])
    .data(
      "fromMarkdownExtensions",
      withMath ? [gfmFromMarkdown(), mathFromMarkdown()] : [gfmFromMarkdown()],
    );
}
