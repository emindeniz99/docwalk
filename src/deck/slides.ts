import type { Section, SectionPlan } from "../sectioning/sectionize";
import { nodesToHtml, type HtmlOptions, type RenderContext } from "../render/toHtml";
import "../render/content.css";
import { purifyHtml } from "./purify";

/**
 * Build one reveal.js `<section>` per docwalk section. Chrome (breadcrumb,
 * continued title) is built with DOM APIs and `textContent`, never by
 * string concatenation, so heading text can never become markup.
 */
export function buildSlide(section: Section, options: RenderContext = {}): HTMLElement {
  const el = document.createElement("section");
  el.dataset["docwalkId"] = section.id;
  el.dataset["kind"] = section.kind;
  el.dataset["title"] = section.title;

  const slide = document.createElement("div");
  slide.className = "docwalk-slide";

  if (section.breadcrumb.length > 0) {
    const nav = document.createElement("nav");
    nav.className = "docwalk-breadcrumb";
    nav.setAttribute("aria-label", "Section path");
    nav.textContent = section.breadcrumb.join(" › ");
    slide.append(nav);
  }

  const body = document.createElement("div");
  body.className = "docwalk-slide-body";
  if (!section.heading && section.title) {
    // A part after a thematic break keeps its section's title.
    const title = document.createElement("h2");
    title.className = "docwalk-part-title";
    const marker = document.createElement("span");
    marker.className = "docwalk-continued";
    marker.textContent = " · continued";
    title.append(section.title, marker);
    body.append(title);
  }
  const nodes = section.heading ? [section.heading, ...section.nodes] : section.nodes;
  body.append(purifyHtml(nodesToHtml(nodes, { footnotePrefix: `${section.id}-`, ...options })));
  unnestSections(body);
  slide.append(body);

  const diagnostic = document.createElement("p");
  diagnostic.className = "docwalk-overflow";
  diagnostic.setAttribute("role", "status");
  diagnostic.hidden = true;
  slide.append(diagnostic);

  el.append(slide);
  return el;
}

/**
 * reveal.js reads every `<section>` inside a slide as a vertical sub-slide,
 * and GitHub's footnote list is a `<section>` (so is raw HTML's, which the
 * schema allows). Inside a slide each becomes a `<div>` with the same
 * attributes and children, so the deck stays one slide per page.
 */
function unnestSections(body: HTMLElement): void {
  for (const inner of body.querySelectorAll("section")) {
    const div = document.createElement("div");
    for (const attr of inner.attributes) div.setAttribute(attr.name, attr.value);
    div.append(...inner.childNodes);
    inner.replaceWith(div);
  }
}

/**
 * Every slide gets the document's heading anchors (so a link to a sub-heading
 * finds its slide) and its definitions (so a footnote or link reference
 * resolves on the slide that uses it, wherever it is defined).
 */
export function buildSlides(plan: SectionPlan, options: HtmlOptions = {}): HTMLElement[] {
  const context = { ...options, headingIds: plan.headingIds, definitions: plan.definitions };
  return plan.sections.map((s) => buildSlide(s, context));
}
