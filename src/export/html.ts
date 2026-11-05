import { inlineFonts, sameOriginRules } from "./css";
import { escapeStyleText, rewriteCssUrls } from "./cssText";
import { buildPages, offline, pageCss, writeHead } from "./pages";
import type { ExportOptions } from "./types";

/** Fonts are embedded only while they stay under this size (raw bytes). */
export const FONT_BUDGET_BYTES = 1_500_000;

/**
 * The exported file needs nothing from anywhere: no scripts at all, inline
 * styles, and images and fonts only as `data:` URLs. A stray reference that
 * slipped past the sanitizer is still refused by the browser.
 */
export const EXPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * One self-contained HTML file of the deck (decision 9): the app's CSS
 * inlined, slides as static HTML with diagrams as inline SVG, sanitized
 * again with DOMPurify, no scripts, no remote requests. It scrolls on screen
 * and prints one slide per page.
 */
export async function exportHtml(options: ExportOptions): Promise<Blob> {
  const rules = sameOriginRules(document);
  const text = options.slides.map((s) => s.element.textContent ?? "").join("\n");
  const fonts = await inlineFonts(rules, text, FONT_BUDGET_BYTES);
  const appCss = rules
    .filter((r) => !r.fontFace)
    .map((r) => rewriteCssUrls(r.cssText, r.base, offline))
    .join("\n");

  const doc = document.implementation.createHTMLDocument("");
  const css = [fonts.note, fonts.css, appCss, pageCss(options.size)].join("\n");
  writeHead(doc, options.title, escapeStyleText(css), EXPORT_CSP);
  doc.body.replaceChildren(buildPages(doc, options, offline));
  return new Blob(["<!doctype html>\n", doc.documentElement.outerHTML], {
    type: "text/html;charset=utf-8",
  });
}
