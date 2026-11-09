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
  tokenLines,
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
 * A worker that keeps blocks waiting this long without answering any of them
 * is stopped, and the blocks it had not answered stay plain. A pattern the
 * regex engine runs into cannot be interrupted; this keeps one from holding
 * the deck's measurement forever. A worker that answers block after block is
 * busy, not stuck: the wait starts again with every answer.
 */
const SILENCE_MS = HIGHLIGHT_TIMEOUT_MS;

/** A timer this far past its due time means the page was busy, not that the worker was silent. */
const LATE_TIMER_MS = 100;

/** How many blocks that ran over a client remembers, to leave them plain at once on the next build. */
const REMEMBERED_OVERRUNS = 100;

/** A message from the worker that has the shape of an answer; anything else is ignored. */
function isReply(data: unknown): data is ShikiReply {
  if (typeof data !== "object" || data === null) return false;
  const { kind, id, languages } = data as Record<string, unknown>;
  if (typeof id !== "number") return false;
  if (kind === "tokens") return true;
  return (
    kind === "loaded" && Array.isArray(languages) && languages.every((l) => typeof l === "string")
  );
}

interface Client {
  request(message: WithoutId<ShikiRequest>): Promise<ShikiReply | null>;
  /** Grammar loads by language, for this worker only: a new worker needs them posted again. */
  grammars: Map<CodeLanguage, Promise<void>>;
  languages: Set<string>;
}

export interface ShikiClientOptions {
  createWorker?: () => WorkerLike;
  /** How long a worker may keep blocks waiting without an answer. */
  silenceMs?: number;
}

/** A short key for a block, so remembering one that ran over does not keep a megabyte of text. */
function blockKey(language: string, text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  return `${language}:${text.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/**
 * A client owns at most one highlighting worker at a time. A crash, a refused
 * start or a worker silent for `silenceMs` while blocks wait drops it; the
 * next build starts another. The worker answers in the order it was asked, so
 * when it falls silent the oldest block still waiting is the one it is stuck
 * on: the client remembers it and never sends it again. Tests pass their own
 * worker and a shorter wait.
 */
export function createShikiClient({
  createWorker = startShikiWorker,
  silenceMs = SILENCE_MS,
}: ShikiClientOptions = {}): { loadTokenizer(languages: CodeLanguage[]): Promise<Tokenize> } {
  let client: Client | null = null;
  // Insertion order is age: a Set remembers it.
  const overruns = new Set<string>();

  const remember = (key: string): void => {
    overruns.delete(key);
    overruns.add(key);
    if (overruns.size > REMEMBERED_OVERRUNS) overruns.delete(overruns.values().next().value!);
  };

  function connect(): Client {
    const worker = createWorker();
    // Requests in the order they were sent, with the block each one carries.
    const waiting = new Map<
      number,
      { key: string | null; settle: (reply: ShikiReply | null) => void }
    >();
    let nextId = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let due = 0;
    let rearmed = false;

    /** Starts the wait again, or stops it when nothing waits. */
    const watch = (): void => {
      clearTimeout(timer);
      timer = undefined;
      if (waiting.size === 0) return;
      due = performance.now() + silenceMs;
      rearmed = false;
      timer = setTimeout(onSilence, silenceMs);
    };
    const onSilence = (): void => {
      // The timer fires late when the page was busy; the answer may be queued behind it.
      if (!rearmed && performance.now() - due > LATE_TIMER_MS) {
        rearmed = true;
        due = performance.now() + silenceMs;
        timer = setTimeout(onSilence, silenceMs);
        return;
      }
      const stuck = waiting.values().next().value;
      if (stuck?.key) remember(stuck.key);
      drop();
    };

    const api: Client = {
      grammars: new Map(),
      languages: new Set(),
      request: (message) => {
        const id = ++nextId;
        const key = message.kind === "tokenize" ? blockKey(message.language, message.text) : null;
        return new Promise((resolve) => {
          waiting.set(id, {
            key,
            settle: (reply) => {
              waiting.delete(id);
              resolve(reply);
            },
          });
          if (timer === undefined) watch();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker has no target origin; the second argument would be a transfer list.
          worker.postMessage({ ...message, id } as ShikiRequest);
        });
      },
    };
    function drop(): void {
      clearTimeout(timer);
      worker.terminate();
      if (client === api) client = null;
      for (const { settle } of waiting.values()) settle(null);
    }
    worker.addEventListener("message", (event) => {
      const { data } = event as MessageEvent<unknown>;
      if (!isReply(data)) return;
      waiting.get(data.id)?.settle(data);
      watch();
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
  async function loadTokenizer(languages: CodeLanguage[]): Promise<Tokenize> {
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
      if (!current.languages.has(language) || overruns.has(blockKey(language, text))) return null;
      const reply = await current.request({ kind: "tokenize", text, language });
      return reply?.kind === "tokens" ? tokenLines(reply.lines) : null;
    };
  }

  return { loadTokenizer };
}

const shared = createShikiClient();

/** The window's highlighting: one worker for every `highlightCode` call. */
export const loadTokenizer = (languages: CodeLanguage[]): Promise<Tokenize> =>
  shared.loadTokenizer(languages);
