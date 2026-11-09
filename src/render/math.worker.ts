/**
 * The math worker (decision 101): Temml's parse and build, off the page's
 * thread. The page sends one `MathRequest` at a time and gets one `tree` back;
 * it terminates this worker when a formula runs past its deadline
 * (`./mathRender.ts`), so nothing here watches the clock.
 *
 * The worker loads nothing and makes no request. `self` is typed narrowly
 * because the page's tsconfig has the DOM library, not the worker one.
 */
import { texToTree, type MathReply } from "./mathTree";

const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(reply: MathReply): void;
};

scope.addEventListener("message", ({ data }) => {
  if (typeof data !== "object" || data === null) return;
  const { id, tex, display } = data as Record<string, unknown>;
  if (typeof id !== "number" || typeof tex !== "string" || typeof display !== "boolean") return;
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin; the second argument would be a transfer list.
  scope.postMessage({ kind: "tree", id, tree: texToTree(tex, display) });
});

// After the listener is added, so a request sent on `ready` is never lost.
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above.
scope.postMessage({ kind: "ready" });
