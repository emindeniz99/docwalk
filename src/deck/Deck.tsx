import Reveal from "reveal.js";
import "reveal.js/reveal.css";
import { useEffect, useRef, useState } from "react";
import { focusTarget, fragmentAddress, fragmentTarget } from "../render/fragments";
import { highlightCode } from "../render/highlight";
import { enableClickToLoad, useLoadRemoteImages } from "../render/remoteImages";
import type { Locale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import type { SectionPlan } from "../sectioning/sectionize";
import { createDeckController, type DeckController } from "./controller";
import { closeContentFocus, openBlockFocus, openDiagramFocus } from "./focus";
import { FOCUS_ATTR, markFocusTarget, markFocusTargets } from "./focusTargets";
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
  /**
   * The UI language. Slide chrome (breadcrumb label, "continued", overflow
   * notes) is built into the deck's DOM, so a switch rebuilds the deck; URL
   * sync puts the viewer back on the same slide, as after an edit. The text
   * itself is read from Paraglide when the deck builds.
   */
  locale?: Locale;
  onReport?: (report: DeckReport) => void;
  /** Receives the controller once the deck is ready, and `null` when it is torn down. */
  onReady?: (controller: DeckController | null) => void;
  /**
   * Present in the fill frame (decision 77): reveal.js scales the slide to
   * the whole stage, with no margin. Only the scale changes; the slide stays
   * 1280x720, so pagination and slide addresses are the same in both frames.
   */
  fill?: boolean;
}

/** reveal.js margin, as a fraction of the stage: the card frame leaves a visible stage around the slide (DESIGN.md, Colors). */
const cardMargin = 0.1;
/** reveal.js's own default, kept for the card frame. */
const cardMaxScale = 2;

/**
 * reveal.js options for a frame. With no margin, reveal's rounding of the
 * scale to the nearest 0.01 would push the slide past the stage by up to
 * half a percent (1446 px on a 1440 px screen), so the fill frame caps the
 * scale at the fit rounded down, which the rounding leaves as it is. The
 * cap also lifts reveal's default limit of 2, which stopped the slide short
 * of a screen wider than 2560 CSS px.
 */
function frameOptions(revealEl: HTMLElement, fill: boolean): { margin: number; maxScale: number } {
  if (!fill) return { margin: cardMargin, maxScale: cardMaxScale };
  const fit = Math.min(
    revealEl.offsetWidth / SLIDE_SIZE.width,
    revealEl.offsetHeight / SLIDE_SIZE.height,
  );
  return { margin: 0, maxScale: Math.floor(fit * 100) / 100 };
}

/**
 * reveal.js writes its arrow buttons' names and the pause overlay's button in
 * English. The deck rebuilds on a locale switch, so naming them once after
 * each initialize keeps them in the UI language.
 */
function localizeRevealChrome(revealEl: HTMLElement): void {
  const name = (selector: string, label: string) =>
    revealEl.querySelector(selector)?.setAttribute("aria-label", label);
  name(".controls .navigate-left", m.deck_control_previous());
  name(".controls .navigate-right", m.deck_control_next());
  name(".controls .navigate-up", m.deck_control_above());
  name(".controls .navigate-down", m.deck_control_below());
  const resume = revealEl.querySelector(".pause-overlay .resume-button");
  if (resume) resume.textContent = m.deck_resume();
}

/**
 * React owns only the outer element. Everything inside `.reveal` is built
 * with DOM APIs and handed to reveal.js, which mutates it freely; React
 * reconciling that subtree would fight reveal (decision 27).
 */
export function Deck({ plan, locale, onReport, onReady, fill = false }: DeckProps) {
  const host = useRef<HTMLDivElement>(null);
  const reveal = useRef<{ deck: InstanceType<typeof Reveal>; el: HTMLElement } | null>(null);
  // Read when a deck initializes, so a rebuild while presenting keeps the frame.
  const fillRef = useRef(fill);
  const loadRemoteImages = useLoadRemoteImages();
  // The first plan builds at once; later plans (keystrokes) wait for a pause,
  // and the last finished deck stays up meanwhile.
  const [built, setBuilt] = useState(plan);
  // Set when a rebuild tears down a deck that had keyboard focus, so the new one takes it.
  const hadFocus = useRef(false);
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
    revealEl.setAttribute("aria-roledescription", m.deck_roledescription());
    revealEl.setAttribute("aria-label", m.deck_label());
    const slidesEl = document.createElement("div");
    slidesEl.className = "slides";
    const slides = buildSlides(built, { loadRemoteImages });
    slidesEl.append(...slides);
    revealEl.append(slidesEl);
    root.replaceChildren(revealEl);
    // reveal.js takes keys only while focus is inside revealEl. A rebuild while
    // presenting (an agent write, a disk reload, a language switch) replaced
    // the focused element and left focus on <body>: the clicker went dead.
    if (hadFocus.current) revealEl.focus({ preventScroll: true });
    hadFocus.current = false;

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
      if (diagram) {
        openDiagramFocus(diagram);
        return;
      }
      // A code block, table or loaded image (decision 87). A link inside it is followed, and
      // a click that ends a text selection is not a request to open anything.
      const block = (event.target as Element).closest<HTMLElement>(`[${FOCUS_ATTR}]`);
      if (!block || (event.target as Element).closest("a")) return;
      const selection = getSelection();
      if (selection && !selection.isCollapsed && selection.containsNode(block, true)) return;
      openBlockFocus(block);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const diagram = (event.target as Element).closest<HTMLElement>(".docwalk-diagram");
      // Only the block itself: Enter on a link inside a table follows the link.
      const block = event.target instanceof HTMLElement && event.target.hasAttribute(FOCUS_ATTR);
      if (!diagram && !block) return;
      // Otherwise the key's default action clicks the Close button the view has just focused.
      event.preventDefault();
      if (diagram) openDiagramFocus(diagram);
      else openBlockFocus(event.target as HTMLElement);
    };
    // An image that finishes loading later (a click on its placeholder, a slow host) becomes
    // a target then; `load` does not bubble, so listen while it travels down.
    const onImageLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) markFocusTarget(event.target);
    };
    const onResize = () => {
      if (deck) Object.assign(deck.getConfig(), frameOptions(revealEl, fillRef.current));
    };
    revealEl.addEventListener("click", onClick);
    revealEl.addEventListener("keydown", onKey);
    revealEl.addEventListener("load", onImageLoad, true);
    const stopClickToLoad = enableClickToLoad(revealEl);

    void (async () => {
      // Code colours load beside the diagrams (they touch other blocks) and
      // both finish before anything is measured (rule 4). Colours change no
      // line break; a grammar that fails to load leaves its block plain.
      // A newer build makes this one stale; stop it between diagrams.
      const [, diagramResults] = await Promise.all([
        highlightCode(slidesEl, { stop: () => cancelled }),
        renderDiagrams(slidesEl, () => cancelled),
      ]);
      if (cancelled) return;
      fitDiagrams(slidesEl, slideBodySize(SLIDE_SIZE));
      await settled(slidesEl);
      if (cancelled) return;

      // Paginate before reveal.js sees the slides, so its slide count,
      // progress bar and overview reflect the final pages.
      const pages = slides.flatMap((s) => paginateSlide(s, { size: SLIDE_SIZE }));
      slidesEl.replaceChildren(...pages);
      // Marks go on the finished pages, so the pagination probes never carry them.
      markFocusTargets(slidesEl);

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
        ...frameOptions(revealEl, fillRef.current),
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
      // Ahead of reveal's own resize listener (added by initialize), so the
      // fill frame's cap is current before reveal lays the slide out.
      window.addEventListener("resize", onResize);
      await deck.initialize();
      if (cancelled) return;
      reveal.current = { deck, el: revealEl };
      // The copy in a code, table or image view belongs to one slide.
      deck.on("slidechanged", closeContentFocus);
      localizeRevealChrome(revealEl);

      const overflowing: DeckReport["overflowing"] = [];
      flagPages(pages, SLIDE_SIZE).forEach((measured, i) => {
        const slide = pages[i];
        if (measured.overflows && slide)
          overflowing.push({ id: slideAddress(slide), measurement: measured });
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
      // Before the deck goes: the view's copy is of a slide that is about to be replaced.
      closeContentFocus();
      revealEl.removeEventListener("click", onClick);
      revealEl.removeEventListener("keydown", onKey);
      revealEl.removeEventListener("load", onImageLoad, true);
      stopClickToLoad();
      onReady?.(null);
      hadFocus.current = revealEl.contains(document.activeElement);
      window.removeEventListener("resize", onResize);
      if (reveal.current?.deck === deck) reveal.current = null;
      deck?.destroy();
      root.replaceChildren();
    };
    // `locale` is read through Paraglide while building; it is here to rebuild on a switch.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [built, locale, onReport, onReady, loadRemoteImages]);

  // Switching frames re-scales the slide in place; nothing is re-measured.
  useEffect(() => {
    fillRef.current = fill;
    if (!reveal.current) return;
    const { deck, el } = reveal.current;
    deck.configure(frameOptions(el, fill));
    deck.layout();
  }, [fill]);

  return (
    <div className="docwalk-deck">
      <div ref={host} className="docwalk-deck-host" />
    </div>
  );
}
