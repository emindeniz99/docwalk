import { MATHML_NS, MATH_ELEMENTS, mathAttributeAllowed, mathClasses } from "./mathAllow";
import { MATH_LIMITS, MathTooLarge, type MathLimits } from "./mathCost";

/**
 * The rebuild half of the allowlist (decision 101): a fresh copy of a MathML
 * tree that keeps only what `./mathAllow.ts` lists. DOM only, so the lists
 * stay importable where there is no DOM.
 */

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const RGB_COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;

/** A hex colour from a hex or an `rgb(r, g, b)` value (what the browser writes for a colour set from script), or null. */
function hexColour(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (HEX_COLOR.test(value)) return value;
  const rgb = RGB_COLOR.exec(value);
  if (!rgb) return null;
  const parts = [rgb[1], rgb[2], rgb[3]].map((part) => Math.min(255, Number(part)));
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Temml writes a few things as a `style` attribute. None of it is kept as
 * style, but what it meant is kept in a form that is allowed: a text or
 * background colour becomes `mathcolor` or `mathbackground`, and the box of
 * `\boxed` becomes Temml's `tml-fbox` class. A colour must be a hex or `rgb()` value.
 */
function fromStyle(style: string): { attributes: [string, string][]; classes: string[] } {
  const attributes: [string, string][] = [];
  const classes: string[] = [];
  const declarations = new Map<string, string>();
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0) declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  const colour = hexColour(declarations.get("color"));
  if (colour) attributes.push(["mathcolor", colour]);
  const background = hexColour(declarations.get("background-color"));
  if (background) attributes.push(["mathbackground", background]);
  if (declarations.get("border") === "1px solid" && declarations.get("padding") === "3pt") {
    classes.push("tml-fbox");
  }
  return { attributes, classes };
}

/**
 * How far a raise may move text off its line, in em, summed down a chain of
 * `mpadded` elements. Each `\raisebox` is held to `maxSize` 20 em by Temml,
 * but nothing added them up: stacked, they drew text 587 px above the slide
 * body with no note (rule 3). A formula's real raises are a fraction of an em.
 */
export const MAX_VOFFSET_EM = 3;

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
 * A fresh copy of `source` holding only what the lists above allow: the
 * element and its subtree, or `null` when `source` itself is not allowed
 * (an element outside the lists takes its whole subtree with it). Throws
 * `MathTooLarge` over the limits.
 */
export function rebuild(source: Element, limits: MathLimits = MATH_LIMITS): Element | null {
  let nodes = 0;
  // `shift` is the sum of the `voffset` of the elements above, in em.
  const copy = (from: Element, depth: number, shift: number): Element | null => {
    if (from.namespaceURI !== MATHML_NS || !MATH_ELEMENTS.has(from.localName)) return null;
    if (depth > limits.depth || ++nodes > limits.nodes) throw new MathTooLarge();
    const to = from.ownerDocument.createElementNS(MATHML_NS, from.localName);
    const classes: string[] = [];
    let below = shift;
    for (const { name, value } of Array.from(from.attributes)) {
      if (name === "voffset") {
        // Kept while the sum along this chain stays in range; dropped from the first raise past it.
        const em = voffsetEm(value);
        if (
          em !== null &&
          Math.abs(shift + em) <= MAX_VOFFSET_EM &&
          mathAttributeAllowed(name, value)
        ) {
          to.setAttribute(name, value);
          below = shift + em;
        }
      } else if (name === "class") classes.push(...mathClasses(value));
      else if (name === "style") {
        const meant = fromStyle(value);
        classes.push(...meant.classes);
        for (const [key, v] of meant.attributes) if (!to.hasAttribute(key)) to.setAttribute(key, v);
      } else if (mathAttributeAllowed(name, value)) to.setAttribute(name, value);
    }
    if (classes.length > 0) to.setAttribute("class", [...new Set(classes)].join(" "));
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.append(from.ownerDocument.createTextNode(child.nodeValue ?? ""));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const kept = copy(child as Element, depth + 1, below);
        if (kept) to.append(kept);
      }
    }
    return to;
  };
  return copy(source, 1, 0);
}
