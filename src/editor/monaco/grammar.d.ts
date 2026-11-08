// Monaco ships its Markdown grammar without types.
declare module "monaco-editor/languages/definitions/markdown/markdown" {
  export const conf: import("monaco-editor/editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor/editor").languages.IMonarchLanguage;
}
