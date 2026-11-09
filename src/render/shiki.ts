/**
 * The lazy half of code highlighting (decision 76), page side. Shiki itself
 * runs in a Web Worker (`./shiki.worker.ts`, with `./shikiTokens.ts`): the
 * first block of a grammar compiles its patterns, hundreds of milliseconds
 * that on this thread would hold up Mermaid's renders before the deck can
 * measure (decision 43). This file loads each grammar chunk, one per language
 * from a fixed list, and posts the grammar to the worker, so the grammars
 * stay chunks of the page that the service worker caches on first use.
 * Imported only by `./highlight.ts`, and only for a document that has a block
 * in a known language.
 */
import type { LanguageRegistration } from "@shikijs/primitive";
import {
  HIGHLIGHT_TIMEOUT_MS,
  type CodeLanguage,
  type CodeToken,
  type Tokenize,
} from "./highlight";
import type { ShikiReply, ShikiRequest } from "./shikiTokens";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

/** One chunk per grammar; a grammar that embeds others (HTML: CSS and JavaScript) imports them. */
const GRAMMARS: Record<CodeLanguage, Grammar> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

/** A request as the caller writes it; the client adds the id. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** The part of `Worker` the client uses. */
type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;

/** The one `new Worker`; Vite only bundles the worker for this literal form. */
function startShikiWorker(): WorkerLike {
  return new Worker(new URL("./shiki.worker.ts", import.meta.url), {
    type: "module",
    name: "docwalk-shiki",
  });
}

/**
 * A worker that has not answered a request after this long is stopped and
 * the request's blocks stay plain. A regex the engine runs into cannot be
 * interrupted; this keeps one from holding the deck's measurement forever.
 */
const REPLY_DEADLINE_MS = HIGHLIGHT_TIMEOUT_MS;

interface Client {
  request(message: WithoutId<ShikiRequest>): Promise<ShikiReply | null>;
  /** Grammar loads by language, for this worker only: a new worker needs them posted again. */
  grammars: Map<CodeLanguage, Promise<void>>;
  languages: Set<string>;
}

let client: Client | null = null;

/** Starts the worker. A crash, a refused start or a missed deadline drops it; the next build starts another. */
function connect(): Client {
  const worker = startShikiWorker();
  const waiting = new Map<number, (reply: ShikiReply | null) => void>();
  let nextId = 0;
  const api: Client = {
    grammars: new Map(),
    languages: new Set(),
    request: (message) => {
      const id = ++nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(drop, REPLY_DEADLINE_MS);
        waiting.set(id, (reply) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(reply);
        });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker has no target origin; the second argument would be a transfer list.
        worker.postMessage({ ...message, id } as ShikiRequest);
      });
    },
  };
  function drop(): void {
    worker.terminate();
    if (client === api) client = null;
    for (const settle of waiting.values()) settle(null);
  }
  worker.addEventListener("message", (event) => {
    const reply = (event as MessageEvent<ShikiReply>).data;
    waiting.get(reply.id)?.(reply);
  });
  worker.addEventListener("error", drop);
  worker.addEventListener("messageerror", drop);
  return api;
}

/**
 * Loads the grammars `languages` need into the worker. A grammar that fails
 * to load is left out (its blocks stay plain) and tried again on the next
 * call. Rejects when no worker can be started.
 */
export async function loadTokenizer(languages: CodeLanguage[]): Promise<Tokenize> {
  const current = (client ??= connect());
  await Promise.all(
    languages.map((language) => {
      let load = current.grammars.get(language);
      if (!load) {
        load = GRAMMARS[language]()
          .then((grammar) => current.request({ kind: "load", grammars: [grammar.default] }))
          .then((reply) => {
            if (reply?.kind === "loaded")
              for (const name of reply.languages) current.languages.add(name);
            if (!current.languages.has(language)) current.grammars.delete(language);
          })
          .catch(() => {
            current.grammars.delete(language);
          });
        current.grammars.set(language, load);
      }
      return load;
    }),
  );
  return async (text, language): Promise<CodeToken[][] | null> => {
    if (!current.languages.has(language)) return null;
    const reply = await current.request({ kind: "tokenize", text, language });
    return reply?.kind === "tokens" ? reply.lines : null;
  };
}
