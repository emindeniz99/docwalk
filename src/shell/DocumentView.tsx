import { useEffect, useRef } from "react";
import type { Root } from "mdast";
import { purifyHtml } from "../deck/purify";
import { renderDiagrams } from "../deck/mermaid";
import { nodesToHtml } from "../render/toHtml";

/**
 * Document mode: the whole file as one scrolling page, close to how GitHub
 * shows it (decision 49). Same sanitizing pipeline as the slides.
 */
export function DocumentView({ root }: { root: Root }) {
  const host = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren(purifyHtml(nodesToHtml(root.children)));
    void renderDiagrams(el);
  }, [root]);
  return <article ref={host} className="docwalk-document" aria-label="Document" />;
}
