import Reveal from "reveal.js";
import "reveal.js/reveal.css";
import { useEffect, useRef } from "react";
import type { SectionPlan } from "../sectioning/sectionize";
import { createDeckController, type DeckController } from "./controller";
import { openDiagramFocus } from "./focus";
import {
  fitDiagrams,
  measureOffscreen,
  settled,
  slideBodySize,
  type SlideMeasurement,
} from "./measure";
import { renderDiagrams } from "./mermaid";
import { paginateSlide } from "./paginate";
import { buildSlides } from "./slides";

/** reveal.js lays slides out at this size and scales the whole deck to fit. */
export const SLIDE_SIZE = { width: 1280, height: 720 } as const;

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

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let cancelled = false;
    let deck: InstanceType<typeof Reveal> | null = null;

    const revealEl = document.createElement("div");
    revealEl.className = "reveal";
    const slidesEl = document.createElement("div");
    slidesEl.className = "slides";
    const slides = buildSlides(plan);
    slidesEl.append(...slides);
    revealEl.append(slidesEl);
    root.replaceChildren(revealEl);

    const onClick = (event: Event) => {
      const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
      if (diagram) openDiagramFocus(diagram);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
      if (diagram) openDiagramFocus(diagram);
    };
    revealEl.addEventListener("click", onClick);
    revealEl.addEventListener("keydown", onKey);

    void (async () => {
      const diagramResults = await renderDiagrams(slidesEl);
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
        keyboardCondition: "focused",
        width: SLIDE_SIZE.width,
        height: SLIDE_SIZE.height,
        // Leave a visible stage around the slide (DESIGN.md, Colors).
        margin: 0.1,
        center: false,
        controls: true,
        progress: true,
        slideNumber: "c/t",
        transition: "none",
      });
      await deck.initialize();
      if (cancelled) return;

      const bodies = pages.map(
        (s) => s.querySelector<HTMLElement>(".docwalk-slide-body") as HTMLElement,
      );
      const measurements = measureOffscreen(bodies, SLIDE_SIZE);
      const overflowing: DeckReport["overflowing"] = [];
      measurements.forEach((m, i) => {
        const slide = pages[i] as HTMLElement;
        const diagnostic = slide.querySelector<HTMLElement>(".docwalk-overflow");
        if (!diagnostic) return;
        const flagged = m.overflows || m.tooSmall > 0;
        diagnostic.hidden = !flagged;
        if (flagged) diagnostic.textContent = describeOverflow(m);
        if (m.overflows) {
          overflowing.push({ id: slideAddress(slide), measurement: m });
        }
      });
      const report: DeckReport = {
        slides: pages.length,
        overflowing,
        diagramErrors: diagramResults.filter((r) => !r.ok).length,
      };
      onReport?.(report);
      onReady?.(createDeckController(deck, pages, slidesEl));
    })();

    return () => {
      cancelled = true;
      revealEl.removeEventListener("click", onClick);
      revealEl.removeEventListener("keydown", onKey);
      onReady?.(null);
      deck?.destroy();
      root.replaceChildren();
    };
  }, [plan, onReport, onReady]);

  return (
    <div className="docwalk-deck">
      <div ref={host} className="docwalk-deck-host" tabIndex={0} />
    </div>
  );
}

export function describeOverflow(m: SlideMeasurement): string {
  const parts: string[] = [];
  if (m.body.y > 0) parts.push(`${Math.round(m.body.y)} px too tall`);
  if (m.body.x > 0) parts.push(`${Math.round(m.body.x)} px too wide`);
  const clipped = m.diagrams.filter((d) => d.x > 0 || d.y > 0).length;
  if (clipped > 0) parts.push(`${clipped} diagram${clipped > 1 ? "s" : ""} clipped`);
  const notes: string[] = [];
  if (parts.length > 0) notes.push(`Does not fit: ${parts.join(", ")}. Scroll inside the slide.`);
  if (m.tooSmall > 0) {
    notes.push(
      `${m.tooSmall} diagram${m.tooSmall > 1 ? "s are" : " is"} too small to read here. Click to open full screen.`,
    );
  }
  return notes.join(" ");
}

/** A slide's stable address: `<section-id>/<page>` (decision 21). */
export function slideAddress(slide: HTMLElement): string {
  return `${slide.dataset["docwalkId"] ?? ""}/${slide.dataset["page"] ?? "1"}`;
}
