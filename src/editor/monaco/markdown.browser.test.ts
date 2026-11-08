import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { editor as monaco } from "monaco-editor/editor";
import { describe, expect, test } from "vitest";
// Importing the editor registers its Markdown grammar, however it is wired.
import "./MonacoEditor";

/**
 * Which lines are code, as the two editors read the same Markdown. The
 * source editor is the only place a viewer sees both colourings, so a line
 * that is a list item's paragraph in one and code in the other looks like a
 * bug in Monaco. CodeMirror's parser (Lezer) is the reference reading.
 */

/** 1-based lines Lezer parses as an indented code block. */
function codeLinesInCodeMirror(source: string): number[] {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
  const lines = new Set<number>();
  tree.iterate({
    enter(node) {
      if (node.name !== "CodeBlock") return;
      const first = state.doc.lineAt(node.from).number;
      const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
      for (let n = first; n <= last; n++) lines.add(n);
    },
  });
  return [...lines].toSorted((a, b) => a - b);
}

/**
 * 1-based lines whose first token Monaco colours as the Markdown "code"
 * string. Fence lines get the same token and are not indented code, so they
 * are left out.
 */
async function codeLinesInMonaco(source: string): Promise<number[]> {
  // Waits until the grammar is registered and loaded, wherever it comes from.
  await monaco.colorize("", "markdown", {});
  const text = source.split("\n");
  return monaco
    .tokenize(source, "markdown")
    .flatMap((tokens, i) =>
      tokens[0]?.type === "string.md" && !/^\s*(?:```|~~~)/.test(text[i] ?? "") ? [i + 1] : [],
    );
}

const cases: [name: string, source: string, code: number[]][] = [
  [
    "a paragraph continued under a bullet with four spaces is text",
    "- item\n\n    continued paragraph\n",
    [],
  ],
  [
    "a paragraph continued under a numbered item with four spaces is text",
    "1. item\n\n    continued paragraph\n",
    [],
  ],
  ["a nested bullet at four spaces is a list item", "- item\n    - nested bullet\n", []],
  [
    "four spaces after a plain paragraph is still code",
    "Paragraph\n\n    real code\n",
    [3],
  ],
  [
    "code indented deeper inside a list item is code",
    "- item\n\n        code inside the item\n",
    [3],
  ],
  [
    "four spaces after the list has ended is code",
    "- item\n\ntext after the list\n\n    code after the list\n",
    [5],
  ],
  [
    "a fenced block in a list item does not end the item",
    "- item\n\n  ```\n  fenced\n  ```\n\n    still the item\n",
    [],
  ],
];

describe("Markdown source colouring: indented code against CodeMirror", () => {
  test.each(cases)("%s", async (_name, source, code) => {
    expect(codeLinesInCodeMirror(source)).toEqual(code);
    expect(await codeLinesInMonaco(source)).toEqual(code);
  });
});
