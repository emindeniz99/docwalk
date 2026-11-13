import { MATHML_NS, MATH_ELEMENTS, mathAttributeAllowed, mathClasses } from "./mathAllow";
import { MATH_LIMITS, MAX_TREE_TEXT, MathTooLarge, type MathLimits } from "./mathCost";

/**
 * The page half of the allowlist (decision 101): elements made from the data
 * the math worker sends (`./mathTree.ts`), keeping only what `./mathAllow.ts`
 * lists. The data is treated as hostile whatever the worker meant: a worker
 * that ran a formula can be made to say anything.
 */

/**
 * How far a raise may move text off its line, in em, summed down a chain of
 * `mpadded` elements. Each `\raisebox` is held to `maxSize` 20 em by Temml,
 * but nothing added them up: stacked, they drew text 587 px above the slide
 * body with no note (rule 3). A formula's real raises are a fraction of an em.
 */
const MAX_VOFFSET_EM = 3;

/** Em per unit for what Temml writes in `voffset`: `em`, or the CSS absolute units. */
const EM_PER_UNIT: Readonly<Record<string, number>> = {
  em: 1,
  pt: 1 / 12,
  px: 1 / 16,
  mm: 96 / 25.4 / 16,
  cm: 96 / 2.54 / 16,
  in: 96 / 16,
};

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]{2})$/;

/** A `voffset` value in em, or null when it is not a length in a unit above. */
function voffsetEm(value: string): number | null {
  const match = LENGTH.exec(value.trim());
  const perUnit = match ? EM_PER_UNIT[match[2]!] : undefined;
  return match && perUnit !== undefined ? Number(match[1]) * perUnit : null;
}

/**
 * The most a space, a width, a height or a depth may add or take away, in em.
 * `voffset` was summed and held to 3 em, but the other attributes that move
 * ink passed with any value up to Temml's `maxSize` 20 em: `\rule{-30em}{1em}`
 * writes a negative `width`, and a negative `lspace` or `width` slides what
 * follows back over what came before, with no note (rule 3). Temml's own
 * lengths are 0.5 em or less except the 3.5 em minimum of `\xrightarrow`;
 * `\quad` and `\qquad` are 1 em and 2 em. 4 em keeps all of those.
 */
const MAX_LENGTH_EM = 4;

/** The attributes `fromTree` holds to `MAX_LENGTH_EM`. `voffset` has its own rule. */
const SPACING_ATTRIBUTES: ReadonlySet<string> = new Set(["width", "lspace", "rspace"]);
const EXTENT_ATTRIBUTES: ReadonlySet<string> = new Set(["height", "depth"]);

/** A multiple of the element's own size: Temml writes `\llap` as `lspace="-1width"`. */
const OWN_SIZE = /^([+-]?(?:\d+\.?\d*|\.\d+))(width|height|depth)$/;

/**
 * What to keep of a `width`, `lspace`, `rspace`, `height` or `depth`, or null to
 * drop it. A unit the rebuild cannot add up is dropped, as for `voffset`. A
 * width or space below zero is dropped: nothing Temml writes needs one, and it
 * is how ink slides over its neighbours. A height or depth keeps its sign,
 * because Temml writes `+0.3em`, `-0.18em` and `\rule[-1em]`'s pair to adjust a
 * box. Past `MAX_LENGTH_EM` the value is cut to it, keeping a leading `+`,
 * which `mpadded` reads as "add". A multiple of the element's own size passes
 * up to one: `\llap` is `-1width`, `\clap` `-0.5width`, and a box can slide
 * only by what it holds.
 */
function lengthValue(name: string, value: string): string | null {
  const text = value.trim();
  const own = OWN_SIZE.exec(text);
  if (own) return Math.abs(Number(own[1])) <= 1 ? text : null;
  if (/^[+-]?0+(?:\.0*)?$/.test(text)) return text; // `0`: the one unitless length.
  const em = voffsetEm(text);
  if (em === null) return null;
  if (SPACING_ATTRIBUTES.has(name) && em < 0) return null;
  if (Math.abs(em) <= MAX_LENGTH_EM) return text;
  return `${text.startsWith("+") ? "+" : ""}${em < 0 ? "-" : ""}${MAX_LENGTH_EM}em`;
}

/**
 * The `<math>` element for `tree`, or `null` when `tree` is not allowed
 * (a root that is not a `math` element, or anything that is not a tree). Every
 * element is made with `createElementNS`; nothing is parsed from a string. A
 * node that is not an object with a listed `name`, a list of two-string
 * `attributes` and a list of `children` drops itself and its subtree, and a
 * pair that fails the lists drops itself. Throws `MathTooLarge` over `limits`
 * or `MAX_TREE_TEXT` characters of text; a cycle meets the depth limit.
 */
export function fromTree(
  tree: unknown,
  display: boolean,
  limits: MathLimits = MATH_LIMITS,
  doc: Document = document,
): Element | null {
  let nodes = 0;
  let text = 0;
  // `shift` is the sum of the `voffset` of the elements above, in em.
  const copy = (from: unknown, depth: number, shift: number): Element | null => {
    if (typeof from !== "object" || from === null) return null;
    const { name, attributes, children } = from as Record<string, unknown>;
    if (typeof name !== "string" || !MATH_ELEMENTS.has(name)) return null;
    if (!Array.isArray(attributes) || !Array.isArray(children)) return null;
    if (depth > limits.depth || ++nodes > limits.nodes) throw new MathTooLarge();
    const to = doc.createElementNS(MATHML_NS, name);
    const classes: string[] = [];
    let below = shift;
    for (const pair of attributes as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [key, value] = pair as unknown[];
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (key === "voffset") {
        // Kept while the sum along this chain stays in range; dropped from the first raise past it.
        const em = voffsetEm(value);
        if (
          em !== null &&
          Math.abs(shift + em) <= MAX_VOFFSET_EM &&
          mathAttributeAllowed(key, value)
        ) {
          to.setAttribute(key, value);
          below = shift + em;
        }
      } else if (SPACING_ATTRIBUTES.has(key) || EXTENT_ATTRIBUTES.has(key)) {
        const kept = lengthValue(key, value);
        if (kept !== null && mathAttributeAllowed(key, kept)) to.setAttribute(key, kept);
      } else if (key === "class") classes.push(...mathClasses(value));
      else if (mathAttributeAllowed(key, value)) to.setAttribute(key, value);
    }
    if (classes.length > 0) to.setAttribute("class", [...new Set(classes)].join(" "));
    for (const child of children as unknown[]) {
      if (typeof child === "string") {
        text += child.length;
        if (text > MAX_TREE_TEXT) throw new MathTooLarge();
        to.append(doc.createTextNode(child));
      } else {
        const kept = copy(child, depth + 1, below);
        if (kept) to.append(kept);
      }
    }
    return to;
  };
  const math = copy(tree, 1, 0);
  if (math?.localName !== "math") return null;
  math.classList.add("docwalk-math");
  if (display) math.setAttribute("display", "block");
  else math.removeAttribute("display");
  return math;
}
