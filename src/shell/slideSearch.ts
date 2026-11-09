/**
 * Matching and snippets for the command palette's slide-text search
 * (decision 81). Pure strings in, strings out: nothing here touches the DOM,
 * and nothing is ever read back as HTML, so page text stays text (rule 5).
 */

/** Text hits shown at most; a line says how many more matched. */
export const TEXT_MATCH_LIMIT = 10;
/** Shorter queries search titles only: one letter matches nearly every slide. */
export const TEXT_MIN_QUERY = 2;
/** Characters of context kept before and after the match in a snippet. */
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 60;
const ELLIPSIS = "…";

/** Trim, fold whitespace runs to one space, compose accents: the form page text is in. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").normalize("NFC");
}

export interface TextMatch {
  start: number;
  end: number;
}

const collators = new Map<string, Intl.Collator>();

/**
 * The same collator React Aria's `useFilter({ sensitivity: "base" })` builds,
 * so a title and a body treat case, accents and the Turkish i the same way.
 */
function collatorFor(locale: string): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { usage: "search", sensitivity: "base" });
    collators.set(locale, collator);
  }
  return collator;
}

/**
 * The first place `query` occurs in `text`, ignoring case and accents, or
 * null. `text` is page text (see `slideText`) and `query` has been through
 * `normalizeQuery`. Like React Aria's `contains`, it compares each window of
 * the query's length with the query; unlike it, it says where.
 */
export function findText(text: string, query: string, locale: string): TextMatch | null {
  const length = query.length;
  if (length === 0 || length > text.length) return null;
  const collator = collatorFor(locale);
  for (let start = 0; start + length <= text.length; start++) {
    if (collator.compare(text.slice(start, start + length), query) === 0) {
      return { start, end: start + length };
    }
  }
  return null;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** A few words around the match, cut at spaces where there is one, with an ellipsis on a cut side. */
export function snippetAround(text: string, { start, end }: TextMatch): Snippet {
  let from = Math.max(0, start - CONTEXT_BEFORE);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
    else if (isLowSurrogate(text.charCodeAt(from))) from++;
  }
  let to = Math.min(text.length, end + CONTEXT_AFTER);
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > end) to = space;
    else if (isHighSurrogate(text.charCodeAt(to - 1))) to--;
  }
  return {
    before: (from > 0 ? ELLIPSIS : "") + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? ELLIPSIS : ""),
  };
}

export interface TextHit<T> {
  slide: T;
  snippet: Snippet;
}

/**
 * The slides whose text holds `query`, in deck order, at most
 * `TEXT_MATCH_LIMIT` of them, with how many matched in all. `skip` names
 * slides that are listed already (their title matched). The query is
 * normalised here; a query under `TEXT_MIN_QUERY` characters finds nothing.
 */
export function searchText<T extends { text: string }>(
  slides: readonly T[],
  rawQuery: string,
  locale: string,
  skip: (slide: T) => boolean,
): { hits: TextHit<T>[]; total: number } {
  const query = normalizeQuery(rawQuery);
  const hits: TextHit<T>[] = [];
  let total = 0;
  if (query.length < TEXT_MIN_QUERY) return { hits, total };
  for (const slide of slides) {
    if (skip(slide)) continue;
    const match = findText(slide.text, query, locale);
    if (!match) continue;
    total++;
    if (hits.length < TEXT_MATCH_LIMIT)
      hits.push({ slide, snippet: snippetAround(slide.text, match) });
  }
  return { hits, total };
}
