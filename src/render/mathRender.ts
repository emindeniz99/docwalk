/**
 * The page half of math (decision 101): the math worker's lifecycle, a deadline
 * for each formula, and the elements made from what the worker sends.
 * Imported only by `./math.ts`, and only for a document that has a formula.
 *
 * Temml's stylesheet is imported here, and that is also what keeps this chunk
 * and the worker file it names out of the precache: `RUNTIME_CACHED_PACKAGES`
 * matches the stylesheet's module id (`tooling/pwa.ts`). Move the import and
 * `tooling/pwa.test.ts` and the build check fail.
 *
 * Temml never runs on this thread. A formula can be built to run for seconds
 * (a macro that pastes millions of tokens), and Temml has no hook to stop a
 * parse, so the parse runs in a worker that this file can terminate.
 */
import "temml/dist/Temml-Local.css";
import { MATH_TIMEOUT_MS, type MathBuilder } from "./math";
import { fromTree } from "./mathRebuild";
import type { MathReply, MathRequest } from "./mathTree";

/** How long one formula may run in the worker before the page stops it. */
export const MATH_DEADLINE_MS = 500;

/** How many overrun sources a renderer remembers, to refuse them at once on the next render. */
const REMEMBERED_OVERRUNS = 100;

/** A timer this far past its due time means the page was busy, not that the worker was slow. */
const LATE_TIMER_MS = 100;

/** The part of `Worker` the renderer uses; a test passes its own. */
export type MathWorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;

/** The one `new Worker`; Vite only bundles the worker for this literal form. */
export function startMathWorker(): MathWorkerLike {
  return new Worker(new URL("./math.worker.ts", import.meta.url), {
    type: "module",
    name: "docwalk-math",
  });
}

export interface MathRendererOptions {
  createWorker?: () => MathWorkerLike;
  deadlineMs?: number;
  /** How long a worker may take to say `ready`. */
  startMs?: number;
}

interface Live {
  worker: MathWorkerLike;
  /** Settles when the worker says `ready`, or fails to. */
  ready: Promise<void>;
}

interface InFlight {
  id: number;
  worker: MathWorkerLike;
  settle: (tree: unknown) => void;
}

const isReply = (data: unknown): data is MathReply =>
  typeof data === "object" &&
  data !== null &&
  ((data as { kind?: unknown }).kind === "ready" || (data as { kind?: unknown }).kind === "tree");

/**
 * A renderer owns at most one worker, one formula at a time. `ready()` starts
 * the worker and resolves with the builder once it has said `ready`; it
 * rejects when no worker can be started, and `renderMath` then leaves the
 * formulas as source.
 */
export function createMathRenderer({
  createWorker = startMathWorker,
  deadlineMs = MATH_DEADLINE_MS,
  startMs = MATH_TIMEOUT_MS,
}: MathRendererOptions = {}): { ready(): Promise<MathBuilder>; dispose(): void } {
  let live: Live | null = null;
  let flight: InFlight | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let nextId = 0;
  let disposed = false;
  // Insertion order is age: a Set remembers it.
  const overruns = new Set<string>();

  const drop = (worker: MathWorkerLike): void => {
    worker.terminate();
    if (live?.worker === worker) live = null;
    if (flight?.worker === worker) flight.settle(null);
  };

  const start = (): Live => {
    const worker = createWorker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        drop(worker);
        reject(new Error("The math worker did not start"));
      }, startMs);
      worker.addEventListener("message", (event) => {
        const { data } = event as MessageEvent<unknown>;
        if (!isReply(data)) return;
        if (data.kind === "ready") resolve();
        else if (flight?.worker === worker && flight.id === data.id) flight.settle(data.tree);
      });
      const failed = (): void => {
        drop(worker);
        reject(new Error("The math worker failed"));
      };
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
    }).finally(() => clearTimeout(timer));
    // The caller handles a rejection; this keeps a start nobody awaits from being reported.
    ready.catch(() => undefined);
    return { worker, ready };
  };

  const ensure = async (): Promise<MathWorkerLike> => {
    if (disposed) throw new Error("The math renderer is disposed");
    live ??= start();
    const current = live;
    await current.ready;
    return current.worker;
  };

  const remember = (source: string): void => {
    overruns.delete(source);
    overruns.add(source);
    if (overruns.size > REMEMBERED_OVERRUNS) overruns.delete(overruns.values().next().value!);
  };

  /** One formula on the worker: its tree, or null on a deadline, a crash or a refusal. */
  const run = async (tex: string, display: boolean, source: string): Promise<unknown> => {
    const worker = await ensure();
    if (disposed) return null;
    const id = ++nextId;
    return new Promise<unknown>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let due = performance.now() + deadlineMs;
      let rearmed = false;
      const settle = (tree: unknown): void => {
        clearTimeout(timer);
        if (flight?.id === id) flight = null;
        resolve(tree);
      };
      const onDeadline = (): void => {
        // The timer fires late when the page was busy; the reply may be waiting behind it.
        if (!rearmed && performance.now() - due > LATE_TIMER_MS) {
          rearmed = true;
          due = performance.now() + deadlineMs;
          timer = setTimeout(onDeadline, deadlineMs);
          return;
        }
        remember(source);
        drop(worker);
        settle(null);
      };
      flight = { id, worker, settle };
      timer = setTimeout(onDeadline, deadlineMs);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker has no target origin; the second argument would be a transfer list.
      worker.postMessage({ id, tex, display } satisfies MathRequest);
    });
  };

  const build: MathBuilder = (tex, display) => {
    const source = `${display ? "d" : "i"}${tex}`;
    if (overruns.has(source)) return Promise.resolve(null);
    const task = async (): Promise<Element | null> => {
      // A copy of the same source may have overrun while this one waited its turn.
      if (disposed || overruns.has(source)) return null;
      const tree = await run(tex, display, source);
      try {
        return fromTree(tree, display);
      } catch {
        return null;
      }
    };
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };

  return {
    ready: async () => {
      await ensure();
      return build;
    },
    dispose: () => {
      disposed = true;
      if (live) drop(live.worker);
    },
  };
}

const shared = createMathRenderer();

/** The window's builder: one worker for every `renderMath` call. Rejects when no worker starts. */
export const mathBuilder = (): Promise<MathBuilder> => shared.ready();
