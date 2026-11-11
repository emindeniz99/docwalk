import { useCallback, useEffect, useRef, useState } from "react";
import type { View } from "./view";

/** On a phone the edit view shows the source or the slide preview, not both. */
export function usePhonePane({ view, phone }: { view: View; phone: boolean }) {
  const [phonePane, setPhonePane] = useState<"source" | "preview">("source");
  // Leaving present mode on a phone lands on the deck just presented (and on
  // the focus Exit and Escape keep there), not on the source pane.
  const [lastView, setLastView] = useState(view);
  const paneSwitchRef = useRef<HTMLDivElement>(null);
  if (lastView !== view) {
    setLastView(view);
    if (lastView === "present") setPhonePane("preview");
  }
  // Scroll the outline away until the sticky pane switch reaches the top, so
  // the chosen pane fills the screen under it and the slide is on screen, not
  // below the outline.
  const showPhonePane = useCallback(() => {
    const main = paneSwitchRef.current?.parentElement;
    const bar = paneSwitchRef.current?.getBoundingClientRect();
    if (main && bar) main.scrollTop += bar.top - main.getBoundingClientRect().top;
    // The deck was display: none; reveal.js lays out again on resize.
    window.dispatchEvent(new Event("resize"));
  }, []);
  // Present unmounts the outline and the pane switch, and Chromium resets the
  // page's scroll: the preview pane came back selected but below the fold.
  const viewBefore = useRef(view);
  useEffect(() => {
    const was = viewBefore.current;
    viewBefore.current = view;
    if (phone && was === "present" && view === "edit") requestAnimationFrame(showPhonePane);
  }, [view, phone, showPhonePane]);
  return { phonePane, setPhonePane, paneSwitchRef, showPhonePane };
}
