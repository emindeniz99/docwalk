import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { describe, expect, test } from "vitest";
import { parseMarkdown } from "./sectionize";

/** Every math node in document order, as `[type, value]`. */
function mathOf(root: Root): [string, string][] {
  const found: [string, string][] = [];
  visit(root, (node) => {
    if (node.type === "inlineMath" || node.type === "math") found.push([node.type, node.value]);
  });
  return found;
}

/** Every node type in the tree, to see what a span turned into. */
function typesOf(root: Root): string[] {
  const types: string[] = [];
  visit(root, (node) => {
    types.push(node.type);
  });
  return types;
}

/** The text of `markdown` once parsed, after checking that it holds no math. */
function plain(markdown: string): string {
  const root = parseMarkdown(markdown);
  expect(mathOf(root)).toEqual([]);
  return toString(root);
}

describe("GitHub's four math forms", () => {
  test("$…$ is inline math", () => {
    expect(mathOf(parseMarkdown("Energy is $E = mc^2$ here."))).toEqual([
      ["inlineMath", "E = mc^2"],
    ]);
  });

  test("$`…`$ is inline math, and the backticks are not part of the formula", () => {
    // GitHub's own advice for formulas with underscores: the backticks keep Markdown out.
    expect(mathOf(parseMarkdown("Load is $`a_b + c_d`$ per node."))).toEqual([
      ["inlineMath", "a_b + c_d"],
    ]);
  });

  test("$$…$$ on its own lines is display math", () => {
    expect(mathOf(parseMarkdown("$$\n\\sum_{i=1}^{n} i\n$$\n"))).toEqual([
      ["math", "\\sum_{i=1}^{n} i"],
    ]);
  });

  test("a ```math fence stays a code node whose language is math", () => {
    const root = parseMarkdown("```math\n\\frac{1}{2}\n```\n");
    const code = root.children[0];
    expect(code).toMatchObject({ type: "code", lang: "math", value: "\\frac{1}{2}" });
    expect(mathOf(root)).toEqual([]);
  });

  test("underscores and asterisks inside a formula are not emphasis", () => {
    // Without a Markdown-level construct, `a_b … c_d` would become emphasis
    // before any math step could see it.
    const root = parseMarkdown("Both $a_b * c_d$ and $x*y*z$ count.");
    expect(mathOf(root)).toEqual([
      ["inlineMath", "a_b * c_d"],
      ["inlineMath", "x*y*z"],
    ]);
    expect(typesOf(root)).not.toContain("emphasis");
  });

  test("$$x$$ inside a sentence is inline math", () => {
    expect(mathOf(parseMarkdown("So $$x^2$$ follows."))).toEqual([["inlineMath", "x^2"]]);
  });
});

describe("dollar signs that are only money (GitHub does not make them math)", () => {
  test("$5 and $10 stays text", () => {
    // The opening $ is followed by a digit, but the closing one follows a space.
    expect(plain("It costs $5 and $10 in total.")).toBe("It costs $5 and $10 in total.");
  });

  test("$20,000 and $30,000 stays text", () => {
    expect(plain("Between $20,000 and $30,000.")).toBe("Between $20,000 and $30,000.");
  });

  test("a closing $ followed by a digit does not close", () => {
    expect(plain("The $x$5 pattern.")).toBe("The $x$5 pattern.");
  });

  test("a space after the opening $ or before the closing $ does not make math", () => {
    expect(plain("Not $ x$ math.")).toBe("Not $ x$ math.");
    expect(plain("Not $x $ math.")).toBe("Not $x $ math.");
  });

  test("an escaped dollar is a dollar", () => {
    expect(plain("Pay \\$5 and \\$10.")).toBe("Pay $5 and $10.");
  });

  test("a rejected pair keeps the Markdown between its dollars", () => {
    // `**or**` sat between the two dollars, where the math construct had
    // swallowed it as literal text.
    const root = parseMarkdown("It costs $5, **or** $10 later.");
    expect(mathOf(root)).toEqual([]);
    expect(typesOf(root)).toContain("strong");
    expect(toString(root)).toBe("It costs $5, or $10 later.");
  });

  test("a lone dollar stays text", () => {
    expect(plain("Only one $ here.")).toBe("Only one $ here.");
  });
});

describe("math in places that are code", () => {
  test("inline code keeps its dollars", () => {
    const root = parseMarkdown("Write `$x$` for math.");
    expect(mathOf(root)).toEqual([]);
    expect(typesOf(root)).toContain("inlineCode");
  });

  test("a fenced block keeps its dollars", () => {
    const root = parseMarkdown("```sh\necho $HOME and $PATH\n```\n");
    expect(mathOf(root)).toEqual([]);
    expect(root.children[0]).toMatchObject({ type: "code", value: "echo $HOME and $PATH" });
  });

  test("an indented code block keeps its dollars", () => {
    const root = parseMarkdown("Text\n\n    $$\n    x\n    $$\n");
    expect(mathOf(root)).toEqual([]);
  });
});

/** Milliseconds `parseMarkdown` takes for `markdown`. */
function time(markdown: string): number {
  const started = performance.now();
  parseMarkdown(markdown);
  return performance.now() - started;
}

describe("a document of rejected spans", () => {
  // Each rejected span used to run a full unified parse, even when it held
  // no Markdown at all: 500 KB of `$ a$ ` took 14.3 s, against 1.7 s for the
  // same length of plain words. The test compares the two on one machine, so
  // load moves both.
  test("parses in a small multiple of the time plain text takes", () => {
    const size = 100_000;
    const plainMs = time("word ".repeat(size / 5));
    const dollarMs = time("$ a$ ".repeat(size / 5));
    expect(dollarMs).toBeLessThan(plainMs * 5 + 250);
  });

  test("a rejected span without Markdown stays the text it was", () => {
    expect(plain("A $ x$ and $y $ and $5 or $10 here.")).toBe(
      "A $ x$ and $y $ and $5 or $10 here.",
    );
  });

  test.each([
    "$ [a](https://example.com/a)$",
    "$ https://example.com/a$",
    "$ www.example.com$",
    "$ mail me@example.com$",
    "$ <https://example.com/a>$",
  ])("a rejected span that holds a link or an address is still read: %s", (span) => {
    expect(typesOf(parseMarkdown(`See ${span} now.`))).toContain("link");
  });

  test("a rejected span with emphasis, strike-through, code or an escape is still read", () => {
    expect(typesOf(parseMarkdown("It $ *a* b$ here."))).toContain("emphasis");
    expect(typesOf(parseMarkdown("It $ ~~a~~ b$ here."))).toContain("delete");
    expect(typesOf(parseMarkdown("It $ `a` b$ here."))).toContain("inlineCode");
    expect(plain("It $ \\* b$ here.")).toBe("It $ * b$ here.");
    expect(plain("It $ a &amp; b$ here.")).toBe("It $ a & b$ here.");
  });

  test("a rejected span across two lines keeps its line break", () => {
    expect(plain("It $ a\nb$ here.")).toBe("It $ a\nb$ here.");
  });
});
