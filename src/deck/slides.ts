import type { Section, SectionPlan } from "../sectioning/sectionize";
import { nodesToHtml, type HtmlOptions } from "../render/toHtml";
import { purifyHtml } from "./purify";

/**
 * Build one reveal.js `<section>` per docwalk section. Chrome (breadcrumb,
 * continued title) is built with DOM APIs and `textContent`, never by
 * string concatenation, so heading text can never become markup.
 */
export function buildSlide(section: Section, options: HtmlOptions = {}): HTMLElement {
  const el = document.createElement("section");
  el.dataset["docwalkId"] = section.id;
  el.dataset["kind"] = section.kind;

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
    title.textContent = `${section.title} · continued`;
    body.append(title);
  }
  const nodes = section.heading ? [section.heading, ...section.nodes] : section.nodes;
  body.append(purifyHtml(nodesToHtml(nodes, options)));
  slide.append(body);

  const diagnostic = document.createElement("p");
  diagnostic.className = "docwalk-overflow";
  diagnostic.setAttribute("role", "status");
  diagnostic.hidden = true;
  slide.append(diagnostic);

  el.append(slide);
  return el;
}

export function buildSlides(plan: SectionPlan, options: HtmlOptions = {}): HTMLElement[] {
  return plan.sections.map((s) => buildSlide(s, options));
}
