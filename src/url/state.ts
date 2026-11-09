/**
 * Viewer state in the URL (decisions 20, 21 and 100). Every value is validated
 * with Valibot at this boundary (decision 46): a link may be hand-edited or
 * hostile, so anything that does not parse becomes `null` instead of
 * throwing, and the app falls back to its defaults.
 */
import * as v from "valibot";
import type { HeadingDepth } from "../sectioning/sectionize";
import type { ViewerUrlState } from "./types";

/** Longest section id, in code points, that a link may carry. */
const MAX_SECTION_ID = 200;

/**
 * Longer hashes are not slide addresses; skip them without decoding. The
 * browser percent-encodes the fragment, so one code point can take up to 12
 * characters (`%F0%9D%92%9C`): the cap must fit the longest id format writes,
 * plus `/` and a five-digit page, or a long non-Latin heading would produce
 * a link that parse then drops.
 */
const MAX_HASH_LENGTH = MAX_SECTION_ID * 12 + 6;

/**
 * A GitHub heading anchor as github-slugger produces it: alphabetic
 * characters (which include circled letters such as `ⓐ`), marks, digits,
 * connector punctuation (`_`, `‿`) and `-`. It never contains `/`, so the
 * first `/` separates the page, and never `=`, so it cannot collide with a
 * share fragment.
 */
const SectionIdSchema = v.pipe(
  v.string(),
  v.regex(new RegExp(`^[\\p{Alphabetic}\\p{M}\\p{N}\\p{Pc}-]{1,${MAX_SECTION_ID}}$`, "u")),
);

/** Most ids a `?sections=` list may name, and the longest encoded value (decision 100). */
const MAX_SECTIONS = 100;
const MAX_SECTIONS_VALUE = 4000;

/**
 * The raw (percent-encoded) value of `?sections=`: ids joined by commas,
 * which format writes as `%2C`. The length is checked before anything is
 * split or decoded, so a hostile value costs one comparison. One bad item
 * (empty, outside the id alphabet, too long) fails the whole list.
 */
const SectionsSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_SECTIONS_VALUE),
  v.transform((raw) => raw.split(/,|%2c/i).map((part) => decode(part) ?? "")),
  v.array(SectionIdSchema),
  v.minLength(1),
  v.maxLength(MAX_SECTIONS),
  v.transform((ids) => [...new Set(ids)]),
);

const PageSchema = v.pipe(v.string(), v.regex(/^[1-9]\d{0,4}$/), v.transform(Number));

const ViewSchema = v.picklist(["edit", "document", "present", "presenter"]);

const LevelSchema = v.union([
  v.literal("auto"),
  v.pipe(
    v.string(),
    v.maxLength(32),
    v.regex(/^[1-6](,[1-6])*$/),
    v.transform((raw): HeadingDepth | HeadingDepth[] => {
      const levels = [...new Set(raw.split(",").map(Number))].toSorted((a, b) => a - b);
      return levels.length === 1 ? (levels[0] as HeadingDepth) : (levels as HeadingDepth[]);
    }),
  ),
]);

function validate<T>(schema: v.GenericSchema<unknown, T>, input: unknown): T | null {
  const result = v.safeParse(schema, input);
  return result.success ? result.output : null;
}

/**
 * Hash forms other than a slide address belong to other features: `#doc=…`
 * is the share fragment (decision 7). A section id never contains `=`.
 */
function isReservedHash(hash: string): boolean {
  return hash.includes("=");
}

/** `[section]` or `[section, page]`, already decoded, to `<section>/<page>`. */
function canonicalAddress(parts: string[]): string | null {
  if (parts.length < 1 || parts.length > 2) return null;
  const sectionId = validate(SectionIdSchema, parts[0]);
  const page = parts.length === 2 ? validate(PageSchema, parts[1]) : 1;
  return sectionId === null || page === null ? null : `${sectionId}/${page}`;
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

function parseAddress(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "" || raw.length > MAX_HASH_LENGTH || isReservedHash(raw)) return null;
  // Split before decoding, so an encoded slash (`%2F`) stays inside the
  // section id, where it fails validation, and cannot forge a page.
  const parts = raw.split("/").map(decode);
  return parts.includes(null) ? null : canonicalAddress(parts as string[]);
}

/**
 * The value of the first `name` parameter as written, still percent-encoded
 * (`URLSearchParams` would decode it, and the length limit of `sections` is
 * on the written form). `null` when the parameter is absent.
 */
function rawQueryParam(url: URL, name: string): string | null {
  for (const pair of url.search.slice(1).split("&")) {
    if (decodeQueryKey(pair) !== name) continue;
    const at = pair.indexOf("=");
    return at < 0 ? "" : pair.slice(at + 1);
  }
  return null;
}

export function parseViewerUrl(url: URL): ViewerUrlState {
  return {
    address: parseAddress(url.hash),
    level: validate(LevelSchema, url.searchParams.get("level")),
    view: validate(ViewSchema, url.searchParams.get("view")),
    sections: validate(SectionsSchema, rawQueryParam(url, "sections")),
  };
}

function formatLevel(level: ViewerUrlState["level"]): string | null {
  if (level === null) return null;
  const raw = Array.isArray(level)
    ? [...new Set(level)].toSorted((a, b) => a - b).join(",")
    : String(level);
  // Round-trip through the parser so format never writes what parse rejects.
  return validate(LevelSchema, raw) === null ? null : raw;
}

/**
 * The ids as `setQueryParam` will write them (joined by commas, which it
 * encodes), or `null` for none, an empty list, or a list parse would refuse:
 * an id outside the alphabet, more than 100 ids, over 4000 encoded characters.
 */
function formatSections(sections: readonly string[] | null): string | null {
  if (sections === null || sections.length === 0) return null;
  const unique = [...new Set(sections)];
  // Checked first: `encodeURIComponent` throws on a lone surrogate, which no id may hold.
  if (unique.some((id) => validate(SectionIdSchema, id) === null)) return null;
  const raw = unique.join(",");
  // Round-trip through the parser, as for `level`, for the count and length limits.
  return validate(SectionsSchema, encodeURIComponent(raw)) === null ? null : raw;
}

/** Whether `format` would write this choice into a link (the picker warns when it would not). */
export function sectionsFitInLink(sections: readonly string[]): boolean {
  return sections.length === 0 || formatSections(sections) !== null;
}

function decodeQueryKey(pair: string): string | null {
  return decode((pair.split("=")[0] ?? "").replaceAll("+", " "));
}

/**
 * Sets or removes one query parameter by editing the raw query string, so
 * unrelated parameters (`?src=https://…`) keep their exact spelling;
 * `URLSearchParams` would re-encode every one of them.
 */
function setQueryParam(url: URL, name: string, value: string | null): void {
  const pairs = url.search.slice(1).split("&").filter(Boolean);
  const next: string[] = [];
  let written = false;
  for (const pair of pairs) {
    if (decodeQueryKey(pair) !== name) next.push(pair);
    else if (value !== null && !written) {
      next.push(`${name}=${encodeURIComponent(value)}`);
      written = true;
    }
  }
  if (value !== null && !written) next.push(`${name}=${encodeURIComponent(value)}`);
  url.search = next.length > 0 ? `?${next.join("&")}` : "";
}

/**
 * Returns a copy of `base` with the given fields written. A field left out
 * is not touched; `null` (or an invalid value) removes it. A reserved hash
 * such as a `#doc=` share fragment is never replaced.
 */
export function formatViewerUrl(base: URL, state: Partial<ViewerUrlState>): URL {
  const url = new URL(base);
  if (state.level !== undefined) setQueryParam(url, "level", formatLevel(state.level));
  if (state.view !== undefined) setQueryParam(url, "view", validate(ViewSchema, state.view));
  if (state.sections !== undefined) setQueryParam(url, "sections", formatSections(state.sections));
  if (state.address !== undefined && !isReservedHash(url.hash)) {
    const address = state.address === null ? null : canonicalAddress(state.address.split("/"));
    url.hash = address ?? "";
  }
  return url;
}

/**
 * `base` without what names a document: `?src=`, `?repo=` with its `path`
 * and `ref`, and a reserved hash (`#doc=…`, `#c=…`). Viewer settings
 * (`?level`, `?view`) and a slide address stay.
 */
export function withoutDocumentLink(base: URL): URL {
  const url = new URL(base);
  for (const name of ["src", "repo", "path", "ref"]) setQueryParam(url, name, null);
  if (isReservedHash(url.hash)) url.hash = "";
  return url;
}
