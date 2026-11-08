/**
 * What MathML may reach the page (decision 101).
 *
 * Temml builds a tree of MathML elements from a formula's TeX. docwalk does not
 * trust that tree, however it was produced: `rebuild` copies it into fresh
 * elements and keeps only names, attributes and values from the lists below.
 * Text is copied as text nodes. No HTML string is parsed or assigned on the way,
 * so nothing a formula says can become markup.
 *
 * The export sanitizer (`src/export/pages.ts`) uses the same lists on the live
 * slides, so a second pass holds the same line.
 */

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** MathML Core's elements, plus `menclose` (Temml writes `\cancel` and `\bcancel` with it). */
export const MATH_ELEMENTS: ReadonlySet<string> = new Set([
  "math",
  "menclose",
  "merror",
  "mfrac",
  "mi",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "none",
]);

/**
 * Elements that carry markup or behaviour inside MathML: an `annotation-xml`
 * holds HTML, `maction` can toggle and link, `mglyph` loads an image. They are
 * not in `MATH_ELEMENTS`; the export sanitizer lists them to forbid them by name.
 */
export const FORBIDDEN_MATH_ELEMENTS: readonly string[] = [
  "semantics",
  "annotation",
  "annotation-xml",
  "maction",
  "mglyph",
];

/** No `href`, `style`, `id`, `xlink:href`, `src` or event handler. */
export const MATH_ATTRIBUTES: ReadonlySet<string> = new Set([
  "accent",
  "accentunder",
  "columnalign",
  "columnspan",
  "depth",
  "dir",
  "display",
  "displaystyle",
  "fence",
  "form",
  "height",
  "largeop",
  "linebreak",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "rowalign",
  "rowspacing",
  "rowspan",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "symmetric",
  "voffset",
  "width",
]);

/**
 * The classes that Temml's own stylesheet (`Temml-Local.css`) defines. A class
 * with no rule does nothing, so keeping only these loses nothing, and a class
 * that belongs to the page (`docwalk-diagram`, `present`) can never come from a
 * formula. `mathAllow.test.ts` checks the list against the stylesheet.
 */
export const MATH_CLASSES: ReadonlySet<string> = new Set([
  "actuarial",
  "chr-lrg",
  "chr-lrg-vec",
  "chr-med",
  "chr-med-vec",
  "chr-sml",
  "chr-sml-vec",
  "circle-pad",
  "downstrike",
  "ff-narrow",
  "ff-nudge-left",
  "ff-squash",
  "longdiv-arc",
  "longdiv-top",
  "mathcal",
  "mathscr",
  "menclose",
  "phasor-angle",
  "phasor-bottom",
  "sout",
  "special-fraction",
  "textcircle",
  "tml-cancel",
  "tml-cancelto",
  "tml-display",
  "tml-eqn",
  "tml-fbox",
  "tml-hat-1",
  "tml-hat-2",
  "tml-hat-3",
  "tml-hat-4",
  "tml-jot",
  "tml-left",
  "tml-lrg-pad",
  "tml-med-pad",
  "tml-overline",
  "tml-prime",
  "tml-right",
  "tml-shift-left",
  "tml-small",
  "tml-sml-pad",
  "tml-tilde-2",
  "tml-tilde-3",
  "tml-tilde-4",
  "tml-underline",
  "tml-vec",
  "tml-xcancel",
  "upstrike",
  "wbk-acc",
  "wbk-lrg",
  "wbk-lrg-acc",
  "wbk-lrg-vec",
  "wbk-med",
  "wbk-med-acc",
  "wbk-med-vec",
  "wbk-sml",
  "wbk-sml-acc",
  "wbk-sml-vec",
]);

/** Letters, digits, spaces and the few marks a length, a colour or a keyword list needs. */
const SAFE_VALUE = /^[\w.%+#, -]{0,64}$/;

/** Whether an attribute of a MathML element may stay. */
export function mathAttributeAllowed(name: string, value: string): boolean {
  return MATH_ATTRIBUTES.has(name) && SAFE_VALUE.test(value);
}

/** The class names of `value` that Temml's stylesheet defines. */
export function mathClasses(value: string): string[] {
  return value.split(/\s+/).filter((name) => MATH_CLASSES.has(name));
}
