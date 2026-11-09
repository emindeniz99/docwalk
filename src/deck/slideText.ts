/**
 * The words a reader sees on one paginated page, as one line of plain text
 * for the command palette's search (decision 81).
 *
 * It reads the rendered page, after pagination, so a hit names the page that
 * holds the words (rule 7). What it leaves out: the breadcrumb and the
 * overflow note (outside the slide body), the "continued" marker, the hidden
 * "Footnotes" label, scripts and styles, and rendered Mermaid diagrams (an
 * SVG's text is a stylesheet and node labels in drawing order, not prose).
 * Speaker notes are HTML comments and never reach the page (decision 79).
 */

/** Elements that end a line of text, so the last word of one never joins the first of the next. */
const BLOCK = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);

/** Elements whose content is not the page's words. */
const SKIPPED =
  ".docwalk-diagram, .docwalk-continued, .docwalk-overflow, [data-footnotes] > .sr-only, script, style, template";

export function slideText(page: HTMLElement): string {
  const body = page.querySelector<HTMLElement>(".docwalk-slide-body") ?? page;
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.matches(SKIPPED)) return;
    const block = BLOCK.has(el.tagName);
    if (block) parts.push(" ");
    for (const child of el.childNodes) walk(child);
    if (block) parts.push(" ");
  };
  walk(body);
  return parts.join("").replace(/\s+/g, " ").trim().normalize("NFC");
}
