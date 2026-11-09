/**
 * Temml's half of math (decision 101): everything that runs in the math
 * worker. A formula goes in as TeX and comes out as a `MathTree`, plain data
 * that the page rebuilds into elements (`./mathRebuild.ts`). No DOM is used
 * here, on purpose: Temml's `__parse` and `__renderToMathMLTree` need none,
 * and a worker has none. `mathTree.test.ts` runs this file in Node, where an
 * upgrade of Temml that reaches for `document` fails at once.
 *
 * `texToTree` is the one door. Whatever goes wrong (a command Temml rejects,
 * an expression over the limits, a stack that gives out) comes back as `null`,
 * and the page then shows the formula as written.
 */
import temml from "temml";
import { MATH_ELEMENTS, mathAttributeAllowed, mathClasses } from "./mathAllow";
import { buildWork, countTree, MATH_LIMITS, MathTooLarge, MAX_BUILD_WORK } from "./mathCost";

/** Page to worker: one formula. */
export interface MathRequest {
  id: number;
  tex: string;
  display: boolean;
}

/** Worker to page. `ready` once, after Temml has evaluated; then one `tree` per request. */
export type MathReply = { kind: "ready" } | { kind: "tree"; id: number; tree: MathTree | null };

/** A MathML element as data: what `toNode()` would have made, minus everything that is not MathML. */
export interface MathTree {
  name: string;
  /** Pairs, not an object: no `__proto__` key can mean anything on either side. */
  attributes: [string, string][];
  /** Elements and text, in order. */
  children: (MathTree | string)[];
}

/** Longest formula docwalk renders, in characters. A page of TeX is a few hundred. */
export const MAX_TEX_CHARS = 4000;

/** Deepest nesting of groups, `\left … \right` pairs and environments. Real formulas stay under 10. */
export const MAX_TEX_NESTING = 24;

/**
 * Most characters of text in one tree. `buildWork` lets a macro of text near
 * 10,000 characters through (`\def\a{\text{x x3000}}\a\a\a` is 9,000 units),
 * so this never refuses a formula it accepted.
 */
export const MAX_TREE_TEXT = 16_000;

/** Counted tokens: an escaped brace or backslash is a character, not a group. */
const NESTING_TOKEN = /\\[{}\\]|\\(?:left|begin)(?![A-Za-z])|\\(?:right|end)(?![A-Za-z])|[{}]/g;

/** How deeply `tex` nests, by the tokens above. */
export function nestingOf(tex: string): number {
  let depth = 0;
  let deepest = 0;
  for (const [token] of tex.matchAll(NESTING_TOKEN)) {
    if (token === "{" || token.endsWith("left") || token.endsWith("begin")) {
      deepest = Math.max(deepest, ++depth);
    } else if (token === "}" || token.endsWith("right") || token.endsWith("end")) {
      depth = Math.max(0, depth - 1);
    }
  }
  return deepest;
}

/**
 * Temml's options. `trust` stays off, so `\includegraphics`, `\style`,
 * `\class`, `\id` and `\data` do not parse (Temml 0.14 has no `\href` or
 * `\url`). `macros` is a new object for each formula, because `\gdef`
 * writes into it.
 */
const OPTIONS = {
  throwOnError: true,
  trust: false,
  annotate: false,
  maxExpand: 200,
  maxSize: [20, 20] as [number, number],
};

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** A hex colour from a hex or an `rgb(r, g, b)` value, or null. */
function hexColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (HEX_COLOR.test(value)) return value;
  const rgb = RGB_COLOR.exec(value);
  if (!rgb) return null;
  const parts = [rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Temml gives a few nodes a `style` object (camelCase properties). None of it
 * is sent as style, but what it meant is sent in a form that is allowed: a
 * text or background colour becomes `mathcolor` or `mathbackground`, and the
 * box of `\boxed` becomes Temml's `tml-fbox` class. A colour must be a hex or
 * `rgb()` value.
 */
function fromStyle(style: Record<string, unknown>): {
  attributes: [string, string][];
  classes: string[];
} {
  const attributes: [string, string][] = [];
  const classes: string[] = [];
  const colour = hexColour(style["color"]);
  if (colour) attributes.push(["mathcolor", colour]);
  const background = hexColour(style["backgroundColor"]);
  if (background) attributes.push(["mathbackground", background]);
  if (style["border"] === "1px solid" && style["padding"] === "3pt") classes.push("tml-fbox");
  return { attributes, classes };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Temml's build tree as data. The tree is read by shape, not by class name,
 * because the worker bundle is minified:
 *
 * - an element has a string `type`, a `children` list and an `attributes`
 *   object (`MathNode`);
 * - text has a string `text` and no `children` (`TextNode`);
 * - a fragment has `children` and nothing else of the above, and is spliced
 *   into its parent, as `toNode()` did;
 * - anything else (`Span`, `AnchorNode`, `Img`) is dropped with its subtree.
 *
 * An element whose name is off `MATH_ELEMENTS` is dropped with its subtree,
 * and attributes and classes pass the same lists the page applies again.
 * Returns the one `<math>` root, or `null` when the tree is not that, or is
 * over the caps (`MATH_LIMITS` for elements and depth, `MAX_TREE_TEXT`).
 */
export function toData(root: unknown): MathTree | null {
  let nodes = 0;
  let text = 0;
  const convert = (node: unknown, depth: number): (MathTree | string)[] => {
    if (!isRecord(node)) return [];
    const { children } = node;
    if (typeof node["text"] === "string" && children === undefined) {
      text += node["text"].length;
      if (text > MAX_TREE_TEXT) throw new MathTooLarge();
      return [node["text"]];
    }
    if (!Array.isArray(children)) return [];
    const type = node["type"];
    const attributes = node["attributes"];
    if (typeof type !== "string") {
      // A fragment carries children and neither attributes nor a link; a span or an anchor does.
      if (attributes !== undefined || node["href"] !== undefined) return [];
      return children.flatMap((child) => convert(child, depth));
    }
    if (!MATH_ELEMENTS.has(type) || !isRecord(attributes)) return [];
    if (depth > MATH_LIMITS.depth || ++nodes > MATH_LIMITS.nodes) throw new MathTooLarge();
    const pairs: [string, string][] = [];
    const taken = new Set<string>();
    const classes: string[] = [];
    for (const [name, raw] of Object.entries(attributes)) {
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const value = String(raw);
      if (name === "class") classes.push(...mathClasses(value));
      else if (mathAttributeAllowed(name, value) && !taken.has(name)) {
        pairs.push([name, value]);
        taken.add(name);
      }
    }
    if (Array.isArray(node["classes"])) {
      classes.push(...mathClasses(node["classes"].filter((c) => typeof c === "string").join(" ")));
    }
    if (isRecord(node["style"])) {
      const meant = fromStyle(node["style"]);
      classes.push(...meant.classes);
      for (const [name, value] of meant.attributes) {
        if (!taken.has(name)) {
          pairs.push([name, value]);
          taken.add(name);
        }
      }
    }
    if (classes.length > 0) pairs.push(["class", [...new Set(classes)].join(" ")]);
    return [
      {
        name: type,
        attributes: pairs,
        children: children.flatMap((child) => convert(child, depth + 1)),
      },
    ];
  };
  try {
    const result = convert(root, 1);
    const [only] = result;
    return result.length === 1 && typeof only === "object" && only.name === "math" ? only : null;
  } catch (error) {
    if (error instanceof MathTooLarge) return null;
    throw error;
  }
}

/**
 * The formula as a `<math>` tree, or `null` when it cannot be shown.
 *
 * Between the source limits and the output limits Temml does work that no
 * limit on either end bounds, so it is measured first (`./mathCost.ts`):
 * the parse tree for what the builders will make, then Temml's build tree
 * for how many elements it holds. A formula over either is refused before
 * the rest is done. The parse itself has no bound here; the page stops the
 * worker that runs it (`./mathRender.ts`).
 */
export function texToTree(tex: string, display: boolean): MathTree | null {
  if (tex.trim() === "" || tex.length > MAX_TEX_CHARS || nestingOf(tex) > MAX_TEX_NESTING) {
    return null;
  }
  try {
    // A parse that throws is a formula Temml rejects. Each call gets its own `macros`.
    // oxlint-disable-next-line no-underscore-dangle -- Temml's name for the parse tree API.
    const parsed = temml.__parse(tex, { ...OPTIONS, displayMode: display, macros: {} });
    if (buildWork(parsed, MAX_BUILD_WORK) > MAX_BUILD_WORK) return null;
    // The tree: `renderToString` makes a string to parse, and `render` fills a given element.
    // oxlint-disable-next-line no-underscore-dangle -- Temml's name for the tree API.
    const built = temml.__renderToMathMLTree(tex, { ...OPTIONS, displayMode: display, macros: {} });
    countTree(built, MATH_LIMITS);
    return toData(built);
  } catch {
    return null;
  }
}
