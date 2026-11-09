import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown } from "../sectioning/sectionize";
import { renderEmoji } from "./emoji";
import { MATH_CLASS, MATH_DISPLAY_CLASS, MATH_ERROR_CLASS, renderMath } from "./math";
import { MATHML_NS, MATH_CLASSES, MATH_ELEMENTS, mathAttributeAllowed } from "./mathAllow";
import { MAX_TEX_CHARS } from "./mathTree";
import { nodesToHtml } from "./toHtml";

/**
 * Rule 5 for decision 101: hostile TeX through the whole path a slide takes
 * (parse, remark-rehype, both sanitizers, renderMath and renderEmoji), then
 * a look at every element that came out and every URL anything tried to set
 * on the way. Nothing may leave an `href`, `src`, `style`, event handler,
 * `id` or unlisted class, or start a request. These tests hold the line
 * whatever Temml does with a command: most fail and keep their source as
 * text, a few draw without the parts that asked for more.
 */

declare global {
  interface Window {
    dwXssRan?: unknown;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete window.dwXssRan;
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** The only HTML a formula's path leaves: the paragraph, the source it keeps, the display block. */
const HTML_ELEMENTS = new Set(["div", "p", "code", "pre"]);
const HTML_CLASSES = new Set(["language-math", MATH_ERROR_CLASS, MATH_DISPLAY_CLASS]);

/** Everything under `box` a formula may not leave behind, one line each. */
function unsafeIn(box: Element): string[] {
  const found: string[] = [];
  for (const el of box.querySelectorAll("*")) {
    const tag = `<${el.localName}>`;
    const math = el.namespaceURI === MATHML_NS;
    if (math ? !MATH_ELEMENTS.has(el.localName) : !HTML_ELEMENTS.has(el.localName)) {
      found.push(`${tag} element`);
    }
    if (!math && el.namespaceURI !== HTML_NS) found.push(`${tag} in ${el.namespaceURI}`);
    for (const { name, value } of el.attributes) {
      if (name === "class") {
        const known = math
          ? (c: string) => MATH_CLASSES.has(c) || c === MATH_CLASS
          : HTML_CLASSES.has.bind(HTML_CLASSES);
        const extra = value.split(/\s+/).filter((c) => c && !known(c));
        if (extra.length > 0) found.push(`class ${extra.join(" ")} on ${tag}`);
      } else if (!math || !mathAttributeAllowed(name, value)) {
        // HTML here carries a class or nothing; MathML only listed names and values.
        found.push(`${name}="${value}" on ${tag}`);
      }
    }
  }
  if (window.dwXssRan !== undefined) found.push("a script ran");
  return found;
}

const URL_NAME = /^(?:src|srcset|href|xlink:href|data|poster|action|formaction|background)$/i;

/**
 * Starts recording every URL set on an element, by attribute or by property,
 * while a formula is built. Temml runs in a worker and makes no elements;
 * this is the second witness that the page's own rebuild makes none that load.
 * A same-page fragment (`#x`, Temml's `\ref`) fetches nothing and is left out.
 */
function watchUrls(): () => string[] {
  const attribute = vi.spyOn(Element.prototype, "setAttribute");
  const attributeNS = vi.spyOn(Element.prototype, "setAttributeNS");
  const setters = [
    vi.spyOn(HTMLImageElement.prototype, "src", "set"),
    vi.spyOn(HTMLImageElement.prototype, "srcset", "set"),
    vi.spyOn(HTMLAnchorElement.prototype, "href", "set"),
    vi.spyOn(HTMLScriptElement.prototype, "src", "set"),
    vi.spyOn(HTMLIFrameElement.prototype, "src", "set"),
    vi.spyOn(HTMLLinkElement.prototype, "href", "set"),
  ];
  return () => {
    const named = [
      ...attribute.mock.calls.map(([name, value]) => [name, value] as const),
      ...attributeNS.mock.calls.map(([, name, value]) => [name, value] as const),
    ].filter(([name]) => URL_NAME.test(name));
    const values = [
      ...named.map(([, value]) => value),
      ...setters.flatMap((s) => s.mock.calls.map(([v]) => v)),
    ];
    return values.map(String).filter((value) => !value.startsWith("#"));
  };
}

interface Rendered {
  box: HTMLElement;
  /** URLs anything set on an element while the formulas were built. */
  urls: string[];
}

/** `markdown` through the slide's whole path, attached to the page. */
async function render(markdown: string): Promise<Rendered> {
  const box = document.createElement("div");
  box.className = "docwalk-slide-body";
  document.body.append(box);
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  const urls = watchUrls();
  await Promise.all([renderMath(box), renderEmoji(box)]);
  const seen = urls();
  vi.restoreAllMocks();
  return { box, urls: seen };
}

/** Resource Timing for the trap host: a second witness that nothing was fetched. */
const fetchedTraps = () =>
  performance.getEntriesByType("resource").filter((entry) => entry.name.includes("trap.example"));

const failedSources = (box: Element) =>
  [...box.querySelectorAll(`code.${MATH_ERROR_CLASS}`)].map((code) => code.textContent);

describe("commands that ask for links, images, styles, ids or data", () => {
  // Temml's `\includegraphics`, `\class`, `\id`, `\style` and `\data` need
  // `trust`; Temml 0.14 has no `\href` or `\url` (they stay in case an
  // upgrade brings them back); the `\html…`, `\cssId` and `\unicode` names
  // are KaTeX's and MathJax's. Either way: source as text.
  const refused: [string, string][] = [
    ["\\href", "\\href{https://trap.example/a}{click}"],
    ["\\url", "\\url{https://trap.example/b}"],
    ["\\includegraphics", "\\includegraphics{https://trap.example/c.png}"],
    [
      "\\includegraphics with options",
      "\\includegraphics[width=1em,alt=x]{https://trap.example/d.png}",
    ],
    ["\\htmlClass", "\\htmlClass{docwalk-diagram}{x}"],
    ["\\htmlId", "\\htmlId{user-content-x}{x}"],
    ["\\htmlStyle", "\\htmlStyle{background:url(https://trap.example/e.png)}{x}"],
    ["\\htmlData", "\\htmlData{foo=bar}{x}"],
    ["\\class", "\\class{docwalk-diagram present}{x}"],
    ["\\style", "\\style{background:url(https://trap.example/f.png)}{x}"],
    ["\\id", "\\id{user-content-x}{x}"],
    ["\\data", "\\data{foo=bar}{x}"],
    ["\\cssId", "\\cssId{user-content-x}{x}"],
    ["\\unicode", "\\unicode{x3C}"],
    ["\\color with a CSS tail", "\\color{red;background:url(https://trap.example/g.png)}{x}"],
    [
      "\\textcolor with a CSS tail",
      "\\textcolor{red;background:url(https://trap.example/h.png)}{x}",
    ],
    ["\\colorbox with a CSS tail", "\\colorbox{red;background:url(https://trap.example/i.png)}{x}"],
    ["\\color with a URL", "\\color{url(https://trap.example/j.png)}{x}"],
    ["\\href renamed by \\let", "\\let\\go\\href\\go{https://trap.example/k}{x}"],
    ["\\href in a macro", "\\def\\go{\\href{https://trap.example/l}{x}}\\go"],
    ["\\href in \\text", "\\text{\\href{https://trap.example/m}{x}}"],
    ["\\href in a \\tag", "\\tag{\\href{https://trap.example/n}{x}} y"],
    ["\\class in \\text", "\\text{\\class{present}{x}}"],
    // Temml builds these as an HTML <a href="#…">, not as MathML, so the rebuild refuses them.
    ["\\ref", "\\ref{user-content-x}"],
    ["\\eqref", "\\eqref{x}"],
  ];

  test.each(refused)("%s keeps its source as text and sets no URL", async (_name, tex) => {
    const { box, urls } = await render(`Look: $${tex}$ end`);
    expect(box.querySelector("math")).toBeNull();
    expect(failedSources(box)).toEqual([tex]);
    expect(unsafeIn(box)).toEqual([]);
    expect(urls).toEqual([]);
  });

  test("the same commands in display math keep their block of source", async () => {
    const tex = refused.map(([, t]) => t).join(" \\\\ ");
    const { box, urls } = await render(`$$\n${tex}\n$$\n`);
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector(`pre.${MATH_ERROR_CLASS} > code`)?.textContent).toBe(tex);
    expect(unsafeIn(box)).toEqual([]);
    expect(urls).toEqual([]);
  });

  test("no request reached the trap host", async () => {
    for (const [, tex] of refused) await render(`$${tex}$`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchedTraps()).toEqual([]);
  });
});

describe("commands that draw, minus what would reach the page", () => {
  test("\\label loses the id Temml puts on its row", async () => {
    const { box } = await render(
      "$$\n\\begin{equation}\\label{user-content-x} a = b\\end{equation}\n$$\n",
    );
    expect(box.querySelector("math")).not.toBeNull();
    expect(box.querySelector("[id]")).toBeNull();
    expect(unsafeIn(box)).toEqual([]);
  });

  test("a valid colour is an attribute, never a style", async () => {
    const { box } = await render(
      "$\\color{#00ff00}{a}\\textcolor{blue}{b}\\colorbox{yellow}{c}\\fcolorbox{red}{white}{d}$",
    );
    expect(box.querySelector("math")).not.toBeNull();
    expect(box.querySelector("[style]")).toBeNull();
    expect(unsafeIn(box)).toEqual([]);
  });

  test("markup and URLs written as text stay text", async () => {
    const { box, urls } = await render(
      '$\\text{<img src="https://trap.example/o.png" onerror="window.dwXssRan=1">}\\operatorname{javascript:alert} \\char"3C script\\char"3E$',
    );
    expect(box.querySelector("math mtext")?.textContent).toContain("<img");
    expect(unsafeIn(box)).toEqual([]);
    expect(urls).toEqual([]);
  });

  test("an array with rules loses the borders Temml writes as style", async () => {
    const { box } = await render("$$\n\\begin{array}{c|c}a&b\\\\\\hline c&d\\end{array}\n$$\n");
    expect(box.querySelector("math mtable")).not.toBeNull();
    expect(box.querySelector("[style]")).toBeNull();
    expect(unsafeIn(box)).toEqual([]);
  });

  test("a formula written as raw HTML is held to the same limits", async () => {
    // GitHub's schema keeps `language-*` on <code>, so an author can write
    // the element remark-rehype makes; it gains nothing. (The text between
    // the tags is Markdown, so a bare https URL there would be an autolink,
    // the author's own link and no formula's.)
    const { box, urls } = await render(
      '<code class="language-math">\\href{javascript:alert(1)}{x}\\class{present}{y}</code> and <code class="language-math">x^2</code>',
    );
    expect(failedSources(box)).toEqual(["\\href{javascript:alert(1)}{x}\\class{present}{y}"]);
    expect(box.querySelectorAll("math")).toHaveLength(1);
    expect(unsafeIn(box)).toEqual([]);
    expect(urls).toEqual([]);
  });
});

/** `x` inside `n` pairs of `open` and `close`. */
const deep = (open: string, close: string, n: number) => `${open.repeat(n)}x${close.repeat(n)}`;

describe("expressions built to exhaust the renderer", () => {
  const bombs: [string, string][] = [
    ["\\def recursion", "\\def\\a{\\a}\\a"],
    ["\\def doubling", "\\def\\a{\\a\\a}\\a"],
    ["\\def with an argument", "\\def\\a#1{\\a{#1#1}}\\a{x}"],
    ["\\newcommand recursion", "\\newcommand{\\b}{\\b}\\b"],
    ["\\gdef doubling", "\\gdef\\c{\\c\\c}\\c"],
    [
      "sixteen levels of doubling",
      [..."abcdefghijklmnop"]
        .map((c, i, all) => `\\def\\${c}{${all[i + 1] ? `\\${all[i + 1]}\\${all[i + 1]}` : "x"}}`)
        .join("") + "\\a",
    ],
  ];

  test.each(bombs)("%s fails fast and keeps its source", async (_name, tex) => {
    const started = performance.now();
    const { box } = await render(`$${tex}$`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(failedSources(box)).toEqual([tex]);
    expect(unsafeIn(box)).toEqual([]);
  });

  const nesting: [string, string][] = [
    ["braces", deep("{", "}", 30)],
    ["\\left … \\right", deep("\\left(", "\\right)", 30)],
    ["\\sqrt", deep("\\sqrt{", "}", 30)],
    ["superscripts", deep("x^{", "}", 30)],
    ["\\frac", deep("\\frac{1}{", "}", 30)],
    ["environments", deep("\\begin{matrix}", "\\end{matrix}", 30)],
  ];

  test.each(nesting)("%s nested 30 deep fail without a stack overflow", async (_name, tex) => {
    const { box } = await render(`$${tex}$`);
    expect(box.querySelector("math")).toBeNull();
    expect(failedSources(box)).toEqual([tex]);
  });

  test("the length limit is exact: one character over is source", async () => {
    // One mtext node, so only the length decides.
    const fits = `\\text{${"a".repeat(MAX_TEX_CHARS - 7)}}`;
    expect(fits).toHaveLength(MAX_TEX_CHARS);
    const over = `\\text{${"a".repeat(MAX_TEX_CHARS - 6)}}`;
    const { box } = await render(`$${fits}$\n\n$${over}$`);
    const [first, second] = box.querySelectorAll("p");
    expect(first!.querySelector("math mtext")).not.toBeNull();
    expect(second!.querySelector("math")).toBeNull();
    expect(failedSources(second!)).toEqual([over]);
  });
});

/**
 * Work Temml does between the source limits and the output limits. The
 * source stays short and the output is refused, but Temml builds a body
 * several times on the way (`\cancelto` three, the lap family twice), so
 * nesting grows exponentially. Before the parse-tree estimate, `\cancelto`
 * 12 deep took 4.5 s on a quiet machine and `\llap` 18 deep 1.9 s; a `\def`
 * of a run of `x` used 199 times under `maxExpand` spent 18 s in `toNode()`.
 */
describe("formulas that make Temml do too much work", () => {
  /** A refusal takes a few milliseconds, load included; the old code took seconds. */
  const REFUSED_WITHIN_MS = 200;

  // The first render loads Temml's chunk, which is no part of what these time.
  beforeAll(async () => {
    await render("$x$");
  });

  const bombs: [string, string][] = [
    ["\\cancelto nested 12 deep", deep("\\cancelto{a}{", "}", 12)],
    ["\\llap nested 18 deep", deep("\\llap{", "}", 18)],
    ["\\mathllap nested 18 deep", deep("\\mathllap{", "}", 18)],
    ["\\equilibriumRight nested 14 deep", deep("\\equilibriumRight{", "}", 14)],
    // 726 characters: 320 `x` per use, and 199 uses is under maxExpand 200.
    ["a \\def run used 199 times", `\\def\\a{${"x".repeat(320)}}${"\\a".repeat(199)}`],
  ];

  test.each(bombs)("%s is refused before it is built", async (_name, tex) => {
    const started = performance.now();
    const { box } = await render(`$${tex}$`);
    expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN_MS);
    expect(failedSources(box)).toEqual([tex]);
    expect(box.querySelector("math")).toBeNull();
  });

  test("the same bombs in display math are refused as fast", async () => {
    const started = performance.now();
    const { box } = await render(`$$\n${bombs.map(([, tex]) => tex).join(" \\\\ ")}\n$$\n`);
    expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN_MS);
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector(`pre.${MATH_ERROR_CLASS}`)).not.toBeNull();
  });

  const fine: [string, string][] = [
    ["\\cancelto", "\\cancelto{a}{x+y}"],
    ["\\cancelto nested 3 deep", deep("\\cancelto{a}{", "}", 3)],
    ["\\llap", "\\llap{x}"],
    ["\\mathllap nested 3 deep", deep("\\mathllap{", "}", 3)],
    ["\\equilibriumRight with labels", "\\equilibriumRight{ab}[cd]"],
    ["a macro used a few times", "\\def\\a{x^2+y^2}\\a+\\a+\\a"],
    ["a long run of text", `\\text{${"a".repeat(3000)}}`],
  ];

  test.each(fine)("%s still draws", async (_name, tex) => {
    const { box } = await render(`$${tex}$`);
    expect(failedSources(box)).toEqual([]);
    expect(box.querySelector("math")).not.toBeNull();
  });
});

describe("shortcodes that name Object's own properties", () => {
  test("stay text through the whole path, beside one that is an emoji", async () => {
    // Underscores escaped: Markdown would read `__proto__` as bold.
    const { box } = await render(
      ":\\_\\_proto\\_\\_: :constructor: :prototype: :hasOwnProperty: :toString: :valueOf: :\\_\\_defineGetter\\_\\_: :rocket:",
    );
    expect(box.textContent).toBe(
      ":__proto__: :constructor: :prototype: :hasOwnProperty: :toString: :valueOf: :__defineGetter__: 🚀",
    );
    expect(unsafeIn(box)).toEqual([]);
  });

  test("a shortcode inside a formula is part of the formula", async () => {
    const { box } = await render("$\\text{:rocket:}$ and :rocket:");
    expect(box.querySelector("math mtext")?.textContent).toBe(":rocket:");
    expect(box.querySelector("p")!.lastChild?.textContent).toBe(" and 🚀");
  });
});
