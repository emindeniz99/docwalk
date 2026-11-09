import { languages } from "monaco-editor/editor";
import { conf, language } from "monaco-editor/languages/definitions/markdown/markdown";

/**
 * Monaco's Markdown grammar with one change: a list item's own paragraphs are
 * not code. The stock grammar colours every line with a 4-space indent as
 * code, so the second paragraph of a list item reads as a code block, which
 * CommonMark and CodeMirror's parser (Lezer) do not. A line belongs to the
 * item when it is indented at least as far as the item's content; it is code
 * only 4 columns further in.
 *
 * Monarch cannot compute with numbers, so each content offset (the width of
 * the marker and the spaces after it, plus the marker's own indent) is a
 * state of its own, `item2` to `item16`; a deeper offset counts as 16.
 * Everything not about list items is the stock grammar, taken from the
 * package: the same states, in the same order. A tab ends the item here
 * (the stock grammar read that line as code too), and so does a line
 * indented less than the content offset.
 */

const MARKER = String.raw`(?:[*+-]|\d+\.)`;
const MAX_OFFSET = 16;
type Rule = languages.IMonarchLanguageRule;

/** The list marker rule: the width of the marker line picks the state for the item's lines. */
function itemStart(enter: "next" | "switchTo"): Rule {
  const cases: Record<string, { token: string } & Record<string, string>> = {};
  for (let width = 2; width < MAX_OFFSET; width++)
    cases[`$1~.{${width}}`] = { token: "keyword", [enter]: `@item${width}` };
  cases["@default"] = { token: "keyword", [enter]: `@item${MAX_OFFSET}` };
  // The lookahead measures the whole content offset; the match is what the stock rule coloured.
  return [new RegExp(String.raw`^(?=( *${MARKER} {1,4}))( *${MARKER} )`), { cases }];
}

/** What a list item's lines do at content offset `width`. */
function itemState(width: number): Rule[] {
  return [
    // Four columns past the content: code inside the item.
    [new RegExp(String.raw`^ {${width + 4}} *\S.*$`), "string"],
    itemStart("switchTo"),
    // A marker the rule above does not measure (a tab after it, a colon): the stock rule reads it.
    [/^\s*(?:[*\-+:]|\d+\.)\s/, { token: "@rematch", next: "@pop" }],
    // Less indented than the content: the item has ended.
    [new RegExp(String.raw`^(?! {${width}})\s*\S`), { token: "@rematch", next: "@pop" }],
    { include: "@blocks" },
    { include: "@fences" },
    { include: "@linecontent" },
  ];
}

const tokenizer: languages.IMonarchLanguage["tokenizer"] = {
  ...language.tokenizer,
  // The stock root, split so the list states can share its blocks.
  blocks: [
    // markdown tables
    [/^\s*\|/, "@rematch", "@table_header"],
    // headers (with #)
    [/^(\s{0,3})(#+)((?:[^#]|@escapes)+)((?:#+)?)/, ["white", "keyword", "keyword", "keyword"]],
    // headers (with =)
    [/^\s*(=+|-+)\s*$/, "keyword"],
    // headers (with ***)
    [/^\s*((\*[ ]?)+)\s*$/, "meta.separator"],
    // quote
    [/^\s*>+/, "comment"],
  ],
  fences: [
    // code block (3 tilde)
    [/^\s*~~~\s*((?:\w|[/\-#])+)?\s*$/, { token: "string", next: "@codeblock" }],
    // github style code blocks (with backticks and language)
    [
      /^\s*```\s*((?:\w|[/\-#])+).*$/,
      { token: "string", next: "@codeblockgh", nextEmbedded: "$1" },
    ],
    // github style code blocks (with backticks but no language)
    [/^\s*```\s*$/, { token: "string", next: "@codeblock" }],
  ],
  root: [
    { include: "@blocks" },
    itemStart("next"),
    // list (starting with * or number), the stock rule for what the one above cannot measure
    [/^\s*([*\-+:]|\d+\.)\s/, "keyword"],
    // code block (4 spaces indent)
    [/^(\t|[ ]{4})[^ ].*$/, "string"],
    { include: "@fences" },
    { include: "@linecontent" },
  ],
};
for (let width = 2; width <= MAX_OFFSET; width++) tokenizer[`item${width}`] = itemState(width);

const markdownGrammar: languages.IMonarchLanguage = {
  ...language,
  start: "root",
  tokenizer,
};

/** Registers `markdown` with the grammar above and the stock language configuration. */
export function registerMarkdown(): void {
  languages.register({
    id: "markdown",
    extensions: [".md", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn", ".mdtxt", ".mdtext"],
    aliases: ["Markdown", "markdown"],
  });
  languages.setLanguageConfiguration("markdown", conf);
  languages.setMonarchTokensProvider("markdown", markdownGrammar);
}
