/**
 * What a formula will cost to build, read before the work is done (decision
 * 101, rule 5). Two checks sit between the source limits and the limits on
 * the data the worker sends:
 *
 * - `buildWork` reads Temml's parse tree and estimates how many nodes its
 *   builders will make, counting a body once for every time a builder builds
 *   it. The source is short and the output is refused, but in between a
 *   nest of `\cancelto` builds its body three times at each level, so twelve
 *   levels (170 characters) made 6.6 million nodes and took 4.5 s.
 * - `countTree` counts Temml's build tree, a few milliseconds of walking,
 *   before it becomes data. Temml's `toNode()`, which docwalk used to call on
 *   it, is quadratic in Chromium for a wide row: a `\def` of a run of `x`
 *   used 199 times (under `maxExpand`) took 18 s.
 *
 * Temml's parse tree is private ("very likely to change"). The walk is
 * generic over it, so a new node type counts as one unit and its children
 * count as they are; only the builders in `REUSED` are known by name.
 * `mathCost.test.ts` parses real TeX against each.
 */

/** How big a formula may get once built. */
export interface MathLimits {
  /** Elements in the result. */
  nodes: number;
  /** Depth of the result's element tree. */
  depth: number;
}

export const MATH_LIMITS: MathLimits = { nodes: 3000, depth: 40 };

/** Thrown when the tree is larger than the limits allow; the formula is then shown as its source. */
export class MathTooLarge extends Error {
  constructor() {
    super("The formula builds a larger tree than docwalk allows");
  }
}

/**
 * Most characters of text in one tree the worker sends, and the page accepts.
 * `buildWork` lets a macro of text near 10,000 characters through
 * (`\def\a{\text{x x3000}}\a\a\a` is 9,000 units), so this never refuses
 * a formula it accepted.
 */
export const MAX_TREE_TEXT = 16_000;

/**
 * Most units of build work docwalk allows one formula. A unit is a parse
 * node, counted once for every time its parent builds it. Real formulas
 * stay under a few hundred; the largest the source limit lets through, a
 * `\text` of 3,990 letters, is 3,990. Past 10,000 the output is over the
 * element limit anyway, and the build costs 15 ms at most.
 */
export const MAX_BUILD_WORK = 10_000;

/** Deepest parse tree walked; one deeper is refused. Real formulas stay under 60. */
const MAX_WALK_DEPTH = 400;

/** Distinct parse nodes walked before the formula is refused. A 4,000-character source makes about 4,000. */
const MAX_WALK_NODES = 100_000;

/**
 * The builders of Temml 0.14.0 that build one field of their parse node more
 * than once, found by reading every `mathmlBuilder` in `src/functions` and
 * `src/environments`:
 *
 * - `cancelto` builds `body` three times (the content, the phantom under the
 *   arrow, and the dummy that gives `to` its height), two when the body is
 *   one character.
 * - `lap` (`\llap`, `\rlap`, `\clap` and the `\math…lap` names) builds `body`
 *   twice for `llap`: once inside an `mphantom` for the strut, once as the
 *   content. `rlap` and `clap` build it once; counting two for the family
 *   costs nothing a real formula would notice.
 * - `stackedArrow` (`\equilibriumRight`, `\equilibriumLeft`) builds `body`
 *   and `below` twice, through `lowerArrowBody` and `upperArrowBelow`, which
 *   point at the same nodes. The walk below counts the second path with no
 *   entry here, because it follows every field.
 *
 * No other builder was found to build a field twice. `tip` and `genfrac`
 * build two different fields; `supsub` builds `base` once; `mathchoice`
 * builds one of its four. A body that a macro repeats is repeated in the
 * parse tree, so the walk sees each copy.
 */
const REUSED: Readonly<Record<string, { field: string; times: number }>> = {
  cancelto: { field: "body", times: 3 },
  lap: { field: "body", times: 2 },
};

/** Fields that are not part of the tree: a source location points at the lexer and everything it holds. */
const SKIPPED_FIELDS: ReadonlySet<string> = new Set(["loc", "token"]);

/**
 * The estimated number of nodes Temml's builders make for `tree`, a value
 * from `temml.__parse`. It stops adding once the sum passes `limit`, so a
 * bomb costs about as much to measure as a formula at the limit. A tree
 * deeper or wider than the walk allows counts as over the limit.
 */
export function buildWork(tree: unknown, limit: number = MAX_BUILD_WORK): number {
  const over = limit + 1;
  // A node reached by two paths is walked once: the cost of a node does not depend on its parent.
  const memo = new Map<object, number>();
  let walked = 0;
  const cost = (node: unknown, depth: number): number => {
    if (typeof node !== "object" || node === null) return 0;
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (depth > MAX_WALK_DEPTH || ++walked > MAX_WALK_NODES) return over;
    // A cycle counts nothing the second time round.
    memo.set(node, 0);
    let total = 0;
    if (Array.isArray(node)) {
      for (const item of node) {
        total += cost(item, depth + 1);
        if (total > limit) break;
      }
    } else {
      const record = node as Record<string, unknown>;
      if (typeof record["type"] === "string") total = 1;
      const reused = typeof record["type"] === "string" ? REUSED[record["type"]] : undefined;
      for (const [key, value] of Object.entries(record)) {
        if (SKIPPED_FIELDS.has(key)) continue;
        total += cost(value, depth + 1) * (reused?.field === key ? reused.times : 1);
        if (total > limit) break;
      }
    }
    total = Math.min(total, over);
    memo.set(node, total);
    return total;
  };
  return cost(tree, 0);
}

/**
 * The number of elements in Temml's build tree (`MathNode`, `Span` and
 * their kind: anything with a `children` list; text nodes have none),
 * counted without making any. Throws `MathTooLarge` over `limits`, which
 * `fromTree` applies again to what the worker sends.
 */
export function countTree(tree: unknown, limits: MathLimits): number {
  let count = 0;
  const walk = (node: unknown, depth: number): void => {
    if (typeof node !== "object" || node === null) return;
    const children = (node as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    if (depth > limits.depth || ++count > limits.nodes) throw new MathTooLarge();
    for (const child of children) walk(child, depth + 1);
  };
  walk(tree, 1);
  return count;
}
