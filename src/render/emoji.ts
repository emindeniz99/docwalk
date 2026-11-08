/**
 * Emoji shortcodes, as GitHub shows them: `:rocket:` is 🚀 (decision 101).
 *
 * Runs on the DOM after both sanitizers and changes text nodes only, so the
 * result is text and never markup; ids, links and titles are not touched.
 * Code, preformatted text, keys, diagrams and formulas keep what they say.
 * The shortcode list is a lazy chunk (`./emojiMap.ts`), loaded only when a
 * text node holds something shaped like `:name:`. An unknown name stays text,
 * and so does everything when the chunk does not load in time. `renderEmoji`
 * never rejects, so a deck always goes on to measure (rule 4).
 */
import { loadWithin } from "./lazy";

/** GitHub's names: lowercase letters, digits, `_`, `-`, and `+` for `:+1:`. */
const SHORTCODE = /:([a-z0-9_+-]+):/g;
const CANDIDATE = /:[a-z0-9_+-]+:/;

/** Where a shortcode is only text the author wrote about the shortcode. */
const KEPT = "code, pre, kbd, samp, script, style, textarea, math, .docwalk-diagram";

/** How long a deck waits for the list before it measures with the shortcodes as text. */
export const EMOJI_TIMEOUT_MS = 5000;

export type EmojiNames = ReadonlyMap<string, string>;

export interface EmojiOptions {
  /** Checked once the list is in: a stale build leaves its text alone. */
  stop?: () => boolean;
  timeoutMs?: number;
  /** Where the list comes from; tests replace it to count loads and to simulate a failure. */
  load?: () => Promise<EmojiNames>;
}

const loadNames = async (): Promise<EmojiNames> => (await import("./emojiMap")).emojiByName;

/** The text nodes under `root` that hold a shortcode candidate and are not code. */
function candidates(root: ParentNode): Text[] {
  const doc = root instanceof Document ? root : (root as Node).ownerDocument;
  if (!doc) return [];
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (CANDIDATE.test(text.data) && !text.parentElement?.closest(KEPT)) found.push(text);
  }
  return found;
}

/** Replaces every known shortcode in the text under `root`. Resolves once done; never rejects. */
export async function renderEmoji(
  root: ParentNode,
  { stop = () => false, timeoutMs = EMOJI_TIMEOUT_MS, load = loadNames }: EmojiOptions = {},
): Promise<void> {
  const found = candidates(root);
  if (found.length === 0) return;
  const names = await loadWithin(load, timeoutMs);
  if (!names || stop()) return;
  for (const text of found) {
    text.data = text.data.replace(SHORTCODE, (whole, name: string) => names.get(name) ?? whole);
  }
}
