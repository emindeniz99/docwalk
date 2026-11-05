import Reveal from "reveal.js";
import "reveal.js/reveal.css";
import { useEffect, useRef, useState } from "react";
import { focusTarget, fragmentAddress, fragmentTarget } from "../render/fragments";
import { enableClickToLoad, useLoadRemoteImages } from "../render/remoteImages";
import type { SectionPlan } from "../sectioning/sectionize";
import { createDeckController, type DeckController } from "./controller";
import { openDiagramFocus } from "./focus";
import { fitDiagrams, settled, slideBodySize, type SlideMeasurement } from "./measure";
import { renderDiagrams } from "./mermaid";
import { paginateSlide } from "./paginate";
import { flagPages, SLIDE_SIZE, slideAddress } from "./pages";
import { buildSlides } from "./slides";

// Kept for the app shell, which loads reveal.js anyway. Code that must stay
// free of reveal.js (the presenter window) imports these from ./pages.
export { describeOverflow, SLIDE_SIZE, slideAddress } from "./pages";

/** A rebuild re-renders and re-measures every slide, so it waits until typing pauses this long. */
export const REBUILD_DELAY_MS = 250;

export interface DeckReport {
  slides: number;
  overflowing: { id: string; measurement: SlideMeasurement }[];
  diagramErrors: number;
}

interface DeckProps {
  plan: SectionPlan;
  onReport?: (report: DeckReport) => void;
  /** Receives the controller once the deck is ready, and `null` when it is torn down. */
  onReady?: (controller: DeckController | null) => void;
}

/**
 * React owns only the outer element. Everything inside `.reveal` is built
 * with DOM APIs and handed to reveal.js, which mutates it freely; React
 * reconciling that subtree would fight reveal (decision 27).
 */
export function Deck({ plan, onReport, onReady }: DeckProps) {
  const host = useRef<HTMLDivElement>(null);
  const loadRemoteImages = useLoadRemoteImages();
  // The first plan builds at once; later plans (keystrokes) wait for a pause,
  // and the last finished deck stays up meanwhile.
  const [built, setBuilt] = useState(plan);
  useEffect(() => {
    if (plan === built) return;
    const timer = setTimeout(() => setBuilt(plan), REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [plan, built]);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let cancelled = false;
    let deck: InstanceType<typeof Reveal> | null = null;

    const revealEl = document.createElement("div");
    revealEl.className = "reveal";
    // reveal.js with keyboardCondition "focused" only takes keys while focus is
    // inside its own element, so that element is the deck's tab stop.
    revealEl.tabIndex = 0;
    revealEl.setAttribute("role", "region");
    revealEl.setAttribute("aria-roledescription", "slide deck");
    revealEl.setAttribute("aria-label", "Slides");
    const slidesEl = document.createElement("div");
    slidesEl.className = "slides";
    const slides = buildSlides(built, { loadRemoteImages });
    slidesEl.append(...slides);
    revealEl.append(slidesEl);
    root.replaceChildren(revealEl);

    let controller: DeckController | null = null;
    const onClick = (event: Event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      if (link) {
        // The browser's own jump would scroll reveal.js's stage. A target on
        // this page (a footnote and its back link) gets focus; otherwise the
        // fragment is an address or a heading's anchor on another slide.
        event.preventDefault();
        const href = link.getAttribute("href") ?? "";
        const page = link.closest<HTMLElement>("section[data-docwalk-id]");
        const target = page ? fragmentTarget(page, href) : null;
        const address = fragmentAddress(href);
        if (target) focusTarget(target);
        else if (address) controller?.goTo(address);
        return;
      }
      const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
      if (diagram) openDiagramFocus(diagram);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
      if (!diagram) return;
      // Otherwise the key's default action clicks the Close button the view has just focused.
      event.preventDefault();
      openDiagramFocus(diagram);
    };
    revealEl.addEventListener("click", onClick);
    revealEl.addEventListener("keydown", onKey);
    const stopClickToLoad = enableClickToLoad(revealEl);

    void (async () => {
      // A newer build makes this one stale; stop it between diagrams.
      const diagramResults = await renderDiagrams(slidesEl, () => cancelled);
      if (cancelled) return;
      fitDiagrams(slidesEl, slideBodySize(SLIDE_SIZE));
      await settled(slidesEl);
      if (cancelled) return;

      // Paginate before reveal.js sees the slides, so its slide count,
      // progress bar and overview reflect the final pages.
      const pages = slides.flatMap((s) => paginateSlide(s, { size: SLIDE_SIZE }));
      slidesEl.replaceChildren(...pages);

      deck = new Reveal(revealEl, {
        embedded: true,
        hash: false,
        history: false,
        respondToHashChanges: false,
        // reveal's "focused" mode only counts pointer presses, so Tab and the
        // Present button would leave the deck deaf to keys. Use real DOM focus.
        keyboardCondition: () => revealEl.contains(document.activeElement),
        // Escape belongs to the app (pen off, then leave present mode). O
        // opens the app's own slide overview (keyboard navigable, named)
        // instead of reveal's.
        keyboard: { 27: () => undefined, 79: () => undefined },
        width: SLIDE_SIZE.width,
        height: SLIDE_SIZE.height,
        // Leave a visible stage around the slide (DESIGN.md, Colors).
        margin: 0.1,
        center: false,
        controls: true,
        progress: true,
        // The header already shows "n / total" and the slide address; reveal's
        // corner chip repeated it on top of the next arrow and the slide's corner.
        slideNumber: false,
        transition: "none",
        // reveal switches to its scroll view when the deck is 435px wide or
        // less (a phone, a narrow preview pane): every slide stacked at full
        // size. Pages are measured for the 1280x720 stage, so keep scaling it.
        scrollActivationWidth: 0,
      });
      await deck.initialize();
      if (cancelled) return;

      const overflowing: DeckReport["overflowing"] = [];
      flagPages(pages, SLIDE_SIZE).forEach((m, i) => {
        const slide = pages[i];
        if (m.overflows && slide) overflowing.push({ id: slideAddress(slide), measurement: m });
      });
      const report: DeckReport = {
        slides: pages.length,
        overflowing,
        diagramErrors: diagramResults.filter((r) => !r.ok).length,
      };
      onReport?.(report);
      controller = createDeckController(deck, pages, slidesEl);
      onReady?.(controller);
    })();

    return () => {
      cancelled = true;
      revealEl.removeEventListener("click", onClick);
      revealEl.removeEventListener("keydown", onKey);
      stopClickToLoad();
      onReady?.(null);
      deck?.destroy();
      root.replaceChildren();
    };
  }, [built, onReport, onReady, loadRemoteImages]);

  return (
    <div className="docwalk-deck">
      <div ref={host} className="docwalk-deck-host" />
    </div>
  );
}
