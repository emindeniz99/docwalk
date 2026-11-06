import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
// Same fonts as the app, so measurements match what users see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import "./content.css";
import { tokens } from "../design/tokens";
import type { DeckController } from "../deck/controller";
import { Deck, type DeckReport } from "../deck/Deck";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { codeLanguage, highlightCode, TOKEN_KINDS } from "./highlight";
import { nodesToHtml } from "./toHtml";

/**
 * Decision 76. Colours are only worth having if they never cost what the
 * rest of docwalk promises: the sanitizer stays authoritative (rule 5),
 * slides are measured as shown (rule 4), a block's text is the document's
 * own, and a language docwalk does not know renders exactly as before.
 */

declare global {
  interface Window {
    dwXssRan?: unknown;
  }
}

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  delete document.documentElement.dataset["theme"];
  delete window.dwXssRan;
});

/** Renders `markdown` through the real pipeline (both sanitizers) into `className`, attached. */
function render(markdown: string, className = "docwalk-slide-body"): HTMLElement {
  const box = document.createElement("div");
  box.className = className;
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(box);
  return box;
}

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\`\n`;
const colourOf = (el: Element) => getComputedStyle(el).color;
const surface = (el: Element) => getComputedStyle(el).backgroundColor;
const keywordIn = (box: Element) => box.querySelector(".dw-code-keyword")!;
const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

const TS = [
  "// Retry with a budget",
  "export async function retry(budget: number): Promise<string> {",
  '  const label = "attempt";',
  "  return `${label} ${budget * 2}`;",
  "}",
].join("\n");

describe("a TypeScript block gets GitHub's colours", () => {
  test("keywords, strings, comments and numbers each get their own colour", async () => {
    const box = render(fence("ts", TS));
    await highlightCode(box);
    const code = box.querySelector("pre > code")!;
    const kind = (text: string) =>
      [...code.querySelectorAll("span")].find((s) => s.textContent?.includes(text));
    const keyword = kind("const")!;
    const string = kind('"attempt"')!;
    const comment = kind("Retry with a budget")!;
    const number = kind("2")!;
    expect(keyword.className).toBe("dw-code-keyword");
    expect(string.className).toBe("dw-code-string");
    expect(comment.className).toBe("dw-code-comment");
    expect(number.className).toBe("dw-code-constant");
    // The slide is white in every theme, so it shows the light set.
    expect(colourOf(keyword)).toBe(rgb(tokens.colors["code-keyword"]));
    expect(colourOf(string)).toBe(rgb(tokens.colors["code-string"]));
    expect(colourOf(comment)).toBe(rgb(tokens.colors["code-comment"]));
    const colours = new Set([keyword, string, comment, number].map(colourOf));
    expect(colours.size).toBe(4);
    expect(colours.has(colourOf(code))).toBe(false);
  });

  test("the block's text, and so what a copy takes, is exactly the source", async () => {
    const box = render(fence("ts", TS));
    const code = box.querySelector("pre > code")!;
    const before = code.textContent;
    await highlightCode(box);
    expect(code.querySelector("span")).not.toBeNull();
    expect(code.textContent).toBe(before);
    expect(code.textContent).toBe(`${TS}\n`);
    const range = document.createRange();
    range.selectNodeContents(code);
    expect(range.toString()).toBe(`${TS}\n`);
  });

  test("only class-bearing spans are added, from the known set", async () => {
    const box = render(fence("ts", TS) + fence("diff", "-old\n+new"));
    await highlightCode(box);
    const allowed = new Set(TOKEN_KINDS.map((k) => `dw-code-${k}`));
    for (const el of box.querySelectorAll("pre > code *")) {
      expect(el.tagName).toBe("SPAN");
      expect([...el.attributes].map((a) => a.name)).toEqual(["class"]);
      expect(allowed.has(el.className)).toBe(true);
      expect(el.children.length).toBe(0);
    }
  });

  test("highlighting a block twice leaves it as the first pass did", async () => {
    const box = render(fence("ts", TS));
    await highlightCode(box);
    const once = box.innerHTML;
    await highlightCode(box);
    expect(box.innerHTML).toBe(once);
  });
});

describe("languages", () => {
  test("GitHub's short names reach their grammar", () => {
    expect(codeLanguage("ts")).toBe("typescript");
    expect(codeLanguage("TypeScript")).toBe("typescript");
    expect(codeLanguage("sh")).toBe("shellscript");
    expect(codeLanguage("bash")).toBe("shellscript");
    expect(codeLanguage("yml")).toBe("yaml");
    expect(codeLanguage("py")).toBe("python");
    expect(codeLanguage("c#")).toBe("csharp");
    expect(codeLanguage("dockerfile")).toBe("docker");
    // Lookups go through a Map: an inherited property name is not a language.
    expect(codeLanguage("constructor")).toBeNull();
    expect(codeLanguage("__proto__")).toBeNull();
  });

  const SAMPLES: [string, string][] = [
    ["sh", 'echo "hello" # greet'],
    ["yml", "name: docwalk # app\nreplicas: 3"],
    ["py", 'def go(n):\n    return "x" * n  # repeat'],
    ["json", '{"retries": 3, "name": "ledger"}'],
    ["go", 'func main() { fmt.Println("hi") }'],
    ["rust", 'fn main() { let x = 5; println!("{}", x); }'],
    ["sql", "SELECT id FROM ledger WHERE amount > 10; -- big"],
    ["kotlin", 'fun main() { val s = "k" }'],
    ["java", 'class A { String s = "j"; }'],
    ["swift", 'let s = "swift" // note'],
    ["cpp", "int main() { return 0; } // c++"],
    ["csharp", 'var s = "c#"; // note'],
    ["toml", 'name = "docwalk" # app'],
    ["html", '<a href="/x">link</a>'],
    ["css", ".a { color: red; } /* note */"],
    ["markdown", "# Title\n\n**bold** text"],
    ["dockerfile", "FROM node:24\nRUN echo hi"],
    ["graphql", "query { user(id: 1) { name } }"],
    ["tsx", 'const a = <div className="x">{n}</div>;'],
    ["jsx", 'const a = <div className="x">{n}</div>;'],
    ["js", 'const a = "js"; // note'],
    ["c", "int main(void) { return 0; } /* c */"],
  ];

  test.each(SAMPLES)("%s blocks are coloured", async (lang, code) => {
    const box = render(fence(lang, code));
    await highlightCode(box);
    const block = box.querySelector("pre > code")!;
    expect(block.querySelectorAll("span[class^='dw-code-']").length).toBeGreaterThan(0);
    expect(block.textContent).toBe(`${code}\n`);
  });

  test("a language docwalk has no grammar for renders exactly as before", async () => {
    const markdown = fence("promql", "rate(http_requests_total[5m])") + fence("", "plain text");
    const box = render(markdown);
    const before = box.innerHTML;
    await highlightCode(box);
    expect(box.innerHTML).toBe(before);
  });

  test("a diff shows added and removed lines on their own surfaces", async () => {
    const box = render(fence("diff", " context\n-removed line\n+added line"));
    await highlightCode(box);
    const added = box.querySelector(".dw-code-inserted")!;
    const removed = box.querySelector(".dw-code-deleted")!;
    expect(added.textContent).toContain("added line");
    expect(removed.textContent).toContain("removed line");
    expect(surface(added)).toBe(rgb(tokens.colors["code-inserted-surface"]));
    expect(surface(removed)).toBe(rgb(tokens.colors["code-deleted-surface"]));
    expect(colourOf(added)).not.toBe(colourOf(removed));
  });
});

describe("themes", () => {
  test("document mode switches to the dark set with the theme; a slide keeps the light one", async () => {
    document.documentElement.dataset["theme"] = "dark";
    const doc = render(fence("ts", TS), "docwalk-document");
    const slide = render(fence("ts", TS));
    await highlightCode(document.body);
    expect(colourOf(keywordIn(doc))).toBe(rgb(tokens.colors["code-keyword-dark"]));
    expect(colourOf(keywordIn(slide))).toBe(rgb(tokens.colors["code-keyword"]));
    document.documentElement.dataset["theme"] = "light";
    expect(colourOf(keywordIn(doc))).toBe(rgb(tokens.colors["code-keyword"]));
  });
});

describe("hostile code blocks stay text (rule 5)", () => {
  const RUN = "dwXssRan=1";
  const CASES: [string, string][] = [
    ["closing tags inside a block", fence("html", `</code></pre><script>${RUN}</script>`)],
    ["an image handler inside a block", fence("js", `<img src=x onerror="${RUN}">`)],
    ["a handler in the info string", fence(`js onerror=${RUN}`, "const a = 1;")],
    ["markup in the language name", fence(`"><svg onload=${RUN}>`, "x")],
    ["markup after a known language", fence(`ts"><img src=x onerror=${RUN}>`, "let a = 1;")],
  ];

  test.each(CASES)("%s", async (_name, markdown) => {
    const box = render(markdown);
    const text = box.querySelector("pre")?.textContent;
    await highlightCode(box);
    await new Promise((r) => setTimeout(r, 50));
    expect(window.dwXssRan).toBeUndefined();
    expect(box.querySelectorAll("script, img, svg, iframe").length).toBe(0);
    for (const el of box.querySelectorAll("*")) {
      for (const attr of el.attributes) expect(attr.name.startsWith("on")).toBe(false);
    }
    expect(box.querySelector("pre")?.textContent).toBe(text);
  });
});

describe("colours are in place before the deck measures (rule 4)", () => {
  // Far taller than an empty slide: the block must get a page of its own
  // and a diagnostic, coloured or not (decision 19).
  const TALL = Array.from({ length: 60 }, (_, i) => `const step${i} = "value ${i}"; // ${i}`);
  const MARKDOWN = `## Intro\n\nShort text.\n\n## Code\n\nBefore the block.\n\n${fence("ts", TALL.join("\n"))}`;

  test("pages are cut from coloured slides, and a too-tall block is still flagged", async () => {
    const container = document.createElement("div");
    Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
    document.body.append(container);
    root = createRoot(container);
    let controller: DeckController | null = null;
    let report: DeckReport | null = null;
    root.render(
      h(Deck, {
        plan: sectionize(parseMarkdown(MARKDOWN), "auto"),
        onReady: (c: DeckController | null) => {
          controller = c;
        },
        onReport: (r: DeckReport) => {
          report = r;
        },
      }),
    );
    await expect.poll(() => controller, { timeout: 20_000 }).not.toBeNull();
    // Pagination copies the slides it measured; colour that arrived later
    // would be missing from these copies.
    const blocks = container.querySelectorAll(".reveal .slides section pre > code");
    expect(blocks.length).toBe(1);
    const keywords = [...blocks[0]!.querySelectorAll(".dw-code-keyword")];
    expect(keywords.filter((k) => k.textContent === "const").length).toBe(60);
    const flagged = controller!.slides().filter((s) => s.flagged);
    expect(flagged.map((s) => s.sectionId)).toEqual(["code"]);
    expect(report!.overflowing.map((o) => o.id)).toEqual(["code/2"]);
  });

  test("colouring a block changes none of its measurements", async () => {
    const box = render(fence("ts", TALL.join("\n")));
    const pre = box.querySelector("pre")!;
    Object.assign(box.style, { width: "1100px" });
    const measure = () => [pre.scrollWidth, pre.scrollHeight, pre.getBoundingClientRect().height];
    await document.fonts.ready;
    const plain = measure();
    await highlightCode(box);
    expect(box.querySelector(".dw-code-keyword")).not.toBeNull();
    expect(measure()).toEqual(plain);
  });
});
