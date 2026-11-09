/**
 * Math, GitHub's four forms (decision 101).
 *
 * Runs on the DOM after both sanitizers, as code colours do (decision 76).
 * The sanitized HTML holds a formula as the TeX text of a
 * `<code class="language-math">`: inline when the code stands in a line of
 * text, display when it is the only child of a `<pre>`. This replaces each
 * with MathML that `./mathRebuild.ts` builds from the allowlist, so no
 * markup of the document's own is ever kept and nothing is parsed from a
 * string.
 *
 * Temml runs in a Web Worker (`./math.worker.ts`), never on this thread: a
 * formula can be built to run for seconds, and the page stops the worker that
 * runs one for too long (`./mathRender.ts`). The page half is a lazy chunk,
 * loaded only when the root has a formula. A formula Temml rejects, one over
 * the limits or the deadline stay as the source they were, marked with
 * `docwalk-math-error`, in the `<code>` or `<pre>` the sanitizer kept. When the
 * chunk does not load in time, or no worker starts, every formula stays as
 * plain source. `renderMath` never rejects, so a deck always goes on to
 * measure (rule 4).
 *
 * It draws in slices. A document can hold 500 formulas, and one loop over
 * them was a single task (100 plain 3,990-character formulas: 14.9 s), which
 * freezes the tab and, in WebKit, the other window of a presenter. After 16 ms
 * the loop hands the thread back, asks `stop()` again, and goes on. The
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

/** How long a deck waits for the math chunk and its worker before it measures with the sources. */
export const MATH_TIMEOUT_MS = 5000;

/**
 * How long one call may spend on formulas, in total: each one's time from the
 * request to the result, the worker's share and any restart included. The
 * per-formula limits keep one formula to tens of milliseconds, and a
 * document's few dozen take a few milliseconds each, so 3 s is more than a
 * real document needs. Six formulas that run out the 500 ms deadline use it
 * up. Formulas past it stay as source, unmarked, and the next call tries them
 * (the ones that ran out are refused at once). Time spent yielded between
 * formulas does not count.
 */
export const MATH_BUDGET_MS = 3000;

/** How long the loop works before it hands the thread back; about one frame. */
export const MATH_SLICE_MS = 16;

/** A formula in, its `<math>` out; `null` means show the source. Rejects when the renderer is gone. */
export type MathBuilder = (tex: string, display: boolean) => Promise<Element | null>;

export interface MathOptions {
  /** Checked once the builder is in, before each formula and after it: a stale build leaves its formulas alone. */
  stop?: () => boolean;
  timeoutMs?: number;
  /** Most time this call spends building formulas; the rest stay as source. */
  budgetMs?: number;
  /** Where the builder comes from; tests replace it to simulate a chunk that does not load or a worker that does not start. */
  load?: () => Promise<MathBuilder>;
}

const loadBuilder = async (): Promise<MathBuilder> => (await import("./mathRender")).mathBuilder();

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
    // A rejection means the renderer is gone: the rest stay as source, as with a chunk that did not load.
    if (!(await draw(code, build, stop))) return;
    const now = performance.now();
    spent += now - started;
    if (now - sliceStart >= MATH_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
}

/** Draws one formula. False when the run should end: the builder rejected, or `stop()` turned true. */
async function draw(code: HTMLElement, build: MathBuilder, stop: () => boolean): Promise<boolean> {
  const pre = code.parentElement;
  const display = pre?.tagName === "PRE" && pre.childElementCount === 1;
  // A ```math fence ends with a newline; the TeX does not need it.
  const tex = (code.textContent ?? "").trim();
  let math: Element | null;
  try {
    math = await build(tex, display);
  } catch {
    return false;
  }
  if (stop()) return false;
  if (!math) {
    (display && pre ? pre : code).classList.add(MATH_ERROR_CLASS);
    code.classList.add(MATH_ERROR_CLASS);
    return true;
  }
  if (display && pre) {
    const host = code.ownerDocument.createElement("div");
    host.className = MATH_DISPLAY_CLASS;
    host.append(math);
    pre.replaceWith(host);
  } else {
    code.replaceWith(math);
  }
  return true;
}
