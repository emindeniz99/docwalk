/**
 * The lazy half of math (decision 101): Temml, its stylesheet and the
 * allowlist rebuild of what it makes. Imported only by `./math.ts`, and only
 * for a document that has a formula.
 *
 * `buildMath` is the one door. Whatever goes wrong (a command Temml rejects,
 * an expression over the limits, a stack that gives out) comes back as `null`,
 * and the caller then shows the formula as written.
 */
import temml from "temml";
import "temml/dist/Temml-Local.css";
import { rebuild } from "./mathRebuild";

/** Longest formula docwalk renders, in characters. A page of TeX is a few hundred. */
export const MAX_TEX_CHARS = 4000;

/** Deepest nesting of groups, `\left … \right` pairs and environments. Real formulas stay under 10. */
export const MAX_TEX_NESTING = 24;

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
 * `\url`). It is also what keeps `toNode()` from making an `<img>`, which
 * would start loading in this page before `rebuild` could drop it.
 * `macros` is a new object for each formula, because `\gdef` writes into it.
 */
const OPTIONS = {
  throwOnError: true,
  trust: false,
  annotate: false,
  maxExpand: 200,
  maxSize: [20, 20] as [number, number],
};

/** The formula as a `<math>` element, or `null` when it cannot be shown. */
export function buildMath(tex: string, display: boolean): Element | null {
  if (tex.trim() === "" || tex.length > MAX_TEX_CHARS || nestingOf(tex) > MAX_TEX_NESTING) {
    return null;
  }
  try {
    // The tree: `renderToString` makes a string to parse, and `render` fills a given element.
    // oxlint-disable-next-line no-underscore-dangle -- Temml's name for the tree API.
    const tree = temml.__renderToMathMLTree(tex, { ...OPTIONS, displayMode: display, macros: {} });
    const built = tree.toNode();
    const math = built instanceof Element ? rebuild(built) : null;
    if (math?.localName !== "math") return null;
    math.classList.add("docwalk-math");
    if (display) math.setAttribute("display", "block");
    else math.removeAttribute("display");
    return math;
  } catch {
    return null;
  }
}
