/**
 * Shiki's tokenizer (decision 76): `@shikijs/primitive` (no HTML output,
 * which docwalk builds itself) with its JavaScript regex engine (no
 * WebAssembly, so the CSP needs no `wasm-unsafe-eval`). It runs only in
 * `./shiki.worker.ts`: compiling a grammar's patterns on its first block
 * takes hundreds of milliseconds, which on the page would hold up Mermaid's
 * renders before the deck can measure (decision 43). The page loads each
 * grammar chunk and posts the grammar here (`./shiki.ts`).
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
import type { CodeLanguage, CodeToken, TokenKind } from "./highlight";

/** What the page asks the worker: load grammars, or tokenize one block. */
export type ShikiRequest =
  | { kind: "load"; id: number; grammars: LanguageRegistration[][] }
  | { kind: "tokenize"; id: number; text: string; language: CodeLanguage };

/** What the worker answers, under the request's id: the languages it has, or a block's tokens. */
export type ShikiReply =
  | { kind: "loaded"; id: number; languages: string[] }
  | { kind: "tokens"; id: number; lines: CodeToken[][] | null };

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

function shiki(): Promise<ShikiPrimitive> {
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
  return highlighter;
}

/**
 * Loads each grammar (one with the grammars it embeds) into the shared
 * highlighter and returns every language it holds. A grammar that fails to
 * load is left out, so its blocks stay plain.
 */
export async function loadGrammars(grammars: LanguageRegistration[][]): Promise<string[]> {
  const core = await shiki();
  for (const grammar of grammars) {
    try {
      await core.loadLanguage(grammar);
    } catch {
      // Left out; the page asks for it again on its next build.
    }
  }
  return core.getLoadedLanguages();
}

/** The lines of `text` as tokens, or null when `language` is not loaded. */
export async function tokenize(
  text: string,
  language: CodeLanguage,
): Promise<CodeToken[][] | null> {
  const core = await shiki();
  if (!core.getLoadedLanguages().includes(language)) return null;
  return codeToTokensBase(core, text, { lang: language, theme: THEME }).map((line) =>
    line.map((token): CodeToken => ({
      text: token.content,
      kind: (token.color && KINDS.get(token.color)) || null,
    })),
  );
}
