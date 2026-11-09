/**
 * The highlighting worker (decision 76): Shiki's regex compiling and
 * tokenizing, off the page's thread. The page posts grammars it has loaded
 * and one block at a time (`./shiki.ts`); this answers each under its id.
 * It loads nothing and makes no request. `self` is typed narrowly because the
 * page's tsconfig has the DOM library, not the worker one.
 */
import { loadGrammars, tokenize, type ShikiReply, type ShikiRequest } from "./shikiTokens";

const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<ShikiRequest>) => void): void;
  postMessage(reply: ShikiReply): void;
};

scope.addEventListener("message", ({ data }) => {
  // oxlint-disable unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin; the second argument would be a transfer list.
  if (data.kind === "load") {
    void loadGrammars(data.grammars).then(
      (languages) => scope.postMessage({ kind: "loaded", id: data.id, languages }),
      () => scope.postMessage({ kind: "loaded", id: data.id, languages: [] }),
    );
  } else if (data.kind === "tokenize") {
    void tokenize(data.text, data.language).then(
      (lines) => scope.postMessage({ kind: "tokens", id: data.id, lines }),
      () => scope.postMessage({ kind: "tokens", id: data.id, lines: null }),
    );
  }
  // oxlint-enable unicorn/require-post-message-target-origin
});
