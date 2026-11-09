/**
 * Language-aware colours for fenced code blocks (decision 76).
 *
 * Runs on the DOM after both sanitizers, never on HTML strings: it reads a
 * block's text with `textContent` and writes it back as text nodes and
 * `<span class="dw-code-…">` elements built with DOM APIs, so nothing in a
 * code block can become markup. A block keeps exactly the text it had (the
 * spans are checked against it), and the colour classes change no font
 * metric, so line breaks and heights stay what pagination measured.
 *
 * Shiki and the grammars are a lazy chunk (`./shiki.ts`), loaded only when a
 * document has a block in one of `CODE_LANGUAGES`; Shiki tokenizes in a Web
 * Worker, so Mermaid renders beside it on this thread. A block in any other
 * language, or one whose grammar fails to load, stays plain. A grammar that
 * lands after the timeout colours its blocks in place (decision 115).
 */

/** The grammars docwalk loads, by Shiki's name for them. */
export const CODE_LANGUAGES = [
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "docker",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "markdown",
  "python",
  "rust",
  "shellscript",
  "sql",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/**
 * Info-string names (GitHub's, lowercased) that mean one of the grammars. A
 * `Map`, so a name such as `constructor` or `__proto__` finds nothing.
 */
const ALIASES = new Map<string, CodeLanguage>([
  ...CODE_LANGUAGES.map((name): [string, CodeLanguage] => [name, name]),
  ["h", "c"],
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["cs", "csharp"],
  ["c#", "csharp"],
  ["patch", "diff"],
  ["dockerfile", "docker"],
  ["golang", "go"],
  ["gql", "graphql"],
  ["htm", "html"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["md", "markdown"],
  ["py", "python"],
  ["rs", "rust"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["shell", "shellscript"],
  ["zsh", "shellscript"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["yml", "yaml"],
]);

/** The grammar for a fence's info string, or null when docwalk has none for it. */
export function codeLanguage(name: string): CodeLanguage | null {
  return ALIASES.get(name.toLowerCase()) ?? null;
}

/** The grammar a rendered `<code>` element asks for through its `language-…` class. */
function languageOf(code: Element): CodeLanguage | null {
  for (const name of code.classList) {
    if (name.startsWith("language-")) return codeLanguage(name.slice("language-".length));
  }
  return null;
}

/** One coloured run of a code block; `kind` null means the block's own text colour. */
export interface CodeToken {
  text: string;
  kind: TokenKind | null;
}

/** The colour classes a token can get; content.css maps each onto the design tokens. */
export const TOKEN_KINDS = [
  "keyword",
  "string",
  "comment",
  "constant",
  "function",
  "parameter",
  "inserted",
  "deleted",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * What the lazy chunk hands back: the lines of `text` as tokens, or null when
 * `language` is not loaded. The chunk's answers come from its worker, so they
 * arrive later.
 */
export type Tokenize = (
  text: string,
  language: CodeLanguage,
) => CodeToken[][] | null | Promise<CodeToken[][] | null>;

/**
 * How long a deck waits for Shiki and the grammars before it measures with
 * plain blocks. A failed load (offline, a never-cached grammar) ends sooner;
 * this bounds a load that hangs.
 */
export const HIGHLIGHT_TIMEOUT_MS = 5000;

/**
 * How much longer after the timeout a grammar may take and still colour the
 * blocks already on the page (decision 115). Past this a hung load is
 * dropped; the next rebuild asks again.
 */
export const LATE_HIGHLIGHT_MS = 60_000;

let loader: Promise<typeof import("./shiki")> | null = null;

/**
 * Loads Shiki and the grammars `languages` need. `tokenize` is null when
 * that fails or takes longer than `timeoutMs`; after a timeout `late` is the
 * load still running, which settles to null if it fails.
 */
async function tokenizerFor(
  languages: ReadonlySet<CodeLanguage>,
  timeoutMs: number,
): Promise<{ tokenize: Tokenize | null; late: Promise<Tokenize | null> | null }> {
  loader ??= import("./shiki");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });
  const load = loader
    .then((shiki) => shiki.loadTokenizer([...languages]))
    .catch((): null => {
      // A chunk that failed to load is asked for again by the next render.
      loader = null;
      return null;
    });
  try {
    const tokenize = await Promise.race([load, timeout]);
    return { tokenize, late: timedOut ? load : null };
  } finally {
    clearTimeout(timer);
  }
}

export interface HighlightOptions {
  /** Checked once the grammars are in: a stale build leaves its blocks alone. */
  stop?: () => boolean;
  timeoutMs?: number;
}

/**
 * Colours every fenced code block under `root` whose language docwalk knows.
 * Resolves once every such block is coloured or left plain, or at the
 * timeout; it never rejects, so a deck always goes on to measure. A grammar
 * that lands after the timeout (within `LATE_HIGHLIGHT_MS`, and only while
 * `stop()` is false) colours the blocks then under `root`, in place: colour
 * changes no metric (decision 76), so nothing is measured again (115).
 */
export async function highlightCode(
  root: ParentNode,
  { stop = () => false, timeoutMs = HIGHLIGHT_TIMEOUT_MS }: HighlightOptions = {},
): Promise<void> {
  const blocks = plainBlocks(root);
  if (blocks.length === 0) return;
  const { tokenize, late } = await tokenizerFor(new Set(blocks.map((b) => b.language)), timeoutMs);
  if (tokenize) {
    if (!stop()) await colourAll(blocks, tokenize, stop);
    return;
  }
  if (late) void colourLate(root, late, stop);
}

/** The blocks under `root` that a known grammar could colour and nothing has yet. */
function plainBlocks(root: ParentNode): { code: HTMLElement; language: CodeLanguage }[] {
  const blocks: { code: HTMLElement; language: CodeLanguage }[] = [];
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const language = languageOf(code);
    // Element children mean the block is coloured already (a copy of a page).
    if (language && code.children.length === 0) blocks.push({ code, language });
  }
  return blocks;
}

/**
 * The late pass (decision 115). It asks `root` for its blocks again, because
 * pagination replaces a split section's elements with copies after the
 * timeout.
 */
async function colourLate(
  root: ParentNode,
  late: Promise<Tokenize | null>,
  stop: () => boolean,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LATE_HIGHLIGHT_MS);
  });
  try {
    const tokenize = await Promise.race([late, cutoff]);
    if (!tokenize || stop()) return;
    await colourAll(plainBlocks(root), tokenize, stop);
  } finally {
    clearTimeout(timer);
  }
}

/** Asks for every block's tokens at once, so the worker never waits on the page between blocks. */
async function colourAll(
  blocks: { code: HTMLElement; language: CodeLanguage }[],
  tokenize: Tokenize,
  stop: () => boolean,
): Promise<void> {
  await Promise.all(blocks.map(({ code, language }) => colour(code, language, tokenize, stop)));
}

async function colour(
  code: HTMLElement,
  language: CodeLanguage,
  tokenize: Tokenize,
  stop: () => boolean,
): Promise<void> {
  const text = code.textContent ?? "";
  let lines: CodeToken[][] | null;
  try {
    lines = await tokenize(text, language);
  } catch {
    return;
  }
  // A stale build leaves its blocks alone, and a block that changed while
  // its tokens were on the way (coloured by another pass) is not coloured twice.
  if (!lines || stop() || code.children.length > 0 || code.textContent !== text) return;
  // The spans must spell the block's text exactly, or copy, search and the
  // measured layout would change; anything else leaves the block plain.
  if (lines.map((line) => line.map((t) => t.text).join("")).join("\n") !== text) return;
  const doc = code.ownerDocument;
  const out = doc.createDocumentFragment();
  lines.forEach((line, i) => {
    if (i > 0) out.append("\n");
    for (const token of line) {
      if (!token.kind) {
        out.append(token.text);
        continue;
      }
      const span = doc.createElement("span");
      span.className = `dw-code-${token.kind}`;
      span.textContent = token.text;
      out.append(span);
    }
  });
  code.replaceChildren(out);
}
