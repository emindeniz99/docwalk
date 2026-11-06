import DOMPurify, { type Config } from "dompurify";
import { rewriteCssUrls } from "./cssText";
import { m } from "../paraglide/messages.js";
import rawPageCss from "./page.css?raw";
import type { ExportOptions, ExportSlide } from "./types";

/** Whether an export may keep a reference to this (absolute) URL. */
export type ResourcePolicy = (url: URL) => boolean;

/** Nothing outside the file: only `data:` URLs and local fragments survive. */
export const offline: ResourcePolicy = () => false;

/** Only the app's own origin (and `blob:` URLs it created). */
export const sameOrigin: ResourcePolicy = (url) => url.origin === location.origin;

/** Attributes whose value the browser fetches or follows. `href` on `<a>` is a link, handled apart. */
const URL_ATTRS = new Set([
  "src",
  "srcset",
  "href",
  "xlink:href",
  "poster",
  "background",
  "action",
  "formaction",
  "cite",
  "longdesc",
  "data-src",
]);

// A private instance: hooks on the shared DOMPurify would leak into the deck's sanitizer.
const purifier = DOMPurify(window);
let activePolicy: ResourcePolicy = offline;

purifier.addHook("afterSanitizeAttributes", (node) => {
  // A copy: removing from the live NamedNodeMap while iterating it would skip attributes.
  for (const { name, value } of Array.from(node.attributes)) {
    const lower = name.toLowerCase();
    // Namespace declarations carry http URLs and mean nothing to the HTML parser.
    if (lower === "xmlns" || lower.startsWith("xmlns:")) {
      node.removeAttribute(name);
    } else if (lower === "style") {
      const rewritten = rewriteCssUrls(value, document.baseURI, activePolicy);
      if (rewritten !== value) node.setAttribute(name, rewritten);
    } else if (node.localName === "a" && lower === "href") {
      // A link is the document's own words; it fetches nothing until clicked.
      if (/^\s*(?:https?:|mailto:|#)/i.test(value)) node.setAttribute("rel", "noopener noreferrer");
      else node.removeAttribute(name);
    } else if (URL_ATTRS.has(lower) && !resourceAllowed(value, activePolicy)) {
      node.removeAttribute(name);
    }
  }
});

function resourceAllowed(value: string, policy: ResourcePolicy): boolean {
  const v = value.trim();
  if (v.startsWith("#")) return true;
  if (/^data:(?:image|font)\//i.test(v)) return true;
  if (v === "" || /^data:/i.test(v)) return false;
  try {
    return policy(new URL(v, document.baseURI));
  } catch {
    return false;
  }
}

const PURIFY_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  // Mermaid styles each diagram with one <style> inside its SVG.
  ADD_TAGS: ["style"],
  FORBID_TAGS: [
    "script",
    "foreignObject",
    "image",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "link",
    "meta",
    "base",
  ],
};

// Pages are assembled in an inert document, so no image starts loading before it is checked.
const inert = document.implementation.createHTMLDocument("");

/**
 * Undo what the live deck added to a slide and what makes no sense on a
 * static page: reveal.js's inline styles and state, the diagram host's
 * button role (nothing opens it in an export), elements that are hidden
 * anyway, and image sources the policy does not allow. A blocked image
 * stays a blocked placeholder; its remote URL is not carried along.
 */
export function prepareSlide(el: HTMLElement, policy: ResourcePolicy): HTMLElement {
  for (const attr of ["style", "hidden", "aria-hidden", "inert"]) el.removeAttribute(attr);
  el.classList.remove("present", "past", "future");
  for (const hidden of el.querySelectorAll("[hidden]")) hidden.remove();
  for (const host of el.querySelectorAll<HTMLElement>(".docwalk-diagram")) {
    for (const attr of ["tabindex", "role", "aria-label", "data-source"])
      host.removeAttribute(attr);
  }
  for (const img of el.querySelectorAll("img")) {
    img.removeAttribute("srcset");
    img.removeAttribute("data-src");
    // Nothing loads a blocked image in an export, so it stops being a button.
    if (img.classList.contains("docwalk-blocked-image")) {
      for (const attr of ["role", "tabindex", "aria-label", "title"]) img.removeAttribute(attr);
    }
    // A lazy image outside the (zero-size) print frame would never load.
    img.removeAttribute("loading");
    const src = img.getAttribute("src");
    if (src !== null && !resourceAllowed(src, policy)) {
      img.removeAttribute("src");
      img.classList.add("docwalk-blocked-image");
    }
  }
  for (const style of el.querySelectorAll("style")) {
    style.textContent = rewriteCssUrls(style.textContent ?? "", document.baseURI, policy);
  }
  return el;
}

/** One slide on its own page box, prepared and sanitized again (DOMPurify) for a document `doc`. */
export function buildPage(
  doc: Document,
  slide: ExportSlide,
  index: number,
  options: ExportOptions,
  policy: ResourcePolicy,
): HTMLElement {
  const page = inert.createElement("article");
  page.className = "docwalk-export-page";
  page.setAttribute(
    "aria-label",
    m.export_page_label({ current: index + 1, total: options.slides.length }),
  );
  page.style.width = `${options.size.width}px`;
  page.style.height = `${options.size.height}px`;
  page.append(prepareSlide(slide.element, policy));
  activePolicy = policy;
  let clean: DocumentFragment;
  try {
    clean = purifier.sanitize(page, PURIFY_CONFIG);
  } finally {
    activePolicy = offline;
  }
  const result = clean.firstElementChild;
  if (!(result instanceof Element)) throw new Error("docwalk: a slide was empty after sanitizing");
  return doc.importNode(result, true) as HTMLElement;
}

/** Every slide, in order, inside `<main class="docwalk-export">`. */
export function buildPages(
  doc: Document,
  options: ExportOptions,
  policy: ResourcePolicy,
): HTMLElement {
  const main = doc.createElement("main");
  main.className = "docwalk-export";
  options.slides.forEach((slide, i) => main.append(buildPage(doc, slide, i, options, policy)));
  return main;
}

/** Layout CSS for a standalone export document: the page size first, then `page.css`. */
export function pageCss(size: ExportOptions["size"]): string {
  return `@page { size: ${size.width}px ${size.height}px; margin: 0; }\n${rawPageCss}`;
}

/** Build the `<head>` shared by the print view and the HTML file. */
export function writeHead(doc: Document, title: string, css: string, csp?: string): void {
  const head = doc.head;
  head.replaceChildren();
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  head.append(charset);
  if (csp) {
    const policy = doc.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = csp;
    head.append(policy);
  }
  const referrer = doc.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const viewport = doc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const titleEl = doc.createElement("title");
  titleEl.textContent = title;
  const style = doc.createElement("style");
  style.textContent = css;
  head.append(referrer, viewport, titleEl, style);
  doc.documentElement.lang = document.documentElement.lang || "en";
  // The slide is white in both themes; pin the light semantic colours (links) to match.
  doc.documentElement.dataset["theme"] = "light";
}

/** Wait until fonts and images in `root` are ready to be printed or captured. */
export async function settled(root: HTMLElement): Promise<void> {
  // Reading layout makes the browser request the fonts the content uses.
  void root.getBoundingClientRect();
  await root.ownerDocument.fonts.ready;
  await Promise.allSettled([...root.querySelectorAll("img")].map((img) => img.decode()));
}
