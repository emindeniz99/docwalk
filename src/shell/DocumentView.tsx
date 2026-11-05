import { useEffect, useLayoutEffect, useRef } from "react";
import type { Root } from "mdast";
import { purifyHtml } from "../deck/purify";
import { renderDiagrams } from "../deck/mermaid";
import "../render/content.css";
import { focusTarget, fragmentTarget } from "../render/fragments";
import { enableClickToLoad, useLoadRemoteImages } from "../render/remoteImages";
import { nodesToHtml } from "../render/toHtml";
import { headingIds } from "../sectioning/sectionize";

/**
 * Document mode: the whole file as one scrolling page, close to how GitHub
 * shows it (decision 49). Same sanitizing pipeline as the slides.
 */
export function DocumentView({
  root,
  onRendered,
}: {
  root: Root;
  /** Called after each render once its diagrams are drawn, for overlays such as comment markers. */
  onRendered?: (el: HTMLElement) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const loadRemoteImages = useLoadRemoteImages();
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
    void renderDiagrams(el).then(() => {
      if (live) rendered.current?.(el);
    });
    // Wide tables and code blocks scroll on their own; a keyboard user can
    // only scroll one that takes focus (WCAG 2.1.1). Only those that scroll
    // get a tab stop, rechecked when the page width changes.
    const markScrollable = () => {
      for (const box of el.querySelectorAll<HTMLElement>("table, pre")) {
        if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) {
          box.tabIndex = 0;
        } else {
          box.removeAttribute("tabindex");
        }
      }
    };
    markScrollable();
    const observer = new ResizeObserver(markScrollable);
    observer.observe(el);
    return () => {
      el.removeEventListener("click", onClick);
      live = false;
      observer.disconnect();
      stopClickToLoad();
    };
  }, [root, loadRemoteImages]);
  return <article ref={host} className="docwalk-document" aria-label="Document" />;
}
