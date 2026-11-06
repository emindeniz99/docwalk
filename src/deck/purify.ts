import DOMPurify from "dompurify";

/**
 * Second sanitizer pass in the browser, after rehype-sanitize. Two passes
 * because each catches what the other's model misses: rehype-sanitize works
 * on the syntax tree, DOMPurify on what the browser's own parser builds
 * (mutation XSS lives in that gap).
 */
export function purifyHtml(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i,
  });
}

/** Mermaid output: SVG only. `htmlLabels` is off, so no HTML inside the SVG is expected or allowed. */
export function purifySvg(svg: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(svg, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { svg: true, svgFilters: true },
    // Mermaid styles its diagram through one scoped <style> element.
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["image", "foreignObject", "script", "a"],
  });
  for (const style of fragment.querySelectorAll("style")) {
    style.textContent = cssWithoutFetches(style.textContent ?? "");
    // reveal.js announces a slide by its text nodes and skips only hidden
    // ones; inside an SVG a <style> displays, so its CSS was read aloud.
    style.setAttribute("aria-hidden", "true");
  }
  return fragment;
}

/**
 * DOMPurify keeps a <style> element but never reads its CSS, and diagram
 * config (themeCSS, fontFamily) lands there. So the browser parses the CSS
 * and every top-level rule that could load something is dropped: any
 * `url(`, `image-set(`, `image(`, `cross-fade(`, `element(` or `@import`.
 * Serializing through the CSSOM resolves escapes such as `u\72l(`; custom
 * property values keep theirs, so a backslash anywhere drops the rule too.
 * Only `url(#id)`, a reference inside the same SVG, is allowed.
 */
const FETCHING_CSS = /url\(|image-set\(|image\(|cross-fade\(|element\(|@import|\\/i;
const LOCAL_REFERENCE = /url\(\s*(["']?)#[\w-]*\1\s*\)/gi;

function cssWithoutFetches(css: string): string {
  const sheet = new CSSStyleSheet();
  try {
    // A constructed sheet ignores @import outright.
    sheet.replaceSync(css);
  } catch {
    return "";
  }
  return [...sheet.cssRules]
    .map((rule) => rule.cssText)
    .filter((text) => !FETCHING_CSS.test(text.replace(LOCAL_REFERENCE, "")))
    .join("\n");
}
