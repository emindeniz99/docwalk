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

/** Folded letters kept per locale before the table starts again; a hostile page can hold a million distinct ones. */
const FOLD_CACHE_LIMIT = 50_000;
const foldCaches = new Map<string, Map<string, string>>();
const MARKS = /\p{M}/gu;

/**
 * One letter as the collator sees it at base sensitivity: lower case, then
 * compatibility forms and accents dropped, katakana as hiragana. Each step is
 * kept only when the collator agrees the result equals the letter, so the
 * Turkish UI keeps ç, ğ, ö, ş, ü and dotless ı as letters of their own and
 * folds dotted İ to i (decision 116).
 */
function foldLetter(letter: string, locale: string): string {
  let cache = foldCaches.get(locale);
  if (!cache) foldCaches.set(locale, (cache = new Map()));
  const known = cache.get(letter);
  if (known !== undefined) return known;
  // The locale changes the lower case of I and İ only (Turkish and Azeri;
  // Lithuanian is no UI locale). toLocaleLowerCase costs 100 times more, and
  // a hostile page can hold a million distinct letters.
  const lower =
    letter === "I" || letter === "İ" ? letter.toLocaleLowerCase(locale) : letter.toLowerCase();
  const bare = lower.normalize("NFKD").replace(MARKS, "");
  const code = bare.length === 1 ? bare.charCodeAt(0) : 0;
  const kana = code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : bare;
  let fold = letter;
  const collator = collatorFor(locale);
  for (const candidate of [kana, bare, lower]) {
    if (candidate === letter || (candidate !== "" && collator.compare(letter, candidate) === 0)) {
      fold = candidate;
      break;
    }
  }
  if (cache.size >= FOLD_CACHE_LIMIT) cache.clear();
  cache.set(letter, fold);
  return fold;
}

/**
 * A text with every letter folded, and for each folded code unit the range of
 * the letter it came from, so a match in the folded text maps back to the
 * page's own indices.
 */
export interface FoldedText {
  folded: string;
  starts: Int32Array;
  ends: Int32Array;
}

export function foldText(text: string, locale: string): FoldedText {
  const parts: string[] = [];
  for (const letter of text) parts.push(foldLetter(letter, locale));
  const folded = parts.join("");
  const starts = new Int32Array(folded.length);
  const ends = new Int32Array(folded.length);
  let at = 0;
  let unit = 0;
  let index = 0;
  for (const letter of text) {
    const end = at + letter.length;
    for (const stop = unit + parts[index++]!.length; unit < stop; unit++) {
      starts[unit] = at;
      ends[unit] = end;
    }
    at = end;
  }
  return { folded, starts, ends };
}

/** The first match of an already folded query, on whole letters only, or null. */
function findFolded({ folded, starts, ends }: FoldedText, query: string): TextMatch | null {
  if (query.length === 0) return null;
  for (let pos = folded.indexOf(query); pos !== -1; pos = folded.indexOf(query, pos + 1)) {
    const last = pos + query.length - 1;
    const wholeStart = pos === 0 || starts[pos] !== starts[pos - 1];
    const wholeEnd = last === folded.length - 1 || starts[last + 1] !== starts[last];
    if (wholeStart && wholeEnd) return { start: starts[pos]!, end: ends[last]! };
  }
  return null;
}

/**
 * The first place `query` occurs in `text`, ignoring case and accents, or
 * null. `text` is page text (see `slideText`) and `query` has been through
 * `normalizeQuery`. Both are folded letter by letter with the collator's
 * verdicts (`foldLetter`) and searched with `indexOf`, so the work grows with
 * the text, not with the text times the query (decision 116).
 */
export function findText(text: string, query: string, locale: string): TextMatch | null {
  if (query.length === 0 || text.length === 0) return null;
  return findFolded(foldText(text, locale), foldText(query, locale).folded);
}

type FoldCache = WeakMap<object, { locale: string; text: string; folded: FoldedText }>;

/** Each slide's folded text per locale, built the first time a search reads it and gone with the deck. */
const foldedSlides: FoldCache = new WeakMap();
/** The same for each slide's title (decision 123). */
const foldedTitles: FoldCache = new WeakMap();

/** `text` folded once per owner and locale; `compose` composes it to NFC first, on a miss only. */
function foldedOnce(
  cache: FoldCache,
  owner: object,
  text: string,
  locale: string,
  compose = false,
): FoldedText {
  const kept = cache.get(owner);
  if (kept && kept.locale === locale && kept.text === text) return kept.folded;
  const folded = foldText(compose ? text.normalize("NFC") : text, locale);
  cache.set(owner, { locale, text, folded });
  return folded;
}

function foldedSlide(slide: { text: string }, locale: string): FoldedText {
  return foldedOnce(foldedSlides, slide, slide.text, locale);
}

/** The last query the title filter folded: it asks once per slide and command on each keystroke. */
let lastQuery = { query: "", locale: "", folded: "" };

/**
 * Whether `title` holds `query`, ignoring case and accents: the palette's
 * title filter, with the verdicts of React Aria's `useFilter` `contains` it
 * replaces (an empty query matches, neither side is trimmed, both are composed
 * to NFC) but folded and searched with `indexOf` like page text, so a 2 MB
 * heading costs one fold per deck instead of a collator call per position
 * (decision 123). `owner` keeps the folded title; without one it is folded
 * again on each call, which suits a short command label.
 */
export function titleMatches(
  title: string,
  query: string,
  locale: string,
  owner?: object,
): boolean {
  if (query.length === 0) return true;
  if (lastQuery.query !== query || lastQuery.locale !== locale) {
    lastQuery = { query, locale, folded: foldText(query.normalize("NFC"), locale).folded };
  }
  const folded = owner
    ? foldedOnce(foldedTitles, owner, title, locale, true)
    : foldText(title.normalize("NFC"), locale);
  return findFolded(folded, lastQuery.folded) !== null;
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
  const folded = foldText(query, locale).folded;
  for (const slide of slides) {
    if (skip(slide)) continue;
    const match = findFolded(foldedSlide(slide, locale), folded);
    if (!match) continue;
    total++;
    if (hits.length < TEXT_MATCH_LIMIT)
      hits.push({ slide, snippet: snippetAround(slide.text, match) });
  }
  return { hits, total };
}
