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
  return DOMPurify.sanitize(svg, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { svg: true, svgFilters: true },
    // Mermaid styles its diagram through one scoped <style> element.
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["image", "foreignObject", "script", "a"],
  });
}
