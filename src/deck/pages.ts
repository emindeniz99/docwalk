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
  const wideCode = m.code.filter((c) => c.x > 0 || c.y > 0).length;
  if (wideCode > 0) parts.push(msg.deck_overflow_code({ count: wideCode }));
  const notes: string[] = [];
  if (parts.length > 0) notes.push(msg.deck_overflow_note({ parts: parts.join(", ") }));
  if (m.tooSmall > 0) notes.push(msg.deck_too_small({ count: m.tooSmall }));
  return notes.join(" ");
}

/** Passes of show-then-measure before the note's text is taken as settled. */
const NOTE_PASSES = 4;

/**
 * Measure every page off-screen and show or hide its diagnostic (rule 3:
 * overflow is reported, never hidden). Returns the measurements in page
 * order so the caller can report them.
 *
 * The note sits under the slide body and takes its height from it once it
 * shows, so a page is measured again with its note in place until the note
 * describes the page as the audience sees it. Pagination reserves the room
 * of a too-small note already (paginate.ts); this catches what is left, such
 * as an atomic block whose "Does not fit" note grows the overflow it reports.
 */
export function flagPages(
  pages: HTMLElement[],
  size: { width: number; height: number },
): SlideMeasurement[] {
  const bodies = pages.map(
    (s) => (s.querySelector<HTMLElement>(".docwalk-slide-body") ?? s) as HTMLElement,
  );
  const measurements = measureOffscreen(bodies, size);
  let pending = pages.map((_, i) => i);
  for (let pass = 0; pass < NOTE_PASSES && pending.length > 0; pass++) {
    const changed = pending.filter((i) => showNote(pages[i], measurements[i]));
    if (changed.length === 0) break;
    const again = measureOffscreen(
      changed.map((i) => bodies[i] as HTMLElement),
      size,
    );
    changed.forEach((i, k) => {
      const m = again[k];
      if (m) measurements[i] = m;
    });
    pending = changed;
  }
  // Whatever the last pass measured is what the note says.
  for (const i of pending) showNote(pages[i], measurements[i]);
  return measurements;
}

/** Show, update or hide a page's note for `m`; true when it changed. */
function showNote(page: HTMLElement | undefined, m: SlideMeasurement | undefined): boolean {
  const diagnostic = page?.querySelector<HTMLElement>(".docwalk-overflow");
  if (!diagnostic || !m) return false;
  const flagged = m.overflows || m.tooSmall > 0;
  const text = flagged ? describeOverflow(m) : "";
  if (diagnostic.hidden === !flagged && (!flagged || diagnostic.textContent === text)) return false;
  diagnostic.hidden = !flagged;
  if (flagged) diagnostic.textContent = text;
  return true;
}
