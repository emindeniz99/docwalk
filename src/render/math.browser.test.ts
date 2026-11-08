import { afterEach, describe, expect, test } from "vitest";
import { purifyHtml } from "../deck/purify";
import { parseMarkdown } from "../sectioning/sectionize";
import {
  MATH_CLASS,
  MATH_DISPLAY_CLASS,
  MATH_ERROR_CLASS,
  MAX_FORMULAS,
  renderMath,
  type MathBuilder,
} from "./math";
import {
  FORBIDDEN_MATH_ELEMENTS,
  MATHML_NS,
  MATH_ATTRIBUTES,
  MATH_CLASSES,
  MATH_ELEMENTS,
} from "./mathAllow";
import { buildMath, MAX_TEX_CHARS, MAX_TEX_NESTING, nestingOf } from "./mathBuild";
import { MathTooLarge, rebuild } from "./mathRebuild";
import { nodesToHtml } from "./toHtml";

/**
 * Decision 101, rule 5. A formula is the document's text, and the MathML that
 * stands for it is built here, after both sanitizers, from lists of names,
 * attributes and values. These tests hold the lists against what Temml makes
 * and against what a hostile formula or a hostile tree asks for.
 */

declare global {
  interface Window {
    dwXssRan?: unknown;
  }
}

afterEach(() => {
  document.body.replaceChildren();
  delete window.dwXssRan;
});

/** Renders `markdown` through both sanitizers, attaches it, and draws its formulas. */
async function render(markdown: string): Promise<HTMLElement> {
  const box = document.createElement("div");
  box.append(purifyHtml(nodesToHtml(parseMarkdown(markdown).children)));
  document.body.append(box);
  await renderMath(box);
  return box;
}

const MATH_NAMES = [...MATH_ELEMENTS];

const UNSAFE_ELEMENT =
  /^(?:a|img|script|style|iframe|object|embed|svg|foreignobject|semantics|annotation|annotation-xml|maction|mglyph)$/;
const UNSAFE_ATTRIBUTE = /^(?:href|src|style|id|xlink:href|on.*)$/i;

/** What a formula left behind under `box` that it may not, one line each. */
function unsafeIn(box: Element): string[] {
  const found: string[] = [];
  for (const el of box.querySelectorAll("*")) {
    const tag = `<${el.localName}>`;
    if (UNSAFE_ELEMENT.test(el.localName)) found.push(`${tag} element`);
    if (el.namespaceURI === MATHML_NS && !MATH_NAMES.includes(el.localName)) {
      found.push(`${tag} is not on the list`);
    }
    for (const { name, value } of el.attributes) {
      if (UNSAFE_ATTRIBUTE.test(name)) found.push(`${name} on ${tag}`);
      if (el.namespaceURI !== MATHML_NS) continue;
      if (name === "class") {
        const extra = value.split(/\s+/).filter((c) => !MATH_CLASSES.has(c) && c !== MATH_CLASS);
        if (extra.length > 0) found.push(`class ${extra.join(" ")} on ${tag}`);
      } else if (!MATH_ATTRIBUTES.has(name) || !/^[\w.%+#, -]{0,64}$/.test(value)) {
        found.push(`${name}="${value}" on ${tag}`);
      }
    }
  }
  if (window.dwXssRan !== undefined) found.push("a script ran");
  return found;
}

/** Nothing a formula may not leave behind, in any element under `box`. */
function expectSafe(box: Element): void {
  expect(unsafeIn(box)).toEqual([]);
}

/** The formula's source, kept as text where a formula could not be drawn. */
const failed = (box: Element) => [...box.querySelectorAll(`code.${MATH_ERROR_CLASS}`)];

/** A builder that throws, as a Temml bug would. */
const boom: MathBuilder = () => {
  throw new Error("boom");
};

describe("the four forms become MathML", () => {
  test("$…$ is an inline <math> in the sentence", async () => {
    const box = await render("Energy is $E = mc^2$ here.");
    const math = box.querySelector("p > math")!;
    expect(math.namespaceURI).toBe(MATHML_NS);
    expect(math.classList.contains(MATH_CLASS)).toBe(true);
    expect(math.hasAttribute("display")).toBe(false);
    expect(math.querySelector("msup")).not.toBeNull();
    expect(box.querySelector("code")).toBeNull();
    expect(box.querySelector("p")!.textContent).toBe("Energy is E=mc2 here.");
    expectSafe(box);
  });

  test("$`…`$ keeps underscores out of Markdown and is math", async () => {
    const box = await render("Load is $`a_b + c_d`$ per node.");
    expect(box.querySelectorAll("math msub")).toHaveLength(2);
    expect(box.querySelector("em")).toBeNull();
    expectSafe(box);
  });

  test("$$ on its own lines is a display equation in an atomic block", async () => {
    const box = await render("Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter");
    const host = box.querySelector(`div.${MATH_DISPLAY_CLASS}`)!;
    expect(host.children).toHaveLength(1);
    const math = host.firstElementChild!;
    expect(math.localName).toBe("math");
    expect(math.getAttribute("display")).toBe("block");
    expect(math.querySelector("mfrac")).not.toBeNull();
    expect(box.querySelector("pre")).toBeNull();
    expect(box.textContent).toContain("Before");
    expect(box.textContent).toContain("After");
    expectSafe(box);
  });

  test("a ```math fence is the same display equation", async () => {
    const box = await render("```math\n\\sqrt{x^2 + y^2}\n```\n");
    expect(
      box.querySelector(`div.${MATH_DISPLAY_CLASS} > math[display=block] msqrt`),
    ).not.toBeNull();
    expect(box.querySelector("pre")).toBeNull();
    expectSafe(box);
  });

  test("$$x$$ in a sentence stays inline", async () => {
    const box = await render("So $$x^2$$ follows.");
    expect(box.querySelector("p > math")).not.toBeNull();
    expect(box.querySelector(`.${MATH_DISPLAY_CLASS}`)).toBeNull();
  });

  test("a matrix, a sum and an aligned block build", async () => {
    const box = await render(
      [
        "$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$",
        "$$\n\\sum_{i=1}^{n} i\n$$",
        "$$\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n$$",
      ].join("\n\n"),
    );
    expect(box.querySelectorAll(`.${MATH_DISPLAY_CLASS}`)).toHaveLength(3);
    expect(box.querySelector("mtable")).not.toBeNull();
    expect(box.querySelector("munderover")).not.toBeNull();
    expect(failed(box)).toHaveLength(0);
    expectSafe(box);
  });

  test("\\color keeps its colour as an attribute, never as style", async () => {
    const box = await render("Red: $\\color{red}{x}$ and $\\colorbox{yellow}{y}$.");
    expect(box.querySelector("[mathcolor='#ff0000']")).not.toBeNull();
    expect(box.querySelector("[style]")).toBeNull();
    expectSafe(box);
  });

  test("\\boxed keeps its box through Temml's own class", async () => {
    const box = await render("Boxed: $\\boxed{x}$");
    expect(box.querySelector("math .tml-fbox")).not.toBeNull();
    expectSafe(box);
  });
});

describe("dollars and code are not math (rule 2)", () => {
  test("a dollar amount stays text and loads nothing", async () => {
    let loads = 0;
    const box = document.createElement("div");
    box.append(purifyHtml(nodesToHtml(parseMarkdown("It costs $5 and $10.").children)));
    await renderMath(box, {
      load: async () => {
        loads++;
        return () => null;
      },
    });
    expect(loads).toBe(0);
    expect(box.textContent).toBe("It costs $5 and $10.");
  });

  test("a $ inside inline code and a fenced block is code", async () => {
    const box = await render("Type `$x^2$` now.\n\n```sh\necho $HOME and $PATH\n```\n");
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector("p code")!.textContent).toBe("$x^2$");
    expect(box.querySelector("pre code")!.textContent).toBe("echo $HOME and $PATH\n");
  });

  test("a $$ inside a fenced block with another language stays code", async () => {
    const box = await render("```tex\n$$\\frac{a}{b}$$\n```\n");
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector("pre code")!.textContent).toContain("$$\\frac{a}{b}$$");
  });
});

describe("a formula that cannot be drawn shows its source (never a crash)", () => {
  test("an unknown command keeps the TeX as written", async () => {
    const box = await render("Bad: $\\notacommand{x}$ done.");
    expect(box.querySelector("math")).toBeNull();
    const [source] = failed(box);
    expect(source?.textContent).toBe("\\notacommand{x}");
    expect(box.querySelector("p")!.textContent).toContain("done.");
  });

  test("a display equation that fails keeps its pre block", async () => {
    const box = await render("$$\n\\frac{1}{\n$$\n");
    expect(box.querySelector(`.${MATH_DISPLAY_CLASS}`)).toBeNull();
    expect(box.querySelector(`pre.${MATH_ERROR_CLASS}`)?.textContent).toContain("\\frac{1}{");
  });

  test("a chunk that does not load leaves every formula as source", async () => {
    const box = document.createElement("div");
    box.append(purifyHtml(nodesToHtml(parseMarkdown("A $x$ and\n\n$$\ny\n$$\n").children)));
    await renderMath(box, { load: () => Promise.reject(new Error("offline")) });
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector("p code.language-math")!.textContent).toBe("x");
    expect(box.querySelector("pre code.language-math")!.textContent).toBe("y");
  });

  test("a chunk that takes too long is given up on", async () => {
    const box = document.createElement("div");
    box.append(purifyHtml(nodesToHtml(parseMarkdown("A $x$ here").children)));
    await renderMath(box, { timeoutMs: 20, load: () => new Promise(() => undefined) });
    expect(box.querySelector("math")).toBeNull();
  });

  test("a stale build draws nothing", async () => {
    const box = document.createElement("div");
    box.append(purifyHtml(nodesToHtml(parseMarkdown("A $x$ here").children)));
    await renderMath(box, { stop: () => true });
    expect(box.querySelector("math")).toBeNull();
  });

  test("a builder that throws is a failed formula", async () => {
    const box = document.createElement("div");
    box.append(purifyHtml(nodesToHtml(parseMarkdown("A $x$ here").children)));
    await renderMath(box, { load: async () => boom });
    expect(failed(box)).toHaveLength(1);
  });

  test("a document with more formulas than the limit draws the first ones", async () => {
    const lines = Array.from({ length: MAX_FORMULAS + 5 }, (_, i) => `$x_{${i}}$`).join(" ");
    const box = await render(lines);
    expect(box.querySelectorAll("math")).toHaveLength(MAX_FORMULAS);
  });
});

describe("hostile formulas (rule 5)", () => {
  const trusted: [string, string][] = [
    ["\\href", "\\href{https://tracker.example/x}{click}"],
    ["\\url", "\\url{https://tracker.example/x}"],
    ["\\includegraphics", "\\includegraphics{https://tracker.example/pixel.png}"],
    ["\\style", "\\style{background:url(https://tracker.example/x)}{x}"],
    ["\\class", "\\class{docwalk-diagram}{x}"],
    ["\\htmlId", "\\htmlId{user-content-x}{x}"],
    ["\\data", "\\data{a=b}{x}"],
  ];

  test.each(trusted)("%s fails and leaves the source as text", async (_name, tex) => {
    const box = await render(`Look: $${tex}$ end`);
    expect(box.querySelector("math")).toBeNull();
    expect(failed(box)[0]?.textContent).toBe(tex);
    expect(
      box.querySelector("a, img, [href], [src], [style], [class~='docwalk-diagram']"),
    ).toBeNull();
    expectSafe(box);
  });

  test("HTML inside \\text is text", async () => {
    const box = await render(
      '$\\text{<img src=x onerror="window.dwXssRan=1"><script>window.dwXssRan=2</script>}$',
    );
    const mtext = box.querySelector("math mtext")!;
    // Temml turns the spaces of \text into no-break spaces.
    expect(mtext.textContent?.replaceAll(" ", " ")).toContain("<img src=x");
    expect(box.querySelector("img, script")).toBeNull();
    expectSafe(box);
  });

  test("HTML inside a macro is text", async () => {
    const box = await render(
      '$\\newcommand{\\x}{<img src=x onerror="window.dwXssRan=1">}\\x$ and $\\def\\y{<b>bold</b>}\\y$',
    );
    expect(box.querySelector("img, b, script")).toBeNull();
    expectSafe(box);
  });

  test("angle brackets from the Markdown are text in the formula", async () => {
    const box = await render("Both $a < b$ and $x<script>window.dwXssRan=1</script>$ appear.");
    expect(box.querySelector("script")).toBeNull();
    expectSafe(box);
  });

  test("a macro definition does not carry over to the next formula", async () => {
    const box = await render("$\\gdef\\secret{leak}\\secret$ then $\\secret$");
    expect(box.querySelectorAll("math")).toHaveLength(1);
    expect(failed(box)[0]?.textContent).toBe("\\secret");
  });

  test("an expansion bomb fails instead of hanging", async () => {
    const levels = "abcdefghijklmnop";
    const defs = [...levels]
      .map(
        (c, i) =>
          `\\def\\${c}{${i + 1 < levels.length ? `\\${levels[i + 1]}\\${levels[i + 1]}` : "x"}}`,
      )
      .join("");
    const started = performance.now();
    const box = await render(`$${defs}\\a$`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(box.querySelector("math")).toBeNull();
    expect(failed(box)).toHaveLength(1);
  });

  test("a huge space or rule is capped, not laid out", async () => {
    const box = await render("$\\hspace{99999em}\\rule{1000em}{1000em}$");
    expect(box.querySelector("math mspace")).not.toBeNull();
    const sizes = [...box.querySelectorAll("[width], [height]")].flatMap((el) =>
      [el.getAttribute("width"), el.getAttribute("height")].filter((v) => v !== null),
    );
    expect(sizes.filter((value) => Number.parseFloat(value) > 20)).toEqual([]);
    expectSafe(box);
  });

  test("an expression over the length limit is source", async () => {
    const tex = `x+${"y+".repeat(MAX_TEX_CHARS)}z`;
    const box = await render(`$${tex}$`);
    expect(box.querySelector("math")).toBeNull();
    expect(failed(box)).toHaveLength(1);
  });

  test("deep nesting is source, not a stack overflow", async () => {
    const depth = MAX_TEX_NESTING + 5;
    const tex = `${"\\frac{1}{".repeat(depth)}x${"}".repeat(depth)}`;
    expect(nestingOf(tex)).toBeGreaterThan(MAX_TEX_NESTING);
    const box = await render(`$$\n${tex}\n$$`);
    expect(box.querySelector("math")).toBeNull();
    expect(box.querySelector(`pre.${MATH_ERROR_CLASS}`)).not.toBeNull();
    const braces = await render(`$${"{".repeat(3000)}x${"}".repeat(3000)}$`);
    expect(braces.querySelector("math")).toBeNull();
  });

  test("nesting just inside the limit still draws", () => {
    const depth = MAX_TEX_NESTING - 2;
    const tex = `${"{".repeat(depth)}x${"}".repeat(depth)}`;
    expect(buildMath(tex, false)).not.toBeNull();
  });

  test("an escaped brace is not a group", () => {
    expect(nestingOf("\\{".repeat(100))).toBe(0);
    expect(nestingOf("\\left( \\begin{matrix} a \\end{matrix} \\right)")).toBe(3);
  });

  test("a tree over the node limit is refused", () => {
    const wide = document.createElementNS(MATHML_NS, "mrow");
    for (let i = 0; i < 50; i++) wide.append(document.createElementNS(MATHML_NS, "mi"));
    expect(() => rebuild(wide, { nodes: 10, depth: 40 })).toThrow(MathTooLarge);
    let deep: Element = document.createElementNS(MATHML_NS, "mi");
    for (let i = 0; i < 50; i++) {
      const outer = document.createElementNS(MATHML_NS, "mrow");
      outer.append(deep);
      deep = outer;
    }
    expect(() => rebuild(deep, { nodes: 3000, depth: 40 })).toThrow(MathTooLarge);
  });
});

/** Built in a document with no browsing context, so the test's own `<img>` never loads. */
const inert = document.implementation.createHTMLDocument("");
const make = (name: string, ns = MATHML_NS) => inert.createElementNS(ns, name);

/** A tree as a trusting or buggy builder might make it. */
function hostile(): Element {
  const math = make("math");
  math.setAttribute("onclick", "window.dwXssRan=1");
  math.setAttribute("style", "background:url(https://tracker.example/x)");
  math.setAttribute("href", "https://tracker.example/x");
  math.setAttribute("id", "user-content-x");
  math.setAttribute("xlink:href", "javascript:window.dwXssRan=1");
  math.setAttribute("class", "docwalk-diagram present tml-vec");
  math.setAttribute("mathcolor", "red;background:url(https://tracker.example/x)");
  math.setAttribute("width", "1em");
  const mi = make("mi");
  mi.textContent = "x";
  mi.setAttribute("mathvariant", "bold");
  const maction = make("maction");
  maction.setAttribute("actiontype", "statusline");
  const semantics = make("semantics");
  const annotation = make("annotation-xml");
  annotation.setAttribute("encoding", "text/html");
  const html = make("img", "http://www.w3.org/1999/xhtml");
  html.setAttribute("src", "https://tracker.example/pixel.png");
  annotation.append(html);
  const link = make("a", "http://www.w3.org/1999/xhtml");
  link.setAttribute("href", "https://tracker.example");
  link.textContent = "link";
  const script = make("script", "http://www.w3.org/1999/xhtml");
  script.textContent = "window.dwXssRan=1";
  const svg = make("svg", "http://www.w3.org/2000/svg");
  svg.append(make("script", "http://www.w3.org/2000/svg"));
  semantics.append(annotation);
  math.append(mi, maction, semantics, link, script, svg, inert.createComment("c"));
  return math;
}

describe("the allowlist holds against a hostile tree, whatever built it", () => {
  test("only listed names, attributes, values and classes survive", () => {
    const clean = rebuild(hostile())!;
    document.body.append(clean);
    expect(clean.outerHTML).toBe(
      '<math width="1em" class="tml-vec"><mi mathvariant="bold">x</mi></math>',
    );
    expectSafe(document.body);
  });

  test("an element outside the list takes its subtree with it", () => {
    expect(rebuild(document.createElementNS("http://www.w3.org/1999/xhtml", "div"))).toBeNull();
    const maction = document.createElementNS(MATHML_NS, "maction");
    expect(rebuild(maction)).toBeNull();
  });

  test("the lists name no element that carries markup or behaviour", () => {
    for (const name of FORBIDDEN_MATH_ELEMENTS) expect(MATH_ELEMENTS.has(name)).toBe(false);
    for (const name of ["href", "style", "id", "src", "onload", "xlink:href", "class"]) {
      expect(MATH_ATTRIBUTES.has(name)).toBe(false);
    }
  });

  test("text is copied as text, markup characters and all", () => {
    const mtext = document.createElementNS(MATHML_NS, "mtext");
    mtext.append(document.createTextNode('<img src=x onerror="1">&amp;'));
    const copy = rebuild(mtext)!;
    expect(copy.childNodes).toHaveLength(1);
    expect(copy.textContent).toBe('<img src=x onerror="1">&amp;');
    expect(copy.querySelector("*")).toBeNull();
  });
});

describe("Temml's output passes the lists for the commands people write", () => {
  const samples = [
    "E = mc^2",
    "\\frac{a}{b} + \\sqrt[3]{x}",
    "\\sum_{i=1}^{n} x_i^2",
    "\\int_0^\\infty e^{-x^2}\\,dx",
    "\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}",
    "\\begin{cases}x&x>0\\\\-x&\\text{otherwise}\\end{cases}",
    "\\vec{v}\\cdot\\hat{n}",
    "\\overline{AB}\\underline{CD}\\widehat{xyz}\\widetilde{abc}",
    "\\mathbb{R}\\mathcal{L}\\mathfrak{g}\\mathbf{x}\\mathrm{d}",
    "\\xrightarrow[b]{a}\\overbrace{x}^{y}\\underbrace{x}_{y}",
    "\\cancel{x}\\bcancel{y}\\xcancel{z}\\sout{w}",
    "\\binom{n}{k}\\left\\langle x\\right\\rangle",
    "\\begin{aligned}a&=b\\\\&=c\\end{aligned}",
    "\\tag{1} x = y",
    "\\text{if } x \\le 0",
  ];

  test.each(samples)("%s", (tex) => {
    const math = buildMath(tex, true);
    expect(math).not.toBeNull();
    const box = document.createElement("div");
    box.append(math!);
    document.body.append(box);
    expectSafe(box);
  });
});
