import { useEffect, useLayoutEffect, useRef } from "react";
import type { Root } from "mdast";
import { purifyHtml } from "../deck/purify";
import { renderDiagrams } from "../deck/mermaid";
import "../render/content.css";
import { anchorTarget, focusTarget, fragmentTarget } from "../render/fragments";
import { renderEmoji } from "../render/emoji";
import { highlightCode } from "../render/highlight";
import { renderMath } from "../render/math";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { enableClickToLoad, useLoadRemoteImages } from "../render/remoteImages";
import { nodesToHtml } from "../render/toHtml";
import { headingIds, type SectionPlan } from "../sectioning/sectionize";
import { parseViewerUrl } from "../url/state";

/**
 * A place in the reading view to bring to the top: a heading anchor (a
 * section id), or null for the top of the document. A new object for every
 * request, so the same section can be asked for twice. Focus stays where it
 * is: the outline is a listbox that takes focus back on the press that
 * selected the section.
 */
export interface DocumentTarget {
  anchor: string | null;
}

/**
 * The heading anchor a section starts at in the reading view. A section
 * without a heading (the intro, a part after a thematic break) has no anchor
 * of its own and uses the closest heading section before it; before any,
 * the top of the document.
 */
export function sectionAnchor(plan: SectionPlan, sectionId: string): string | null {
  const index = plan.sections.findIndex((sec) => sec.id === sectionId);
  for (let i = index; i >= 0; i--) {
    const sec = plan.sections[i];
    if (sec?.heading) return sec.id;
  }
  return null;
}

/**
 * Where a link opens the reading view: the heading its hash names. A slide
 * address goes to its section's heading, as entering document mode from that
 * slide does; any other anchor (a GitHub link to a sub-heading, such as
 * `#retry-budget`) to the heading with that anchor. Null when the hash names
 * nothing, which leaves the reading view at the top.
 */
export function linkedTarget(plan: SectionPlan, url: URL): DocumentTarget | null {
  const address = parseViewerUrl(url).address;
  if (!address) return null;
  const id = address.slice(0, address.lastIndexOf("/"));
  return { anchor: plan.sections.some((sec) => sec.id === id) ? sectionAnchor(plan, id) : id };
}

/**
 * Document mode: the whole file as one scrolling page, close to how GitHub
 * shows it (decision 49). Same sanitizing pipeline as the slides.
 */
export function DocumentView({
  root,
  onRendered,
  scrollTarget = null,
}: {
  root: Root;
  /** Called after each render once its diagrams are drawn, for overlays such as comment markers. */
  onRendered?: (el: HTMLElement) => void;
  /** Scrolls the reading view to a section (the outline, entering document mode). */
  scrollTarget?: DocumentTarget | null;
}) {
  const host = useRef<HTMLElement>(null);
  // Diagrams drawn after a scroll change the height above the target. Until
  // they are drawn, a request is kept and applied again once they are, if
  // the reader has not scrolled since.
  const drawn = useRef(false);
  const pending = useRef<{ target: DocumentTarget; top: number } | null>(null);
  const loadRemoteImages = useLoadRemoteImages();
  // Footnote labels, image buttons and diagram notes are rendered in the UI language.
  const locale = useLocale();
  const rendered = useRef(onRendered);
  useLayoutEffect(() => {
    rendered.current = onRendered;
  });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren(
      purifyHtml(nodesToHtml(root.children, { loadRemoteImages, headingIds: headingIds(root) })),
    );
    const stopClickToLoad = enableClickToLoad(el);
    // Content ids carry GitHub's `user-content-` prefix and links do not, so
    // `#retry-budget` and footnote links are resolved here, as GitHub's page
    // script does. A link with no target here keeps its default behaviour.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      const target = link && fragmentTarget(el, link.getAttribute("href") ?? "");
      if (!target) return;
      event.preventDefault();
      focusTarget(target);
    };
    el.addEventListener("click", onClick);
    let live = true;
    // Beside the diagrams, not before them: colours change no height, so a
    // pending scroll target needs no second pass for them. Formulas do, so
    // they are part of what the scroll target waits for.
    void highlightCode(el, { stop: () => !live });
    // Wide tables, code blocks and equations scroll on their own; a keyboard user can
    // only scroll one that takes focus (WCAG 2.1.1). Only those that scroll
    // get a tab stop, rechecked when the page width changes and once
    // formulas are drawn (an equation replaces its source block).
    const markScrollable = () => {
      for (const box of el.querySelectorAll<HTMLElement>("table, pre, .docwalk-math-display")) {
        if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) {
          box.tabIndex = 0;
        } else {
          box.removeAttribute("tabindex");
        }
      }
    };
    drawn.current = false;
    void Promise.all([
      renderDiagrams(el),
      renderMath(el, { stop: () => !live }),
      renderEmoji(el, { stop: () => !live }),
    ]).then(() => {
      if (!live) return;
      drawn.current = true;
      markScrollable();
      const kept = pending.current;
      pending.current = null;
      if (kept && el.getBoundingClientRect().top === kept.top) bringIntoView(el, kept.target);
      rendered.current?.(el);
    });
    markScrollable();
    const observer = new ResizeObserver(markScrollable);
    observer.observe(el);
    return () => {
      el.removeEventListener("click", onClick);
      live = false;
      observer.disconnect();
      stopClickToLoad();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [root, loadRemoteImages, locale]);
  // After the render effect above, so on mount the content is there to scroll to.
  useEffect(() => {
    const el = host.current;
    if (!el || !scrollTarget) return;
    bringIntoView(el, scrollTarget);
    pending.current = drawn.current
      ? null
      : { target: scrollTarget, top: el.getBoundingClientRect().top };
  }, [scrollTarget]);
  return <article ref={host} className="docwalk-document" aria-label={m.app_document()} />;
}

/** Scrolls the target's heading (or the top of the document) to the top of the reading view. */
function bringIntoView(el: HTMLElement, { anchor }: DocumentTarget): void {
  const heading = anchor ? anchorTarget(el, anchor) : null;
  (heading ?? el).scrollIntoView({ block: "start" });
}
