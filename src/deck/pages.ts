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
