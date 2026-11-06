import { m as msg } from "../paraglide/messages.js";
import { measureOffscreen, type SlideMeasurement } from "./measure";

/**
 * Page-level helpers shared by the audience deck and the presenter window.
 * This module must not import reveal.js (directly or through ./Deck.tsx):
 * the presenter window rebuilds pages with the same pipeline but never runs
 * reveal, and importing it would pull reveal.js and its CSS into that window.
 */

/** reveal.js lays slides out at this size and scales the whole deck to fit. */
export const SLIDE_SIZE = { width: 1280, height: 720 } as const;

/** A slide's stable address: `<section-id>/<page>` (decision 21). */
export function slideAddress(slide: HTMLElement): string {
  return `${slide.dataset["docwalkId"] ?? ""}/${slide.dataset["page"] ?? "1"}`;
}

export function describeOverflow(m: SlideMeasurement): string {
  const parts: string[] = [];
  if (m.body.y > 0) parts.push(msg.deck_overflow_tall({ px: Math.round(m.body.y) }));
  if (m.body.x > 0) parts.push(msg.deck_overflow_wide({ px: Math.round(m.body.x) }));
  const clipped = m.diagrams.filter((d) => d.x > 0 || d.y > 0).length;
  if (clipped > 0) parts.push(msg.deck_overflow_clipped({ count: clipped }));
  const notes: string[] = [];
  if (parts.length > 0) notes.push(msg.deck_overflow_note({ parts: parts.join(", ") }));
  if (m.tooSmall > 0) notes.push(msg.deck_too_small({ count: m.tooSmall }));
  return notes.join(" ");
}

/**
 * Measure every page off-screen and show or hide its diagnostic (rule 3:
 * overflow is reported, never hidden). Returns the measurements in page
 * order so the caller can report them.
 */
export function flagPages(
  pages: HTMLElement[],
  size: { width: number; height: number },
): SlideMeasurement[] {
  const bodies = pages.map(
    (s) => (s.querySelector<HTMLElement>(".docwalk-slide-body") ?? s) as HTMLElement,
  );
  const measurements = measureOffscreen(bodies, size);
  measurements.forEach((m, i) => {
    const diagnostic = pages[i]?.querySelector<HTMLElement>(".docwalk-overflow");
    if (!diagnostic) return;
    const flagged = m.overflows || m.tooSmall > 0;
    diagnostic.hidden = !flagged;
    if (flagged) diagnostic.textContent = describeOverflow(m);
  });
  return measurements;
}
