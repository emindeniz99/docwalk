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
 *
 * It draws in slices. A document can hold 500 formulas, and one loop over
 * them was a single task (100 plain 3,990-character formulas: 14.9 s), which
 * freezes the tab and, in WebKit, the other window of a presenter. After 16 ms
 * of work it hands the thread back, asks `stop()` again, and goes on. The
 * promise resolves when the last formula is drawn or left as source, so the
 * callers that await it still measure after math has rendered (rule 4).
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

/**
 * How long one call may spend building formulas, in total. The per-formula
 * limits keep one formula to tens of milliseconds, and a document's few dozen
 * take a few milliseconds each, so 3 s is more than a real document needs.
 * Formulas past it stay as source, unmarked, and the next call tries them.
 * Time spent yielded does not count.
 */
export const MATH_BUDGET_MS = 3000;

/** How long the loop works before it hands the thread back; about one frame. */
export const MATH_SLICE_MS = 16;

export type MathBuilder = (tex: string, display: boolean) => Element | null;

export interface MathOptions {
  /** Checked once Temml is in, and before each formula: a stale build leaves its formulas alone. */
  stop?: () => boolean;
  timeoutMs?: number;
  /** Most time this call spends building formulas; the rest stay as source. */
  budgetMs?: number;
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

/**
 * Hands the main thread back for a turn. WebKit has no `scheduler.yield`;
 * a zero timeout is the portable fallback, and it lets timers run too.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Replaces every formula under `root` with MathML. Resolves once each is drawn or left as source. */
export async function renderMath(
  root: ParentNode,
  {
    stop = () => false,
    timeoutMs = MATH_TIMEOUT_MS,
    budgetMs = MATH_BUDGET_MS,
    load = loadBuilder,
  }: MathOptions = {},
): Promise<void> {
  const found = formulas(root);
  if (found.length === 0) return;
  const build = await loadWithin(load, timeoutMs);
  if (!build) return;
  let spent = 0;
  let sliceStart = performance.now();
  for (const code of found.slice(0, MAX_FORMULAS)) {
    if (stop() || spent >= budgetMs) return;
    const started = performance.now();
    draw(code, build);
    const now = performance.now();
    spent += now - started;
    if (now - sliceStart >= MATH_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
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
