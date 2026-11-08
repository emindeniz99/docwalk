/**
 * Math, GitHub's four forms (decision 101).
 *
 * Runs on the DOM after both sanitizers, as code colours do (decision 76).
 * The sanitized HTML holds a formula as the TeX text of a
 * `<code class="language-math">`: inline when the code stands in a line of
 * text, display when it is the only child of a `<pre>`. This replaces each
 * with MathML that `./mathBuild.ts` builds from the allowlist, so no
 * markup of the document's own is ever kept and nothing is parsed from a
 * string.
 *
 * Temml is a lazy chunk, loaded only when the root has a formula. A formula
 * Temml rejects, one over the limits, and every formula when the chunk does
 * not load in time stay as the source they were, in the `<code>` or `<pre>`
 * the sanitizer kept. `renderMath` never rejects, so a deck always goes on to
 * measure (rule 4).
 */
import { loadWithin } from "./lazy";

/** Class on the block that holds a display equation. It scrolls inside itself, and the measure reads it. */
export const MATH_DISPLAY_CLASS = "docwalk-math-display";

/** Class on the `<math>` element of every formula. */
export const MATH_CLASS = "docwalk-math";

/** Class left on the source of a formula that could not be shown. */
export const MATH_ERROR_CLASS = "docwalk-math-error";

/** Most formulas one call renders; the rest stay as source. A document holds a few dozen. */
export const MAX_FORMULAS = 500;

/** How long a deck waits for Temml before it measures with the sources. */
export const MATH_TIMEOUT_MS = 5000;

export type MathBuilder = (tex: string, display: boolean) => Element | null;

export interface MathOptions {
  /** Checked once Temml is in: a stale build leaves its formulas alone. */
  stop?: () => boolean;
  timeoutMs?: number;
  /** Where the builder comes from; tests replace it to simulate a chunk that does not load. */
  load?: () => Promise<MathBuilder>;
}

const loadBuilder = async (): Promise<MathBuilder> => (await import("./mathBuild")).buildMath;

/** The `<code>` elements of `root` that hold a formula and have not been rendered. */
function formulas(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("code.language-math")].filter(
    (code) => !code.classList.contains(MATH_ERROR_CLASS),
  );
}

/** Replaces every formula under `root` with MathML. Resolves once each is drawn or left as source. */
export async function renderMath(
  root: ParentNode,
  { stop = () => false, timeoutMs = MATH_TIMEOUT_MS, load = loadBuilder }: MathOptions = {},
): Promise<void> {
  const found = formulas(root);
  if (found.length === 0) return;
  const build = await loadWithin(load, timeoutMs);
  if (!build || stop()) return;
  for (const code of found.slice(0, MAX_FORMULAS)) draw(code, build);
}

function draw(code: HTMLElement, build: MathBuilder): void {
  const pre = code.parentElement;
  const display = pre?.tagName === "PRE" && pre.childElementCount === 1;
  // A ```math fence ends with a newline; the TeX does not need it.
  const tex = (code.textContent ?? "").trim();
  let math: Element | null = null;
  try {
    math = build(tex, display);
  } catch {
    math = null;
  }
  if (!math) {
    (display && pre ? pre : code).classList.add(MATH_ERROR_CLASS);
    code.classList.add(MATH_ERROR_CLASS);
    return;
  }
  if (display && pre) {
    const host = code.ownerDocument.createElement("div");
    host.className = MATH_DISPLAY_CLASS;
    host.append(math);
    pre.replaceWith(host);
  } else {
    code.replaceWith(math);
  }
}
