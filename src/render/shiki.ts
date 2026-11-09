/**
 * The lazy half of code highlighting (decision 76): Shiki's tokenizer
 * (`@shikijs/primitive`: no HTML output, which docwalk builds itself) with
 * its JavaScript regex engine (no WebAssembly, so the CSP needs no
 * `wasm-unsafe-eval`) and one dynamically imported chunk per grammar.
 * Imported only by `./highlight.ts`, and only for a document that has a
 * block in a known language.
 */
import { createCssVariablesTheme } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import {
  codeToTokensBase,
  createShikiPrimitiveAsync,
  type LanguageRegistration,
  type ShikiPrimitive,
  type ThemeRegistration,
} from "@shikijs/primitive";
import type { CodeLanguage, CodeToken, TokenKind, Tokenize } from "./highlight";

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

const PREFIX = "--dw-code-";

/**
 * Shiki's CSS-variables theme colours each token `var(--dw-code-<name>)`.
 * Those names are only lookup keys: each maps to one of docwalk's colour
 * classes, and a name not listed here (punctuation, plain text) gets none.
 * No colour value from Shiki reaches the page.
 */
const KINDS = new Map<string, TokenKind>([
  [`var(${PREFIX}token-keyword)`, "keyword"],
  [`var(${PREFIX}token-string)`, "string"],
  [`var(${PREFIX}token-string-expression)`, "string"],
  [`var(${PREFIX}token-link)`, "string"],
  [`var(${PREFIX}token-comment)`, "comment"],
  [`var(${PREFIX}token-constant)`, "constant"],
  [`var(${PREFIX}token-changed)`, "constant"],
  [`var(${PREFIX}token-function)`, "function"],
  [`var(${PREFIX}token-parameter)`, "parameter"],
  [`var(${PREFIX}token-inserted)`, "inserted"],
  [`var(${PREFIX}token-deleted)`, "deleted"],
]);

const THEME = "docwalk";

/**
 * The CSS-variables theme marks Markdown headings with weight alone, which
 * docwalk leaves out (decision 76: colour only), so they get the constant
 * colour, as on GitHub. Bold and italic are marked with weight and style
 * alone too; GitHub shows them in its text colour, so the function colour is
 * docwalk's own choice (decision 115).
 */
function docwalkTheme(): ThemeRegistration {
  const theme = createCssVariablesTheme({ name: THEME, variablePrefix: PREFIX, fontStyle: false });
  return {
    ...theme,
    tokenColors: [
      ...(theme.tokenColors ?? []),
      {
        scope: ["markup.heading", "entity.name.section"],
        settings: { foreground: `var(${PREFIX}token-constant)` },
      },
      {
        scope: ["markup.bold", "markup.italic"],
        settings: { foreground: `var(${PREFIX}token-function)` },
      },
    ],
  };
}

let highlighter: Promise<ShikiPrimitive> | null = null;
const pending = new Map<CodeLanguage, Promise<void>>();

/**
 * Loads the grammars `languages` need into one shared highlighter. A grammar
 * that fails to load is left out (its blocks stay plain) and tried again on
 * the next call.
 */
export async function loadTokenizer(languages: CodeLanguage[]): Promise<Tokenize> {
  highlighter ??= createShikiPrimitiveAsync({
    themes: [docwalkTheme()],
    langs: [],
    // `forgiving`: a pattern the engine cannot translate is skipped instead of
    // failing the whole grammar; that block is then a little less coloured.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighter = null;
    throw error;
  });
  const core = await highlighter;
  await Promise.all(
    languages.map((language) => {
      let load = pending.get(language);
      if (!load) {
        load = GRAMMARS[language]()
          .then((grammar) => core.loadLanguage(grammar.default))
          .catch(() => {
            pending.delete(language);
          });
        pending.set(language, load);
      }
      return load;
    }),
  );
  const loaded = new Set(core.getLoadedLanguages());
  return (text, language) => {
    if (!loaded.has(language)) return null;
    return codeToTokensBase(core, text, { lang: language, theme: THEME }).map((line) =>
      line.map((token): CodeToken => ({
        text: token.content,
        kind: (token.color && KINDS.get(token.color)) || null,
      })),
    );
  };
}
