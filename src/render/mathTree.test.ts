import { describe, expect, test } from "vitest";
import { MATH_CLASSES, MATH_ELEMENTS, mathAttributeAllowed } from "./mathAllow";
import { MATH_LIMITS, MAX_TREE_TEXT } from "./mathCost";
import { MAX_TEX_CHARS, MAX_TEX_NESTING, texToTree, toData, type MathTree } from "./mathTree";

/**
 * Decision 101, rule 5. Temml runs in a worker and the page gets its tree as
 * data. This file runs in Node, where there is no `document`: it holds that
 * Temml's parse and build need none (the worker has none either), and that
 * what the worker sends is already inside the lists.
 */

/** Every element of `tree`, the root first. */
function elementsOf(tree: MathTree): MathTree[] {
  return [
    tree,
    ...tree.children.flatMap((child) => (typeof child === "string" ? [] : elementsOf(child))),
  ];
}

/** The text below `el`, in order. */
const textOf = (el: MathTree): string =>
  el.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

const tree = (tex: string, display = true): MathTree => {
  const result = texToTree(tex, display);
  if (result === null) throw new Error(`${tex} gave no tree`);
  return result;
};

const pairs = (root: MathTree) => elementsOf(root).flatMap((el) => el.attributes);

describe("Temml needs no document", () => {
  test("Temml parses and builds with no DOM", () => {
    // A Temml upgrade that touches `document` while parsing or building fails here, in Node.
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    const math = tree("\\frac{a}{b}");
    expect(math.name).toBe("math");
    expect(elementsOf(math).some((el) => el.name === "mfrac")).toBe(true);
  });
});

describe("what the worker sends is inside the lists", () => {
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
    const els = elementsOf(tree(tex));
    expect(els.filter((el) => !MATH_ELEMENTS.has(el.name)).map((el) => el.name)).toEqual([]);
    const all = els.flatMap((el) => el.attributes);
    expect(all.filter(([name]) => name === "style")).toEqual([]);
    const classes = all
      .filter(([name]) => name === "class")
      .flatMap(([, value]) => value.split(" "));
    expect(classes.filter((c) => !MATH_CLASSES.has(c))).toEqual([]);
    const others = all.filter(([name]) => name !== "class");
    expect(others.filter(([name, value]) => !mathAttributeAllowed(name, value))).toEqual([]);
  });

  test("\\color keeps its colour as an attribute", () => {
    expect(pairs(tree("\\color{red}{x}"))).toContainEqual(["mathcolor", "#ff0000"]);
  });

  test("\\boxed keeps its box through Temml's own class", () => {
    const classes = pairs(tree("\\boxed{x}")).filter(([name]) => name === "class");
    expect(classes.some(([, value]) => value.split(" ").includes("tml-fbox"))).toBe(true);
  });

  test("a fragment inside an element is spliced, in order", () => {
    // \cancelto puts a DocumentFragment below <math>; it has no element of its own.
    const root = tree("\\cancelto{0}{x}");
    // The body twice (content and phantom), then the target.
    expect(textOf(root)).toBe("xx0");
    expect(root.children.every((child) => typeof child !== "string" && child.name === "mrow")).toBe(
      true,
    );
    expect(elementsOf(root).map((el) => el.name)).toContain("mover");
  });

  test("the HTML parts of Temml's tree are dropped, and the formula still builds", () => {
    const root = tree("\\begin{equation}x\\end{equation}");
    expect(elementsOf(root).map((el) => el.name)).not.toContain("span");
    expect(elementsOf(root).some((el) => el.name === "mi")).toBe(true);
  });

  test("a formula whose root is not <math> gives nothing", () => {
    // \ref builds an anchor at the root, which docwalk never keeps.
    expect(texToTree("\\ref{a}", true)).toBeNull();
  });

  test("HTML in \\text is one string in an mtext, never an element", () => {
    const root = tree("\\text{<img src=x onerror=1>}");
    expect(elementsOf(root).map((el) => el.name)).not.toContain("img");
    const mtext = elementsOf(root).find((el) => el.name === "mtext")!;
    expect(mtext.children).toHaveLength(1);
    expect(typeof mtext.children[0]).toBe("string");
    // Temml turns the spaces of \text into no-break spaces.
    expect((mtext.children[0] as string).replaceAll("\u00a0", " ")).toBe("<img src=x onerror=1>");
  });
});

describe("a formula docwalk will not draw gives nothing", () => {
  test("longer than the source limit", () => {
    expect(texToTree("x".repeat(MAX_TEX_CHARS + 1), false)).toBeNull();
  });

  test("an empty formula", () => {
    expect(texToTree("  ", false)).toBeNull();
  });

  test("nested past the limit", () => {
    const depth = MAX_TEX_NESTING + 1;
    expect(texToTree(`${"{".repeat(depth)}x${"}".repeat(depth)}`, false)).toBeNull();
  });

  test("a macro run whose build would cost too much", () => {
    // 726 characters, under maxExpand, and 63,680 parse nodes.
    const def = `\\def\\a{${"x".repeat(320)}}`;
    const tex = `${def}${"\\a".repeat(199)}`;
    expect(tex.length).toBeLessThan(MAX_TEX_CHARS);
    expect(texToTree(tex, false)).toBeNull();
  });

  test("TeX Temml rejects", () => {
    expect(texToTree("\\notacommand{x}", false)).toBeNull();
    expect(texToTree("\\includegraphics{https://tracker.example/x.png}", false)).toBeNull();
  });
});

/** A node shaped like Temml's `MathNode`. */
const node = (type: string, children: unknown[] = []) => ({
  type,
  attributes: {},
  children,
  classes: [],
  style: {},
});

/** `levels` elements deep below a `math` root, ending in an `mi`. */
const chain = (levels: number) => {
  let inner: unknown = node("mi");
  for (let i = 1; i < levels; i++) inner = node("mrow", [inner]);
  return node("math", [inner]);
};

/** A `math` holding one `mtext` of `n` characters. */
const text = (n: number) => node("math", [node("mtext", [{ text: "x".repeat(n) }])]);

describe("the data has its own caps", () => {
  test("a tree at the element limit passes, one element over does not", () => {
    const at = node(
      "math",
      Array.from({ length: MATH_LIMITS.nodes - 1 }, () => node("mi")),
    );
    expect(toData(at)).not.toBeNull();
    const over = node(
      "math",
      Array.from({ length: MATH_LIMITS.nodes }, () => node("mi")),
    );
    expect(toData(over)).toBeNull();
  });

  test("a tree at the depth limit passes, one level deeper does not", () => {
    expect(toData(chain(MATH_LIMITS.depth - 1))).not.toBeNull();
    expect(toData(chain(MATH_LIMITS.depth))).toBeNull();
  });

  test("text over the character cap gives nothing", () => {
    expect(toData(text(MAX_TREE_TEXT))).not.toBeNull();
    expect(toData(text(MAX_TREE_TEXT + 1))).toBeNull();
  });
});
