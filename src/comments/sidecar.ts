import type { DocumentSource } from "../inputs/types";
import { slugify } from "../export/filename";

const MARKDOWN_EXT = /\.(?:md|markdown|mdown|txt)$/i;

/** The last path segment of a URL or repo path, without its Markdown extension. */
function baseName(path: string): string {
  const last = path.split(/[/\\]/).filter(Boolean).at(-1) ?? "";
  return last.replace(MARKDOWN_EXT, "");
}

/**
 * `<name>.comments.json` (decision 55), named after the Markdown file it
 * goes next to: `design.md` → `design.comments.json`. A document without a
 * file name (pasted, shared) is named after its title.
 */
export function sidecarFileName(source: DocumentSource, title: string): string {
  let name = "";
  if (source.kind === "file") name = baseName(source.name);
  else if (source.kind === "repo") name = baseName(source.path);
  else if (source.kind === "url" && URL.canParse(source.url)) {
    const path = new URL(source.url).pathname;
    try {
      name = baseName(decodeURIComponent(path));
    } catch {
      // A malformed escape (`%E0%A4%A`) keeps its encoded spelling.
      name = baseName(path);
    }
  }
  // Keep a file name readable but safe: letters and digits of any script, dashes.
  const safe = slugify(name) || slugify(title) || "document";
  return `${safe}.comments.json`;
}
