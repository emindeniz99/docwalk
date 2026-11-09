/**
 * Ids for a copy of slide content shown beside the slide itself, as the
 * slide overview's thumbnails are (decision 108).
 *
 * The focus view drops a copy's ids (`cleanCopy` in `focus.ts`), which suits
 * a code block or a table. A page can hold a Mermaid diagram, and that SVG
 * needs its ids: its `<style>` selects by the root's id, and its edges reach
 * their markers with `url(#id)`. So a copy here keeps every id under a prefix
 * of its own, and each reference inside the copy follows the renamed element.
 * Only the DOM and the CSSOM are touched; no HTML is parsed (rule 5).
 */

/** `url(#id)` with or without quotes, as SVG attributes and serialized CSS write it. */
const URL_REFERENCE = /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g;
/** An id selector as the CSSOM serializes it: `#` and an identifier, escapes included. */
const ID_SELECTOR = /#((?:\\[0-9a-fA-F]{1,6} ?|\\[^\n\r\f0-9a-fA-F]|[\w\u0080-￿-])+)/g;
/** Attributes that hold a list of ids. */
const ID_LISTS = new Set(["aria-labelledby", "aria-describedby"]);

/**
 * Prefixes every id in `copy` and points each reference inside it at the
 * renamed element: `href="#id"` (`xlink:href` too), `url(#id)` in any
 * attribute, the ARIA id lists, and the id selectors and `url(#id)` values
 * of a `<style>`. A reference to an id the copy does not hold keeps pointing
 * where it did, at the slide.
 */
export function renameIds(copy: Element, prefix: string): void {
  const elements = [copy, ...copy.querySelectorAll("*")];
  const renamed = new Map<string, string>();
  for (const el of elements) {
    if (!el.id) continue;
    renamed.set(el.id, prefix + el.id);
    el.id = prefix + el.id;
  }
  if (renamed.size === 0) return;

  const urls = (value: string) =>
    value.replace(URL_REFERENCE, (whole, quote: string, id: string) => {
      const to = renamed.get(id);
      return to === undefined ? whole : `url(${quote}#${to}${quote})`;
    });
  for (const el of elements) {
    for (const attr of el.attributes) {
      const { localName, value } = attr;
      let next = value;
      if (localName === "id") continue;
      if (localName === "href") {
        const to = value.startsWith("#") ? renamed.get(value.slice(1)) : undefined;
        if (to !== undefined) next = `#${to}`;
      } else if (ID_LISTS.has(localName)) {
        next = value.replace(/\S+/g, (id) => renamed.get(id) ?? id);
      } else if (value.includes("url(")) {
        next = urls(value);
      }
      if (next !== value) attr.value = next;
    }
    if (el.localName === "style") el.textContent = renameInCss(el.textContent ?? "", renamed, urls);
  }
}

/** The style sheet's text with its id selectors and `url(#id)` values renamed, through the CSSOM. */
function renameInCss(
  css: string,
  renamed: ReadonlyMap<string, string>,
  urls: (value: string) => string,
): string {
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return css;
  }
  // The CSSOM writes an id as CSS.escape does, so the escaped forms are the keys.
  const selectors = new Map([...renamed].map(([from, to]) => [CSS.escape(from), CSS.escape(to)]));
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = rule.selectorText.replace(ID_SELECTOR, (whole, id: string) => {
          const to = selectors.get(id);
          return to === undefined ? whole : `#${to}`;
        });
      }
      if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
        const { style } = rule;
        for (const name of style) {
          const value = style.getPropertyValue(name);
          if (value.includes("url(")) {
            style.setProperty(name, urls(value), style.getPropertyPriority(name));
          }
        }
      }
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) visit(rule.cssRules);
    }
  };
  visit(sheet.cssRules);
  return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
}
