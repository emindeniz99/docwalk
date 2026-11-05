/**
 * Text as Markdown that renders as exactly that text. Monaco renders hover
 * messages as Markdown, and a diagnostic can quote the document (a heading,
 * a diagram label), which is hostile input (AGENTS.md rule 5): unescaped,
 * `![x](https://host/p.png)` would load a remote image past the sanitizer's
 * click-to-load gate. CommonMark lets a backslash escape any ASCII
 * punctuation, so escaping all of it leaves no syntax behind.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}
