import { useEffect, useRef } from "react";
import type { Root } from "mdast";
import { purifyHtml } from "../deck/purify";
import { renderDiagrams } from "../deck/mermaid";
import { enableClickToLoad, useLoadRemoteImages } from "../render/remoteImages";
import { nodesToHtml } from "../render/toHtml";

/**
 * Document mode: the whole file as one scrolling page, close to how GitHub
 * shows it (decision 49). Same sanitizing pipeline as the slides.
 */
export function DocumentView({ root }: { root: Root }) {
  const host = useRef<HTMLElement>(null);
  const loadRemoteImages = useLoadRemoteImages();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren(purifyHtml(nodesToHtml(root.children, { loadRemoteImages })));
    const stopClickToLoad = enableClickToLoad(el);
    void renderDiagrams(el);
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
      observer.disconnect();
      stopClickToLoad();
    };
  }, [root, loadRemoteImages]);
  return <article ref={host} className="docwalk-document" aria-label="Document" />;
}
